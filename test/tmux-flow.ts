#!/usr/bin/env bun
import type { SessionRecord } from "../src/lib/types.js"
import { LauncherService } from "../src/lib/opencode.js"
import { getPreviewSessionID, getPreviewSessionMeta, listActiveSessions } from "../src/lib/terminal.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import { SERVER_PASSWORD_FILE } from "../src/lib/constants.js"
import { createV2Client } from "../src/lib/opencode-v2.js"
import { NotificationTracker } from "../src/lib/notifications.js"
import { cleanupTestSessions, createTestWorkspace, sleep } from "./test-support.js"

const execFileAsync = promisify(execFile)

async function assertLivePreview(sessionID: string, generation: 1 | 2 | undefined, title: string) {
  const preview = await getPreviewSessionMeta()
  if (!preview?.paneID) throw new Error("Missing preview pane")
  const deadline = Date.now() + 20_000
  let screen = ""
  let status = ""
  while (Date.now() < deadline) {
    const info = await execFileAsync("tmux", ["display-message", "-p", "-t", preview.paneID, "#{pane_dead}:#{pane_current_command}:#{pane_pid}"])
    status = info.stdout.trim()
    if (!/^0:\.?opencode:\d+$/.test(status)) break
    const pid = status.split(":")[2]
    const args = await execFileAsync("ps", ["-p", pid, "-o", "command="])
    if (!args.stdout.includes(sessionID)) throw new Error(`Preview process is not attached to session ${sessionID}`)
    screen = (await execFileAsync("tmux", ["capture-pane", "-p", "-t", preview.paneID])).stdout
    if (generation === 2 ? screen.includes(title) : screen.includes("ctrl+p") && screen.includes("OpenCode")) return
    await sleep(250)
  }
  throw new Error(`OpenCode preview did not render its session: ${status}\n${screen}`)
}

async function main() {
  const service = new LauncherService()
  const createdSessions: Array<{ directory: string; sessionID: string }> = []
  const eventAbort = new AbortController()

  try {
    const { client, baseUrl, generation } = await service.ensureReady()
    const events = await client.global.event({ signal: eventAbort.signal })
    const observed = (async () => {
      for await (const event of events.stream) {
        if (event.payload.type === "session.created" || (event.payload.type as string) === "v2.changed") return true
      }
      return false
    })()
    const firstDirectory = await createTestWorkspace("flow one")
    const secondDirectory = await createTestWorkspace("flow-two")
    const firstResult = await client.session.create({ directory: firstDirectory })
    const secondResult = await client.session.create({ directory: secondDirectory })
    const receivedEvent = await Promise.race([observed, sleep(5000).then(() => false)])
    if (!receivedEvent) throw new Error("No session creation event was received")
    const first = firstResult.data as SessionRecord | undefined
    const second = secondResult.data as SessionRecord | undefined

    if (!first || !second) {
      throw new Error("Could not create isolated sessions for tmux flow test")
    }

    createdSessions.push(
      { directory: first.directory, sessionID: first.id },
      { directory: second.directory, sessionID: second.id },
    )

    const snapshot = await service.getSnapshot()
    if (!snapshot.directories.some((item) => item.sessions.some((session) => session.id === first.id))) {
      throw new Error("New session is missing from the sidebar snapshot")
    }
    await service.renameSession(first.directory, first.id, "Renamed integration session")
    const renamed = await service.getSnapshot()
    if (!renamed.directories.some((item) => item.sessions.some((session) => session.id === first.id && session.title === "Renamed integration session"))) {
      throw new Error("Renamed session is missing from the sidebar snapshot")
    }

    if (generation === 2) {
      const v2 = client as unknown as ReturnType<typeof createV2Client>
      const formAbort = new AbortController()
      try {
        const formEvents = await v2.global.event({ signal: formAbort.signal })
        const notification = (async () => {
          const tracker = new NotificationTracker()
          for await (const event of formEvents.stream) {
            if (event.payload.type !== "question.asked") continue
            return tracker.handleEvent({ directory: event.directory, event: event.payload as never })[0]
          }
        })()
        const password = (await fs.readFile(SERVER_PASSWORD_FILE, "utf8")).trim()
        const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
        const created = await fetch(`${baseUrl}/api/session/${first.id}/form`, {
          method: "POST", headers, body: JSON.stringify({ title: "Integration question", fields: [{ key: "answer", type: "string" }] }),
        })
        if (!created.ok) throw new Error(`Could not create test form: HTTP ${created.status}`)
        const form = await created.json() as { data: { id: string } }
        const effect = await Promise.race([notification, sleep(5000).then(() => undefined)])
        if (effect?.kind !== "attention") throw new Error("A real form event did not produce an attention notification")
        const pending = await v2.pending([first.directory])
        if (!pending.questions.some((request) => request.id === form.data.id)) throw new Error("Pending form was not found")
        const reply = await fetch(`${baseUrl}/api/session/${first.id}/form/${form.data.id}/reply`, {
          method: "POST", headers, body: JSON.stringify({ answer: { answer: "ok" } }),
        })
        if (!reply.ok) throw new Error(`Could not reply to test form: HTTP ${reply.status}`)
        if ((await v2.pending([first.directory])).questions.some((request) => request.id === form.data.id)) throw new Error("Replied form is still pending")
      } finally {
        formAbort.abort()
      }

      const missingDirectory = await createTestWorkspace("deleted-directory")
      const missingResult = await client.session.create({ directory: missingDirectory })
      const missingSession = missingResult.data as SessionRecord | undefined
      if (!missingSession) throw new Error("Could not create the deleted-directory test session")
      createdSessions.push({ directory: missingDirectory, sessionID: missingSession.id })
      await fs.rm(missingDirectory, { recursive: true })
      await service.renameSession(first.directory, first.id, "Renamed integration session")
      await service.getSnapshot()
    }

    await service.openSession(first.directory, first)
    await sleep(1200)
    await assertLivePreview(first.id, generation, "Renamed integration session")

    const previewA = await getPreviewSessionID()
    if (previewA !== first.id) {
      throw new Error(`Expected preview to be ${first.id}, got ${previewA}`)
    }

    await service.openSession(second.directory, second)
    await sleep(1200)
    await assertLivePreview(second.id, generation, second.title)

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

    if (!await service.restartCurrentSession()) throw new Error("Could not restart the preview")
    await sleep(1200)
    await assertLivePreview(first.id, generation, "Renamed integration session")
    await service.killSession(second.id)
    await service.deleteSession(second.directory, second.id)
    const afterDelete = await service.getSnapshot()
    if (afterDelete.directories.some((item) => item.sessions.some((session) => session.id === second.id))) {
      throw new Error("Deleted session is still present in the sidebar snapshot")
    }

    console.log("tmux-flow-ok")
  } finally {
    eventAbort.abort()
    await cleanupTestSessions(service, createdSessions)
    await service.shutdown().catch(() => {})
  }
}

await main()
