#!/usr/bin/env node
import React from "react"
import { render } from "ink"
import { App } from "./app.js"
import { LauncherService } from "./lib/opencode.js"

const service = new LauncherService()
let cleanedUp = false

function renderApp() {
  return <App service={service} onCleanup={cleanup} />
}

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  await service.shutdown().catch(() => {})
}

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(0))
})

process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(0))
})

process.on("exit", () => {
  void cleanup()
})

const instance = render(renderApp(), { exitOnCtrlC: false })

process.stdout.on("resize", () => {
  instance.clear()
  instance.rerender(renderApp())
})
