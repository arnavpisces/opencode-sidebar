import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { LauncherService } from "../src/lib/opencode.js"
import * as terminal from "../src/lib/terminal.js"
import * as state from "../src/lib/state.js"
import os from "node:os"

afterEach(() => mock.restore())

test("reuses unchanged snapshots and immediately refreshes hidden/re-added directories", async () => {
  let persisted = { serverPort: 42112, pinnedDirectories: [] as string[], hiddenDirectories: [] as string[], themeID: "rose-noir" }
  spyOn(terminal, "listActiveSessions").mockResolvedValue([])
  spyOn(terminal, "getPreviewSessionID").mockResolvedValue(undefined)
  spyOn(state, "loadState").mockImplementation(async () => persisted)
  spyOn(state, "updateState").mockImplementation(async updater => persisted = await updater(persisted))
  let now = 10000
  spyOn(Date, "now").mockImplementation(() => now)
  const directory = os.tmpdir()
  const client = createOpencodeClient({ baseUrl: "http://localhost", throwOnError: true, fetch: async input => {
    const route = new URL((input as Request).url).pathname
    const data = route === "/project" ? [{ id: "p", worktree: directory, sandboxes: [] }] : route === "/session/status" ? {} : []
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
  } })
  const service = new LauncherService()
  spyOn(service, "ensureReady").mockResolvedValue({ client, baseUrl: "http://localhost", port: 42112 })
  const initial = await service.getSnapshot()
  now += 10000
  expect(await service.getSnapshot()).toBe(initial)
  await service.hideDirectory(directory)
  expect((await service.getSnapshot()).directories).toEqual([])
  await service.addProjectDirectory(directory)
  expect(persisted.hiddenDirectories).toEqual([])
  expect((await service.getSnapshot()).directories.map(record => record.directory)).toEqual([directory])
})

test("shutdown preserves shared server when another pane uses the same session", async () => {
  const record = { sessionID: "shared", paneID: "%1", windowID: "@1", windowName: "one", directory: "/tmp", title: "Shared", active: true }
  spyOn(terminal, "listOwnedSessions").mockResolvedValueOnce([record]).mockResolvedValue([])
  spyOn(terminal, "listAllActiveSessions").mockResolvedValue([record, { ...record, paneID: "%2" }])
  spyOn(terminal, "killSessionWindow").mockResolvedValue(true)
  const service = new LauncherService()
  const internals = service as unknown as { startedServerPID: number; port: number }
  internals.startedServerPID = 99999999
  internals.port = 42112
  await service.shutdown()
  expect(internals.startedServerPID).toBe(99999999)
  expect(internals.port).toBe(42112)
})

test("a directory mutation during a refresh retries the captured stale state", async () => {
  let persisted = { serverPort: 42112, pinnedDirectories: [] as string[], hiddenDirectories: [] as string[], themeID: "rose-noir" }
  spyOn(terminal, "listActiveSessions").mockResolvedValue([])
  spyOn(terminal, "getPreviewSessionID").mockResolvedValue(undefined)
  spyOn(state, "loadState").mockImplementation(async () => persisted)
  spyOn(state, "updateState").mockImplementation(async updater => persisted = await updater(persisted))
  let release!: () => void
  let started!: () => void
  const requestStarted = new Promise<void>(resolve => started = resolve)
  const blocked = new Promise<void>(resolve => release = resolve)
  let projectsFetched = 0
  const client = createOpencodeClient({ baseUrl: "http://localhost", throwOnError: true, fetch: async input => {
    const route = new URL((input as Request).url).pathname
    if (route === "/project" && ++projectsFetched === 1) { started(); await blocked }
    const data = route === "/project" ? [{ id: "p", worktree: "/tmp/project", sandboxes: [] }] : route === "/session/status" ? {} : []
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
  } })
  const service = new LauncherService()
  spyOn(service, "ensureReady").mockResolvedValue({ client, baseUrl: "http://localhost", port: 42112 })
  const first = service.getSnapshot()
  await requestStarted
  await service.hideDirectory("/tmp/project")
  const second = service.getSnapshot()
  release()
  const results = await Promise.all([first, second])
  expect(results.map(snapshot => snapshot.directories)).toEqual([[], []])
  expect((await service.getSnapshot()).directories).toEqual([])
  expect(projectsFetched).toBe(2)
})

test("an in-flight state read cannot restore the cache after mutation", async () => {
  let persisted = { serverPort: 42112, pinnedDirectories: [] as string[], hiddenDirectories: [] as string[], themeID: "rose-noir" }
  spyOn(terminal, "listActiveSessions").mockResolvedValue([])
  spyOn(terminal, "getPreviewSessionID").mockResolvedValue(undefined)
  let release!: () => void
  let started!: () => void
  const readStarted = new Promise<void>(resolve => started = resolve)
  const blocked = new Promise<void>(resolve => release = resolve)
  let reads = 0
  spyOn(state, "loadState").mockImplementation(async () => {
    const captured = persisted
    if (++reads === 1) { started(); await blocked }
    return captured
  })
  spyOn(state, "updateState").mockImplementation(async updater => persisted = await updater(persisted))
  const client = createOpencodeClient({ baseUrl: "http://localhost", throwOnError: true, fetch: async input => {
    const route = new URL((input as Request).url).pathname
    const data = route === "/project" ? [{ id: "p", worktree: "/tmp/project", sandboxes: [] }] : route === "/session/status" ? {} : []
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
  } })
  const service = new LauncherService()
  spyOn(service, "ensureReady").mockResolvedValue({ client, baseUrl: "http://localhost", port: 42112 })
  const pending = service.getSnapshot()
  await readStarted
  await service.hideDirectory("/tmp/project")
  release()
  expect((await pending).directories).toEqual([])
  expect(reads).toBe(2)
})
