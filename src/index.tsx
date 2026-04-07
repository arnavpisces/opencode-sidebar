#!/usr/bin/env bun
import React from "react"
import { render } from "ink"
import { App } from "./app.js"
import { LauncherService } from "./lib/opencode.js"

const service = new LauncherService()
let cleanedUp = false

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

render(<App service={service} />)
