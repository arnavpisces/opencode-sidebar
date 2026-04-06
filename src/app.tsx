import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { STATUS_MESSAGE_HOLD_MS, WINDOW_POLL_INTERVAL_MS } from "./lib/constants.js"
import { LauncherService } from "./lib/opencode.js"
import type { DirectoryRecord, SidebarRow, Snapshot } from "./lib/types.js"
import { isPrintable, relativeTime, truncate } from "./lib/util.js"

type Mode = "browse" | "search" | "pin"
type DeleteTarget = {
  sessionID: string
  directory: string
  title: string
}

type BorderColor = React.ComponentProps<typeof Box>["borderColor"]
type TextColor = React.ComponentProps<typeof Text>["color"]

const service = new LauncherService()
const SPINNER_FRAMES = ["-", "\\", "|", "/"]
const LIVE_FRAMES = ["o", "O", "0", "O"]
const SELECT_FRAMES = [">", "}", "]", "}"]

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
    const matchingSessions = query
      ? record.sessions.filter((session) => rowMatchesQuery({ key: session.id, kind: "session", record, session }, query))
      : record.sessions
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

function useFrame(intervalMs: number) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setValue((current) => current + 1)
    }, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
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

function sectionRule(title: string, width: number) {
  const prefix = `--[ ${title} ]`
  if (prefix.length >= width) return truncate(prefix, width)
  return prefix + "-".repeat(width - prefix.length)
}

function metricLine(label: string, value: string, width: number) {
  return truncate(`${label.toUpperCase().padEnd(10)} ${value}`, width)
}

function snapshotHasKey(snapshot: Snapshot | null, key?: string) {
  if (!snapshot || !key) return false
  if (key.startsWith("dir:")) {
    return snapshot.directories.some((record) => record.directory === key.slice(4))
  }
  if (key.startsWith("session:")) {
    return snapshot.directories.some((record) => record.sessions.some((session) => session.id === key.slice(8)))
  }
  return false
}

function findSessionInSnapshot(snapshot: Snapshot | null, sessionID?: string) {
  if (!snapshot || !sessionID) return undefined
  for (const record of snapshot.directories) {
    const session = record.sessions.find((item) => item.id === sessionID)
    if (session) {
      return { record, session }
    }
  }
  return undefined
}

function describeOpenResult(result: { backend?: string; action: "focused" | "opened"; windowID?: string }) {
  if (result.backend === "tmux") {
    return result.action === "focused" ? "Loaded selected session in preview" : "Opened tmux session"
  }
  if (result.backend === "current-terminal") return "Switching current terminal to OpenCode..."
  return result.action === "focused" ? `Focused existing ${result.backend} window` : `Opened new ${result.backend} window`
}

function Panel(props: {
  title: string
  width: number
  borderColor?: BorderColor
  titleColor?: TextColor
  children?: React.ReactNode
}) {
  const { title, width, borderColor = "gray", titleColor = "cyanBright", children } = props
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={titleColor} bold>
        {truncate(title, width)}
      </Text>
      {children}
    </Box>
  )
}

export function App() {
  const { exit } = useApp()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selectedKey, setSelectedKey] = useState<string>()
  const [mode, setMode] = useState<Mode>("browse")
  const [inputValue, setInputValue] = useState("")
  const [status, setStatus] = useState("Booting opencode server...")
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>()
  const [stickyStatusUntil, setStickyStatusUntil] = useState(0)
  const width = process.stdout.columns ?? 100
  const height = process.stdout.rows ?? 24
  const now = useNowTick()
  const frame = useFrame(160)
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
  const liveGlyph = LIVE_FRAMES[frame % LIVE_FRAMES.length]
  const selectGlyph = SELECT_FRAMES[frame % SELECT_FRAMES.length]
  const inputCursor = frame % 2 === 0 ? "_" : " "
  const compactLayout = width < 44 || height < 28
  const panelGap = compactLayout ? 0 : 1
  const showBanner = !compactLayout
  const panelTextWidth = Math.max(18, width - 8)
  const rows = useMemo(() => buildRows(snapshot, expanded, mode === "search" ? inputValue : ""), [expanded, inputValue, mode, snapshot])
  const selectedIndex = useMemo(() => {
    if (!rows.length) return 0
    if (!selectedKey) return 0
    const match = rows.findIndex((row) => rowKey(row) === selectedKey)
    return match >= 0 ? match : 0
  }, [rows, selectedKey])
  const selectedRow = rows[selectedIndex]
  const previewSession = useMemo(() => findSessionInSnapshot(snapshot, snapshot?.previewSessionID), [snapshot])

  const setTemporaryStatus = useCallback((message: string) => {
    setStatus(message)
    setStickyStatusUntil(Date.now() + STATUS_MESSAGE_HOLD_MS)
  }, [])

  const refresh = useCallback(
    async (preferredSelectedKey?: string) => {
      setLoading(true)
      setError(undefined)
      try {
        const next = await service.getSnapshot()
        setSnapshot(next)
        if (Date.now() > stickyStatusUntil) {
          setStatus(`Connected to ${next.baseUrl} [${service.describeBackend()}]`)
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
        setSelectedKey((current) => {
          if (preferredSelectedKey && snapshotHasKey(next, preferredSelectedKey)) return preferredSelectedKey
          if (current && snapshotHasKey(next, current)) return current
          return next.directories[0] ? `dir:${next.directories[0].directory}` : undefined
        })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    [stickyStatusUntil],
  )

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
    if (!deleteTarget) return
    if (snapshotHasKey(snapshot, `session:${deleteTarget.sessionID}`)) return
    setDeleteTarget(undefined)
    setTemporaryStatus("Selected session is already gone")
  }, [deleteTarget, setTemporaryStatus, snapshot])

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
      setBusy(`Adding ${value}...`)
      try {
        const directory = await service.pinDirectory(value)
        setTemporaryStatus(`Pinned ${directory}`)
        setMode("browse")
        setInputValue("")
        await refresh(`dir:${directory}`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(undefined)
      }
    }
  }, [inputValue, mode, refresh, setTemporaryStatus])

  const openSelection = useCallback(async () => {
    if (!selectedRow) return
    setBusy(selectedRow.kind === "session" ? `Opening ${selectedRow.session.title || "New session"}...` : `Opening ${selectedRow.record.label}...`)
    try {
      const result =
        selectedRow.kind === "session"
          ? await service.openSession(selectedRow.record.directory, selectedRow.session)
          : await service.openDirectory(selectedRow.record)
      setTemporaryStatus(describeOpenResult(result))
      setMode("browse")
      setInputValue("")
      await refresh(`session:${result.sessionID}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  const openLatestOrCreate = useCallback(async () => {
    if (!selectedRow) return
    const record = selectedRow.record
    setBusy(`Opening ${record.label}...`)
    try {
      const result = record.sessions[0]
        ? await service.openSession(record.directory, record.sessions[0])
        : await service.openNewSession(record.directory)
      setTemporaryStatus(describeOpenResult(result))
      await refresh(`session:${result.sessionID}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  const createNewSession = useCallback(async () => {
    if (!selectedRow) return
    setBusy(`Creating a new session for ${selectedRow.record.label}...`)
    try {
      const result = await service.openNewSession(selectedRow.record.directory)
      setTemporaryStatus(describeOpenResult(result))
      await refresh(`session:${result.sessionID}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  const unpinSelection = useCallback(async () => {
    if (!selectedRow || !selectedRow.record.pinned) return
    setBusy(`Removing ${selectedRow.record.label} from pins...`)
    try {
      await service.unpinDirectory(selectedRow.record.directory)
      setTemporaryStatus(`Unpinned ${selectedRow.record.directory}`)
      await refresh(rowKey(selectedRow))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [refresh, selectedRow, setTemporaryStatus])

  const requestDeleteSelection = useCallback(() => {
    if (!selectedRow || selectedRow.kind !== "session") {
      setTemporaryStatus("Select a session to delete")
      return
    }
    setDeleteTarget({
      sessionID: selectedRow.session.id,
      directory: selectedRow.record.directory,
      title: selectedRow.session.title || "New session",
    })
  }, [selectedRow, setTemporaryStatus])

  const confirmDeleteSelection = useCallback(async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(undefined)
    setSelectedKey(`dir:${target.directory}`)
    setBusy(`Deleting ${target.title}...`)
    try {
      await service.deleteSession(target.directory, target.sessionID)
      setTemporaryStatus(`Deleted session ${target.title}`)
      await refresh(`dir:${target.directory}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [deleteTarget, refresh, setTemporaryStatus])

  const cancelDeleteSelection = useCallback(() => {
    if (!deleteTarget) return
    setDeleteTarget(undefined)
    setTemporaryStatus("Delete cancelled")
  }, [deleteTarget, setTemporaryStatus])

  useInput(
    (input, key) => {
      const loweredInput = input.toLowerCase()

      if (deleteTarget) {
        if (key.escape || loweredInput === "n") {
          cancelDeleteSelection()
          return
        }
        if (key.return || loweredInput === "y") {
          void confirmDeleteSelection()
        }
        return
      }

      if (busy) {
        if (input === "q" || (key.ctrl && input === "c")) exit()
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
        requestDeleteSelection()
        return
      }
      if (input === "r") {
        void refresh()
        return
      }
      if (input === "n") {
        void createNewSession()
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
        void openSelection()
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
    },
    { isActive: Boolean(process.stdin.isTTY) },
  )

  const directoryCount = snapshot?.directories.length ?? 0
  const sessionCount = snapshot?.directories.reduce((count, record) => count + record.sessions.length, 0) ?? 0
  const activeCount = snapshot?.activeSessions.length ?? 0

  const detail = useMemo(() => {
    if (!selectedRow) return "No project selected"
    if (selectedRow.kind === "directory") {
      const active = selectedRow.record.activeSessionIDs.size
      return `${selectedRow.record.sessions.length} sessions${active ? ` | ${active} live` : ""}`
    }
    const active = selectedRow.record.activeSessionIDs.has(selectedRow.session.id)
    return `${selectedRow.session.id}${active ? " | live" : ""}`
  }, [selectedRow])

  const previewLabel = useMemo(() => {
    if (!previewSession) return "idle"
    const label = previewSession.session.title || previewSession.record.label
    return truncate(label, compactLayout ? 18 : Math.max(18, panelTextWidth - 16))
  }, [compactLayout, panelTextWidth, previewSession])

  const bannerTitle = compactLayout ? `:: OPENCODE SIDEBAR :: [${spinner}]` : `:: OPENCODE SIDEBAR v0.1 :: [SYNC ${spinner}]`
  const statusTitle = compactLayout ? `:: OPENCODE SIDEBAR :: [${spinner}]` : `STATUS / MATRIX [${liveGlyph}]`
  const showToolsPanel = !compactLayout || !deleteTarget
  const apiState = snapshot ? "CONNECTED" : error ? "DEGRADED" : "BOOTING"
  const statusLines = compactLayout
    ? [
        metricLine("api", `[${apiState}]`, panelTextWidth),
        metricLine("preview", `[${previewLabel}]`, panelTextWidth),
        metricLine("workspace", `[${directoryCount} D | ${sessionCount} S | ${activeCount} LIVE]`, panelTextWidth),
      ]
    : [
        metricLine("api", `[${apiState}]`, panelTextWidth),
        metricLine("backend", `[${service.describeBackend().toUpperCase()}]`, panelTextWidth),
        metricLine("preview", `[${previewLabel}]`, panelTextWidth),
        metricLine("workspace", `[${directoryCount} D | ${sessionCount} S | ${activeCount} LIVE]`, panelTextWidth),
      ]
  const statusMessageText = error ? `STATE      ERROR :: ${error}` : busy ? `STATE      WORK :: ${busy} [${spinner}]` : `STATE      LINK :: ${status}`
  const statusMessageLines = wrapText(statusMessageText, panelTextWidth).slice(0, compactLayout ? 1 : 2)
  const toolsLines = wrapText(
    compactLayout
      ? "[ENT] LOAD  [N] NEW  [D] DEL  [/] FIND  [A] PIN"
      : "[ENT] LOAD  [N] NEW  [D] DEL  [/] FIND  [A] PIN  [X] UNPIN  [SPC] EXPAND  [R] REFRESH  [Q] QUIT  [ALT-B] LAUNCH  [ALT-]] PREVIEW",
    panelTextWidth,
  ).slice(0, compactLayout ? 1 : 3)
  const promptPrimary = mode === "search"
    ? `/ ${truncate(inputValue, Math.max(0, panelTextWidth - 4))}${inputCursor}`
    : mode === "pin"
      ? `+ ${truncate(inputValue, Math.max(0, panelTextWidth - 4))}${inputCursor}`
      : truncate(selectedRow?.record.directory ?? "No project selected", panelTextWidth)
  const promptDetail = mode === "search" || mode === "pin"
    ? ["[Enter] submit  [Esc] cancel"]
    : wrapText(rows.length > 0 ? `${selectedIndex + 1}/${rows.length}  ${detail}` : `FOCUS ${detail}`, panelTextWidth).slice(0, compactLayout ? 1 : 2)
  const deleteLines = deleteTarget
    ? [
        `Delete session \"${truncate(deleteTarget.title, Math.max(8, panelTextWidth - 18))}\"?`,
        truncate(deleteTarget.directory, panelTextWidth),
        "[Enter/Y] confirm  [Esc/N] cancel",
      ]
    : []
  const projectHeader = sectionRule(rows.length ? `PROJECT MATRIX ${selectedIndex + 1}/${rows.length}` : "PROJECT MATRIX", panelTextWidth)
  const projectFooter = rows.length > 0 ? truncate(`FOCUS :: ${selectedIndex + 1}/${rows.length} :: ${detail}`, panelTextWidth) : truncate(`FOCUS :: ${detail}`, panelTextWidth)

  const projectPanelStaticHeight = 2 + (loading && !snapshot ? 1 : 0) + (!rows.length && !loading ? 1 : 0)
  const fixedHeight =
    (showBanner ? 3 + panelGap : 0) +
    (3 + statusLines.length + statusMessageLines.length + panelGap) +
    (deleteTarget ? 3 + deleteLines.length + panelGap : 0) +
    (showToolsPanel ? 3 + toolsLines.length + panelGap : 0) +
    (3 + promptDetail.length + panelGap) +
    projectPanelStaticHeight
  const visibleRowCount = Math.max(1, height - fixedHeight)
  const visibleRows = useMemo(() => windowRows(rows, selectedIndex, visibleRowCount), [rows, selectedIndex, visibleRowCount])
  const firstVisibleIndex = useMemo(() => {
    if (!visibleRows.length) return 0
    return rows.findIndex((row) => row.key === visibleRows[0]?.key)
  }, [rows, visibleRows])

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      {showBanner ? <Panel title={bannerTitle} width={panelTextWidth} borderColor="cyan" titleColor="cyanBright" /> : null}

      <Box marginTop={panelGap}>
        <Panel title={statusTitle} width={panelTextWidth}>
          {statusLines.map((line, index) => (
            <Text key={`status-line-${index}`} color="white">
              {truncate(line, panelTextWidth)}
            </Text>
          ))}
          {statusMessageLines.map((line, index) => (
            <Text key={`status-message-${index}`} color={error ? "redBright" : busy ? "yellowBright" : "gray"}>
              {truncate(line, panelTextWidth)}
            </Text>
          ))}
        </Panel>
      </Box>

      {deleteTarget ? (
        <Box marginTop={panelGap}>
          <Panel title="DELETE / ARM / CONFIRM" width={panelTextWidth} borderColor="redBright" titleColor="redBright">
            {deleteLines.map((line, index) => (
              <Text key={`delete-${index}`} color={index === 2 ? "yellowBright" : "white"}>
                {truncate(line, panelTextWidth)}
              </Text>
            ))}
          </Panel>
        </Box>
      ) : null}

      <Box marginTop={panelGap} flexDirection="column">
        <Text color="gray">{projectHeader}</Text>
        {loading && !snapshot ? <Text color="yellowBright">SYNC :: workspace...</Text> : null}
        {!rows.length && !loading ? <Text color="gray">No projects yet. Press A to pin a directory.</Text> : null}
        {visibleRows.map((row, visibleIndex) => {
          const index = firstVisibleIndex + visibleIndex
          const selected = index === selectedIndex
          const selectedForeground: TextColor = selected ? "black" : undefined
          const selectedBackground = selected ? "cyan" : undefined
          const rowWidth = panelTextWidth

          if (row.kind === "directory") {
            const expandedNow = mode === "search" ? true : expanded[row.record.directory] ?? row.record.pinned
            const activeDirectoryCount = row.record.activeSessionIDs.size
            const hasPreview = row.record.sessions.some((session) => snapshot?.previewSessionID === session.id)
            const stateBadge = activeDirectoryCount > 0 ? `[${liveGlyph}]` : hasPreview ? `[>]` : row.record.openSessionIDs.size > 0 ? `[+]` : `[.]`
            const pinBadge = row.record.pinned ? "[P]" : "[ ]"
            const suffix = activeDirectoryCount > 0 ? `[${activeDirectoryCount}/${row.record.sessions.length}]` : `[${row.record.sessions.length}]`
            const label = `${selected ? `[${selectGlyph}]` : "[ ]"} ${expandedNow ? "v" : ">"} ${pinBadge}${stateBadge} ${row.record.label}`
            const availableWidth = Math.max(8, rowWidth - suffix.length - 1)
            return (
              <Box key={row.key} width={rowWidth} justifyContent="space-between">
                <Text color={selected ? selectedForeground : "cyanBright"} backgroundColor={selectedBackground} bold>
                  {truncate(label, availableWidth)}
                </Text>
                <Text color={selected ? selectedForeground : "gray"} backgroundColor={selectedBackground}>
                  {suffix}
                </Text>
              </Box>
            )
          }

          const isActive = row.record.activeSessionIDs.has(row.session.id)
          const isPreview = snapshot?.previewSessionID === row.session.id
          const sessionBadge = isActive ? `[${liveGlyph}]` : isPreview ? `[>]` : row.record.openSessionIDs.has(row.session.id) ? `[+]` : `[.]`
          const label = `${selected ? `[${selectGlyph}]` : " | "}-- ${sessionBadge} ${row.session.title || "New session"}`
          const suffix = `[${relativeTime(row.session.time.updated, now)}]`
          const availableWidth = Math.max(8, rowWidth - suffix.length - 1)
          const color: TextColor = selected ? selectedForeground : isActive ? "greenBright" : isPreview ? "magentaBright" : "white"
          return (
            <Box key={row.key} width={rowWidth} justifyContent="space-between">
              <Text color={color} backgroundColor={selectedBackground}>
                {truncate(label, availableWidth)}
              </Text>
              <Text color={selected ? selectedForeground : "gray"} backgroundColor={selectedBackground}>
                {suffix}
              </Text>
            </Box>
          )
        })}
        <Text color="gray">{projectFooter}</Text>
      </Box>

      {showToolsPanel ? (
        <Box marginTop={panelGap}>
          <Panel title="TOOLS / MODES" width={panelTextWidth}>
            {toolsLines.map((line, index) => (
              <Text key={`tool-${index}`} color="gray">
                {truncate(line, panelTextWidth)}
              </Text>
            ))}
          </Panel>
        </Box>
      ) : null}

      <Box marginTop={panelGap} borderStyle="single" borderColor={mode === "browse" ? "gray" : "greenBright"} flexDirection="column" paddingX={1}>
        <Text color={mode === "browse" ? "white" : "greenBright"}>{truncate(promptPrimary, panelTextWidth)}</Text>
        {promptDetail.map((line, index) => (
          <Text key={`prompt-${index}`} color="gray">
            {truncate(line, panelTextWidth)}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
