import net from "node:net"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import {
  DEFAULT_PORT,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  SERVER_HOST,
  SERVER_LOG_FILE,
  SESSION_PAGE_LIMIT,
  SNAPSHOT_DEBOUNCE_MS,
} from "./constants.js"
import { buildSnapshot } from "./model.js"
import { SoundNotifier } from "./notifications.js"
import { loadState, saveState, updateState } from "./state.js"
import { getThemeScheme } from "./themes.js"
import type { DirectoryRecord, OpenResult, ProjectRecord, SessionRecord, SessionRuntimeStatus, Snapshot } from "./types.js"
import { assertDirectoryExists, directoryLabel, directorySubtitle, normalizeDirectory, sleep } from "./util.js"
import {
  describeTerminalBackend,
  getPreviewSessionID,
  isTmuxMouseModeEnabled,
  killSessionWindow,
  listActiveSessions,
  openSessionWithPreferredTerminal,
  resetTerminalBackground as resetTerminalBackgroundStyle,
  retitleSessionWindow,
  setTerminalBackground as setTerminalBackgroundStyle,
} from "./terminal.js"

type OpencodeClient = ReturnType<typeof createOpencodeClient>
type ReadyState = {
  client: OpencodeClient
  baseUrl: string
  port: number
}

type DirectoryAutocompleteOption = {
  directory: string
  label: string
  subtitle: string
  pinned: boolean
}

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
  await fs.mkdir(path.dirname(SERVER_LOG_FILE), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await fs.chmod(path.dirname(SERVER_LOG_FILE), PRIVATE_DIRECTORY_MODE).catch(() => {})
  const handle = await fs.open(SERVER_LOG_FILE, "a", PRIVATE_FILE_MODE)
  await fs.chmod(SERVER_LOG_FILE, PRIVATE_FILE_MODE).catch(() => {})
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

function normalizeDirectoryQuery(rawQuery: string) {
  const trimmed = rawQuery.trim()
  if (!trimmed) return { query: "", absolute: undefined }

  const expanded = trimmed.startsWith("~/") ? path.join(process.env.HOME ?? "", trimmed.slice(2)) : trimmed
  if (path.isAbsolute(expanded)) {
    return {
      query: path.basename(expanded),
      absolute: expanded,
    }
  }

  return {
    query: trimmed,
    absolute: undefined,
  }
}

function fuzzyDirectoryScore(candidate: string, query: string) {
  const lowerCandidate = candidate.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (!lowerQuery) return 100
  if (lowerCandidate === lowerQuery) return 500
  if (lowerCandidate.startsWith(lowerQuery)) return 400 - lowerCandidate.length

  const substringIndex = lowerCandidate.indexOf(lowerQuery)
  if (substringIndex >= 0) return 300 - substringIndex

  let queryIndex = 0
  for (const char of lowerCandidate) {
    if (char === lowerQuery[queryIndex]) {
      queryIndex += 1
      if (queryIndex === lowerQuery.length) return 200 - lowerCandidate.length
    }
  }

  return -1
}

async function listMatchingDirectories(input: { root: string; fragment: string; limit: number }) {
  const entries = await fs.readdir(input.root, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      directory: path.join(input.root, entry.name),
      score: fuzzyDirectoryScore(entry.name, input.fragment),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, input.limit)
    .map((entry) => entry.directory)
}

function optionFromDirectory(directory: string, pinnedDirectories: string[]) {
  return {
    directory,
    label: directoryLabel(directory),
    subtitle: directorySubtitle(directory),
    pinned: pinnedDirectories.includes(directory),
  } satisfies DirectoryAutocompleteOption
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
  return sessions.map((session) => {
    const status = statuses[session.id]
    if (status) {
      return {
        ...session,
        status,
      }
    }
    return {
      ...session,
      status: {
        type: "idle",
      } satisfies SessionRuntimeStatus,
    }
  })
}

export class LauncherService {
  private client?: OpencodeClient
  private baseUrl?: string
  private port?: number
  private readyPromise?: Promise<ReadyState>
  private snapshotPromise?: Promise<Snapshot>
  private readonly launchedSessionIDs = new Set<string>()
  private readonly notifier = new SoundNotifier()

  async ensureReady(): Promise<ReadyState> {
    if (this.client && this.baseUrl && this.port && (await isHealthy(this.port))) {
      return {
        client: this.client,
        baseUrl: this.baseUrl,
        port: this.port,
      }
    }

    if (this.readyPromise) {
      return this.readyPromise
    }

    this.readyPromise = (async () => {
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
    })()

    try {
      return await this.readyPromise
    } finally {
      this.readyPromise = undefined
    }
  }

  async getSnapshot(): Promise<Snapshot> {
    if (this.snapshotPromise) {
      return this.snapshotPromise
    }

    this.snapshotPromise = (async () => {
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
    })()

    try {
      return await this.snapshotPromise
    } finally {
      this.snapshotPromise = undefined
    }
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

  async autocompleteDirectories(rawQuery: string, limit = 12) {
    const [{ client }, state] = await Promise.all([this.ensureReady(), loadState()])
    const normalized = normalizeDirectoryQuery(rawQuery)

    if (normalized.absolute) {
      const exactDirectory = path.resolve(normalized.absolute)
      const exactStats = await fs.stat(exactDirectory).catch(() => undefined)
      const searchRoot = exactStats?.isDirectory() ? exactDirectory : path.dirname(exactDirectory)
      const fragment = exactStats?.isDirectory() ? "" : path.basename(exactDirectory)
      const localResults = await listMatchingDirectories({
        root: searchRoot,
        fragment,
        limit,
      })

      const exactMatch = exactStats?.isDirectory() ? [exactDirectory] : []
      return [...new Set([...exactMatch, ...localResults])].map((item) => optionFromDirectory(item, state.pinnedDirectories)).slice(0, limit)
    }

    const response = await client.find.files({
      query: normalized.query,
      type: "directory",
      limit,
    })
    const results = ((response.data ?? []) as string[])
      .filter((item) => item.endsWith("/"))
      .map((item) => item.replace(/\/+$/, ""))
      .map((item) => optionFromDirectory(normalizeDirectory(item), state.pinnedDirectories))

    return results
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

  async getThemeID() {
    return (await loadState()).themeID
  }

  async setThemeID(themeID: string) {
    await updateState((state) => ({
      ...state,
      themeID,
    }))
    return themeID
  }

  async openSession(directory: string, session: SessionRecord): Promise<OpenResult> {
    const [{ baseUrl }, state] = await Promise.all([this.ensureReady(), loadState()])
    const result = await openSessionWithPreferredTerminal({
      sessionID: session.id,
      directory,
      title: session.title,
      baseUrl,
      background: getThemeScheme(state.themeID).base.background,
    })
    this.launchedSessionIDs.add(session.id)
    return result
  }

  async openNewSession(directory: string): Promise<OpenResult> {
    const [{ client, baseUrl }, state] = await Promise.all([this.ensureReady(), loadState()])
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
      background: getThemeScheme(state.themeID).base.background,
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

  async renameSession(directory: string, sessionID: string, title: string) {
    const { client } = await this.ensureReady()
    const nextTitle = title.trim()
    if (!nextTitle) {
      throw new Error("Session title is empty")
    }
    await client.session.update({
      sessionID,
      directory,
      title: nextTitle,
    })
    await retitleSessionWindow(sessionID, directory, nextTitle).catch(() => false)
    return nextTitle
  }

  async killSession(sessionID: string) {
    const killed = await killSessionWindow(sessionID)
    if (killed) {
      this.launchedSessionIDs.delete(sessionID)
    }
    return killed
  }

  async isMouseModeEnabled() {
    return isTmuxMouseModeEnabled().catch(() => false)
  }

  async setTerminalBackground(background: string) {
    await setTerminalBackgroundStyle(background).catch(() => {})
  }

  async resetTerminalBackground() {
    await resetTerminalBackgroundStyle().catch(() => {})
  }

  async shutdown() {
    const launchedSessionIDs = [...this.launchedSessionIDs]
    const results = [] as boolean[]
    for (const sessionID of launchedSessionIDs) {
      results.push(await killSessionWindow(sessionID).catch(() => false))
    }

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const activeSessionIDs = new Set((await listActiveSessions().catch(() => [])).map((session) => session.sessionID))
      if (launchedSessionIDs.every((sessionID) => !activeSessionIDs.has(sessionID))) {
        break
      }
      await sleep(100)
    }

    this.launchedSessionIDs.clear()
    return results
  }

  async subscribe(signal: AbortSignal, onInvalidate: () => void) {
    const { client } = await this.ensureReady()
    let timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!signal.aborted) onInvalidate()
      }, SNAPSHOT_DEBOUNCE_MS)
    }

    signal.addEventListener(
      "abort",
      () => {
        if (timer) clearTimeout(timer)
      },
      { once: true },
    )

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
