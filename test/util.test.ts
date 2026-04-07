import { describe, expect, test } from "bun:test"
import { relativeTime, sessionWorkspace, sessionWindowTitle, truncate, wrapTextHard } from "../src/lib/util.js"

describe("util helpers", () => {
  test("relativeTime uses compact units", () => {
    expect(relativeTime(0, 59_000)).toBe("now")
    expect(relativeTime(0, 5 * 60_000)).toBe("5m")
    expect(relativeTime(0, 2 * 60 * 60_000)).toBe("2h")
  })

  test("session workspace is deterministic", () => {
    expect(sessionWorkspace("session_123")).toBe("opencode-session-session_123")
  })

  test("session window title is readable", () => {
    expect(sessionWindowTitle("/tmp/project", "Build the sidebar")).toContain("project")
    expect(sessionWindowTitle("/tmp/project", "Build the sidebar")).toContain("Build the sidebar")
  })

  test("truncate adds ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…")
  })

  test("wrapTextHard wraps long tokens without dropping content", () => {
    expect(wrapTextHard("/Users/arnavpisces/Desktop/Personal/really-long-folder-name", 12)).toEqual([
      "/Users/arnav",
      "pisces/Deskt",
      "op/Personal/",
      "really-long-",
      "folder-name",
    ])
  })
})
