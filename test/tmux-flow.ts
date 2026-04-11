#!/usr/bin/env bun
import type { SessionRecord } from "../src/lib/types.js"
import { LauncherService } from "../src/lib/opencode.js"
import { getPreviewSessionID, listActiveSessions } from "../src/lib/terminal.js"
import { cleanupTestSessions, createTestWorkspace, sleep } from "./test-support.js"

async function main() {
  const service = new LauncherService()
  const createdSessions: Array<{ directory: string; sessionID: string }> = []

  try {
    const { client } = await service.ensureReady()
    const firstDirectory = await createTestWorkspace("flow-one")
    const secondDirectory = await createTestWorkspace("flow-two")
    const firstResult = await client.session.create({ directory: firstDirectory })
    const secondResult = await client.session.create({ directory: secondDirectory })
    const first = firstResult.data as SessionRecord | undefined
    const second = secondResult.data as SessionRecord | undefined

    if (!first || !second) {
      throw new Error("Could not create isolated sessions for tmux flow test")
    }

    createdSessions.push(
      { directory: first.directory, sessionID: first.id },
      { directory: second.directory, sessionID: second.id },
    )

    await service.openSession(first.directory, first)
    await sleep(1200)

    const previewA = await getPreviewSessionID()
    if (previewA !== first.id) {
      throw new Error(`Expected preview to be ${first.id}, got ${previewA}`)
    }

    await service.openSession(second.directory, second)
    await sleep(1200)

    const previewB = await getPreviewSessionID()
    if (previewB !== second.id) {
      throw new Error(`Expected preview to be ${second.id}, got ${previewB}`)
    }

    const activeAfterB = await listActiveSessions()
    if (!activeAfterB.some((item) => item.sessionID === first.id)) {
      throw new Error(`Expected first session ${first.id} to be parked in background`)
    }

    await service.openSession(first.directory, first)
    await sleep(1200)

    const previewA2 = await getPreviewSessionID()
    if (previewA2 !== first.id) {
      throw new Error(`Expected preview to return to ${first.id}, got ${previewA2}`)
    }

    const activeAfterA2 = await listActiveSessions()
    if (!activeAfterA2.some((item) => item.sessionID === second.id)) {
      throw new Error(`Expected second session ${second.id} to remain parked in background`)
    }

    console.log("tmux-flow-ok")
  } finally {
    await service.shutdown().catch(() => {})
    await cleanupTestSessions(service, createdSessions)
  }
}

await main()
