import fs from "node:fs/promises"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

if (process.env.SIDEBAR_RENDER_RAW_LOG) {
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...args) => {
    appendFileSync(process.env.SIDEBAR_RENDER_RAW_LOG, chunk)
    return write(chunk, ...args)
  }
}

const root = process.env.SIDEBAR_RENDER_ROOT ?? process.cwd()
const controlFile = process.env.SIDEBAR_RENDER_CONTROL
if (!controlFile) throw new Error("SIDEBAR_RENDER_CONTROL is required")
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href)
const { default: React } = await load("node_modules/react/index.js")
const { renderTerminalApp } = await load("dist/lib/render-terminal.js")
const { App } = await load("dist/app.js")
const { bindSidebarToggleKey } = await load("dist/lib/tmux.js")
const { buildSnapshot } = await load("dist/lib/model.js")
const initialThemeID = process.env.SIDEBAR_RENDER_THEME ?? "rose-noir"
let stopped = false
const wallClock = Date.now
let idle = false
// Exercise the idle repaint path without waiting 45 seconds for animations to stop.
Date.now = () => wallClock() + (idle ? 60_000 : 0)
const read = async () => JSON.parse(await fs.readFile(controlFile, "utf8"))
const service = {
  async getSnapshot() {
    const control = await read()
    if (control.snapshotDelay) await new Promise((resolve) => setTimeout(resolve, control.snapshotDelay))
    // Acknowledge after the snapshot's React update has had a render turn.
    // Tests must not depend on server polling finishing within a fixed sleep.
    setTimeout(() => {
      void fs.writeFile(`${controlFile}.applied`, String(control.sequence)).catch(() => {})
    }, 100)
    idle = Boolean(control.idle)
    if (control.error) throw new Error(control.error)
    const directories = Array.from({ length: control.count ?? 1 }, (_, i) => `/tmp/render-project-${i}`)
    return buildSnapshot({
      baseUrl: "http://127.0.0.1:42112",
      serverPort: 42112,
      projects: directories.map((directory, i) => ({ id: String(i), worktree: directory, sandboxes: [] })),
      sessions: directories.flatMap((directory, i) => Array.from({ length: control.sessions ?? 4 }, (_, j) => ({
        id: `render-${i}-${j}`, directory, title: `Session ${i}-${j} ${control.label ?? ""}`,
        time: { created: 1, updated: wallClock() },
        status: { type: control.working ? "busy" : "idle" },
      }))),
      pinnedDirectories: [], panes: [], activeSessions: [],
      previewSessionID: control.preview ? "render-0-0" : undefined,
    })
  },
  async subscribe(signal, invalidate) {
    let previous = ""
    const timer = setInterval(async () => {
      if (signal.aborted) return
      const next = await fs.readFile(controlFile, "utf8")
      if (next !== previous) { previous = next; invalidate() }
    }, 100)
    signal.addEventListener("abort", () => clearInterval(timer), { once: true })
  },
  describeBackend: () => "tmux",
  getThemeID: async () => initialThemeID,
  setThemeID: async (id) => id,
  setTerminalBackground: async () => {},
  resetTerminalBackground: async () => {},
  isMouseModeEnabled: async () => true,
  shutdown: async () => { stopped = true },
  autocompleteDirectories: async () => [],
  restartCurrentSession: async () => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    return false
  },
}
await bindSidebarToggleKey()
const instance = renderTerminalApp(React.createElement(App, { service, initialThemeID }), {
  exitOnCtrlC: false,
  kittyKeyboard: { mode: "auto" },
})
process.on("SIGTERM", () => { instance.unmount(); process.exit(0) })
await instance.waitUntilExit()
if (!stopped) instance.unmount()
