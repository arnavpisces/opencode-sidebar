import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { STATUS_MESSAGE_HOLD_MS, WINDOW_POLL_INTERVAL_MS } from "./lib/constants.js"
import { LauncherService } from "./lib/opencode.js"
import type { DirectoryRecord, SidebarRow, Snapshot } from "./lib/types.js"
import { isPrintable, relativeTime, truncate } from "./lib/util.js"

type Mode = "browse" | "search" | "pin"

const service = new LauncherService()

function rowKey(row: SidebarRow) {
  return row.key
}

function rowMatchesQuery(row: SidebarRow, query: string) {
  if (!query) return true
  const lower = query.toLowerCase()
  if (row.kind === "directory") {
    return (
      row.record.label.toLowerCase().includes(lower) ||
      row.record.directory.toLowerCase().includes(lower) ||
      row.record.subtitle.toLowerCase().includes(lower)
    )
  }
  return (
    row.session.title.toLowerCase().includes(lower) ||
    row.record.label.toLowerCase().includes(lower) ||
    row.record.directory.toLowerCase().includes(lower)
  )
}

function buildRows(snapshot: Snapshot | null, expanded: Record<string, boolean>, query: string): SidebarRow[] {
  if (!snapshot) return []
  const rows: SidebarRow[] = []
  for (const record of snapshot.directories) {
    const matchingSessions = query ? record.sessions.filter((session) => rowMatchesQuery({ key: session.id, kind: "session", record, session }, query)) : record.sessions
    const directoryMatches = rowMatchesQuery({ key: record.directory, kind: "directory", record }, query)
    if (!directoryMatches && matchingSessions.length === 0) continue

    rows.push({
      key: `dir:${record.directory}`,
      kind: "directory",
      record,
    })

    const showSessions = query ? true : expanded[record.directory] ?? record.pinned
    if (!showSessions) continue

    for (const session of matchingSessions) {
      rows.push({
        key: `session:${session.id}`,
        kind: "session",
        record,
        session,
      })
    }
  }
  return rows
}

function useNowTick() {
  const [value, setValue] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setValue(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return value
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function windowRows<T>(rows: T[], selectedIndex: number, limit: number) {
  if (limit <= 0) return [] as T[]
  if (rows.length <= limit) return rows
  const before = Math.floor(limit / 3)
  const start = clamp(selectedIndex - before, 0, Math.max(0, rows.length - limit))
  return rows.slice(start, start + limit)
}

function wrapText(input: string, width: number) {
  if (width <= 0) return [] as string[]
  const words = input.split(/\s+/).filter(Boolean)
  if (!words.length) return [""]
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    if (`${current} ${word}`.length <= width) {
      current += ` ${word}`
      continue
    }
    lines.push(current)
    current = word
  }
  if (current) lines.push(current)
  return lines
}

function sectionTitle(title: string) {
  return `--- ${title.toUpperCase()} ---`
}

function describeOpenResult(result: { backend?: string; action: "focused" | "opened"; windowID?: string }) {
  if (result.backend === "tmux") {
    return result.action === "focused" ? "Loaded selected session in preview" : "Opened tmux session"
  }
  if (result.backend === "current-terminal") return "Switching current terminal to OpenCode…"
  return result.action === "focused" ? `Focused existing ${result.backend} window` : `Opened new ${result.backend} window`
}

export function App() {
  const { exit } = useApp()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selectedKey, setSelectedKey] = useState<string>()
  const [mode, setMode] = useState<Mode>("browse")
  const [inputValue, setInputValue] = useState("")
  const [status, setStatus] = useState("Booting opencode server…")
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [stickyStatusUntil, setStickyStatusUntil] = useState(0)
  const width = process.stdout.columns ?? 100
  const height = process.stdout.rows ?? 24
  const now = useNowTick()
  const rows = useMemo(() => buildRows(snapshot, expanded, mode === "search" ? inputValue : ""), [expanded, inputValue, mode, snapshot])
  const selectedIndex = useMemo(() => {
    if (!rows.length) return 0
    if (!selectedKey) return 0
    const match = rows.findIndex((row) => rowKey(row) === selectedKey)
    return match >= 0 ? match : 0
  }, [rows, selectedKey])
  const selectedRow = rows[selectedIndex]

  const setTemporaryStatus = useCallback((message: string) => {
    setStatus(message)
    setStickyStatusUntil(Date.now() + STATUS_MESSAGE_HOLD_MS)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const next = await service.getSnapshot()
      setSnapshot(next)
      if (Date.now() > stickyStatusUntil) {
        setStatus(`Connected to ${next.baseUrl}  ·  backend: ${service.describeBackend()}`)
      }
      setExpanded((current) => {
        const updated = { ...current }
        for (const [index, record] of next.directories.entries()) {
          if (!(record.directory in updated)) {
            updated[record.directory] = record.pinned || index < 6
          }
        }
        return updated
      })
      setSelectedKey((current) => current ?? (next.directories[0] ? `dir:${next.directories[0].directory}` : undefined))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [stickyStatusUntil])

  useEffect(() => {
    const abort = new AbortController()
    void refresh()
    void service.subscribe(abort.signal, refresh)
    const timer = setInterval(() => {
      void refresh()
    }, WINDOW_POLL_INTERVAL_MS)
    return () => {
      abort.abort()
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (!rows.length && snapshot?.directories.length) {
      setSelectedKey(`dir:${snapshot.directories[0].directory}`)
    }
    if (!rows.length) return
    if (!selectedRow) {
      setSelectedKey(rowKey(rows[Math.min(selectedIndex, rows.length - 1)]))
    }
  }, [rows, selectedIndex, selectedRow, snapshot])

  const move = useCallback(
    (direction: number) => {
      if (!rows.length) return
      const next = (selectedIndex + direction + rows.length) % rows.length
      setSelectedKey(rowKey(rows[next]))
    },
    [rows, selectedIndex],
  )

  const toggleDirectory = useCallback((record: DirectoryRecord, next?: boolean) => {
    setExpanded((current) => ({
      ...current,
      [record.directory]: next ?? !current[record.directory],
    }))
  }, [])

  const commitInput = useCallback(async () => {
    const value = inputValue.trim()
    if (!value) {
      setMode("browse")
      setInputValue("")
      return
    }

    if (mode === "pin") {
      setBusy(`Adding ${value}…`)
      try {
        const directory = await service.pinDirectory(value)
        setTemporaryStatus(`Pinned ${directory}`)
        setMode("browse")
        setInputValue("")
        await refresh()
        setSelectedKey(`dir:${directory}`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(undefined)
      }
    }
  }, [inputValue, mode, refresh, setTemporaryStatus])

  const openSelection = useCallback(async () => {
    if (!selectedRow) return
    setBusy(selectedRow.kind === "session" ? `Opening ${selectedRow.session.title}…` : `Opening ${selectedRow.record.label}…`)
    try {
      const result =
        selectedRow.kind === "session"
          ? await service.openSession(selectedRow.record.directory, selectedRow.session)
          : await service.openDirectory(selectedRow.record)
      setTemporaryStatus(describeOpenResult(result))
      setMode("browse")
      setInputValue("")
      await refresh()
      setSelectedKey(`session:${result.sessionID}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  const openLatestOrCreate = useCallback(async () => {
    if (!selectedRow) return
    const record = selectedRow.record
    setBusy(`Opening ${record.label}…`)
    try {
      const result = record.sessions[0]
        ? await service.openSession(record.directory, record.sessions[0])
        : await service.openNewSession(record.directory)
      setTemporaryStatus(describeOpenResult(result))
      await refresh()
      setSelectedKey(`session:${result.sessionID}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  const unpinSelection = useCallback(async () => {
    if (!selectedRow || !selectedRow.record.pinned) return
    setBusy(`Removing ${selectedRow.record.label} from pins…`)
    try {
      await service.unpinDirectory(selectedRow.record.directory)
      setTemporaryStatus(`Unpinned ${selectedRow.record.directory}`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  const deleteSelection = useCallback(async () => {
    if (!selectedRow || selectedRow.kind !== "session") return
    setBusy(`Deleting ${selectedRow.session.title}…`)
    try {
      await service.deleteSession(selectedRow.record.directory, selectedRow.session.id)
      setTemporaryStatus(`Deleted session ${selectedRow.session.title}`)
      await refresh()
      setSelectedKey(`dir:${selectedRow.record.directory}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  useInput((input, key) => {
    if (busy) {
      if (input === "q" || key.escape) exit()
      return
    }

    if (mode === "search" || mode === "pin") {
      if (mode === "search") {
        if (key.upArrow) {
          move(-1)
          return
        }
        if (key.downArrow) {
          move(1)
          return
        }
      }
      if (key.escape) {
        if (mode === "search" && inputValue) {
          setInputValue("")
        } else {
          setMode("browse")
          setInputValue("")
          setTemporaryStatus("Ready")
        }
        return
      }
      if (key.return) {
        if (mode === "search") {
          void openSelection()
          return
        }
        void commitInput()
        return
      }
      if (key.backspace || key.delete) {
        setInputValue((current) => current.slice(0, -1))
        return
      }
      if (isPrintable(input)) {
        setInputValue((current) => current + input)
      }
      return
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      exit()
      return
    }
    if (input === "/") {
      setMode("search")
      setInputValue("")
      setTemporaryStatus("Type to filter projects and sessions")
      return
    }
    if (input === "a") {
      setMode("pin")
      setInputValue("")
      setTemporaryStatus("Enter an absolute or ~/ path to pin")
      return
    }
    if (input === "x") {
      void unpinSelection()
      return
    }
    if (input === "d") {
      void deleteSelection()
      return
    }
    if (input === "r") {
      void refresh()
      return
    }
    if (input === "n") {
      if (!selectedRow) return
      setBusy(`Creating a new session for ${selectedRow.record.label}…`)
      void (async () => {
        try {
          const result = await service.openNewSession(selectedRow.record.directory)
          setTemporaryStatus(describeOpenResult(result))
          await refresh()
          setSelectedKey(`session:${result.sessionID}`)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(undefined)
        }
      })()
      return
    }
    if (input === "o") {
      void openLatestOrCreate()
      return
    }
    if (input === " ") {
      if (selectedRow?.kind === "directory") toggleDirectory(selectedRow.record)
      return
    }
    if (key.return) {
      if (selectedRow?.kind === "directory") {
        void openSelection()
      } else {
        void openSelection()
      }
      return
    }
    if (key.upArrow) {
      move(-1)
      return
    }
    if (key.downArrow) {
      move(1)
      return
    }
    if (key.leftArrow && selectedRow?.kind === "directory") {
      toggleDirectory(selectedRow.record, false)
      return
    }
    if (key.rightArrow && selectedRow?.kind === "directory") {
      toggleDirectory(selectedRow.record, true)
    }
  }, { isActive: Boolean(process.stdin.isTTY) })

  const header = useMemo(() => {
    if (!snapshot) return "Booting OpenCode Sidebar"
    const activeCount = snapshot.activeSessions.length
    return `OpenCode Sidebar v0.1  ·  ${snapshot.directories.length} dirs  ·  ${activeCount} active`
  }, [snapshot])

  const detail = useMemo(() => {
    if (!selectedRow) return "No project selected"
    if (selectedRow.kind === "directory") {
      const active = selectedRow.record.activeSessionIDs.size
      return `${selectedRow.record.directory}  ·  ${selectedRow.record.sessions.length} session${selectedRow.record.sessions.length === 1 ? "" : "s"}${active ? `  ·  ${active} active` : ""}`
    }
    const active = selectedRow.record.activeSessionIDs.has(selectedRow.session.id)
    return `${selectedRow.record.directory}  ·  ${selectedRow.session.id}${active ? "  ·  active" : ""}`
  }, [selectedRow])

  const promptLabel = mode === "search" ? "Search" : mode === "pin" ? "Pin" : undefined
  const controlsLines = useMemo(() => {
    const compact = width < 40
    const text = compact
      ? "Enter load  n new  d delete  / search  Alt-b launcher"
      : "Enter recall/load  n new  d delete  / search  a pin  x unpin  Alt-b launcher  Alt-] preview"
    return wrapText(text, Math.max(8, width - 2))
  }, [width])
  const headerLines = useMemo(() => wrapText(status, Math.max(8, width - 2)), [status, width])
  const reservedLines = mode === "browse" ? 8 + controlsLines.length + Math.max(0, headerLines.length - 1) : 8
  const listHeightAdjusted = Math.max(6, height - reservedLines)
  const visibleRowsAdjusted = useMemo(() => windowRows(rows, selectedIndex, listHeightAdjusted), [listHeightAdjusted, rows, selectedIndex])
  const firstVisibleAdjusted = useMemo(() => {
    if (!visibleRowsAdjusted.length) return 0
    return rows.findIndex((row) => row.key === visibleRowsAdjusted[0]?.key)
  }, [rows, visibleRowsAdjusted])
  const footerHint = rows.length > visibleRowsAdjusted.length ? `${selectedIndex + 1}/${rows.length}  ·  ${detail}` : detail

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      <Text bold color="cyanBright">
        {truncate(header, width - 2)}
      </Text>
      <Text color="gray">{sectionTitle("Status")}</Text>
      {(error ? wrapText(error, Math.max(8, width - 2)) : busy ? wrapText(busy, Math.max(8, width - 2)) : headerLines).map((line, index) => (
        <Text key={`status-${index}`} color={error ? "redBright" : busy ? "yellowBright" : "gray"}>
          {truncate(line, width - 2)}
        </Text>
      ))}
      {promptLabel ? (
        <Text color="greenBright">
          {promptLabel}: {inputValue}
          <Text color="white">█</Text>
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text color="gray">{sectionTitle("Controls")}</Text>
          {controlsLines.map((line, index) => (
            <Text key={`control-${index}`} color="gray">
              {truncate(line, width - 2)}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">{sectionTitle("Projects")}</Text>
        {loading && !snapshot ? <Text color="yellow">Loading snapshot…</Text> : null}
        {!rows.length && !loading ? <Text color="gray">No projects yet. Press a to pin a directory.</Text> : null}
        {visibleRowsAdjusted.map((row, visibleIndex) => {
          const index = firstVisibleAdjusted + visibleIndex
          const selected = index === selectedIndex
          const isActiveSession = row.kind === "session" && row.record.activeSessionIDs.has(row.session.id)
          const isPreviewSession = row.kind === "session" && snapshot?.previewSessionID === row.session.id
          const foreground = selected ? "black" : row.kind === "directory" ? "cyanBright" : isActiveSession ? "greenBright" : isPreviewSession ? "yellowBright" : "white"
          const background = selected ? "green" : undefined
          const availableWidth = Math.max(18, width - 10)
          if (row.kind === "directory") {
            const expandedNow = mode === "search" ? true : expanded[row.record.directory] ?? row.record.pinned
            const marker = expandedNow ? "▾" : "▸"
            const activeCount = row.record.activeSessionIDs.size
            const hasPreview = row.record.sessions.some((session) => snapshot?.previewSessionID === session.id)
            const openMark = activeCount > 0 ? "◆" : hasPreview ? "▶" : row.record.openSessionIDs.size > 0 ? "●" : "○"
            const suffix = activeCount > 0 ? `${activeCount}/${row.record.sessions.length}` : String(row.record.sessions.length)
            return (
              <Box key={row.key} justifyContent="space-between">
                <Text color={foreground} backgroundColor={background} bold>
                  {truncate(`${marker} ${openMark} ${row.record.label}${row.record.pinned ? "  [pinned]" : ""}`, availableWidth)}
                </Text>
                <Text color={selected ? "black" : "gray"} backgroundColor={background}>
                  {suffix}
                </Text>
              </Box>
            )
          }

          const open = row.record.activeSessionIDs.has(row.session.id)
            ? "◆"
            : snapshot?.previewSessionID === row.session.id
              ? "▶"
              : row.record.openSessionIDs.has(row.session.id)
                ? "●"
                : "○"
          return (
            <Box key={row.key} justifyContent="space-between" marginLeft={2}>
              <Text color={foreground} backgroundColor={background}>
                {truncate(`${open} ${row.session.title || "New session"}`, availableWidth)}
              </Text>
              <Text color={selected ? "black" : "gray"} backgroundColor={background}>
                {relativeTime(row.session.time.updated, now)}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="gray">{truncate(footerHint, width - 6)}</Text>
      </Box>
    </Box>
  )
}
