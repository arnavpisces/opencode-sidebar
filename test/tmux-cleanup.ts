#!/usr/bin/env bun
import { LauncherService } from "../src/lib/opencode.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function tmux(args: string[]) {
  const { stdout } = await execFileAsync("tmux", args)
  return stdout.trim()
}

async function main() {
  const service = new LauncherService()
  const directory = process.cwd()

  const firstResult = await service.openNewSession(directory)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const secondResult = await service.openNewSession(directory)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const launchedSessionIDs = new Set([firstResult.sessionID, secondResult.sessionID])

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
  await new Promise((resolve) => setTimeout(resolve, 600))

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
}

await main()
