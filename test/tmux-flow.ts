#!/usr/bin/env bun
import { LauncherService } from "../src/lib/opencode.js"
import { getPreviewSessionID, listActiveSessions } from "../src/lib/terminal.js"

async function main() {
  const service = new LauncherService()
  const snapshot = await service.getSnapshot()

  const first = snapshot.directories.find((item) => item.directory.includes("opencode-plugin-sidebar"))?.sessions[0]
  const second = snapshot.directories.find((item) => item.directory.includes("atlassian-opentui"))?.sessions[0]

  if (!first || !second) {
    throw new Error("Could not locate two sessions for tmux flow test")
  }

  await service.openSession(first.directory, first)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const previewA = await getPreviewSessionID()
  if (previewA !== first.id) {
    throw new Error(`Expected preview to be ${first.id}, got ${previewA}`)
  }

  await service.openSession(second.directory, second)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const previewB = await getPreviewSessionID()
  if (previewB !== second.id) {
    throw new Error(`Expected preview to be ${second.id}, got ${previewB}`)
  }

  const activeAfterB = await listActiveSessions()
  if (!activeAfterB.some((item) => item.sessionID === first.id)) {
    throw new Error(`Expected first session ${first.id} to be parked in background`)
  }

  await service.openSession(first.directory, first)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const previewA2 = await getPreviewSessionID()
  if (previewA2 !== first.id) {
    throw new Error(`Expected preview to return to ${first.id}, got ${previewA2}`)
  }

  const activeAfterA2 = await listActiveSessions()
  if (!activeAfterA2.some((item) => item.sessionID === second.id)) {
    throw new Error(`Expected second session ${second.id} to remain parked in background`)
  }

  console.log("tmux-flow-ok")
}

await main()
