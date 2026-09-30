import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink"
import { projectSessionWindows, scrollProjectWindow, type DisplayRow } from "./lib/sidebar-window.js"
import { STATUS_MESSAGE_HOLD_MS, WINDOW_POLL_INTERVAL_MS } from "./lib/constants.js"
import { LauncherService } from "./lib/opencode.js"
import { getSidebarLayoutState, isTmux, SIDEBAR_TOGGLE_SHORTCUT, toggleSidebarLayout } from "./lib/tmux.js"
import { resetTerminalBackground, writeTerminalBackground } from "./lib/terminal-theme.js"
import { DEFAULT_THEME_ID, getThemeScheme, THEMES, type ThemeScheme } from "./lib/themes.js"
import type { DirectoryRecord, SidebarRow, Snapshot } from "./lib/types.js"
import {
  deleteTextInputValue,
  isMouseEscapeInput,
  isPrintable,
  parseSgrMouseInput,
  relativeTime,
  sanitizePastedText,
  truncate,
  wrapTextHard,
} from "./lib/util.js"

type Mode = "browse" | "search" | "add-project" | "rename-session" | "theme"
type DeleteTarget = {
  sessionID: string
  directory: string
  title: string
}

type KillTarget = {
  sessionID: string
  directory: string
  title: string
}

type RenameTarget = {
  sessionID: string
  directory: string
  title: string
}

type HideTarget = {
  directory: string
  label: string
}

type AddProjectOption = {
  directory: string
  label: string
  subtitle: string
  pinned: boolean
}

type MousePressTarget =
  | {
      kind: "toggle"
      key: string
    }
  | {
      kind: "row"
      key: string
    }

type ModalLineEntry = {
  palette?: ThemeScheme
  line: string
  color?: TextColor
  backgroundColor?: TextColor
}

type TextColor = React.ComponentProps<typeof Text>["color"]

const SPINNER_FRAMES = ["-", "\\", "|", "/"]
const LIVE_FRAMES = ["o", "O", "0", "O"]
const ADD_PROJECT_KEY = "action:add-project"
const SAD_FACE = "(◕︵◕)"
const UNWELL_FACE = "(@_@)"
const RUNNING_FACES = ["(•̀ᴗ•́)", "(ง'̀-'́)ง", "(•̀ㅂ•́)و"]
const IDLE_FACES = ["(◕ᴥ◕)", "(◕ᴗ◕)", "(•ᴗ•)"]
const SLEEP_FACES = ["(-ᴥ-)", "(-_-) zZ", "(˘▾˘)~"]

function rowKey(row: SidebarRow) {
  return row.key
}

function rowMatchesQuery(row: SidebarRow, query: string) {
  if (!query) return true
  const lower = query.toLowerCase()
  if (row.kind === "action") {
    return row.label.toLowerCase().includes(lower) || row.detail.toLowerCase().includes(lower)
  }
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

function addProjectOptionMatches(option: AddProjectOption, query: string) {
  if (!query) return true
  const lower = query.toLowerCase()
  return (
    option.label.toLowerCase().includes(lower) ||
    option.directory.toLowerCase().includes(lower) ||
    option.subtitle.toLowerCase().includes(lower)
  )
}

function optionDisplay(option: AddProjectOption) {
  return `${option.directory}${option.pinned ? " [PINNED]" : ""}`
}

const ADD_PROJECT_ROW: SidebarRow = {
  key: ADD_PROJECT_KEY,
  kind: "action",
  action: "add-project",
  label: "Add project folder",
  detail: "Autocomplete directories or enter a path",
} as const

function buildRows(snapshot: Snapshot | null, expanded: Record<string, boolean>, query: string): SidebarRow[] {
  const rows: SidebarRow[] = []

  if (rowMatchesQuery(ADD_PROJECT_ROW, query)) {
    rows.push(ADD_PROJECT_ROW)
  }

  if (!snapshot) return rows
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
    const timer = setInterval(() => setValue(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return value
}

function useFrame(intervalMs: number, active: boolean) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setValue((current) => current + 1)
    }, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, active])
  return active ? value : 0
}

function useTerminalSize() {
  const { stdout } = useStdout()
  const [size, setSize] = useState(() => ({
    width: stdout?.columns ?? 100,
    height: stdout?.rows ?? 24,
  }))

  useEffect(() => {
    if (!stdout) return

    const update = () => {
      setSize({
        width: stdout.columns ?? 100,
        height: stdout.rows ?? 24,
      })
    }

    update()
    stdout.on("resize", update)
    return () => {
      stdout.off("resize", update)
    }
  }, [stdout])

  return size
}

function minimumWidth(value: number) {
  return Math.max(1, value)
}

function fitLine(input: string, width: number) {
  return truncate(input, width).padEnd(width, " ")
}

function packHints(items: string[], width: number) {
  const lines: string[] = []
  let line = ""
  for (const item of items) {
    const next = line ? `${line} · ${item}` : item
    if (next.length > width && line) {
      lines.push(line)
      line = truncate(item, width)
    } else line = truncate(next, width)
  }
  if (line) lines.push(line)
  return lines
}

function dropdownOptionLines(marker: string, label: string, width: number) {
  const gutter = `${marker} `
  const contentWidth = minimumWidth(width - gutter.length)
  return wrapTextHard(label, contentWidth).map((line, index) => `${index === 0 ? gutter : " ".repeat(gutter.length)}${line}`)
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function windowRows<T>(rows: T[], selectedIndex: number, limit: number) {
  if (limit <= 0) return [] as T[]
  if (rows.length <= limit) return rows
  const before = Math.floor(limit / 2)
  const start = clamp(selectedIndex - before, 0, Math.max(0, rows.length - limit))
  return rows.slice(start, start + limit)
}

function sessionJustCompleted(status?: Snapshot["directories"][number]["sessions"][number]["status"]) {
  return status?.type === "idle" && status.justCompleted === true
}

function sessionIsWorking(status?: Snapshot["directories"][number]["sessions"][number]["status"]) {
  return status?.type === "busy" || status?.type === "retry"
}

function snapshotHasKey(snapshot: Snapshot | null, key?: string) {
  if (!key) return false
  if (key.startsWith("action:")) return key === ADD_PROJECT_KEY
  if (!snapshot) return false
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

function mascotTitle(input: {
  compact: boolean
  width: number
  frame: number
  busy: boolean
  activeCount: number
  recentlyActive: boolean
  error?: string
  mode: Mode
  theme: ThemeScheme
}) {
  const attentionNeeded = Boolean(input.error) || input.mode === "add-project" || input.mode === "theme"
  const face = input.error
    ? UNWELL_FACE
    : attentionNeeded
      ? SAD_FACE
      : input.busy
        ? RUNNING_FACES[input.frame % RUNNING_FACES.length]
        : input.recentlyActive || input.activeCount > 0
          ? IDLE_FACES[input.frame % IDLE_FACES.length]
          : SLEEP_FACES[input.frame % SLEEP_FACES.length]

  const mood = input.error
    ? "Not feeling great"
    : attentionNeeded
      ? input.mode === "theme"
        ? "Picking a palette"
        : "Needs attention"
      : input.busy
        ? "Locked in"
        : input.recentlyActive || input.activeCount > 0
          ? "On watch"
          : "Sleeping"

  return `OPENCODE SIDEBAR ${face} ${mood}`
}

function AnimatedSpinner({ active, frame }: { active: boolean; frame: number }) {
  if (!active) return null
  return <Text>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
}

function BlinkingCursor({ frame }: { frame: number }) {
  return <Text>{frame % 2 === 0 ? "_" : " "}</Text>
}

function MascotBanner(props: {
  compact: boolean
  width: number
  busy: boolean
  activeCount: number
  recentlyActive: boolean
  error?: string
  mode: Mode
  theme: ThemeScheme
  frame: number
}) {
  const title = mascotTitle(props)
  return <Text color={props.theme.semantic.highlight} bold wrap="truncate-end">{title}</Text>
}

function KeyHints({ line, theme }: { line: string; theme: ThemeScheme }) {
  return <Text>{line.split(/(\[[^\]]+\])/g).map((part, index) => <Text key={index} color={part.startsWith("[") ? theme.semantic.info : theme.semantic.muted}>{part}</Text>)}</Text>
}

// Ink's native border renderer resets backgrounds on edge cells. Paint each
// frame cell as Text so corners, sides, and interior share the theme background.
function Frame({ width, theme, children }: { width: number; theme: ThemeScheme; children: React.ReactNode }) {
  const innerWidth = Math.max(0, width - 2)
  return <Box width={width} flexDirection="column" backgroundColor={theme.base.background}>
    <Text color={theme.semantic.border} backgroundColor={theme.base.background}>{`┌${"─".repeat(innerWidth)}┐`}</Text>
    {React.Children.toArray(children).map((child, index) => <Box key={index} width={width} height={1} backgroundColor={theme.base.background}>
      <Text color={theme.semantic.border} backgroundColor={theme.base.background}>│</Text>
      <Box width={innerWidth} flexShrink={0} backgroundColor={theme.base.background}>{child}</Box>
      <Text color={theme.semantic.border} backgroundColor={theme.base.background}>│</Text>
    </Box>)}
    <Text color={theme.semantic.border} backgroundColor={theme.base.background}>{`└${"─".repeat(innerWidth)}┘`}</Text>
  </Box>
}

function Panel(props: {
  title: string
  width: number
  titleColor?: TextColor
  ruleColor?: TextColor
  children?: React.ReactNode
}) {
  const { title, width, titleColor = "cyanBright", ruleColor = "gray", children } = props
  return (
    <Box width={width} flexDirection="column">
      <Text color={ruleColor}>{"─".repeat(width)}</Text>
      <Text color={titleColor} bold>
        {fitLine(title, width)}
      </Text>
      {children}
    </Box>
  )
}

export function App({
  service,
  onCleanup,
  onRequestExit,
  initialThemeID = DEFAULT_THEME_ID,
}: {
  service: LauncherService
  onCleanup?: () => Promise<void> | void
  onRequestExit?: () => void
  initialThemeID?: string
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { stdin, setRawMode } = useStdin()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [projectOffsets, setProjectOffsets] = useState<Record<string, number>>({})
  const [selectedKey, setSelectedKey] = useState<string>()
  const [mode, setMode] = useState<Mode>("browse")
  const [showHelp, setShowHelp] = useState(false)
  const [helpOffset, setHelpOffset] = useState(0)
  const [inputValue, setInputValue] = useState("")
  const [status, setStatus] = useState("")
  const [statusDeadline, setStatusDeadline] = useState(0)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>()
  const [killTarget, setKillTarget] = useState<KillTarget>()
  const [hideTarget, setHideTarget] = useState<HideTarget>()
  const [renameTarget, setRenameTarget] = useState<RenameTarget>()
  const [addProjectOptionIndex, setAddProjectOptionIndex] = useState(0)
  const [addProjectOptions, setAddProjectOptions] = useState<AddProjectOption[]>([])
  const [addProjectLoading, setAddProjectLoading] = useState(false)
  const [themeID, setThemeID] = useState(initialThemeID)
  const [themeOptionIndex, setThemeOptionIndex] = useState(0)
  const [mouseEnabled, setMouseEnabled] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarShortcut, setSidebarShortcut] = useState(SIDEBAR_TOGGLE_SHORTCUT)
  const sidebarTogglePending = useRef(false)
  const stickyStatusUntilRef = useRef(0)
  const backgroundWritesRef = useRef<Promise<void>>(Promise.resolve())
  const backgroundGenerationRef = useRef(0)
  const lastInteractionAtRef = useRef(Date.now())
  const lastMouseUpRef = useRef<{ key: string; at: number } | undefined>(undefined)
  const mousePressTargetRef = useRef<MousePressTarget | undefined>(undefined)
  const scrollIndexRef = useRef(0)
  const { width, height } = useTerminalSize()
  const viewportHeight = Math.max(1, height)
  const now = useNowTick()
  const hasWorkingSessions = snapshot?.directories.some((record) => record.sessions.some((session) => sessionIsWorking(session.status))) ?? false
  const recentlyActive = Date.now() - lastInteractionAtRef.current < 45_000
  const animationsActive = hasWorkingSessions || Boolean(busy) || mode === "search" || recentlyActive
  const animFrame = useFrame(250, animationsActive)
  const slowFrame = Math.floor(animFrame / 3)
  const compactLayout = width < 38 || height < 28
  const panelGap = compactLayout ? 0 : 1
  const showBanner = height >= 12 && !(mode === "theme" && height < 20)
  const panelOuterWidth = minimumWidth(width - 2)
  const panelTextWidth = panelOuterWidth
  const sectionTextWidth = minimumWidth(width - 2)
  const themeOptions = useMemo(() => THEMES.map((item) => ({ id: item.id, name: item.name })), [])
  const selectedThemeOption = themeOptions[Math.max(0, Math.min(themeOptionIndex, themeOptions.length - 1))]
  const previewThemeID = mode === "theme" ? selectedThemeOption?.id ?? themeID : themeID
  const theme = useMemo(() => getThemeScheme(previewThemeID), [previewThemeID])
  useEffect(() => {
    const generation = ++backgroundGenerationRef.current
    writeTerminalBackground(stdout, theme.base.background)
    backgroundWritesRef.current = backgroundWritesRef.current.then(async () => {
      if (generation === backgroundGenerationRef.current) await service.setTerminalBackground(theme.base.background)
    }).catch(() => {})
  }, [stdout, service, theme.base.background])
  const rows = useMemo(() => buildRows(snapshot, expanded, mode === "search" ? inputValue : ""), [expanded, inputValue, mode, snapshot])
  const selectedIndex = useMemo(() => {
    if (!rows.length) return 0
    if (!selectedKey) return 0
    const match = rows.findIndex((row) => rowKey(row) === selectedKey)
    return match >= 0 ? match : 0
  }, [rows, selectedKey])
  const selectedRow = rows[selectedIndex]
  const projected = useMemo(() => projectSessionWindows(rows, projectOffsets, selectedRow?.key), [rows, projectOffsets, selectedRow?.key])
  useEffect(() => {
    if (Object.keys(projected.offsets).length !== Object.keys(projectOffsets).length || Object.keys(projected.offsets).some((directory) => projected.offsets[directory] !== projectOffsets[directory])) setProjectOffsets(projected.offsets)
  }, [projected.offsets, projectOffsets])
  useEffect(() => { setProjectOffsets({}) }, [mode === "search" ? inputValue : ""])
  scrollIndexRef.current = selectedIndex
  const previewSession = useMemo(() => findSessionInSnapshot(snapshot, snapshot?.previewSessionID), [snapshot])
  const addProjectSelectedOption = addProjectOptions[Math.max(0, Math.min(addProjectOptionIndex, addProjectOptions.length - 1))]

  const closeApp = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    onRequestExit?.()
    backgroundGenerationRef.current++
    await backgroundWritesRef.current
    try {
      if (onCleanup) {
        await onCleanup()
      } else {
        await service.shutdown()
      }
    } catch {
      // Best-effort cleanup only.
    }
    exit()
  }, [exit, onCleanup, onRequestExit, service])

  const setTemporaryStatus = useCallback((message: string) => {
    const nextStickyStatusUntil = Date.now() + STATUS_MESSAGE_HOLD_MS
    stickyStatusUntilRef.current = nextStickyStatusUntil
    setStatusDeadline(nextStickyStatusUntil)
    setStatus(message)
  }, [])

  useEffect(() => {
    if (!isTmux()) return
    let stopped = false
    let reading = false
    const update = async () => {
      if (reading) return
      reading = true
      try {
        const layout = await getSidebarLayoutState()
        if (!stopped) {
          setSidebarCollapsed(layout.collapsed && layout.registered)
          setSidebarShortcut(layout.shortcut)
        }
      } catch { /* The tmux pane may disappear during shutdown. */ }
      finally { reading = false }
    }
    void update()
    const onResize = () => { void update() }
    stdout.on("resize", onResize)
    const timer = setInterval(onResize, 250)
    return () => { stopped = true; clearInterval(timer); stdout.off("resize", onResize) }
  }, [stdout])

  const toggleSidebar = useCallback(async () => {
    if (sidebarTogglePending.current) return
    sidebarTogglePending.current = true
    try {
      if (await toggleSidebarLayout()) {
        const layout = await getSidebarLayoutState()
        setSidebarCollapsed(layout.collapsed)
      } else setTemporaryStatus("Open a session before collapsing the sidebar")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { sidebarTogglePending.current = false }
  }, [setTemporaryStatus])

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(""), Math.max(0, statusDeadline - Date.now()))
    return () => clearTimeout(timer)
  }, [status, statusDeadline])

  const beginAddProject = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    setMode("add-project")
    setInputValue("")
    setAddProjectOptionIndex(0)
    setTemporaryStatus("Type to autocomplete directories or enter an absolute or ~/ path")
  }, [setTemporaryStatus])

  const beginThemeMenu = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    setMode("theme")
    setThemeOptionIndex(Math.max(0, themeOptions.findIndex((option) => option.id === themeID)))
  }, [themeID, themeOptions])

  const beginRenameSession = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    if (!selectedRow || selectedRow.kind !== "session") {
      setTemporaryStatus("Select a session to rename")
      return
    }
    const title = selectedRow.session.title || "New session"
    setRenameTarget({
      sessionID: selectedRow.session.id,
      directory: selectedRow.record.directory,
      title,
    })
    setMode("rename-session")
    setInputValue(title)
    setTemporaryStatus("Edit the session title and press Enter")
  }, [selectedRow, setTemporaryStatus])

  const refresh = useCallback(
    async (preferredSelectedKey?: string) => {
      setLoading(true)
      setError(undefined)
      try {
        const next = await service.getSnapshot()
        setSnapshot(next)
        if (Date.now() > stickyStatusUntilRef.current) {
          setStatus("")
        }
        setExpanded((current) => {
          const nextDirSet = new Set(next.directories.map((d) => d.directory))
          let changed = false
          const updated: Record<string, boolean> = {}
          for (const dir of Object.keys(current)) {
            if (nextDirSet.has(dir)) {
              updated[dir] = current[dir]
            } else {
              changed = true
            }
          }
          for (const [index, record] of next.directories.entries()) {
            if (!(record.directory in updated)) {
              updated[record.directory] = record.pinned || index < 6
              changed = true
            }
          }
          return changed ? updated : current
        })
        setSelectedKey((current) => {
          if (preferredSelectedKey && snapshotHasKey(next, preferredSelectedKey)) return preferredSelectedKey
          if (current && snapshotHasKey(next, current)) return current
          return next.directories[0] ? `dir:${next.directories[0].directory}` : ADD_PROJECT_KEY
        })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    [service],
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
    if (deleteTarget && !snapshotHasKey(snapshot, `session:${deleteTarget.sessionID}`)) {
      setDeleteTarget(undefined)
      setTemporaryStatus("Selected session is already gone")
      return
    }
    if (killTarget && !snapshotHasKey(snapshot, `session:${killTarget.sessionID}`)) {
      setKillTarget(undefined)
      setTemporaryStatus("Selected session is already gone")
    }
    if (hideTarget && !snapshotHasKey(snapshot, `dir:${hideTarget.directory}`)) {
      setHideTarget(undefined)
      setTemporaryStatus("Selected project folder is already gone")
    }
    if (renameTarget && !snapshotHasKey(snapshot, `session:${renameTarget.sessionID}`)) {
      setRenameTarget(undefined)
      if (mode === "rename-session") {
        setMode("browse")
        setInputValue("")
      }
      setTemporaryStatus("Selected session is already gone")
    }
  }, [deleteTarget, killTarget, hideTarget, mode, renameTarget, setTemporaryStatus, snapshot])

  useEffect(() => {
    if (!rows.length && snapshot?.directories.length) {
      setSelectedKey(`dir:${snapshot.directories[0].directory}`)
    }
    if (!rows.length) return
    if (!selectedRow) {
      setSelectedKey(rowKey(rows[Math.min(selectedIndex, rows.length - 1)]))
    }
  }, [rows, selectedIndex, selectedRow, snapshot])

  useEffect(() => {
    if (mode !== "add-project") return
    setAddProjectOptionIndex((current) => {
      if (addProjectOptions.length === 0) return 0
      return clamp(current, 0, addProjectOptions.length - 1)
    })
  }, [addProjectOptions.length, mode])

  useEffect(() => {
    let cancelled = false
    void service
      .getThemeID()
      .then((nextThemeID) => {
        if (!cancelled) {
          setThemeID(nextThemeID)
          setThemeOptionIndex(Math.max(0, THEMES.findIndex((item) => item.id === nextThemeID)))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [service])

  useEffect(() => {
    return () => {
      backgroundGenerationRef.current++
      resetTerminalBackground(stdout)
      void backgroundWritesRef.current.then(() => service.resetTerminalBackground()).catch(() => {})
    }
  }, [service, stdout])

  useEffect(() => {
    if (mode === "add-project") {
      setAddProjectOptionIndex(0)
    }
  }, [inputValue, mode])

  useEffect(() => {
    if (mode !== "add-project") {
      setAddProjectOptions([])
      setAddProjectLoading(false)
      return
    }

    let cancelled = false
    setAddProjectLoading(true)
    void service
      .autocompleteDirectories(inputValue)
      .then((options) => {
        if (cancelled) return
        setAddProjectOptions(inputValue.trim() ? options : options.filter((option) => addProjectOptionMatches(option, inputValue)))
        setAddProjectLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setAddProjectOptions([])
        setAddProjectLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [inputValue, mode, service])

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      void service
        .isMouseModeEnabled()
        .then((enabled) => {
          if (!cancelled) {
            setMouseEnabled(enabled)
          }
        })
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [service])

  useEffect(() => {
    if (!stdout) return
    if (!mouseEnabled) return
    try {
      stdout.write("\u001b[?1000h\u001b[?1006h")
    } catch {
      // Mouse reporting is best-effort only.
    }

    return () => {
      try {
        stdout.write("\u001b[?1000l\u001b[?1006l")
      } catch {
        // Ignore teardown errors while exiting the app.
      }
    }
  }, [mouseEnabled, stdout])

  const move = useCallback(
    (direction: number) => {
      lastInteractionAtRef.current = Date.now()
      if (!rows.length) return
      const next = (selectedIndex + direction + rows.length) % rows.length
      setSelectedKey(rowKey(rows[next]))
    },
    [rows, selectedIndex],
  )

  const toggleDirectory = useCallback((record: DirectoryRecord, next?: boolean) => {
    lastInteractionAtRef.current = Date.now()
    setExpanded((current) => {
      const prev = current[record.directory]
      const nextVal = next ?? !prev
      if (prev === nextVal) return current
      return { ...current, [record.directory]: nextVal }
    })
  }, [])

  const commitInput = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    if (mode === "theme" && selectedThemeOption) {
      setBusy(`Applying ${selectedThemeOption.name}...`)
      try {
        await service.setThemeID(selectedThemeOption.id)
        setThemeID(selectedThemeOption.id)
        setTemporaryStatus(`Theme set to ${selectedThemeOption.name}`)
        setMode("browse")
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(undefined)
      }
      return
    }

    const value = inputValue.trim()
    if (!value) {
      if (mode === "add-project" && addProjectSelectedOption) {
        setBusy(`Adding ${addProjectSelectedOption.directory}...`)
        try {
          const directory = await service.addProjectDirectory(addProjectSelectedOption.directory)
          setTemporaryStatus(`Added project folder ${directory}`)
          setMode("browse")
          setInputValue("")
          setAddProjectOptionIndex(0)
          await refresh(`dir:${directory}`)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(undefined)
        }
        return
      }

      setMode("browse")
      setInputValue("")
      setRenameTarget(undefined)
      return
    }

    if (mode === "add-project") {
      const nextDirectory = addProjectSelectedOption?.directory ?? value
      setBusy(`Adding ${nextDirectory}...`)
      try {
        const directory = await service.addProjectDirectory(nextDirectory)
        setTemporaryStatus(`Added project folder ${directory}`)
        setMode("browse")
        setInputValue("")
        setAddProjectOptionIndex(0)
        await refresh(`dir:${directory}`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(undefined)
      }
      return
    }

    if (mode === "rename-session" && renameTarget) {
      setBusy(`Renaming ${renameTarget.title}...`)
      try {
        const title = await service.renameSession(renameTarget.directory, renameTarget.sessionID, value)
        setTemporaryStatus(`Renamed session to ${title}`)
        setMode("browse")
        setInputValue("")
        setRenameTarget(undefined)
        await refresh(`session:${renameTarget.sessionID}`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(undefined)
      }
      return
    }

  }, [addProjectSelectedOption, inputValue, mode, refresh, renameTarget, selectedThemeOption, service, setTemporaryStatus])

  const openRow = useCallback(async (row: SidebarRow) => {
    lastInteractionAtRef.current = Date.now()
    if (row.kind === "action") {
      beginAddProject()
      return
    }
    setBusy(row.kind === "session" ? `Opening ${row.session.title || "New session"}...` : `Opening ${row.record.label}...`)
    try {
      const result =
        row.kind === "session"
          ? await service.openSession(row.record.directory, row.session)
          : await service.openDirectory(row.record)
      setTemporaryStatus(describeOpenResult(result))
      setMode("browse")
      setInputValue("")
      await refresh(`session:${result.sessionID}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [beginAddProject, refresh, service, setTemporaryStatus])

  const openSelection = useCallback(async () => {
    if (!selectedRow) return
    await openRow(selectedRow)
  }, [openRow, selectedRow])

  const openLatestOrCreate = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    if (!selectedRow) return
    if (selectedRow.kind === "action") {
      beginAddProject()
      return
    }
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
  }, [beginAddProject, refresh, selectedRow, setTemporaryStatus])

  const createNewSession = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    if (!selectedRow) return
    if (selectedRow.kind === "action") {
      beginAddProject()
      return
    }
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
  }, [beginAddProject, refresh, selectedRow, setTemporaryStatus])

  const unpinSelection = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    if (!selectedRow || selectedRow.kind !== "directory" || !selectedRow.record.pinned) return
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
    lastInteractionAtRef.current = Date.now()
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
    lastInteractionAtRef.current = Date.now()
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
    lastInteractionAtRef.current = Date.now()
    if (!deleteTarget) return
    setDeleteTarget(undefined)
    setTemporaryStatus("Delete cancelled")
  }, [deleteTarget, setTemporaryStatus])

  const requestKillSelection = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    if (!selectedRow || selectedRow.kind !== "session") {
      setTemporaryStatus("Select a session to kill")
      return
    }
    if (!selectedRow.record.openSessionIDs.includes(selectedRow.session.id)) {
      setTemporaryStatus("Selected session is not currently running")
      return
    }
    setKillTarget({
      sessionID: selectedRow.session.id,
      directory: selectedRow.record.directory,
      title: selectedRow.session.title || "New session",
    })
  }, [selectedRow, setTemporaryStatus])

  const confirmKillSelection = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    if (!killTarget) return
    const target = killTarget
    setKillTarget(undefined)
    setSelectedKey(`session:${target.sessionID}`)
    setBusy(`Killing ${target.title}...`)
    try {
      const killed = await service.killSession(target.sessionID)
      if (killed) {
        setTemporaryStatus(`Killed running window for ${target.title}`)
      } else {
        setTemporaryStatus(`${target.title} was not running`)
      }
      await refresh(`session:${target.sessionID}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [killTarget, refresh, setTemporaryStatus])

  const cancelKillSelection = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    if (!killTarget) return
    setKillTarget(undefined)
    setTemporaryStatus("Kill cancelled")
  }, [killTarget, setTemporaryStatus])

  const requestHideSelection = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    if (!selectedRow || selectedRow.kind !== "directory") {
      setTemporaryStatus("Select a project folder to hide")
      return
    }
    setHideTarget({
      directory: selectedRow.record.directory,
      label: selectedRow.record.label,
    })
  }, [selectedRow, setTemporaryStatus])

  const confirmHideSelection = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    if (!hideTarget) return
    const target = hideTarget
    setHideTarget(undefined)
    setBusy(`Hiding ${target.label}...`)
    try {
      await service.hideDirectory(target.directory)
      setTemporaryStatus(`Hid project folder ${target.directory}`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }, [hideTarget, refresh, service, setTemporaryStatus])

  const cancelHideSelection = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    if (!hideTarget) return
    setHideTarget(undefined)
    setTemporaryStatus("Hide cancelled")
  }, [hideTarget, setTemporaryStatus])

  const cancelRenameSelection = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    if (!renameTarget && mode !== "rename-session") return
    setRenameTarget(undefined)
    setMode("browse")
    setInputValue("")
    setTemporaryStatus("Rename cancelled")
  }, [mode, renameTarget, setTemporaryStatus])

  const cancelThemeSelection = useCallback(() => {
    lastInteractionAtRef.current = Date.now()
    if (mode !== "theme") return
    setMode("browse")
    setTemporaryStatus("Theme selection cancelled")
  }, [mode, setTemporaryStatus])

  const inputHandlerRef = useRef<(input: string, key: any) => void>(() => {})
  inputHandlerRef.current = (input, key) => {
      const loweredInput = input.toLowerCase()
      const isInterrupt = input === "\u0003" || (key.ctrl && input === "c")
      lastInteractionAtRef.current = Date.now()

      if (isInterrupt) {
        void closeApp()
        return
      }

      if (isMouseEscapeInput(input)) {
        return
      }

      if (sidebarCollapsed) {
        if (key.tab || key.return || key.escape || input === "?") void toggleSidebar()
        else if (input === "q") void closeApp()
        return
      }
      if (key.tab && mode === "browse" && !deleteTarget && !killTarget && !hideTarget && !showHelp) {
        void toggleSidebar()
        return
      }

      if (showHelp) {
        if (input === "q") {
          void closeApp()
          return
        }
        if (key.escape || input === "?") setShowHelp(false)
        else if (key.upArrow || key.pageUp) setHelpOffset(Math.max(0, helpStart - (key.pageUp ? helpViewportRows : 1)))
        else if (key.downArrow || key.pageDown) setHelpOffset(Math.min(helpMaxOffset, helpStart + (key.pageDown ? helpViewportRows : 1)))
        return
      }
      if (input === "?" && mode === "browse" && !deleteTarget && !killTarget && !hideTarget && !busy) {
        setHelpOffset(0)
        setShowHelp(true)
        return
      }

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

      if (killTarget) {
        if (key.escape || loweredInput === "n") {
          cancelKillSelection()
          return
        }
        if (key.return || loweredInput === "y") {
          void confirmKillSelection()
        }
        return
      }

      if (hideTarget) {
        if (key.escape || loweredInput === "n") {
          cancelHideSelection()
          return
        }
        if (key.return || loweredInput === "y") {
          void confirmHideSelection()
        }
        return
      }

      if (mode === "rename-session") {
        if (key.escape) {
          cancelRenameSelection()
          return
        }
        if (key.return) {
          void commitInput()
          return
        }
        if (key.backspace || key.delete) {
          setInputValue((current) => deleteTextInputValue(current, key))
          return
        }
        const pasted = sanitizePastedText(input)
        if (pasted && !key.ctrl && !key.meta) {
          setInputValue((current) => current + pasted)
          return
        }
        if (isPrintable(input)) {
          setInputValue((current) => current + input)
        }
        return
      }

      if (busy) {
        if (input === "q") {
          void closeApp()
        }
        return
      }

      if (mode === "search" || mode === "add-project") {
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
        if (mode === "add-project") {
          if (key.upArrow) {
            setAddProjectOptionIndex((current) => {
              if (addProjectOptions.length === 0) return 0
              return (current - 1 + addProjectOptions.length) % addProjectOptions.length
            })
            return
          }
          if (key.downArrow) {
            setAddProjectOptionIndex((current) => {
              if (addProjectOptions.length === 0) return 0
              return (current + 1) % addProjectOptions.length
            })
            return
          }
        }
        if (key.escape) {
          if (mode === "search" && inputValue) {
            setInputValue("")
          } else {
            setMode("browse")
            setInputValue("")
            setAddProjectOptionIndex(0)
            setTemporaryStatus("Ready")
          }
          return
        }
        if (key.return) {
          if (mode === "search") {
            void openSelection()
            return
          }
          if (!inputValue.trim() && addProjectSelectedOption) {
            setBusy(`Adding ${addProjectSelectedOption.directory}...`)
            void service
              .addProjectDirectory(addProjectSelectedOption.directory)
              .then(async (directory) => {
                setTemporaryStatus(`Added project folder ${directory}`)
                setMode("browse")
                setInputValue("")
                setAddProjectOptionIndex(0)
                await refresh(`dir:${directory}`)
              })
              .catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause))
              })
              .finally(() => {
                setBusy(undefined)
              })
            return
          }

          void commitInput()
          return
        }
        if (key.backspace || key.delete) {
          setInputValue((current) => deleteTextInputValue(current, key))
          return
        }
        const pasted = sanitizePastedText(input)
        if (pasted && !key.ctrl && !key.meta) {
          setInputValue((current) => current + pasted)
          return
        }
        if (isPrintable(input)) {
          setInputValue((current) => current + input)
        }
        return
      }

      if (mode === "theme") {
        if (key.escape) {
          cancelThemeSelection()
          return
        }
        if (key.return) {
          void commitInput()
          return
        }
        if (key.upArrow) {
          setThemeOptionIndex((current) => (current - 1 + themeOptions.length) % themeOptions.length)
          return
        }
        if (key.downArrow) {
          setThemeOptionIndex((current) => (current + 1) % themeOptions.length)
          return
        }
        return
      }

      if (input === "q") {
        void closeApp()
        return
      }
      if (input === "/") {
        setMode("search")
        setInputValue("")
        setTemporaryStatus("Type to filter projects and sessions")
        return
      }
      if (input === "a") {
        beginAddProject()
        return
      }
      if (input === "t") {
        beginThemeMenu()
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
      if (input === "k") {
        requestKillSelection()
        return
      }
      if (input === "h") {
        requestHideSelection()
        return
      }
      if (input === "e") {
        beginRenameSession()
        return
      }
      if (input === "r") {
        void (async () => {
          const restarted = await service.restartCurrentSession()
          if (restarted) {
            setTemporaryStatus("Session restarting...")
          } else {
            setTemporaryStatus("No active session to restart")
          }
          await refresh()
        })()
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
  }

  useInput(
    useCallback((input: string, key: any) => {
      inputHandlerRef.current?.(input, key)
    }, []),
    { isActive: Boolean(process.stdin.isTTY) },
  )

  const directoryCount = snapshot?.directories.length ?? 0
  const sessionCount = snapshot?.directories.reduce((count, record) => count + record.sessions.length, 0) ?? 0
  const activeCount = snapshot?.activeSessions.length ?? 0

  const runningCount = snapshot?.directories.reduce((count, record) => count + record.sessions.filter((session) => sessionIsWorking(session.status)).length, 0) ?? 0
  const openCount = snapshot?.directories.reduce((count, record) => count + record.openSessionIDs.length, 0) ?? 0
  const statusTitle = error ? "Connection issue" : snapshot ? "Connected" : "Connecting…"
  const showAddProjectModal = mode === "add-project"
  const showRenameSessionModal = mode === "rename-session"
  const showThemeModal = mode === "theme"
  const showToolsPanel = mode === "browse" && !deleteTarget && !killTarget && !hideTarget
  const addProjectDropdownLimit = compactLayout ? 4 : 6
  const visibleAddProjectOptions = useMemo(
    () => windowRows(addProjectOptions, addProjectOptionIndex, addProjectDropdownLimit),
    [addProjectDropdownLimit, addProjectOptionIndex, addProjectOptions],
  )
  const addProjectFirstVisibleIndex = useMemo(() => {
    if (!visibleAddProjectOptions.length) return 0
    return addProjectOptions.findIndex((option) => option.directory === visibleAddProjectOptions[0]?.directory)
  }, [addProjectOptions, visibleAddProjectOptions])
  const statusLines = useMemo(
    () => [
      ...wrapTextHard(`${directoryCount} projects · ${sessionCount} sessions`, panelTextWidth),
      ...(mode === "theme" && height < 20 ? [] : wrapTextHard(`${runningCount} running · ${openCount} open`, panelTextWidth)),
      ...(previewSession ? [ `Preview: ${previewSession.session.title || "New session"}` ] : []),
    ],
    [directoryCount, sessionCount, runningCount, openCount, panelTextWidth, previewSession, mode, height],
  )
  const statusMessageText = error ? `Error: ${error}` : busy ? busy : status
  const statusMessageLines = useMemo(() => statusMessageText ? wrapTextHard(statusMessageText, panelTextWidth - (busy ? 1 : 0)) : [], [statusMessageText, panelTextWidth, busy])
  const toolsLines = packHints(
    busy ? ["[q] Quit"] : selectedRow?.kind === "directory"
      ? ["[Enter] Open", `[Space] ${expanded[selectedRow.record.directory] ?? selectedRow.record.pinned ? "Fold" : "Expand"}`, "[n] New", "[/] Find", "[?] Help"]
      : selectedRow?.kind === "action" ? ["[Enter] Add project", "[/] Find", "[?] Help"]
      : ["[Enter] Open", "[n] New", "[/] Find", "[?] Help"],
    panelTextWidth,
  )
  const helpHeadings = new Set(["Navigate", "Sessions and projects", "Find and settings", "Mouse", "Text entry", "Confirmations"])
  const helpTextWidth = minimumWidth(panelTextWidth - 2)
  const helpLines = [
    "Navigate",
    "[Up/Down] Select item across projects",
    "[Left/Right] Fold or expand project",
    "[Space] Fold or expand project",
    "[Enter] Open selection",
    "[o] Open latest session or create one",
    "",
    "Sessions and projects",
    "[n] New session · [a] Add project folder",
    "[e] Rename session · [d] Delete session",
    "[k] Close running session · [r] Restart",
    "[h] Hide project · [x] Unpin project",
    "",
    "Find and settings",
    "[/] Find · [t] Choose theme · [q] Quit",
    `[${sidebarShortcut}] Toggle sidebar from either pane`,
    "[Tab] Collapse sidebar while browsing",
    "[Ctrl+C] Quit",
    "",
    "Mouse",
    "Click anywhere on collapsed rail Expand sidebar",
    "Click Select · Double-click Open",
    "Click chevron Fold or expand",
    `Wheel Scroll hovered project (${mouseEnabled ? "enabled" : "enable tmux mouse"})`,
    "",
    "Text entry",
    "[Enter] Submit · [Esc] Cancel or clear search",
    "[Up/Down] Choose autocomplete or theme",
    "[Opt+Delete] / [Shift+Delete] Clear input",
    "? Types a question mark in text fields",
    "",
    "Confirmations",
    "[Enter / y] Confirm · [Esc / n] Cancel",
  ].flatMap((line) => line ? wrapTextHard(line, helpTextWidth) : [""])
  const helpViewportRows = Math.max(1, viewportHeight - 6 - (error ? 1 : 0))
  const helpMaxOffset = Math.max(0, helpLines.length - helpViewportRows)
  const helpStart = Math.min(helpOffset, helpMaxOffset)
  const addProjectLineEntries: ModalLineEntry[] = useMemo(
    () =>
      showAddProjectModal
        ? [
            ...wrapTextHard(`Path :: ${inputValue}`, panelTextWidth).map((line) => ({
              line,
              color: theme.semantic.success as TextColor,
            })),
            ...wrapTextHard("Autocomplete matches directories like OpenCode's @ picker. Absolute and ~/ paths still work.", panelTextWidth).map((line) => ({
              line,
              color: theme.base.foreground as TextColor,
            })),
            ...(addProjectLoading
              ? wrapTextHard("Searching directories...", panelTextWidth).map((line) => ({
                  line,
                  color: theme.base.foreground as TextColor,
                }))
              : visibleAddProjectOptions.length > 0
              ? visibleAddProjectOptions.flatMap((option, visibleIndex) => {
                  const index = addProjectFirstVisibleIndex + visibleIndex
                  const selected = index === addProjectOptionIndex
                  return dropdownOptionLines(selected ? ">" : " ", optionDisplay(option), panelTextWidth).map((line) => ({
                    line,
                    color: selected ? theme.semantic.selectionFg : theme.base.foreground,
                    backgroundColor: selected ? theme.semantic.selectionBg : undefined,
                  }))
                })
              : wrapTextHard("No matching directories. Press Enter to add the typed path.", panelTextWidth).map((line) => ({
                  line,
                  color: theme.base.foreground as TextColor,
                }))),
            ...wrapTextHard("[Up/Down] Choose  [Enter] Add  [Esc] Cancel  [Opt+Delete/Shift+Delete] Clear", panelTextWidth).map((line) => ({
              line,
              color: theme.semantic.warning as TextColor,
            })),
          ]
        : [],
    [showAddProjectModal, inputValue, panelTextWidth, theme, addProjectLoading, visibleAddProjectOptions, addProjectFirstVisibleIndex, addProjectOptionIndex],
  )
  const renameSessionLines = useMemo(
    () =>
      showRenameSessionModal
        ? [
            ...wrapTextHard(`Title :: ${inputValue}`, panelTextWidth),
            ...wrapTextHard("Give the selected session a new title.", panelTextWidth),
            ...wrapTextHard("[Enter] Rename  [Esc] Cancel  [Opt+Delete/Shift+Delete] Clear", panelTextWidth),
          ]
        : [],
    [showRenameSessionModal, inputValue, panelTextWidth],
  )
  const themeControls = packHints([...(height < 20 ? [] : ["[↑↓] Choose"]), "[Enter] Apply", "[Esc] Cancel"], panelTextWidth)
  const themeOverhead = 2 + (showBanner ? 3 : 0) + panelGap + 2 + statusLines.length + statusMessageLines.length + panelGap + 2 + 1 + (compactLayout ? 0 : 1) + themeControls.length
  const themeWindowLimit = Math.max(1, Math.min(8, viewportHeight - themeOverhead))
  const visibleThemeOptions = windowRows(themeOptions, themeOptionIndex, themeWindowLimit)
  const themeLineEntries: ModalLineEntry[] = showThemeModal ? [
    { line: `Theme ${themeOptionIndex + 1} of ${themeOptions.length}`, color: theme.semantic.highlight },
    ...(!compactLayout ? [{ line: "Swatches: BG · FG · Text · Accent", color: theme.base.foreground }] : []),
    ...visibleThemeOptions.map((option) => ({
      line: option.name,
      palette: getThemeScheme(option.id),
      color: option.id === selectedThemeOption?.id ? theme.semantic.selectionFg : theme.base.foreground,
      backgroundColor: option.id === selectedThemeOption?.id ? theme.semantic.selectionBg : undefined,
    })),
    ...themeControls.map((line) => ({ line, color: theme.semantic.warning })),
  ] : []
  const selectedDirectory = selectedRow && selectedRow.kind !== "action" ? selectedRow.record.directory : undefined
  const homeDirectory = process.env.HOME
  const selectedPath = selectedDirectory && homeDirectory && (selectedDirectory === homeDirectory || selectedDirectory.startsWith(`${homeDirectory}/`))
    ? `~${selectedDirectory.slice(homeDirectory.length)}`
    : selectedDirectory
  const promptPrimary = mode === "search"
    ? `/ ${inputValue}`
    : selectedRow?.kind === "session" ? selectedRow.session.title || "New session"
    : selectedRow?.kind === "directory" ? selectedRow.record.label
    : selectedRow?.kind === "action" ? "Add project folder" : "No project selected"
  const promptPrimaryLines = [promptPrimary]
  const promptDetail = mode === "search"
    ? ["Enter Open · Esc Clear / Back"]
    : [selectedPath ?? (selectedRow?.kind === "action" ? selectedRow.detail : "")].filter(Boolean)
  const deleteLines = useMemo(
    () =>
      deleteTarget
        ? [
            `Delete session "${truncate(deleteTarget.title, minimumWidth(panelTextWidth - 18))}"?`,
            truncate(deleteTarget.directory, panelTextWidth),
            "[Enter/Y] confirm  [Esc/N] cancel",
          ]
        : [],
    [deleteTarget, panelTextWidth],
  )
  const killLines = useMemo(
    () =>
      killTarget
        ? [
            `Kill running window for "${truncate(killTarget.title, minimumWidth(panelTextWidth - 22))}"?`,
            truncate(killTarget.directory, panelTextWidth),
            "[Enter/Y] confirm  [Esc/N] cancel",
          ]
        : [],
    [killTarget, panelTextWidth],
  )
  const hideLines = useMemo(
    () =>
      hideTarget
        ? [
            `Hide project folder "${truncate(hideTarget.label, minimumWidth(panelTextWidth - 22))}"?`,
            truncate(hideTarget.directory, panelTextWidth),
            "[Enter/Y] confirm  [Esc/N] cancel",
          ]
        : [],
    [hideTarget, panelTextWidth],
  )
  const projectPosition = rows.length ? `${selectedIndex + 1}/${rows.length}` : ""
  const projectHeader = fitLine("PROJECTS", Math.max(0, sectionTextWidth - projectPosition.length)) + projectPosition
  const ageWidth = Math.max(3, ...rows.map((row) => row.kind === "session" ? relativeTime(row.session.time.updated, now).length : 0))

  // Count rendered rows once for both the viewport budget and mouse coordinates.
  const sectionHeight = (shown: boolean, contentRows: number) => shown ? panelGap + 2 + contentRows : 0
  const beforeProjectRows =
    2 + // outer top padding and collapse control
    (showBanner ? 3 : 0) +
    sectionHeight(true, statusLines.length + statusMessageLines.length) +
    sectionHeight(Boolean(deleteTarget), deleteLines.length) +
    sectionHeight(Boolean(killTarget), killLines.length) +
    sectionHeight(Boolean(hideTarget), hideLines.length) +
    sectionHeight(showAddProjectModal, addProjectLineEntries.length) +
    sectionHeight(showRenameSessionModal, renameSessionLines.length) +
    sectionHeight(showThemeModal, themeLineEntries.length) +
    panelGap + 2 + // separator and project heading
    (loading && !snapshot ? 1 : 0) +
    (!loading && snapshot?.directories.length === 0 ? 1 : 0)
  const projectRowsStartY = beforeProjectRows + 1 // SGR mouse coordinates are one based.
  const showPrompt = mode !== "add-project" && mode !== "rename-session" && mode !== "theme"
  const promptHeight = showPrompt ? panelGap + (showToolsPanel ? 0 : 1) + (mode === "search" ? 1 : promptPrimaryLines.length) + promptDetail.length : 0
  const fixedHeight = beforeProjectRows + (showToolsPanel ? panelGap + 1 + toolsLines.length : 0) + promptHeight
  const visibleRowCount = Math.max(1, viewportHeight - fixedHeight)
  const projectedSelectedIndex = Math.max(0, projected.display.findIndex((row) => row.key === selectedRow?.key))
  const visibleRows = useMemo(() => windowRows(projected.display, projectedSelectedIndex, visibleRowCount), [projected.display, projectedSelectedIndex, visibleRowCount])

  const mouseContextRef = useRef<{
    mode: Mode
    sidebarCollapsed: boolean
    width: number
    height: number
    toggleSidebar: () => Promise<void>
    projectRowsStartY: number
    showHelp: boolean
    visibleRows: DisplayRow[]
    projectOffsets: Record<string, number>
    setProjectOffsets: React.Dispatch<React.SetStateAction<Record<string, number>>>
    rows: SidebarRow[]
    selectedIndex: number
    scrollIndexRef: React.MutableRefObject<number>
    toggleDirectory: (record: DirectoryRecord, next?: boolean) => void
    openRow: (row: SidebarRow) => Promise<void>
    beginAddProject: () => void
    setSelectedKey: React.Dispatch<React.SetStateAction<string | undefined>>
  }>(null!)
  const mouseContext = {
    mode,
    sidebarCollapsed,
    width,
    height,
    toggleSidebar,
    projectRowsStartY,
    showHelp,
    visibleRows,
    projectOffsets: projected.offsets,
    setProjectOffsets,
    rows,
    selectedIndex,
    scrollIndexRef,
    toggleDirectory,
    openRow,
    beginAddProject,
    setSelectedKey,
  }
  mouseContextRef.current = mouseContext

  const handleMouseSelection = useCallback(
    (input: string) => {
      const ctx = mouseContextRef.current
      for (const event of parseSgrMouseInput(input)) {
        const insidePane = event.x >= 1 && event.x <= ctx.width && event.y >= 1 && event.y <= ctx.height
        if (event.code === 0 && event.release && insidePane && (ctx.sidebarCollapsed || (!ctx.showHelp && event.y === 2))) {
          void ctx.toggleSidebar()
          return true
        }
      }
      if (ctx.sidebarCollapsed) return false
      if (ctx.mode !== "browse" || ctx.showHelp) return false

      const projectRowsStartY = ctx.projectRowsStartY

      let handled = false
      let scrollDelta = 0
      for (const event of parseSgrMouseInput(input)) {
        if ((event.code & 64) !== 0) {
          if (event.release) continue
          if (event.y < projectRowsStartY || event.y >= projectRowsStartY + ctx.visibleRows.length || !ctx.rows.length) continue
          const delta = (event.code & 1) === 0 ? -1 : 1
          const hovered = ctx.visibleRows[event.y - projectRowsStartY]
          const directory = hovered?.kind === "session" ? hovered.record.directory : hovered?.kind === "overflow" ? hovered.directory : undefined
          if (directory) {
            const next = scrollProjectWindow(ctx.rows, directory, ctx.projectOffsets[directory] ?? 0, delta, ctx.rows[ctx.scrollIndexRef.current]?.key)
            ctx.projectOffsets[directory] = next.start
            ctx.setProjectOffsets((current) => ({ ...current, [directory]: next.start }))
            if (next.selectedKey) {
              const index = ctx.rows.findIndex((row) => row.key === next.selectedKey)
              if (index >= 0) ctx.scrollIndexRef.current = index
              ctx.setSelectedKey(next.selectedKey)
            }
          } else scrollDelta += delta
          handled = true
          continue
        }
        if ((event.code & 3) !== 0) continue

        const rowIndex = event.y - projectRowsStartY
        if (rowIndex < 0 || rowIndex >= ctx.visibleRows.length) {
          if (event.release) {
            mousePressTargetRef.current = undefined
          }
          continue
        }
        const row = ctx.visibleRows[rowIndex]
        if (!row || row.kind === "overflow") continue

        const inDirectoryToggle = row.kind === "directory" && event.x >= 4 && event.x <= 5

        if (!event.release) {
          mousePressTargetRef.current = {
            kind: inDirectoryToggle ? "toggle" : "row",
            key: row.key,
          }
          handled = true
          continue
        }

        const pressedTarget = mousePressTargetRef.current
        mousePressTargetRef.current = undefined
        if (!pressedTarget || pressedTarget.key !== row.key || pressedTarget.kind !== (inDirectoryToggle ? "toggle" : "row")) {
          continue
        }

        handled = true

        if (pressedTarget.kind === "toggle" && row.kind === "directory") {
          ctx.toggleDirectory(row.record)
          continue
        }

        ctx.setSelectedKey(row.key)

        if (row.kind === "action") {
          ctx.beginAddProject()
          continue
        }

        const nowMs = Date.now()
        const last = lastMouseUpRef.current
        if (last?.key === row.key && nowMs - last.at < 350) {
          lastMouseUpRef.current = undefined
          void ctx.openRow(row)
        } else {
          lastMouseUpRef.current = { key: row.key, at: nowMs }
        }
      }

      if (scrollDelta !== 0 && ctx.rows.length) {
        const currentIdx = ctx.scrollIndexRef.current
        const nextIdx = Math.max(0, Math.min(currentIdx + scrollDelta, ctx.rows.length - 1))
        ctx.scrollIndexRef.current = nextIdx
        ctx.setSelectedKey(rowKey(ctx.rows[nextIdx]))
      }

      return handled
    },
    [],
  )

  useEffect(() => {
    if (!mouseEnabled) return
    if (!stdin.isTTY) return

    setRawMode(true)
    const onData = (chunk: Buffer | string) => {
      const input = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      if (!isMouseEscapeInput(input)) return
      handleMouseSelection(input)
    }

    stdin.on("data", onData)
    return () => {
      setRawMode(false)
      stdin.off("data", onData)
    }
  }, [mouseEnabled, stdin, setRawMode])

  if (sidebarCollapsed) {
    return (
      <Box width={width} height={viewportHeight} overflow="hidden" backgroundColor={theme.base.background}>
        <Box width={width} flexDirection="column" alignItems="center" flexShrink={0} paddingTop={1}>
          <Text color={theme.semantic.info} bold>›</Text>
          <Text> </Text>
          <Text color={openCount ? theme.semantic.highlight : theme.semantic.muted}>≡</Text>
          <Text> </Text>
          <Text color={error ? theme.semantic.error : runningCount ? theme.semantic.success : theme.semantic.muted}>
            {error ? "!" : runningCount ? "●" : "○"}
          </Text>
        </Box>
      </Box>
    )
  }

  if (showHelp) {
    return (
      <Box width={width} height={viewportHeight} overflow="hidden" backgroundColor={theme.base.background}>
        <Box width={width} flexDirection="column" flexShrink={0} paddingX={1} paddingTop={1}>
        <Frame width={panelTextWidth} theme={theme}>
          <Text color={theme.semantic.info} bold wrap="truncate-end">Help</Text>
          <Text color={theme.semantic.muted} wrap="truncate-end">{`Theme: ${theme.name}`}</Text>
          {error ? <Text color={theme.semantic.error} wrap="truncate-end">{`Error: ${error}`}</Text> : null}
          {Array.from({ length: helpViewportRows }, (_, index) => {
            const line = helpLines[helpStart + index] || " "
            return helpHeadings.has(line) ? <Text key={index} color={theme.semantic.info} bold wrap="truncate-end">{line}</Text> : <KeyHints key={index} line={line} theme={theme} />
          })}
          <KeyHints line={helpTextWidth < 24 ? "[↑↓] Scroll [Esc]" : helpTextWidth < 45 ? "[↑↓] Scroll · [Esc] Back" : `[Esc/?] Back · [↑↓] Scroll ${helpStart + 1}/${helpLines.length}`} theme={theme} />
        </Frame>
        </Box>
      </Box>
    )
  }

  // Keep a full terminal frame, but don't squash panels when wrapped content
  // exceeds its height: overflowing text would otherwise overwrite other rows.
  return (
    <Box flexDirection="column" width={width} height={viewportHeight} overflow="hidden" backgroundColor={theme.base.background}>
    <Box flexDirection="column" width={width} minHeight={viewportHeight} flexShrink={0} paddingX={1} paddingTop={1}>
      <Text color={theme.semantic.info} wrap="truncate-end">{`‹ [Tab] Collapse · [${sidebarShortcut}] Toggle`}</Text>
      {showBanner ? (
        <Frame width={panelOuterWidth} theme={theme}>
          <MascotBanner
            compact={compactLayout}
            width={minimumWidth(panelTextWidth - 2)}
            busy={hasWorkingSessions}
            activeCount={activeCount}
            recentlyActive={recentlyActive}
            error={error}
            mode={mode}
            theme={theme}
            frame={slowFrame}
          />
        </Frame>
      ) : null}

      <Box marginTop={panelGap}>
        <Panel title={statusTitle} width={panelTextWidth} ruleColor={theme.semantic.border} titleColor={error ? theme.semantic.error : snapshot ? theme.semantic.success : theme.semantic.warning}>
          {statusLines.map((line, index) => (
            <Text key={`status-line-${index}`} color={theme.semantic.muted} wrap="truncate-end">
              {line}
            </Text>
          ))}
          {statusMessageLines.map((line, index) => (
            <Text key={`status-message-${index}`} color={error ? theme.semantic.error : busy ? theme.semantic.warning : theme.semantic.muted}>
              {fitLine(line, panelTextWidth - (busy && index === statusMessageLines.length - 1 ? 1 : 0))}
              {busy && index === statusMessageLines.length - 1 ? <AnimatedSpinner active={true} frame={animFrame} /> : null}
            </Text>
          ))}
        </Panel>
      </Box>

      {deleteTarget ? (
        <Box marginTop={panelGap}>
          <Panel title="Delete session" width={panelTextWidth} ruleColor={theme.semantic.border} titleColor={theme.semantic.error}>
            {deleteLines.map((line, index) => (
              <Text key={`delete-${index}`} color={index === 2 ? theme.semantic.warning : theme.base.foreground}>
                {fitLine(line, panelTextWidth)}
              </Text>
            ))}
          </Panel>
        </Box>
      ) : null}

      {killTarget ? (
        <Box marginTop={panelGap}>
          <Panel title="Close running session" width={panelTextWidth} ruleColor={theme.semantic.border} titleColor={theme.semantic.warning}>
            {killLines.map((line, index) => (
              <Text key={`kill-${index}`} color={index === 2 ? theme.semantic.warning : theme.base.foreground}>
                {fitLine(line, panelTextWidth)}
              </Text>
            ))}
          </Panel>
        </Box>
      ) : null}

      {hideTarget ? (
        <Box marginTop={panelGap}>
          <Panel title="Hide project" width={panelTextWidth} ruleColor={theme.semantic.border} titleColor={theme.semantic.error}>
            {hideLines.map((line, index) => (
              <Text key={`hide-${index}`} color={index === 2 ? theme.semantic.warning : theme.base.foreground}>
                {fitLine(line, panelTextWidth)}
              </Text>
            ))}
          </Panel>
        </Box>
      ) : null}

      {showAddProjectModal ? (
        <Box marginTop={panelGap}>
          <Panel title="Add project folder" width={panelTextWidth} ruleColor={theme.semantic.border} titleColor={theme.semantic.success}>
            {addProjectLineEntries.map((entry, index) => {
              return (
                <Text key={`add-project-${index}`} color={entry.color} backgroundColor={entry.backgroundColor}>
                  {fitLine(entry.line, panelTextWidth)}
                </Text>
              )
            })}
          </Panel>
        </Box>
      ) : null}

      {showRenameSessionModal ? (
        <Box marginTop={panelGap}>
          <Panel title="Rename session" width={panelTextWidth} ruleColor={theme.semantic.border} titleColor={theme.ansi.magenta}>
            {renameSessionLines.map((line, index) => (
              <Text key={`rename-session-${index}`} color={index === 2 ? theme.semantic.warning : index === 0 ? theme.ansi.magenta : theme.base.foreground}>
                {fitLine(line, panelTextWidth)}
              </Text>
            ))}
          </Panel>
        </Box>
      ) : null}

      {showThemeModal ? (
        <Box marginTop={panelGap}>
          <Panel title={height < 20 ? "Choose theme [↑↓]" : "Choose theme"} width={panelTextWidth} ruleColor={theme.semantic.border} titleColor={theme.semantic.highlight}>
            {themeLineEntries.map((entry, index) => {
              if (!entry.palette) return <Text key={index} color={entry.color} wrap="truncate-end">{entry.line}</Text>
              const palette = entry.palette
              const colors = [palette.base.background, palette.semantic.panelBg, palette.semantic.info, palette.semantic.highlight]
              const selected = palette.id === selectedThemeOption?.id
              return <Box key={palette.id} width={panelTextWidth} height={1} backgroundColor={entry.backgroundColor}>
                <Text color={entry.color}>{selected ? "> " : "  "}</Text>
                {colors.map((color, swatch) => <Text key={swatch}>{swatch ? <Text> </Text> : null}<Text color={color} backgroundColor={color}>█</Text></Text>)}
                <Box width={Math.max(0, panelTextWidth - 2 - (colors.length * 2 - 1))} flexShrink={0}>
                  <Text color={entry.color} wrap="truncate-end">{` ${entry.line}`}</Text>
                </Box>
              </Box>
            })}
          </Panel>
        </Box>
      ) : null}

      <Box marginTop={panelGap} flexDirection="column">
        <Text color={theme.semantic.border}>{"─".repeat(sectionTextWidth)}</Text>
        <Text color={theme.semantic.muted}>{truncate(projectHeader, sectionTextWidth)}</Text>
        {loading && !snapshot ? <Text color={theme.semantic.warning}>SYNC :: workspace...</Text> : null}
        {!loading && snapshot?.directories.length === 0 ? <Text color={theme.semantic.muted}>No projects yet. Add a project folder to get started.</Text> : null}
        {visibleRows.map((row) => {
          if (row.kind === "overflow") return <Text key={row.key} color={theme.semantic.muted} wrap="truncate-end">{`    ... ${row.count} ${row.above ? "above" : "more"}`}</Text>
          const selected = row.key === selectedRow?.key
          const selectedForeground: TextColor = selected ? theme.semantic.selectionFg : undefined
          const selectedBackground = selected ? theme.semantic.selectionBg : undefined
          const rowWidth = sectionTextWidth

          const selectionMarker = selected ? "> " : "  "

          if (row.kind === "action") {
            return (
              <Box key={row.key} width={rowWidth} backgroundColor={selectedBackground}>
                <Text color={selected ? selectedForeground : theme.semantic.muted} wrap="truncate-end">
                  {`${selectionMarker}Add project folder`}
                </Text>
              </Box>
            )
          }

          if (row.kind === "directory") {
            const expandedNow = mode === "search" ? true : expanded[row.record.directory] ?? row.record.pinned
            const activeDirectoryCount = row.record.activeSessionIDs.length
            const suffix = activeDirectoryCount > 0 ? `${activeDirectoryCount}/${row.record.sessions.length}` : `${row.record.sessions.length}`
            const labelWidth = Math.max(0, rowWidth - 4 - suffix.length - 1)
            return (
              <Box key={row.key} width={rowWidth} backgroundColor={selectedBackground}>
                <Text color={selectedForeground}>{selectionMarker}</Text>
                <Text color={selected ? selectedForeground : theme.semantic.muted}>{expandedNow ? "⌄ " : "› "}</Text>
                <Box width={labelWidth} flexShrink={0}>
                  <Text color={selected ? selectedForeground : theme.semantic.info} bold wrap="truncate-end">{row.record.label}</Text>
                </Box>
                <Text color={selected ? selectedForeground : theme.semantic.muted}>{` ${suffix}`}</Text>
              </Box>
            )
          }

          const isActive = row.record.activeSessionIDs.includes(row.session.id)
          const isPreview = snapshot?.previewSessionID === row.session.id
          const isWorking = sessionIsWorking(row.session.status)
          const completion = sessionJustCompleted(row.session.status)
          const suffix = relativeTime(row.session.time.updated, now).padStart(ageWidth)
          const marker = isWorking ? LIVE_FRAMES[animFrame % LIVE_FRAMES.length] : completion ? "*" : isPreview ? ">" : isActive ? "•" : "·"
          const titleWidth = Math.max(0, rowWidth - 6 - ageWidth - 1)
          const markerColor: TextColor = selected ? selectedForeground : isWorking ? theme.semantic.warning : completion ? theme.semantic.success : isPreview ? theme.semantic.info : isActive ? theme.semantic.success : theme.semantic.muted
          return (
            <Box key={row.key} width={rowWidth} backgroundColor={selectedBackground}>
              <Text color={selectedForeground}>{`${selectionMarker}  `}</Text>
              <Text color={markerColor}>{`${marker} `}</Text>
              <Box width={titleWidth} flexShrink={0}>
                <Text color={selected ? selectedForeground : theme.base.foreground} wrap="truncate-end">{row.session.title || "New session"}</Text>
              </Box>
              <Text color={selected ? selectedForeground : theme.semantic.muted}>{` ${suffix}`}</Text>
            </Box>
          )
        })}
      </Box>

      {showToolsPanel ? (
        <Box marginTop={panelGap} flexDirection="column" width={panelTextWidth}>
          <Text color={theme.semantic.border}>{"─".repeat(panelTextWidth)}</Text>
          {toolsLines.map((line, index) => <KeyHints key={`hint-${index}`} line={line} theme={theme} />)}
        </Box>
      ) : null}

      {mode !== "add-project" && mode !== "rename-session" && mode !== "theme" ? (
        <Box width={panelOuterWidth} marginTop={panelGap} flexDirection="column">
          {!showToolsPanel ? <Text color={theme.semantic.border}>{"─".repeat(panelTextWidth)}</Text> : null}
          {mode === "search" ? (
              <Text color={theme.semantic.success}>
                {fitLine(`/ ${inputValue}`, panelTextWidth - 1)}
                <BlinkingCursor frame={animFrame} />
              </Text>
          ) : (
            promptPrimaryLines.map((line, index) => (
              <Text key={`prompt-primary-${index}`} color={mode === "browse" ? theme.base.foreground : theme.semantic.success} wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
          {promptDetail.map((line, index) => (
            <Text key={`prompt-${index}`} color={theme.semantic.muted} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
    </Box>
  )
}
