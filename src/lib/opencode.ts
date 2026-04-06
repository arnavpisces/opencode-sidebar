import net from "node:net"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { DEFAULT_PORT, SERVER_HOST, SERVER_LOG_FILE, SESSION_PAGE_LIMIT, SNAPSHOT_DEBOUNCE_MS } from "./constants.js"
import { buildSnapshot } from "./model.js"
import { loadState, saveState, updateState } from "./state.js"
import type { DirectoryRecord, OpenResult, ProjectRecord, SessionRecord, Snapshot } from "./types.js"
import { assertDirectoryExists, normalizeDirectory, sleep } from "./util.js"
import {
  describeTerminalBackend,
  getPreviewSessionID,
  listActiveSessions,
  openSessionWithPreferredTerminal,
} from "./terminal.js"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

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

export class LauncherService {
  private client?: OpencodeClient
  private baseUrl?: string
  private port?: number

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
    const [projects, sessions] = await Promise.all([fetchProjects(client), fetchAllSessions(client)])

    return buildSnapshot({
      baseUrl,
      serverPort: port,
      projects,
      sessions,
      pinnedDirectories: state.pinnedDirectories,
      panes: [],
      activeSessions,
      previewSessionID,
    })
  }

  async pinDirectory(rawDirectory: string) {
    const { client } = await this.ensureReady()
    const directory = normalizeDirectory(rawDirectory)
    await assertDirectoryExists(directory)
    await client.project.current({ directory })
    await updateState((state) => ({
      ...state,
      pinnedDirectories: state.pinnedDirectories.includes(directory)
        ? state.pinnedDirectories
        : [...state.pinnedDirectories, directory],
    }))
    return directory
  }

  async unpinDirectory(directory: string) {
    await updateState((state) => ({
      ...state,
      pinnedDirectories: state.pinnedDirectories.filter((item) => item !== directory),
    }))
  }

  async openSession(directory: string, session: SessionRecord): Promise<OpenResult> {
    const { baseUrl } = await this.ensureReady()
    return openSessionWithPreferredTerminal({
      sessionID: session.id,
      directory,
      title: session.title,
      baseUrl,
    })
  }

  async openNewSession(directory: string): Promise<OpenResult> {
    const { client, baseUrl } = await this.ensureReady()
    const result = await client.session.create({ directory })
    if (!result.data) {
      throw new Error("Failed to create a new session")
    }
    const session = result.data as SessionRecord
    return openSessionWithPreferredTerminal({
      sessionID: session.id,
      directory,
      title: session.title,
      baseUrl,
    })
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
          const events = await client.global.syncEvent.subscribe({ signal })
          for await (const _event of events.stream) {
            if (signal.aborted) break
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
