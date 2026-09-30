import { describe, expect, test } from "bun:test"
import type { DirectoryRecord, SidebarRow } from "../src/lib/types.js"
import { projectSessionWindows, scrollProjectWindow } from "../src/lib/sidebar-window.js"

function project(directory: string, count: number): SidebarRow[] {
  const record = { directory } as DirectoryRecord
  return [{ kind: "directory", key: `dir:${directory}`, record }, ...Array.from({ length: count }, (_, index) => ({
    kind: "session" as const, key: `session:${directory}-${index}`, record, session: { id: `${directory}-${index}` } as DirectoryRecord["sessions"][number],
  }))]
}
const sessionKeys = (rows: ReturnType<typeof projectSessionWindows>["display"]) => rows.filter((row) => row.kind === "session").map((row) => row.key)

describe("project session windows", () => {
  test("caps display at five without dropping logical rows and reveals every selection", () => {
    const rows = project("a", 9)
    let offsets = {}
    for (let index = 0; index < 9; index++) {
      const key = `session:a-${index}`
      const result = projectSessionWindows(rows, offsets, key)
      expect(sessionKeys(result.display)).toHaveLength(5)
      expect(sessionKeys(result.display)).toContain(key)
      offsets = result.offsets
    }
    expect(rows).toHaveLength(10)
    const result = projectSessionWindows(rows, {}, "session:a-6")
    expect(result.offsets.a).toBe(2)
    expect(result.display.filter((row) => row.kind === "overflow")).toEqual([
      { kind: "overflow", key: "above:a", directory: "a", count: 2, above: true },
      { kind: "overflow", key: "below:a", directory: "a", count: 2, above: false },
    ])
  })
  test("preserves independent project windows when selection leaves a project", () => {
    const result = projectSessionWindows([...project("a", 9), ...project("b", 9)], { a: 3, b: 2 }, "session:b-4")
    expect(result.offsets).toEqual({ a: 3, b: 2 })
    expect(sessionKeys(result.display)).toContain("session:a-3")
    expect(sessionKeys(result.display)).not.toContain("session:a-0")
  })
  test("clamps filtered or removed sessions and prunes removed projects", () => {
    const result = projectSessionWindows(project("a", 3), { a: 4, removed: 8 }, "session:a-2")
    expect(result.offsets).toEqual({ a: 0 })
    expect(sessionKeys(result.display)).toHaveLength(3)
    expect(result.display.some((row) => row.kind === "overflow")).toBe(false)
    const collapsed = projectSessionWindows(project("a", 0), { a: 3 })
    expect(collapsed.offsets.a).toBe(3)
  })
  test("wheel clamps to project boundaries and keeps its selection visible", () => {
    const rows = [...project("a", 9), ...project("b", 9)]
    expect(scrollProjectWindow(rows, "a", 4, 1, "session:a-8")).toEqual({ start: 4, selectedKey: "session:a-8" })
    expect(scrollProjectWindow(rows, "a", 2, -1, "session:a-6")).toEqual({ start: 1, selectedKey: "session:a-5" })
    expect(scrollProjectWindow(rows, "a", 0, -1, "session:b-4")).toEqual({ start: 0, selectedKey: "session:b-4" })
    expect(scrollProjectWindow(rows, "a", 0, 2, "session:a-0")).toEqual({ start: 2, selectedKey: "session:a-2" })
  })
})
