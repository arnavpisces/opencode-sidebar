import path from "node:path"
import { createServerFetch, OpenCodeHttpError } from "./server-fetch.js"
import type { ProjectRecord, SessionRecord, SessionRuntimeStatus } from "./types.js"

// OpenCode 2 is a separate API from @opencode-ai/sdk/v2 (the latter is the
// second version of the OpenCode 1 SDK). Keep the old client contract at this
// boundary so the rest of the sidebar can handle both generations alike.
type V2Session = { id: string; title?: string; location: { directory: string }; time: SessionRecord["time"] }
type V2Event = { type: string; data?: Record<string, any>; location?: { directory?: string } }

export function normalizeV2Session(session: V2Session): SessionRecord {
  return { id: session.id, title: session.title ?? "New session", directory: session.location.directory, time: session.time }
}

export function translateV2Event(event: V2Event) {
  const data = event.data ?? {}
  const directory = event.location?.directory ?? ""
  let type = event.type
  let properties: Record<string, any> = data
  if (type === "session.execution.started") {
    type = "session.status"
    properties = { sessionID: data.sessionID, status: { type: "busy" } }
  } else if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)) {
    type = "session.idle"
  } else if (type === "form.created") {
    type = "question.asked"
    properties = data.form ?? {}
  } else if (type === "form.replied" || type === "form.cancelled") {
    type = "question.replied"
    properties = { requestID: data.id }
  } else if (type === "session.created" || type === "session.deleted") {
    // The v1 notification handler expects a full session on creation. A fresh
    // snapshot carries it; ignoring this event still triggers invalidation.
    type = "v2.changed"
  }
  return { directory, payload: { type, properties } }
}

export function createV2Client(baseUrl: string, password: string) {
  const fetchRequest = createServerFetch()
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  async function request<T>(route: string, options: RequestInit = {}): Promise<T> {
    const response = await fetchRequest(`${baseUrl}${route}`, {
      ...options,
      headers: { authorization, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
    })
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
  const scoped = (route: string, directory: string) => `${route}?${new URLSearchParams({ "location[directory]": directory })}`
  const client = {
    project: {
      list: async () => ({ data: (await request<Array<{ id: string; canonical: string; name?: string; sandboxes?: string[] }>>("/api/project")).map((p): ProjectRecord => ({ id: p.id, name: p.name, worktree: p.canonical, sandboxes: p.sandboxes ?? [] })) }),
      current: async (_input: { directory: string }) => ({ data: undefined }),
    },
    experimental: { session: {
      list: async (input: { cursor?: string; limit: number }) => {
        const query = new URLSearchParams({ parentID: "null", archived: "false", limit: String(input.limit), order: "desc" })
        if (input.cursor) query.set("cursor", input.cursor)
        const result = await request<{ data: V2Session[]; cursor: { next?: string | null } }>(`/api/session?${query}`)
        return { data: result.data.map(normalizeV2Session), nextCursor: result.cursor.next }
      },
    } },
    session: {
      create: async ({ directory }: { directory: string }) => {
        const result = await request<{ data: V2Session }>("/api/session", { method: "POST", body: JSON.stringify({ location: { directory } }) })
        return { data: normalizeV2Session(result.data) }
      },
      delete: async ({ sessionID }: { sessionID: string }) => request<void>(`/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" }),
      update: async ({ sessionID, title }: { sessionID: string; title: string }) => request<void>(`/api/session/${encodeURIComponent(sessionID)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
      status: async () => {
        const result = await request<{ data: Record<string, unknown> }>("/api/session/active")
        const data: Record<string, SessionRuntimeStatus> = {}
        for (const id of Object.keys(result.data)) data[id] = { type: "busy" }
        return { data }
      },
    },
    pending: async (directories: string[]) => {
      const entries: Array<{ questions: Array<{ id: string; sessionID: string }>; permissions: Array<{ id: string; sessionID: string }> }> = []
      // A user's history can span many directories. Bound concurrent requests
      // so a refresh does not flood the server.
      for (let offset = 0; offset < directories.length; offset += 8) {
        const batch = await Promise.all(directories.slice(offset, offset + 8).map(async (directory) => {
          const pendingAt = async (route: string) => {
            try {
              const result = await request<{ data: Array<{ id: string; sessionID: string }> }>(scoped(route, directory))
              return result.data
            } catch (error) {
              // History can contain sessions whose directories have since been
              // deleted. V2 cannot open a Location for them, but they must not
              // prevent the rest of the sidebar from loading.
              if (error instanceof OpenCodeHttpError && error.status === 404) return []
              throw error
            }
          }
          const [questions, permissions] = await Promise.all([pendingAt("/api/form"), pendingAt("/api/permission/request")])
          return { questions, permissions }
        }))
        entries.push(...batch)
      }
      return { questions: entries.flatMap((item) => item.questions), permissions: entries.flatMap((item) => item.permissions) }
    },
    find: { files: async ({ query, limit }: { query: string; limit: number }) => {
      const params = new URLSearchParams({ query, type: "directory", limit: String(limit) })
      const result = await request<{ location: { directory: string }; data: Array<{ path: string; type: string }> }>(`/api/fs/find?${params}`)
      return { data: result.data.filter((item) => item.type === "directory").map((item) => path.resolve(result.location.directory, item.path) + "/") }
    } },
    global: { event: async ({ signal }: { signal: AbortSignal }) => {
      const response = await fetchRequest(`${baseUrl}/api/event`, { signal, headers: { authorization } })
      async function* stream() {
        if (!response.body) return
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            // CR and LF can arrive in separate network chunks, so normalize
            // after joining the new text with the unconsumed buffer.
            buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, "\n")
            let end: number
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
              if (!data) continue
              try { yield translateV2Event(JSON.parse(data) as V2Event) } catch { /* Ignore malformed events. */ }
            }
          }
        } finally { await reader.cancel().catch(() => {}) }
      }
      return { stream: stream() }
    } },
  }
  return client
}
