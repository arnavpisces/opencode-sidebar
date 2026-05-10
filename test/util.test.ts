import { describe, expect, test } from "bun:test"
import {
  deleteTextInputValue,
  isMouseEscapeInput,
  parseSgrMouseInput,
  relativeTime,
  sessionWorkspace,
  sessionWindowTitle,
  truncate,
  wrapTextHard,
} from "../src/lib/util.js"

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

  test("deleteTextInputValue clears the whole input for option-delete and shift-delete", () => {
    expect(deleteTextInputValue("Rename me", { meta: true, delete: true })).toBe("")
    expect(deleteTextInputValue("/tmp/project", { meta: true, backspace: true })).toBe("")
    expect(deleteTextInputValue("Rename me", { shift: true, delete: true })).toBe("")
    expect(deleteTextInputValue("Rename me", { backspace: true })).toBe("Rename m")
  })

  test("mouse helpers recognize and parse sgr mouse input", () => {
    const input = "\u001b[<0;12;18M\u001b[<0;12;18m"
    expect(isMouseEscapeInput(input)).toBe(true)
    expect(parseSgrMouseInput(input)).toEqual([
      { code: 0, x: 12, y: 18, release: false },
      { code: 0, x: 12, y: 18, release: true },
    ])
  })
})
