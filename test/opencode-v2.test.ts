import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createV2Client, normalizeV2Session, translateV2Event } from "../src/lib/opencode-v2.js"
import { NotificationTracker } from "../src/lib/notifications.js"
import { sessionCommand } from "../src/lib/terminal.js"

afterEach(() => mock.restore())

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })

describe("OpenCode 2 compatibility", () => {
  test("maps its paginated sessions, project, status, pending requests and file results", async () => {
    const requests: Request[] = []
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request
      requests.push(request)
      const url = new URL(request.url)
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
      if (url.pathname === "/api/session" && request.method === "POST") return json({ data: { id: "ses_1", location: { directory: "/tmp/project" }, time: { created: 1, updated: 2 } } })
      if (url.pathname === "/api/session") return json({ data: [{ id: "ses_1", title: "Title", location: { directory: "/tmp/project" }, time: { created: 1, updated: 2 } }], cursor: { next: "opaque+cursor" } })
      if (url.pathname === "/api/project") return json([{ id: "p", canonical: "/tmp/project", sandboxes: [] }])
      if (url.pathname === "/api/session/active") return json({ data: { ses_1: { type: "running" } } })
      if (url.pathname === "/api/form") return json({ data: [{ id: "form_1", sessionID: "ses_1" }] })
      if (url.pathname === "/api/permission/request") return json({ data: [{ id: "per_1", sessionID: "ses_1" }] })
      if (url.pathname === "/api/fs/find") return json({ location: { directory: "/tmp/project" }, data: [{ type: "directory", path: "nested" }] })
      return new Response(null, { status: 204 })
    })
    const client = createV2Client("http://localhost:1234", "secret")
    const sessions = await client.experimental.session.list({ limit: 50, cursor: "prior+cursor" })
    expect(sessions.nextCursor).toBe("opaque+cursor")
    expect(sessions.data[0]).toEqual({ id: "ses_1", title: "Title", directory: "/tmp/project", time: { created: 1, updated: 2 } })
    expect(new URL(requests[0].url).searchParams.get("cursor")).toBe("prior+cursor")
    expect(new URL(requests[0].url).searchParams.get("parentID")).toBe("null")
    expect((await client.project.list()).data[0].worktree).toBe("/tmp/project")
    expect((await client.session.status()).data.ses_1.type).toBe("busy")
    expect((await client.session.create({ directory: "/tmp/project" })).data.title).toBe("New session")
    expect(await client.pending(["/tmp/project"])).toEqual({ questions: [{ id: "form_1", sessionID: "ses_1" }], permissions: [{ id: "per_1", sessionID: "ses_1" }] })
    expect((await client.find.files({ query: "nest", limit: 5 })).data).toEqual(["/tmp/project/nested/"])
    await client.session.update({ sessionID: "ses_1", title: "Renamed" })
    await client.session.delete({ sessionID: "ses_1" })
    expect(requests.at(-2)?.method).toBe("PATCH")
    expect(requests.at(-1)?.method).toBe("DELETE")
    expect(normalizeV2Session({ id: "s", location: { directory: "/x" }, time: { created: 1, updated: 1 } }).directory).toBe("/x")
  })

  test("translates v2 form, permission and execution events into notifications", () => {
    const tracker = new NotificationTracker(() => 10_000)
    const translate = (type: string, data: Record<string, unknown>) => {
      const event = translateV2Event({ type, data, location: { directory: "/tmp/project" } })
      return tracker.handleEvent({ directory: event.directory, event: event.payload as never })
    }
    expect(translate("form.created", { form: { id: "f", sessionID: "s" } })[0].kind).toBe("attention")
    expect(translate("form.created", { form: { id: "f", sessionID: "s" } })).toEqual([])
    translate("form.replied", { id: "f", sessionID: "s" })
    expect(translate("permission.asked", { id: "p", sessionID: "s" })[0].kind).toBe("attention")
    translate("session.execution.started", { sessionID: "s" })
    expect(translate("session.execution.succeeded", { sessionID: "s" })[0].kind).toBe("completion")
  })

  test("ignores deleted locations but reports other pending request failures", async () => {
    let status = 404
    spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status }))
    const client = createV2Client("http://localhost:1234", "secret")
    expect(await client.pending(["/deleted"])).toEqual({ questions: [], permissions: [] })
    status = 503
    await expect(client.pending(["/broken"])).rejects.toThrow("HTTP 503")
  })

  test("does not hide a permission failure when the forms endpoint returns 404", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request
      return new Response(null, { status: new URL(request.url).pathname === "/api/form" ? 404 : 503 })
    })
    await expect(createV2Client("http://localhost:1234", "secret").pending(["/project"])).rejects.toThrow("HTTP 503")
  })

  test("parses event frames when CRLF boundaries cross network chunks", async () => {
    const encoder = new TextEncoder()
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"form.created","data":{"form":{"id":"form_1","sessionID":"ses_1"}}}\r'))
        controller.enqueue(encoder.encode('\n\r'))
        controller.enqueue(encoder.encode('\n'))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } }))
    const client = createV2Client("http://localhost:1234", "secret")
    const { stream } = await client.global.event({ signal: new AbortController().signal })
    const events = []
    for await (const event of stream) events.push(event)
    expect(events).toEqual([{ directory: "", payload: { type: "question.asked", properties: { id: "form_1", sessionID: "ses_1" } } }])
  })

  test("uses the matching CLI and keeps the v2 password out of command arguments", () => {
    expect(sessionCommand("/tmp/a", "ses_x", "http://localhost:1234", 1)).toEqual(["opencode", "attach", "http://localhost:1234", "--dir", "/tmp/a", "--session", "ses_x"])
    const command = sessionCommand("/tmp/a", "ses_x", "http://localhost:1234", 2)
    expect(command).toContain("--server")
    expect(command).toContain("ses_x")
    expect(command.join(" ")).not.toContain("secret")
  })
})
