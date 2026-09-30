import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { LauncherService } from "../src/lib/opencode.js"
import { createServerFetch } from "../src/lib/server-fetch.js"
import * as terminal from "../src/lib/terminal.js"
import * as state from "../src/lib/state.js"

afterEach(() => mock.restore())

const json = (data: unknown) => new Response(JSON.stringify(data), {
  headers: { "content-type": "application/json" },
})

describe("startup sync", () => {
  test("aborts a stalled request, releases shared snapshot, and recovers on the next refresh", async () => {
    spyOn(terminal, "listActiveSessions").mockResolvedValue([])
    spyOn(terminal, "getPreviewSessionID").mockResolvedValue(undefined)
    spyOn(state, "loadState").mockResolvedValue({
      serverPort: 42112, pinnedDirectories: [], hiddenDirectories: [], themeID: "rose-noir",
    })
    let stalled = true
    let aborted = false
    const client = createOpencodeClient({
      baseUrl: "http://localhost:42112",
      throwOnError: true,
      fetch: createServerFetch(30, async (input) => {
        const request = input as Request
        const route = new URL(request.url).pathname
        if (route === "/project" && stalled) {
          return new Promise<Response>((_, reject) => {
            request.signal.addEventListener("abort", () => {
              aborted = true
              reject(request.signal.reason)
            }, { once: true })
          })
        }
        if (route === "/project") return json([{ id: "p", worktree: "/tmp/project", sandboxes: [] }])
        return json(route === "/session/status" ? {} : [])
      }),
    })
    const service = new LauncherService()
    spyOn(service, "ensureReady").mockResolvedValue({ client, baseUrl: "http://localhost:42112", port: 42112 })
    const results = await Promise.allSettled([service.getSnapshot(), service.getSnapshot()])
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect((results[0] as PromiseRejectedResult).reason.message).toContain("/project timed out")
    expect(aborted).toBe(true)
    stalled = false
    const snapshot = await service.getSnapshot()
    expect(snapshot.directories.map((directory) => directory.directory)).toEqual(["/tmp/project"])
  })

  test("bounds stalled response bodies as well as response headers", async () => {
    let aborted = false
    const serverFetch = createServerFetch(30, async (input) => {
      const request = input as Request
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("["))
          request.signal.addEventListener("abort", () => {
            aborted = true
            controller.error(request.signal.reason)
          }, { once: true })
        },
      }))
    })
    await expect(serverFetch("http://localhost/project")).rejects.toThrow("/project timed out")
    expect(aborted).toBe(true)
  })

  test("reports HTTP failures instead of displaying an empty successful sync", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      throwOnError: true,
      fetch: createServerFetch(30, async () => new Response("unavailable", { status: 503 })),
    })
    await expect(client.project.list()).rejects.toThrow("/project failed (HTTP 503)")
  })

  test("preserves pagination headers and response data", async () => {
    const serverFetch = createServerFetch(30, async () => new Response("[1]", {
      headers: { "x-next-cursor": "123", "content-type": "application/json" },
    }))
    const response = await serverFetch("http://localhost/experimental/session")
    expect(response.headers.get("x-next-cursor")).toBe("123")
    expect(await response.json()).toEqual([1])
  })

  test("keeps SSE open past finite request deadline and retains caller cancellation", async () => {
    let signal: AbortSignal | undefined
    const serverFetch = createServerFetch(20, async (input) => {
      signal = (input as Request).signal
      return new Response(new ReadableStream({ start(controller) {
        signal!.addEventListener("abort", () => controller.close(), { once: true })
      } }))
    })
    const abort = new AbortController()
    const response = await serverFetch("http://localhost/global/event", { signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(signal?.aborted).toBe(false)
    abort.abort()
    expect(signal?.aborted).toBe(true)
    expect((await response.body!.getReader().read()).done).toBe(true)
  })

  test("preserves caller cancellation of finite requests", async () => {
    const serverFetch = createServerFetch(1000, async (input) => new Promise<Response>((_, reject) => {
      const signal = (input as Request).signal
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    const abort = new AbortController()
    const pending = serverFetch("http://localhost/project", { signal: abort.signal })
    abort.abort(new Error("caller cancelled"))
    await expect(pending).rejects.toThrow("caller cancelled")
  })

  test("retries event subscription readiness after an initial startup failure", async () => {
    const abort = new AbortController()
    let connected = false
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: createServerFetch(20, async (input) => {
        connected = true
        const signal = (input as Request).signal
        return new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.close(), { once: true })
          },
        }), { headers: { "content-type": "text/event-stream" } })
      }),
    })
    const service = new LauncherService()
    const ready = spyOn(service, "ensureReady")
      .mockRejectedValueOnce(new Error("initial startup failure"))
      .mockResolvedValue({ client, baseUrl: "http://localhost", port: 42112 })
    try {
      await service.subscribe(abort.signal, () => {})
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(ready).toHaveBeenCalledTimes(2)
      expect(connected).toBe(true)
    } finally {
      abort.abort()
    }
  })
})
