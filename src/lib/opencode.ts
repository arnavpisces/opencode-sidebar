import net from "node:net"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { DEFAULT_PORT, SERVER_HOST, SERVER_LOG_FILE, SESSION_PAGE_LIMIT, SNAPSHOT_DEBOUNCE_MS } from "./constants.js"
import { buildSnapshot } from "./model.js"
import { SoundNotifier } from "./notifications.js"
import { loadState, saveState, updateState } from "./state.js"
import type { DirectoryRecord, OpenResult, ProjectRecord, SessionRecord, SessionRuntimeStatus, Snapshot } from "./types.js"
import { assertDirectoryExists, normalizeDirectory, sleep } from "./util.js"
import {
  describeTerminalBackend,
  getPreviewSessionID,
  killSessionWindow,
  listActiveSessions,
  openSessionWithPreferredTerminal,
} from "./terminal.js"

type OpencodeClient = ReturnType<typeof createOpencodeClient>
const RECENT_COMPLETION_WINDOW_MS = 5 * 60_000

async function isHealthy(port: number) {
  try {
    const response = await fetch(`http://${SERVER_HOST}:${port}/global/health`)
    if (!response.ok) return false
    const json = (await response.json()) as { healthy?: boolean }
    return json.healthy === true
  } catch {
    return false
  }
}

async function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, SERVER_HOST)
  })
}

async function nextFreePort(start: number) {
  for (let port = start; port < start + 50; port++) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error("Could not find a free local port for opencode serve")
}

async function startDetachedServer(port: number) {
  await fs.mkdir(path.dirname(SERVER_LOG_FILE), { recursive: true })
  const handle = await fs.open(SERVER_LOG_FILE, "a")
  const child = spawn(
    "opencode",
    ["serve", "--hostname", SERVER_HOST, "--port", String(port)],
    {
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
    },
  )
  child.unref()
  await handle.close()
}

async function ensureServerPort() {
  const state = await loadState()
  let port = state.serverPort || DEFAULT_PORT

  if (await isHealthy(port)) return port

  if (!(await isPortAvailable(port))) {
    port = await nextFreePort(Math.max(DEFAULT_PORT, port + 1))
  }

  if (port !== state.serverPort) {
    await saveState({ ...state, serverPort: port })
  }

  await startDetachedServer(port)

  const started = Date.now()
  while (Date.now() - started < 20_000) {
    if (await isHealthy(port)) return port
    await sleep(250)
  }

  throw new Error(`Timed out waiting for opencode serve on port ${port}`)
}

async function fetchAllSessions(client: OpencodeClient) {
  const sessions: SessionRecord[] = []
  let cursor: number | undefined

  while (sessions.length < 2000) {
    const result = await client.experimental.session.list({
      roots: true,
      limit: SESSION_PAGE_LIMIT,
      archived: false,
      cursor,
    })
    const chunk = (result.data ?? []) as SessionRecord[]
    sessions.push(...chunk)
    const next = result.response.headers.get("x-next-cursor")
    if (!next) break
    cursor = Number(next)
    if (!Number.isFinite(cursor)) break
  }

  return sessions
}

async function fetchProjects(client: OpencodeClient) {
  const result = await client.project.list()
  return ((result.data ?? []) as ProjectRecord[]).map((project) => ({
    id: project.id,
    name: project.name,
    worktree: project.worktree,
    sandboxes: project.sandboxes ?? [],
  }))
}

async function fetchSessionStatuses(client: OpencodeClient) {
  const result = await client.session.status()
  return ((result.data ?? {}) as Record<string, SessionRuntimeStatus>)
}

async function fetchPendingQuestions(client: OpencodeClient) {
  const result = await client.question.list()
  return result.data ?? []
}

async function fetchPendingPermissions(client: OpencodeClient) {
  const result = await client.permission.list()
  return result.data ?? []
}

function mergeSessionStatuses(sessions: SessionRecord[], statuses: Record<string, SessionRuntimeStatus>) {
  const now = Date.now()
  return sessions.map((session) => {
    const status = statuses[session.id]
    if (status) {
      return {
        ...session,
        status,
      }
    }
    const justCompleted = now - session.time.updated <= RECENT_COMPLETION_WINDOW_MS
    return {
      ...session,
      status: {
        type: "idle",
        justCompleted,
      } satisfies SessionRuntimeStatus,
    }
  })
}

export class LauncherService {
  private client?: OpencodeClient
  private baseUrl?: string
  private port?: number
  private readonly launchedSessionIDs = new Set<string>()
  private readonly notifier = new SoundNotifier()

  async ensureReady() {
    if (this.client && this.baseUrl && this.port && (await isHealthy(this.port))) {
      return {
        client: this.client,
        baseUrl: this.baseUrl,
        port: this.port,
      }
    }

    this.client = undefined
    this.baseUrl = undefined
    this.port = undefined

    const port = await ensureServerPort()
    const baseUrl = `http://${SERVER_HOST}:${port}`
    const client = createOpencodeClient({ baseUrl })

    this.client = client
    this.baseUrl = baseUrl
    this.port = port

    return {
      client,
      baseUrl,
      port,
    }
  }

  async getSnapshot(): Promise<Snapshot> {
    const [{ client, baseUrl, port }, state, activeSessions, previewSessionID] = await Promise.all([
      this.ensureReady(),
      loadState(),
      listActiveSessions(),
      getPreviewSessionID(),
    ])
    const [projects, sessions, statuses, questions, permissions] = await Promise.all([
      fetchProjects(client),
      fetchAllSessions(client),
      fetchSessionStatuses(client),
      fetchPendingQuestions(client),
      fetchPendingPermissions(client),
    ])

    const snapshot = buildSnapshot({
      baseUrl,
      serverPort: port,
      projects,
      sessions: mergeSessionStatuses(sessions, statuses),
      pinnedDirectories: state.pinnedDirectories,
      panes: [],
      activeSessions,
      previewSessionID,
    })
    this.notifier.syncSnapshot(snapshot)
    this.notifier.syncPendingRequests({
      questions,
      permissions,
    })
    return snapshot
  }

  async addProjectDirectory(rawDirectory: string) {
    const { client } = await this.ensureReady()
    const directory = normalizeDirectory(rawDirectory)
    await assertDirectoryExists(directory)
    try {
      await client.project.current({ directory })
    } catch {
      // Some folders may not have been opened in OpenCode yet. Persisting the path
      // still lets the sidebar surface it so a first session can be created there.
    }
    await updateState((state) => ({
      ...state,
      pinnedDirectories: state.pinnedDirectories.includes(directory)
        ? state.pinnedDirectories
        : [...state.pinnedDirectories, directory],
    }))
    return directory
  }

  async pinDirectory(rawDirectory: string) {
    return this.addProjectDirectory(rawDirectory)
  }

  async unpinDirectory(directory: string) {
    await updateState((state) => ({
      ...state,
      pinnedDirectories: state.pinnedDirectories.filter((item) => item !== directory),
    }))
  }

  async openSession(directory: string, session: SessionRecord): Promise<OpenResult> {
    const { baseUrl } = await this.ensureReady()
    const result = await openSessionWithPreferredTerminal({
      sessionID: session.id,
      directory,
      title: session.title,
      baseUrl,
    })
    this.launchedSessionIDs.add(session.id)
    return result
  }

  async openNewSession(directory: string): Promise<OpenResult> {
    const { client, baseUrl } = await this.ensureReady()
    const result = await client.session.create({ directory })
    if (!result.data) {
      throw new Error("Failed to create a new session")
    }
    const session = result.data as SessionRecord
    const openResult = await openSessionWithPreferredTerminal({
      sessionID: session.id,
      directory,
      title: session.title,
      baseUrl,
    })
    this.launchedSessionIDs.add(session.id)
    return openResult
  }

  async openDirectory(record: DirectoryRecord): Promise<OpenResult> {
    if (record.sessions.length > 0) {
      return this.openSession(record.directory, record.sessions[0])
    }
    return this.openNewSession(record.directory)
  }

  async deleteSession(directory: string, sessionID: string) {
    const { client } = await this.ensureReady()
    await client.session.delete({
      sessionID,
      directory,
    })
  }

  async killSession(sessionID: string) {
    const killed = await killSessionWindow(sessionID)
    if (killed) {
      this.launchedSessionIDs.delete(sessionID)
    }
    return killed
  }

  async shutdown() {
    const results = [] as boolean[]
    for (const sessionID of this.launchedSessionIDs) {
      results.push(await killSessionWindow(sessionID).catch(() => false))
    }
    this.launchedSessionIDs.clear()
    return results
  }

  async subscribe(signal: AbortSignal, onInvalidate: () => void) {
    const { client } = await this.ensureReady()
    let timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(onInvalidate, SNAPSHOT_DEBOUNCE_MS)
    }

    ;(async () => {
      while (!signal.aborted) {
        try {
          const events = await client.global.event({ signal })
          for await (const event of events.stream) {
            if (signal.aborted) break
            this.notifier.handleEvent({
              directory: event.directory,
              event: event.payload,
            })
            invalidate()
          }
        } catch {
          if (signal.aborted) break
          await sleep(1000)
        }
      }
    })().catch(() => {})
  }

  describeBackend() {
    return describeTerminalBackend()
  }
}
