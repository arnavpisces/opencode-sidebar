import type { SidebarRow } from "./types.js"

export const PROJECT_SESSION_LIMIT = 5
export type DisplayRow = SidebarRow | { kind: "overflow"; key: string; directory: string; count: number; above: boolean }
const bounded = (value: number, max: number) => Math.max(0, Math.min(value, max))

/** Keep navigation logical; overflow indicators are presentation-only rows. */
export function projectSessionWindows(rows: SidebarRow[], offsets: Record<string, number>, selectedKey?: string) {
  const display: DisplayRow[] = []
  const directories = new Set(rows.flatMap((row) => row.kind === "directory" ? [row.record.directory] : []))
  const nextOffsets = Object.fromEntries(Object.entries(offsets).filter(([directory]) => directories.has(directory)))
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (row.kind !== "session") {
      display.push(row)
      continue
    }
    const directory = row.record.directory
    const sessions: SidebarRow[] = []
    while (index < rows.length && rows[index]?.kind === "session" && (rows[index] as Extract<SidebarRow, { kind: "session" }>).record.directory === directory) {
      sessions.push(rows[index++]!)
    }
    index--
    let start = bounded(offsets[directory] ?? 0, sessions.length - PROJECT_SESSION_LIMIT)
    const selected = sessions.findIndex((session) => session.key === selectedKey)
    if (selected >= 0 && selected < start) start = selected
    if (selected >= start + PROJECT_SESSION_LIMIT) start = selected - PROJECT_SESSION_LIMIT + 1
    nextOffsets[directory] = start
    if (start) display.push({ kind: "overflow", key: `above:${directory}`, directory, count: start, above: true })
    display.push(...sessions.slice(start, start + PROJECT_SESSION_LIMIT))
    const remaining = sessions.length - start - PROJECT_SESSION_LIMIT
    if (remaining > 0) display.push({ kind: "overflow", key: `below:${directory}`, directory, count: remaining, above: false })
  }
  return { display, offsets: nextOffsets }
}

/** A wheel moves only the hovered project's window, preserving visible selection. */
export function scrollProjectWindow(rows: SidebarRow[], directory: string, start: number, delta: number, selectedKey?: string) {
  const sessions = rows.filter((row) => row.kind === "session" && row.record.directory === directory)
  const nextStart = bounded(start + delta, sessions.length - PROJECT_SESSION_LIMIT)
  const selected = sessions.findIndex((row) => row.key === selectedKey)
  const nextSelected = selected < 0 ? selectedKey : sessions[Math.max(nextStart, Math.min(selected, nextStart + PROJECT_SESSION_LIMIT - 1))]?.key
  return { start: nextStart, selectedKey: nextSelected }
}
