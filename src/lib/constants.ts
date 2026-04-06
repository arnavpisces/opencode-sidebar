import os from "node:os"
import path from "node:path"

export const APP_NAME = "opencode-wezterm-sidebar"
export const APP_DIR = process.env.OPENCODE_SIDEBAR_DIR ?? path.join(os.homedir(), ".local", "share", APP_NAME)
export const STATE_FILE = path.join(APP_DIR, "state.json")
export const SERVER_LOG_FILE = path.join(APP_DIR, "opencode-server.log")
export const DEFAULT_PORT = 42112
export const SESSION_WINDOW_PREFIX = "opencode-session-"
export const LAUNCHER_WORKSPACE = "opencode-sidebar-launcher"
export const SERVER_HOST = "127.0.0.1"
export const SESSION_PAGE_LIMIT = 500
export const WINDOW_POLL_INTERVAL_MS = 2000
export const SNAPSHOT_DEBOUNCE_MS = 150
export const STATUS_MESSAGE_HOLD_MS = 2500
