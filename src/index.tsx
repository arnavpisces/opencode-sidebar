#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import v8 from "node:v8"
import React from "react"
import { render } from "ink"
import { App } from "./app.js"
import { LauncherService } from "./lib/opencode.js"
import { APP_DIR } from "./lib/constants.js"
import { loadStateSync } from "./lib/state.js"
import { writeTerminalBackground, resetTerminalBackground } from "./lib/terminal-theme.js"
import { getThemeScheme } from "./lib/themes.js"

const service = new LauncherService()
const initialThemeID = loadStateSync().themeID
const initialTheme = getThemeScheme(initialThemeID)
let cleanedUp = false
let fatalExitStarted = false
process.exitCode = 1
writeTerminalBackground(process.stdout, initialTheme.base.background)
void service.setTerminalBackground(initialTheme.base.background)

function renderApp() {
  return <App service={service} onCleanup={cleanup} onRequestExit={() => { process.exitCode = 0 }} initialThemeID={initialThemeID} />
}

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  await service.shutdown().catch(() => {})
  if (process.exitCode === 0) {
    resetTerminalBackground(process.stdout)
    await service.resetTerminalBackground().catch(() => {})
  }
}

process.on("SIGINT", () => {
  process.exitCode = 0
  void cleanup().finally(() => process.exit(0))
})

process.on("SIGTERM", () => {
  process.exitCode = 0
  void cleanup().finally(() => process.exit(0))
})

function startFatalExit(error: unknown) {
  if (fatalExitStarted) return
  fatalExitStarted = true
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[opencode-sidebar] Fatal error\n${detail}`)
  void cleanup().finally(() => process.exit(1))
}

process.on("uncaughtException", startFatalExit)
process.on("unhandledRejection", startFatalExit)

if (process.env.OPENCODE_SIDEBAR_MEMLOG === "1") {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true })
  } catch {}
  const memlogPath = path.join(APP_DIR, "memlog.txt")
  const heapDir = path.join(APP_DIR, "heaps")
  try { fs.mkdirSync(heapDir, { recursive: true }) } catch {}

  const takeHeap = () => {
    try {
      const file = path.join(heapDir, `heap-${Date.now()}.heapsnapshot`)
      v8.writeHeapSnapshot(file)
    } catch {}
  }
  takeHeap()

  setInterval(() => {
    const mem = process.memoryUsage()
    const line = `${new Date().toISOString()} rss=${mem.rss} heapUsed=${mem.heapUsed} external=${mem.external}\n`
    try { fs.appendFileSync(memlogPath, line) } catch {}
  }, 5 * 60_000).unref()

  process.on("SIGUSR2", takeHeap)
}

const instance = render(renderApp(), {
  exitOnCtrlC: false,
  incrementalRendering: true,
  kittyKeyboard: {
    mode: "auto",
  },
})
