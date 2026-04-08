import fs from "node:fs/promises"
import { APP_DIR, DEFAULT_PORT, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE, STATE_FILE } from "./constants.js"
import type { PersistedState } from "./types.js"
import { distinct } from "./util.js"

const DEFAULT_STATE: PersistedState = {
  serverPort: DEFAULT_PORT,
  pinnedDirectories: [],
}

async function ensureAppDir() {
  await fs.mkdir(APP_DIR, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await fs.chmod(APP_DIR, PRIVATE_DIRECTORY_MODE).catch(() => {})
}

export async function loadState(): Promise<PersistedState> {
  await ensureAppDir()
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      serverPort: parsed.serverPort && Number.isInteger(parsed.serverPort) ? parsed.serverPort : DEFAULT_PORT,
      pinnedDirectories: distinct((parsed.pinnedDirectories ?? []).filter((item): item is string => typeof item === "string")),
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export async function saveState(state: PersistedState) {
  await ensureAppDir()
  const normalized: PersistedState = {
    serverPort: state.serverPort,
    pinnedDirectories: distinct(state.pinnedDirectories),
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
