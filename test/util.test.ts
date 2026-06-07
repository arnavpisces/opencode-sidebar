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

  test("scroll delta clamps at list boundaries", () => {
    const clamp = (idx: number, delta: number, len: number) => Math.max(0, Math.min(idx + delta, len - 1))

    expect(clamp(0, -5, 10)).toBe(0)
    expect(clamp(0, 0, 10)).toBe(0)
    expect(clamp(0, 3, 10)).toBe(3)

    expect(clamp(9, 2, 10)).toBe(9)
    expect(clamp(9, 0, 10)).toBe(9)
    expect(clamp(9, -3, 10)).toBe(6)

    expect(clamp(0, -1, 1)).toBe(0)
    expect(clamp(0, 1, 1)).toBe(0)

    expect(clamp(5, 20, 10)).toBe(9)
    expect(clamp(5, -20, 10)).toBe(0)
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
