#!/usr/bin/env bun
import fs from "node:fs/promises"
import React from "react"
import { render } from "ink"
import { App } from "./app.js"
import { LauncherService } from "./lib/opencode.js"
import { sleep } from "./lib/util.js"

const service = new LauncherService()
let cleanedUp = false
let renderRevision = 0

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  await service.shutdown().catch(() => {})
}

async function startTestControlChannel() {
  const file = process.env.OPENCODE_SIDEBAR_TEST_CONTROL
  if (!file) return

  for (;;) {
    try {
      const raw = await fs.readFile(file, "utf8")
      const commands = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      if (commands.length > 0) {
        const snapshot = await service.getSnapshot()
        for (const command of commands) {
          if (!command.startsWith("open:")) continue
          const target = command.slice(5)
          const session = snapshot.directories.flatMap((record) => record.sessions).find((item) => item.id === target)
          if (session) {
            await service.openSession(session.directory, session)
          }
        }
        await fs.writeFile(file, "")
      }
    } catch {
      // Ignore missing control file and transient races in test mode.
    }
    await sleep(150)
  }
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

void startTestControlChannel()

const instance = render(<App service={service} renderRevision={renderRevision} />, { exitOnCtrlC: false })

process.stdout.on("resize", () => {
  renderRevision += 1
  instance.clear()
  instance.rerender(<App service={service} renderRevision={renderRevision} />)
})
