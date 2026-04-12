import { describe, expect, test } from "bun:test"
import { buildSnapshot } from "../src/lib/model.js"

describe("buildSnapshot", () => {
  test("groups sessions by exact directory and preserves pins", () => {
    const snapshot = buildSnapshot({
      baseUrl: "http://127.0.0.1:42112",
      serverPort: 42112,
      pinnedDirectories: ["/tmp/zeta"],
      panes: [
        {
          window_id: 1,
          tab_id: 1,
          pane_id: 9,
          workspace: "opencode-session-session_a",
          title: "A",
          cwd: "/tmp/alpha",
        },
      ],
      projects: [
        {
          id: "project_a",
          name: "Alpha",
          worktree: "/tmp/alpha",
          sandboxes: [],
        },
      ],
      sessions: [
        {
          id: "session_a",
          title: "First",
          directory: "/tmp/alpha",
          time: { created: 1, updated: 10 },
          project: null,
        },
        {
          id: "session_b",
          title: "Second",
          directory: "/tmp/beta",
          time: { created: 1, updated: 8 },
          project: null,
        },
      ],
    })

    expect(snapshot.directories.map((item) => item.directory)).toEqual(["/tmp/zeta", "/tmp/alpha", "/tmp/beta"])
    expect(snapshot.directories[1].label).toBe("Alpha")
    expect(snapshot.directories[1].openSessionIDs.has("session_a")).toBe(true)
  })

  test("preserves session runtime status metadata", () => {
    const snapshot = buildSnapshot({
      baseUrl: "http://127.0.0.1:42112",
      serverPort: 42112,
      pinnedDirectories: [],
      panes: [],
      projects: [],
      sessions: [
        {
          id: "session_busy",
          title: "Busy",
          directory: "/tmp/alpha",
          status: { type: "busy" },
          time: { created: 1, updated: 10 },
          project: null,
        },
        {
          id: "session_done",
          title: "Done",
          directory: "/tmp/alpha",
          status: { type: "idle", justCompleted: true },
          time: { created: 1, updated: 9 },
          project: null,
        },
      ],
    })

    expect(snapshot.directories[0].sessions[0].status).toEqual({ type: "busy" })
    expect(snapshot.directories[0].sessions[1].status).toEqual({ type: "idle", justCompleted: true })
  })

  test("includes manually added directories even before sessions exist", () => {
    const snapshot = buildSnapshot({
      baseUrl: "http://127.0.0.1:42112",
      serverPort: 42112,
      pinnedDirectories: ["/tmp/manual-project"],
      panes: [],
      projects: [],
      sessions: [],
    })

    expect(snapshot.directories).toHaveLength(1)
    expect(snapshot.directories[0]).toMatchObject({
      directory: "/tmp/manual-project",
      pinned: true,
      label: "manual-project",
    })
    expect(snapshot.directories[0].sessions).toEqual([])
  })

  test("plain idle sessions do not get completion markers from recent updates alone", () => {
    const snapshot = buildSnapshot({
      baseUrl: "http://127.0.0.1:42112",
      serverPort: 42112,
      pinnedDirectories: [],
      panes: [],
      projects: [],
      sessions: [
        {
          id: "session_renamed",
          title: "Renamed session",
          directory: "/tmp/alpha",
          status: { type: "idle" },
          time: { created: 1, updated: Date.now() },
          project: null,
        },
      ],
    })

    expect(snapshot.directories[0].sessions[0].status).toEqual({ type: "idle" })
  })
})
