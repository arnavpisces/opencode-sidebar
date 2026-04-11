#!/usr/bin/env bun
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { LauncherService } from "../src/lib/opencode.js"
import type { SessionRecord } from "../src/lib/types.js"
import { cleanupTestSessions, createTestWorkspace, getTestRoot, sleep } from "./test-support.js"

const execFileAsync = promisify(execFile)

async function tmux(args: string[]) {
  const { stdout } = await execFileAsync("tmux", args)
  return stdout.trim()
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
  const controlFile = path.join(getTestRoot(), `sidebar-sigint-control-${process.pid}.txt`)
  const workspace = await createTestWorkspace("sigint")
  const service = new LauncherService()
  let launchedSessionIDs: string[] = []
  const createdSessions: Array<{ directory: string; sessionID: string }> = []

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
    const { client } = await service.ensureReady()
    const firstResult = await client.session.create({ directory: workspace })
    const secondResult = await client.session.create({ directory: workspace })
    const first = firstResult.data as SessionRecord | undefined
    const second = secondResult.data as SessionRecord | undefined

    if (!first || !second) {
      throw new Error("Could not create isolated sessions for the SIGINT cleanup test")
    }

    createdSessions.push(
      { directory: workspace, sessionID: first.id },
      { directory: workspace, sessionID: second.id },
    )

    await waitForSession(tmuxSession)
    await sleep(2500)

    const sidebarPaneOutput = await tmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
    const sidebarPaneID = sidebarPaneOutput.split("\n").filter(Boolean)[0]
    if (!sidebarPaneID) {
      throw new Error("Could not determine sidebar pane ID")
    }

    await fs.writeFile(controlFile, `open:${first.id}\nopen:${second.id}\n`)

    const started = Date.now()

    while (Date.now() - started < 15_000) {
      const active = await tmux(["list-panes", "-a", "-F", "#{@opencode_session_id}"]).catch(() => "")
      const sessionIDs = new Set(active.split("\n").filter(Boolean))
      launchedSessionIDs = [first.id, second.id].filter((sessionID) => sessionIDs.has(sessionID))
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
    await service.shutdown().catch(() => {})
    await cleanupTestSessions(
      service,
      [...createdSessions, ...launchedSessionIDs.map((sessionID) => ({ directory: workspace, sessionID }))],
    )
    await fs.rm(controlFile, { force: true }).catch(() => {})
    await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => {})
  }
}

await main()
