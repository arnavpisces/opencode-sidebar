import { describe, expect, test } from "bun:test"
import { trimBackgroundSessions } from "../src/lib/tmux.js"

describe("trimBackgroundSessions", () => {
  test("drops oldest inactive windows beyond the retention cap", () => {
    const victims = trimBackgroundSessions(
      [
        {
          sessionID: "active_one",
          paneID: "%1",
          windowID: "@9",
          windowName: "active",
          directory: "/tmp/a",
          title: "A",
          active: true,
        },
        {
          sessionID: "oldest",
          paneID: "%2",
          windowID: "@3",
          windowName: "oldest",
          directory: "/tmp/b",
          title: "B",
          active: false,
        },
        {
          sessionID: "middle",
          paneID: "%3",
          windowID: "@5",
          windowName: "middle",
          directory: "/tmp/c",
          title: "C",
          active: false,
        },
        {
          sessionID: "newest",
          paneID: "%4",
          windowID: "@8",
          windowName: "newest",
          directory: "/tmp/d",
          title: "D",
          active: false,
        },
      ],
      2,
    )

    expect(victims.map((item) => item.sessionID)).toEqual(["oldest"])
  })

  test("never trims active windows", () => {
    const victims = trimBackgroundSessions(
      [
        {
          sessionID: "active_one",
          paneID: "%1",
          windowID: "@1",
          windowName: "active",
          directory: "/tmp/a",
          title: "A",
          active: true,
        },
      ],
      0,
    )

    expect(victims).toEqual([])
  })

  test("preserves owner metadata on active session records", () => {
    const victims = trimBackgroundSessions(
      [
        {
          sessionID: "owned_session",
          paneID: "%1",
          windowID: "@2",
          windowName: "owned",
          directory: "/tmp/a",
          title: "A",
          active: false,
          ownerID: "sidebar-1",
        },
      ],
      0,
    )

    expect(victims[0]?.ownerID).toBe("sidebar-1")
  })
})
