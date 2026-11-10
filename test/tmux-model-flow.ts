#!/usr/bin/env bun
import { createServer } from "node:http"
import net from "node:net"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { LauncherService } from "../src/lib/opencode.js"
import { NotificationTracker } from "../src/lib/notifications.js"
import { getPreviewSessionMeta } from "../src/lib/terminal.js"
import { loadState } from "../src/lib/state.js"
import { cleanupTestSessions, createTestWorkspace, sleep } from "./test-support.js"

const execFileAsync = promisify(execFile)
const calls: string[] = []
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume the request */ }
  calls.push(request.url ?? "")
  await sleep(2000)
  response.writeHead(200, { "content-type": "text/event-stream" })
  const frame = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`)
  const common = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test" }
  frame({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "Hello from mock model" }, finish_reason: null }] })
  frame({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })
  response.end("data: [DONE]\n\n")
})
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve))
const address = modelServer.address()
if (!address || typeof address === "string") throw new Error("Could not start local mock model")
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: "mock/test",
  providers: {
    mock: {
      name: "Mock model",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-only" },
      models: { test: { name: "Mock model" } },
    },
  },
})

const service = new LauncherService()
const abort = new AbortController()
const subscriptionAbort = new AbortController()
const created: Array<{ directory: string; sessionID: string }> = []
try {
  const directory = await createTestWorkspace("model flow")
  const opened = await service.openNewSession(directory)
  created.push({ directory, sessionID: opened.sessionID })
  const preview = await getPreviewSessionMeta()
  if (!preview?.paneID) throw new Error("Missing model test preview pane")
  const pane = preview.paneID
  const { client, port } = await service.ensureReady()
  // Keep the real service subscription running through shutdown to exercise
  // reconnects racing with termination of the owned server.
  await service.subscribe(subscriptionAbort.signal, () => {})
  const events = await client.global.event({ signal: abort.signal })
  const tracker = new NotificationTracker()
  const effects: string[] = []
  const eventTypes: string[] = []
  const consume = (async () => {
    try {
      for await (const event of events.stream) {
        const properties = event.payload.properties as { sessionID?: string }
        if (properties.sessionID !== opened.sessionID) continue
        eventTypes.push(event.payload.type)
        effects.push(...tracker.handleEvent({ directory: event.directory, event: event.payload }).map((item) => item.kind))
      }
    } catch {
      if (!abort.signal.aborted) throw new Error("Model test event stream failed")
    }
  })()
  try {
    let screen = ""
    const readyUntil = Date.now() + 20_000
    while (Date.now() < readyUntil) {
      screen = (await execFileAsync("tmux", ["capture-pane", "-p", "-t", pane])).stdout
      if (screen.includes("Mock model")) break
      await sleep(250)
    }
    if (!screen.includes("Mock model")) throw new Error(`Mock model TUI did not become ready:\n${screen}`)
    await execFileAsync("tmux", ["send-keys", "-t", pane, "-l", "Reply with the test response"])
    await execFileAsync("tmux", ["send-keys", "-t", pane, "Enter"])
    let sawBusy = false
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const status = await client.session.status()
      if (status.data?.[opened.sessionID]?.type === "busy") sawBusy = true
      screen = (await execFileAsync("tmux", ["capture-pane", "-p", "-S", "-200", "-t", pane])).stdout
      if (screen.includes("Hello from mock model") && effects.includes("completion")) break
      await sleep(250)
    }
    if (!calls.some((url) => url.endsWith("/chat/completions"))) throw new Error("TUI never reached the local mock provider")
    if (!sawBusy) throw new Error("Sidebar did not observe the session as busy")
    if (!screen.includes("Hello from mock model")) throw new Error(`Mock response was not rendered in the TUI:\n${screen}`)
    if (!effects.includes("completion")) throw new Error(`Session completed without a notification event: ${eventTypes.join(", ")}`)
    abort.abort()
    await consume
    await cleanupTestSessions(service, created)
    created.length = 0
    await service.shutdown()
    await sleep(1800)
    const ports = [...new Set([port, (await loadState()).serverPort])]
    for (const candidate of ports) {
      const listening = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ port: candidate, host: "127.0.0.1" })
        socket.setTimeout(1000)
        socket.once("connect", () => { socket.destroy(); resolve(true) })
        socket.once("error", () => resolve(false))
        socket.once("timeout", () => { socket.destroy(); resolve(false) })
      })
      if (listening) throw new Error(`OpenCode server restarted after shutdown on port ${candidate}`)
    }
    console.log("tmux-model-flow-ok")
  } finally {
    abort.abort()
    await consume.catch(() => {})
  }
} finally {
  subscriptionAbort.abort()
  await cleanupTestSessions(service, created)
  await service.shutdown().catch(() => {})
  await new Promise<void>((resolve) => modelServer.close(() => resolve()))
}
