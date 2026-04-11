#!/usr/bin/env bun
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"
import { LauncherService } from "../src/lib/opencode.js"

const execFileAsync = promisify(execFile)

async function tmux(args: string[]) {
  const { stdout } = await execFileAsync("tmux", args)
  return stdout.trim()
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSession(name: string, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const sessions = await tmux(["list-sessions"]).catch(() => "")
    if (sessions.split("\n").some((line) => line.startsWith(`${name}:`))) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for tmux session ${name}`)
}

async function waitForSessionIDsToDisappear(sessionIDs: string[], timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const output = await tmux(["list-panes", "-a", "-F", "#{@opencode_session_id}"]).catch(() => "")
    const active = new Set(output.split("\n").filter(Boolean))
    if (sessionIDs.every((id) => !active.has(id))) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for launched session panes to disappear: ${sessionIDs.join(", ")}`)
}

async function waitForSessionIDsToAppear(sessionIDs: string[], timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const output = await tmux(["list-panes", "-a", "-F", "#{@opencode_session_id}"]).catch(() => "")
    const active = new Set(output.split("\n").filter(Boolean))
    if (sessionIDs.every((id) => active.has(id))) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for launched session panes to appear: ${sessionIDs.join(", ")}`)
}

async function main() {
  const root = process.cwd()
  const tmuxSession = `sidebar-sigint-${process.pid}`
  const controlFile = `${root}/test/sidebar-sigint-control-${process.pid}.txt`

  await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => {})
  await fs.writeFile(controlFile, "")

  await execFileAsync("tmux", [
    "new-session",
    "-d",
    "-s",
    tmuxSession,
    `cd \"${root}\" && OPENCODE_SIDEBAR_BACKEND=tmux OPENCODE_SIDEBAR_TEST_CONTROL=\"${controlFile}\" bun run test/sidebar-test-entry.tsx`,
  ])

  try {
    await waitForSession(tmuxSession)
    await sleep(2500)

    const sidebarPaneOutput = await tmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
    const sidebarPaneID = sidebarPaneOutput.split("\n").filter(Boolean)[0]
    if (!sidebarPaneID) {
      throw new Error("Could not determine sidebar pane ID")
    }

    await fs.writeFile(controlFile, `new:${root}\nnew:${root}\n`)

    const service = new LauncherService()
    const started = Date.now()
    let launchedSessionIDs: string[] = []

    while (Date.now() - started < 15_000) {
      const snapshot = await service.getSnapshot()
      launchedSessionIDs = snapshot.directories
        .find((item) => item.directory === root)
        ?.sessions
        .slice(0, 2)
        .map((session) => session.id) ?? []
      if (launchedSessionIDs.length >= 2) break
      await sleep(250)
    }

    if (launchedSessionIDs.length < 2) {
      throw new Error("Timed out waiting for two launched sessions in the sidebar test workspace")
    }

    await waitForSessionIDsToAppear(launchedSessionIDs)

    await execFileAsync("tmux", ["send-keys", "-t", sidebarPaneID, "C-c"])
    await waitForSessionIDsToDisappear(launchedSessionIDs)

    console.log("sidebar-sigint-cleanup-ok")
  } finally {
    await fs.rm(controlFile, { force: true }).catch(() => {})
    await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => {})
  }
}

await main()
