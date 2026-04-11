#!/usr/bin/env bun
import fs from "node:fs/promises"
import React from "react"
import { render } from "ink"
import { App } from "../src/app.js"
import { LauncherService } from "../src/lib/opencode.js"
import { sleep } from "../src/lib/util.js"

const controlFile = process.env.OPENCODE_SIDEBAR_TEST_CONTROL

if (!controlFile) {
  throw new Error("OPENCODE_SIDEBAR_TEST_CONTROL is required for the sidebar test entry")
}

const service = new LauncherService()
const testControlAbort = new AbortController()
let cleanedUp = false

function renderApp() {
  return <App service={service} onCleanup={cleanup} />
}

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  testControlAbort.abort()
  await service.shutdown().catch(() => {})
}

async function startTestControlChannel(file: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const raw = await fs.readFile(file, "utf8")
      const commands = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      if (commands.length > 0) {
        for (const command of commands) {
          if (command.startsWith("open:")) {
            const target = command.slice(5)
            const snapshot = await service.getSnapshot()
            const session = snapshot.directories.flatMap((record) => record.sessions).find((item) => item.id === target)
            if (session) {
              await service.openSession(session.directory, session)
            }
            continue
          }

          if (command.startsWith("new:")) {
            const directory = command.slice(4)
            if (directory) {
              await service.openNewSession(directory)
            }
          }
        }
        await fs.writeFile(file, "")
      }
    } catch {
      // Ignore missing control file and transient races in test mode.
    }

    if (!signal.aborted) {
      await sleep(150)
    }
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

void startTestControlChannel(controlFile, testControlAbort.signal).catch(() => {})

const instance = render(renderApp(), { exitOnCtrlC: false })

process.stdout.on("resize", () => {
  instance.clear()
  instance.rerender(renderApp())
})
