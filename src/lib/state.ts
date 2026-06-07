import fsSync from "node:fs"
import fs from "node:fs/promises"
import { APP_DIR, DEFAULT_PORT, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE, STATE_FILE } from "./constants.js"
import { DEFAULT_THEME_ID } from "./themes.js"
import type { PersistedState } from "./types.js"
import { distinct } from "./util.js"

const DEFAULT_STATE: PersistedState = {
  serverPort: DEFAULT_PORT,
  pinnedDirectories: [],
  hiddenDirectories: [],
  themeID: DEFAULT_THEME_ID,
}

async function ensureAppDir() {
  await fs.mkdir(APP_DIR, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await fs.chmod(APP_DIR, PRIVATE_DIRECTORY_MODE).catch(() => {})
}

function ensureAppDirSync() {
  fsSync.mkdirSync(APP_DIR, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  try {
    fsSync.chmodSync(APP_DIR, PRIVATE_DIRECTORY_MODE)
  } catch {
    // Best-effort permissions fix.
  }
}

function normalizeState(parsed: Partial<PersistedState>): PersistedState {
  return {
    serverPort: parsed.serverPort && Number.isInteger(parsed.serverPort) ? parsed.serverPort : DEFAULT_PORT,
    pinnedDirectories: distinct((parsed.pinnedDirectories ?? []).filter((item): item is string => typeof item === "string")),
    hiddenDirectories: distinct((parsed.hiddenDirectories ?? []).filter((item): item is string => typeof item === "string")),
    themeID: typeof parsed.themeID === "string" ? parsed.themeID : DEFAULT_THEME_ID,
  }
}

export function loadStateSync(): PersistedState {
  try {
    ensureAppDirSync()
    const raw = fsSync.readFileSync(STATE_FILE, "utf8")
    return normalizeState(JSON.parse(raw) as Partial<PersistedState>)
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export async function loadState(): Promise<PersistedState> {
  await ensureAppDir()
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8")
    return normalizeState(JSON.parse(raw) as Partial<PersistedState>)
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export async function saveState(state: PersistedState) {
  await ensureAppDir()
  const normalized: PersistedState = {
    serverPort: state.serverPort,
    pinnedDirectories: distinct(state.pinnedDirectories),
    hiddenDirectories: distinct(state.hiddenDirectories),
    themeID: state.themeID || DEFAULT_THEME_ID,
  }
  await fs.writeFile(STATE_FILE, JSON.stringify(normalized, null, 2) + "\n", {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  })
  await fs.chmod(STATE_FILE, PRIVATE_FILE_MODE).catch(() => {})
}

export async function updateState(updater: (state: PersistedState) => PersistedState | Promise<PersistedState>) {
  const current = await loadState()
  const next = await updater(current)
  await saveState(next)
  return next
}

export async function touchAppDir() {
  await ensureAppDir()
  return APP_DIR
}
