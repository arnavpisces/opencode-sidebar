#!/usr/bin/env bun
import { LauncherService } from "../src/lib/opencode.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cleanupTestSessions, createTestWorkspace, sleep } from "./test-support.js"

const execFileAsync = promisify(execFile)

async function tmux(args: string[]) {
  const { stdout } = await execFileAsync("tmux", args)
  return stdout.trim()
}

async function main() {
  const service = new LauncherService()
  const createdSessions: Array<{ directory: string; sessionID: string }> = []

  try {
    const directory = await createTestWorkspace("cleanup")
    const firstResult = await service.openNewSession(directory)
    await sleep(1200)
    const secondResult = await service.openNewSession(directory)
    await sleep(1200)

    createdSessions.push(
      { directory, sessionID: firstResult.sessionID },
      { directory, sessionID: secondResult.sessionID },
    )

    const launchedSessionIDs = new Set(createdSessions.map((session) => session.sessionID))

    const before = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{pane_current_command}\t#{@opencode_session_id}",
    ])

    const ownedBefore = before
      .split("\n")
      .filter(Boolean)
      .filter((line) => launchedSessionIDs.has(line.split("\t")[2] ?? ""))

    if (ownedBefore.length < 1) {
      throw new Error(`Expected at least one launched session pane before shutdown, got ${ownedBefore.length}`)
    }

    await service.shutdown()
    await sleep(600)

    const after = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{pane_current_command}\t#{@opencode_session_id}",
    ]).catch(() => "")

    const ownedAfter = after
      .split("\n")
      .filter(Boolean)
      .filter((line) => launchedSessionIDs.has(line.split("\t")[2] ?? ""))

    if (ownedAfter.length !== 0) {
      throw new Error(`Expected no owned panes after shutdown, got ${ownedAfter.length}`)
    }

    console.log("tmux-cleanup-ok")
  } finally {
    await service.shutdown().catch(() => {})
    await cleanupTestSessions(service, createdSessions)
  }
}

await main()
