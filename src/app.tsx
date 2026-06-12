import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink"
import { STATUS_MESSAGE_HOLD_MS, WINDOW_POLL_INTERVAL_MS } from "./lib/constants.js"
import { LauncherService } from "./lib/opencode.js"
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

type ThemeOption = {
  id: string
  name: string
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
  line: string
  color?: TextColor
  backgroundColor?: TextColor
}

type BorderColor = React.ComponentProps<typeof Box>["borderColor"]
type TextColor = React.ComponentProps<typeof Text>["color"]

const SPINNER_FRAMES = ["-", "\\", "|", "/"]
const LIVE_FRAMES = ["o", "O", "0", "O"]
const SELECT_FRAMES = [">", "}", "]", "}"]
const ADD_PROJECT_KEY = "action:add-project"
const HAPPY_BREATHING_FACES = ["(◕ᴥ◕)", "(◕ᴗ◕)"]
const SUPER_HAPPY_FACE = "(◕‿◕)"
const SLEEPING_FACE = "(-ᴥ-)"
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

function themeOptionDisplay(option: ThemeOption) {
  return option.name
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

function sectionRule(title: string, width: number) {
  const prefix = `--[ ${title} ]`
  if (prefix.length >= width) return truncate(prefix, width)
  return prefix + "-".repeat(width - prefix.length)
}

function metricLine(label: string, value: string, width: number) {
  return truncate(`${label.toUpperCase().padEnd(10)} ${value}`, width)
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

  const wideTitle = `:: OPENCODE SIDEBAR :: ${face} ${mood} :: ${input.theme.name}`
  const compactTitle = `:: OPENCODE SIDEBAR :: ${face}`

  if (input.compact) return compactTitle
  if (wideTitle.length <= input.width) return wideTitle
  const mediumTitle = `:: OPENCODE SIDEBAR :: ${face} ${mood}`
  if (mediumTitle.length <= input.width) return mediumTitle
  return compactTitle
}

function AnimatedSpinner({ active, frame }: { active: boolean; frame: number }) {
  if (!active) return null
  return <Text>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
}

function LiveActivityGlyph({ active, frame }: { active: boolean; frame: number }) {
  if (!active) return null
  return <Text>{LIVE_FRAMES[frame % LIVE_FRAMES.length]}</Text>
}

function SelectAnimationGlyph({ selected, frame }: { selected: boolean; frame: number }) {
  if (!selected) return <Text>[ ]</Text>
  return <Text>[{SELECT_FRAMES[frame % SELECT_FRAMES.length]}]</Text>
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
  return <Text color={props.theme.semantic.highlight} bold>{fitLine(title, props.width)}</Text>
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
    <Box width={width + 4} flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
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
  const [selectedKey, setSelectedKey] = useState<string>()
  const [mode, setMode] = useState<Mode>("browse")
  const [inputValue, setInputValue] = useState("")
  const [status, setStatus] = useState("Booting opencode server...")
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
  const stickyStatusUntilRef = useRef(0)
  const lastInteractionAtRef = useRef(Date.now())
  const lastMouseUpRef = useRef<{ key: string; at: number } | undefined>(undefined)
  const mousePressTargetRef = useRef<MousePressTarget | undefined>(undefined)
  const scrollIndexRef = useRef(0)
  const { width, height } = useTerminalSize()
  const usableHeight = height - 1
  const now = useNowTick()
  const hasWorkingSessions = snapshot?.directories.some((record) => record.sessions.some((session) => sessionIsWorking(session.status))) ?? false
  const recentlyActive = Date.now() - lastInteractionAtRef.current < 45_000
  const animationsActive = hasWorkingSessions || Boolean(busy) || mode === "search" || recentlyActive
  const animFrame = useFrame(250, animationsActive)
  const slowFrame = Math.floor(animFrame / 3)
  const compactLayout = width < 38 || height < 28
  const panelGap = compactLayout ? 0 : 1
  const showBanner = height >= 12
  const panelOuterWidth = minimumWidth(width - 2)
  const panelTextWidth = minimumWidth(panelOuterWidth - 4)
  const sectionTextWidth = minimumWidth(width - 2)
  const themeOptions = useMemo(() => THEMES.map((item) => ({ id: item.id, name: item.name })), [])
  const selectedThemeOption = themeOptions[Math.max(0, Math.min(themeOptionIndex, themeOptions.length - 1))]
  const previewThemeID = mode === "theme" ? selectedThemeOption?.id ?? themeID : themeID
  const theme = useMemo(() => getThemeScheme(previewThemeID), [previewThemeID])
  const rows = useMemo(() => buildRows(snapshot, expanded, mode === "search" ? inputValue : ""), [expanded, inputValue, mode, snapshot])
  const selectedIndex = useMemo(() => {
    if (!rows.length) return 0
    if (!selectedKey) return 0
    const match = rows.findIndex((row) => rowKey(row) === selectedKey)
    return match >= 0 ? match : 0
  }, [rows, selectedKey])
  const selectedRow = rows[selectedIndex]
  scrollIndexRef.current = selectedIndex
  const previewSession = useMemo(() => findSessionInSnapshot(snapshot, snapshot?.previewSessionID), [snapshot])
  const addProjectSelectedOption = addProjectOptions[Math.max(0, Math.min(addProjectOptionIndex, addProjectOptions.length - 1))]

  const closeApp = useCallback(async () => {
    lastInteractionAtRef.current = Date.now()
    onRequestExit?.()
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
    setStatus(message)
  }, [])

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
    setTemporaryStatus("Choose a sidebar theme")
  }, [setTemporaryStatus, themeID, themeOptions])

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
          setStatus(`Connected to ${next.baseUrl} [${service.describeBackend()}]`)
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
      resetTerminalBackground(stdout)
      void service.resetTerminalBackground()
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
        writeTerminalBackground(stdout, getThemeScheme(selectedThemeOption.id).base.background)
        void service.setTerminalBackground(getThemeScheme(selectedThemeOption.id).base.background)
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

  const detail = useMemo(() => {
    if (!selectedRow) return "No project selected"
    if (selectedRow.kind === "action") return selectedRow.detail
    if (selectedRow.kind === "directory") {
      const active = selectedRow.record.activeSessionIDs.length
      return `${selectedRow.record.sessions.length} sessions${active ? ` | ${active} live` : ""}`
    }
    const active = selectedRow.record.activeSessionIDs.includes(selectedRow.session.id)
    return `${selectedRow.session.id}${active ? " | live" : ""}`
  }, [selectedRow])

  const previewLabel = useMemo(() => {
    if (!previewSession) return "idle"
    const label = previewSession.session.title || previewSession.record.label
    return truncate(label, compactLayout ? panelTextWidth : minimumWidth(panelTextWidth - 16))
  }, [compactLayout, panelTextWidth, previewSession])

  const activityGlyph = hasWorkingSessions ? "o" : activeCount > 0 ? "|" : "."
  const statusTitle = `STATUS / MATRIX [${activityGlyph}]`
  const showAddProjectModal = mode === "add-project"
  const showRenameSessionModal = mode === "rename-session"
  const showThemeModal = mode === "theme"
  const showToolsPanel = !compactLayout || (!deleteTarget && !killTarget && !hideTarget)
  const addProjectDropdownLimit = compactLayout ? 4 : 6
  const visibleAddProjectOptions = useMemo(
    () => windowRows(addProjectOptions, addProjectOptionIndex, addProjectDropdownLimit),
    [addProjectDropdownLimit, addProjectOptionIndex, addProjectOptions],
  )
  const addProjectFirstVisibleIndex = useMemo(() => {
    if (!visibleAddProjectOptions.length) return 0
    return addProjectOptions.findIndex((option) => option.directory === visibleAddProjectOptions[0]?.directory)
  }, [addProjectOptions, visibleAddProjectOptions])
  const apiState = snapshot ? "CONNECTED" : error ? "DEGRADED" : "BOOTING"
  const statusLines = useMemo(
    () =>
      compactLayout
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
          ],
    [compactLayout, apiState, previewLabel, directoryCount, sessionCount, activeCount, panelTextWidth, service],
  )
  const statusMessageText = error ? `STATE      ERROR :: ${error}` : busy ? `STATE      WORK :: ${busy}` : `STATE      LINK :: ${status}`
  const statusMessageLines = useMemo(() => wrapTextHard(statusMessageText, panelTextWidth), [statusMessageText, panelTextWidth])
  const shortcutItems = useMemo(() => [
    { key: "Enter", desc: "Load" },
    { key: "Double-click", desc: "Open" },
    { key: "N", desc: "New" },
    { key: "E", desc: "Rename" },
    { key: "D", desc: "Delete" },
    { key: "H", desc: "Hide" },
    { key: "K", desc: "Kill" },
    { key: "/", desc: "Find" },
    { key: "A", desc: "Add" },
    { key: "T", desc: "Theme" },
    { key: "Space", desc: "Expand" },
    { key: "R", desc: "Restart" },
    { key: "Q", desc: "Quit" },
  ], [])
  const toolsLines = useMemo(() => {
    const mouseDesc = mouseEnabled ? "Click + arrow toggle enabled" : "Enable tmux mouse"
    const shortcutDesc = shortcutItems.map((s) => `[${s.key}] ${s.desc}`).concat([`[Mouse] ${mouseDesc}`]).join("  ")
    return wrapTextHard(shortcutDesc, panelTextWidth)
  }, [mouseEnabled, panelTextWidth, shortcutItems])
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
  const themeLineEntries: ModalLineEntry[] = useMemo(
    () =>
      showThemeModal
        ? [
            ...wrapTextHard(`Theme :: ${selectedThemeOption?.name ?? theme.name}`, panelTextWidth).map((line) => ({
              line,
              color: theme.semantic.highlight as TextColor,
            })),
            ...wrapTextHard("Choose a color scheme for the sidebar.", panelTextWidth).map((line) => ({
              line,
              color: theme.base.foreground as TextColor,
            })),
            ...themeOptions.flatMap((option, index) => {
              const selected = index === themeOptionIndex
              return wrapTextHard(`${selected ? ">" : " "} ${themeOptionDisplay(option)}`, panelTextWidth).map((line) => ({
                line,
                color: selected ? theme.semantic.selectionFg : theme.base.foreground,
                backgroundColor: selected ? theme.semantic.selectionBg : undefined,
              }))
            }),
            ...wrapTextHard("[Up/Down] Choose  [Enter] Apply  [Esc] Cancel", panelTextWidth).map((line) => ({
              line,
              color: theme.semantic.warning as TextColor,
            })),
          ]
        : [],
    [showThemeModal, selectedThemeOption, theme, panelTextWidth, themeOptions, themeOptionIndex],
  )
  const promptPrimary = mode === "search"
    ? `/ ${inputValue}`
    : selectedRow?.kind === "action" ? selectedRow.detail : selectedRow?.record.directory ?? "No project selected"
  const promptPrimaryLines = useMemo(() => wrapTextHard(promptPrimary, panelTextWidth), [promptPrimary, panelTextWidth])
  const promptDetail = useMemo(
    () =>
      mode === "search"
        ? ["[Enter] submit  [Esc] cancel"]
        : wrapTextHard(rows.length > 0 ? `${selectedIndex + 1}/${rows.length}  ${detail}` : `FOCUS ${detail}`, panelTextWidth),
    [mode, rows.length, selectedIndex, detail, panelTextWidth],
  )
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
  const projectHeader = sectionRule(rows.length ? `PROJECT MATRIX ${selectedIndex + 1}/${rows.length}` : "PROJECT MATRIX", sectionTextWidth)
  const projectFooter = rows.length > 0 ? truncate(`FOCUS :: ${selectedIndex + 1}/${rows.length} :: ${detail}`, sectionTextWidth) : truncate(`FOCUS :: ${detail}`, sectionTextWidth)

  const projectPanelStaticHeight = 2 + (loading && !snapshot ? 1 : 0) + (!rows.length && !loading ? 1 : 0)
  const fixedHeight =
    (showBanner ? 3 + panelGap : 0) +
    (3 + statusLines.length + statusMessageLines.length + panelGap) +
    (deleteTarget ? 3 + deleteLines.length + panelGap : 0) +
    (killTarget ? 3 + killLines.length + panelGap : 0) +
    (hideTarget ? 3 + hideLines.length + panelGap : 0) +
    (showAddProjectModal ? 3 + addProjectLineEntries.length + panelGap : 0) +
    (showRenameSessionModal ? 3 + renameSessionLines.length + panelGap : 0) +
    (showThemeModal ? 3 + themeLineEntries.length + panelGap : 0) +
    (showToolsPanel ? 3 + toolsLines.length + panelGap : 0) +
    (mode !== "add-project" && mode !== "rename-session" && mode !== "theme" ? 3 + promptPrimaryLines.length + promptDetail.length + panelGap : 0) +
    projectPanelStaticHeight
  const visibleRowCount = Math.max(1, height - fixedHeight)
  const visibleRows = useMemo(() => windowRows(rows, selectedIndex, visibleRowCount), [rows, selectedIndex, visibleRowCount])
  const firstVisibleIndex = useMemo(() => {
    if (!visibleRows.length) return 0
    return rows.findIndex((row) => row.key === visibleRows[0]?.key)
  }, [rows, visibleRows])

  const mouseContextRef = useRef<{
    mode: Mode
    showBanner: boolean
    panelGap: number
    statusLines: string[]
    statusMessageLines: string[]
    deleteTarget: DeleteTarget | undefined
    deleteLines: string[]
    killTarget: KillTarget | undefined
    killLines: string[]
    hideTarget: HideTarget | undefined
    hideLines: string[]
    showAddProjectModal: boolean
    showRenameSessionModal: boolean
    showThemeModal: boolean
    addProjectLineEntries: ModalLineEntry[]
    renameSessionLines: string[]
    themeLineEntries: ModalLineEntry[]
    loading: boolean
    snapshot: Snapshot | null
    visibleRows: SidebarRow[]
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
    showBanner,
    panelGap,
    statusLines,
    statusMessageLines,
    deleteTarget,
    deleteLines,
    killTarget,
    killLines,
    hideTarget,
    hideLines,
    showAddProjectModal,
    showRenameSessionModal,
    showThemeModal,
    addProjectLineEntries,
    renameSessionLines,
    themeLineEntries,
    loading,
    snapshot,
    visibleRows,
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
      if (ctx.mode !== "browse") return false

      let projectRowsStartY = 2
      if (ctx.showBanner) projectRowsStartY += 3
      projectRowsStartY += ctx.panelGap
      projectRowsStartY += 3 + ctx.statusLines.length + ctx.statusMessageLines.length
      if (ctx.deleteTarget) projectRowsStartY += ctx.panelGap + 3 + ctx.deleteLines.length
      if (ctx.killTarget) projectRowsStartY += ctx.panelGap + 3 + ctx.killLines.length
      if (ctx.hideTarget) projectRowsStartY += ctx.panelGap + 3 + ctx.hideLines.length
      if (ctx.showAddProjectModal) projectRowsStartY += ctx.panelGap + 3 + ctx.addProjectLineEntries.length
      if (ctx.showRenameSessionModal) projectRowsStartY += ctx.panelGap + 3 + ctx.renameSessionLines.length
      if (ctx.showThemeModal) projectRowsStartY += ctx.panelGap + 3 + ctx.themeLineEntries.length
      projectRowsStartY += ctx.panelGap + 1
      if (ctx.loading && !ctx.snapshot) projectRowsStartY += 1
      if (!ctx.loading && ctx.snapshot?.directories.length === 0) projectRowsStartY += 1

      let handled = false
      let scrollDelta = 0
      for (const event of parseSgrMouseInput(input)) {
        if ((event.code & 64) !== 0) {
          if (event.release) continue
          if (event.y < projectRowsStartY || event.y >= projectRowsStartY + ctx.visibleRows.length || !ctx.rows.length) continue
          scrollDelta += (event.code & 1) === 0 ? -1 : 1
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
        if (!row) continue

        const inDirectoryToggle = row.kind === "directory" && event.x <= 5

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

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} paddingTop={1} backgroundColor={theme.base.background}>
      {showBanner ? (
        <Box width={panelOuterWidth} flexDirection="column" borderStyle="single" borderColor={theme.semantic.highlight} paddingX={1}>
          <MascotBanner
            compact={compactLayout}
            width={panelTextWidth}
            busy={hasWorkingSessions}
            activeCount={activeCount}
            recentlyActive={recentlyActive}
            error={error}
            mode={mode}
            theme={theme}
            frame={slowFrame}
          />
        </Box>
      ) : null}

      <Box marginTop={panelGap}>
        <Panel title={statusTitle} width={panelTextWidth} borderColor={theme.semantic.border} titleColor={theme.semantic.info}>
          {statusLines.map((line, index) => (
            <Text key={`status-line-${index}`} color={theme.base.foreground}>
              {fitLine(line, panelTextWidth)}
            </Text>
          ))}
          {statusMessageLines.map((line, index) => (
            <Text key={`status-message-${index}`} color={error ? theme.semantic.error : busy ? theme.semantic.warning : theme.semantic.muted}>
              {fitLine(line, panelTextWidth)}
              {busy && index === statusMessageLines.length - 1 ? <AnimatedSpinner active={true} frame={animFrame} /> : null}
            </Text>
          ))}
        </Panel>
      </Box>

      {deleteTarget ? (
        <Box marginTop={panelGap}>
          <Panel title="DELETE / ARM / CONFIRM" width={panelTextWidth} borderColor={theme.semantic.error} titleColor={theme.semantic.error}>
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
          <Panel title="KILL / WINDOW / CONFIRM" width={panelTextWidth} borderColor={theme.semantic.warning} titleColor={theme.semantic.warning}>
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
          <Panel title="HIDE / PROJECT / CONFIRM" width={panelTextWidth} borderColor={theme.semantic.error} titleColor={theme.semantic.error}>
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
          <Panel title="ADD / PROJECT / FOLDER" width={panelTextWidth} borderColor={theme.semantic.success} titleColor={theme.semantic.success}>
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
          <Panel title="RENAME / SESSION / TITLE" width={panelTextWidth} borderColor={theme.ansi.magenta} titleColor={theme.ansi.magenta}>
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
          <Panel title="THEME / SELECTOR" width={panelTextWidth} borderColor={theme.semantic.highlight} titleColor={theme.semantic.highlight}>
            {themeLineEntries.map((entry, index) => {
              return (
                <Text key={`theme-line-${index}`} color={entry.color} backgroundColor={entry.backgroundColor}>
                  {fitLine(entry.line, panelTextWidth)}
                </Text>
              )
            })}
          </Panel>
        </Box>
      ) : null}

      <Box marginTop={panelGap} flexDirection="column">
        <Text color={theme.semantic.muted}>{truncate(projectHeader, sectionTextWidth)}</Text>
        {loading && !snapshot ? <Text color={theme.semantic.warning}>SYNC :: workspace...</Text> : null}
        {!loading && snapshot?.directories.length === 0 ? <Text color={theme.semantic.muted}>No projects yet. Add a project folder to get started.</Text> : null}
        {visibleRows.map((row, visibleIndex) => {
          const index = firstVisibleIndex + visibleIndex
          const selected = index === selectedIndex
          const selectedForeground: TextColor = selected ? theme.semantic.selectionFg : undefined
          const selectedBackground = selected ? theme.semantic.selectionBg : undefined
          const rowWidth = sectionTextWidth

          if (row.kind === "action") {
            const suffix = "[ADD]"
            const label = ` + ${row.label}`
            const availableWidth = minimumWidth(rowWidth - suffix.length - 1)
            return (
              <Box key={row.key} width={rowWidth} justifyContent="space-between">
                <Text color={selected ? selectedForeground : theme.semantic.success} backgroundColor={selectedBackground} bold>
                  <SelectAnimationGlyph selected={selected} frame={animFrame} />
                  <Text>{truncate(label, availableWidth)}</Text>
                </Text>
                <Text color={selected ? selectedForeground : theme.semantic.muted} backgroundColor={selectedBackground}>
                  {suffix}
                </Text>
              </Box>
            )
          }

          if (row.kind === "directory") {
            const expandedNow = mode === "search" ? true : expanded[row.record.directory] ?? row.record.pinned
            const activeDirectoryCount = row.record.activeSessionIDs.length
            const hasWorkingSession = row.record.sessions.some((session) => sessionIsWorking(session.status))
            const hasCompleted = row.record.sessions.some((session) => sessionJustCompleted(session.status))
            const marker = activeDirectoryCount > 0 ? "|" : hasCompleted ? "*" : " "
            const suffix = activeDirectoryCount > 0 ? `${activeDirectoryCount}/${row.record.sessions.length}` : `${row.record.sessions.length}`
            const label = `${expandedNow ? "v" : ">"} ${row.record.label}`
            const availableWidth = minimumWidth(rowWidth - suffix.length - 5)
            return (
              <Box key={row.key} width={rowWidth} justifyContent="space-between">
                <Text color={selected ? selectedForeground : theme.semantic.info} backgroundColor={selectedBackground} bold>
                  {hasWorkingSession ? <LiveActivityGlyph active={true} frame={animFrame} /> : <Text>{marker}</Text>}
                  <Text>{truncate(` ${label}`, availableWidth - 1)}</Text>
                </Text>
                <Text color={selected ? selectedForeground : hasCompleted ? theme.semantic.error : theme.semantic.muted} backgroundColor={selectedBackground}>
                  {suffix}
                </Text>
              </Box>
            )
          }

          const isActive = row.record.activeSessionIDs.includes(row.session.id)
          const isPreview = snapshot?.previewSessionID === row.session.id
          const isWorking = sessionIsWorking(row.session.status)
          const completion = sessionJustCompleted(row.session.status)
          const suffix = relativeTime(row.session.time.updated, now)
          const marker = completion ? "*" : isPreview ? ">" : isActive ? "|" : "."
          const leftWidth = minimumWidth(rowWidth - suffix.length - 1)
          const titleWidth = minimumWidth(leftWidth - 5)
          const color: TextColor = selected
            ? selectedForeground
            : completion
              ? theme.semantic.error
              : isWorking || isActive
                ? theme.semantic.success
                : isPreview
                  ? theme.ansi.magenta
                  : theme.base.foreground
          const markerColor: TextColor = selected ? selectedForeground : isWorking ? theme.semantic.success : completion ? theme.semantic.error : isPreview ? theme.ansi.magenta : isActive ? theme.semantic.success : theme.semantic.muted
          return (
            <Box key={row.key} width={rowWidth} justifyContent="space-between">
              <Box width={leftWidth}>
                <Text color={color} backgroundColor={selectedBackground}>
                  {"|-- "}
                </Text>
                {isWorking ? (
                  <LiveActivityGlyph active={true} frame={animFrame} />
                ) : (
                  <Text color={markerColor} backgroundColor={selectedBackground}>
                    {marker}
                  </Text>
                )}
                <Text color={color} backgroundColor={selectedBackground}>
                  {truncate(` ${row.session.title || "New session"}`, titleWidth)}
                </Text>
              </Box>
              <Text color={selected ? selectedForeground : completion ? theme.semantic.error : theme.semantic.muted} backgroundColor={selectedBackground}>
                {suffix}
              </Text>
            </Box>
          )
        })}
        <Text color={theme.semantic.muted}>{truncate(projectFooter, sectionTextWidth)}</Text>
      </Box>

      {showToolsPanel ? (
        <Box marginTop={panelGap}>
          <Panel title="SHORTCUTS" width={panelTextWidth} borderColor={theme.semantic.border} titleColor={theme.semantic.info}>
            {toolsLines.map((line, index) => {
              const segments = line.split(/(\[.*?\])/g)
              return (
                <Text key={`tool-${index}`}>
                  {segments.map((segment, segIndex) => {
                    if (segment.startsWith("[") && segment.endsWith("]")) {
                      return <Text key={segIndex} color={theme.semantic.info}>{segment}</Text>
                    }
                    return <Text key={segIndex} color={theme.semantic.muted}>{segment}</Text>
                  })}
                </Text>
              )
            })}
          </Panel>
        </Box>
      ) : null}

      {mode !== "add-project" && mode !== "rename-session" && mode !== "theme" ? (
        <Box width={panelOuterWidth} marginTop={panelGap} borderStyle="single" borderColor={mode === "browse" ? theme.semantic.border : theme.semantic.success} flexDirection="column" paddingX={1}>
          {mode === "search" ? (
              <Text color={theme.semantic.success}>
                {fitLine(`/ ${inputValue}`, panelTextWidth - 1)}
                <BlinkingCursor frame={animFrame} />
              </Text>
          ) : (
            promptPrimaryLines.map((line, index) => (
              <Text key={`prompt-primary-${index}`} color={mode === "browse" ? theme.base.foreground : theme.semantic.success}>
                {fitLine(line, panelTextWidth)}
              </Text>
            ))
          )}
          {promptDetail.map((line, index) => (
            <Text key={`prompt-${index}`} color={theme.semantic.muted}>
              {fitLine(line, panelTextWidth)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
