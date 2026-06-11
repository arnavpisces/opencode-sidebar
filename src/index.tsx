#!/usr/bin/env node
import React from "react"
import { render } from "ink"
import { App } from "./app.js"
import { LauncherService } from "./lib/opencode.js"
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

const instance = render(renderApp(), {
  exitOnCtrlC: false,
  incrementalRendering: true,
  kittyKeyboard: {
    mode: "auto",
  },
})
