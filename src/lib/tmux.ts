import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { MAX_BACKGROUND_SESSIONS } from "./constants.js"
import type { ActiveSessionRecord } from "./types.js"
import { sessionWindowTitle, tmuxWindowName } from "./util.js"

const execFileAsync = promisify(execFile)
let cachedRightPaneID: string | undefined
const SESSION_OPTION = "@opencode_session_id"
const DIRECTORY_OPTION = "@opencode_directory"
const TITLE_OPTION = "@opencode_title"
const PREVIEW_SESSION_OPTION = "@opencode_preview_session_id"
const PREVIEW_DIRECTORY_OPTION = "@opencode_preview_directory"
const PREVIEW_TITLE_OPTION = "@opencode_preview_title"
const PREVIEW_PANE_OPTION = "@opencode_preview_pane_id"

async function runTmux(args: string[]) {
  const { stdout } = await execFileAsync("tmux", args, {
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

async function getPaneWidth(paneID: string) {
  return Number(
    await runTmux([
      "display-message",
      "-p",
      "-t",
      paneID,
      "#{pane_width}",
    ]),
  )
}

export function isTmux() {
  return Boolean(process.env.TMUX && process.env.TMUX_PANE)
}

export async function getCurrentPaneID() {
  if (!process.env.TMUX_PANE) throw new Error("Not running inside tmux")
  return process.env.TMUX_PANE
}

export async function getSessionName() {
  return runTmux(["display-message", "-p", "#{session_name}"])
}

export async function listActiveSessionWindows(): Promise<ActiveSessionRecord[]> {
  const session = await getSessionName()
  const output = await runTmux([
    "list-panes",
    "-a",
    "-t",
    session,
    "-F",
      `#{pane_id}\t#{window_id}\t#{window_name}\t#{window_active}\t#{${SESSION_OPTION}}\t#{${DIRECTORY_OPTION}}\t#{${TITLE_OPTION}}`,
    ])

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((parts) => parts[4])
    .map(([paneID, windowID, windowName, active, sessionID, directory, title]) => ({
      paneID,
      windowID,
      windowName,
      active: active === "1",
      sessionID,
      directory,
      title,
    }))
}

export function trimBackgroundSessions(records: ActiveSessionRecord[], maxBackgroundSessions = MAX_BACKGROUND_SESSIONS) {
  if (maxBackgroundSessions < 0) return []
  return [...records]
    .filter((record) => !record.active)
    .sort((a, b) => {
      const windowA = Number(a.windowID.replace(/^@/, ""))
      const windowB = Number(b.windowID.replace(/^@/, ""))
      return windowA - windowB
    })
    .slice(0, Math.max(0, records.filter((record) => !record.active).length - maxBackgroundSessions))
}

export async function findWindowBySessionID(sessionID: string) {
  const windows = await listActiveSessionWindows()
  return windows.find((window) => window.sessionID === sessionID)
}

export async function findBackgroundWindowBySessionID(sessionID: string) {
  const preview = await getPreviewSessionMeta()
  const windows = await listActiveSessionWindows()
  return windows.find((window) => {
    if (window.sessionID !== sessionID) return false
    if (preview?.paneID && window.paneID === preview.paneID) return false
    return !window.active || Boolean(window.sessionID)
  })
}

export async function findAnyWindowBySessionID(sessionID: string) {
  const preview = await getPreviewSessionMeta()
  const windows = await listActiveSessionWindows()
  const previewWindow = preview?.paneID ? windows.find((window) => window.paneID === preview.paneID) : undefined
  if (previewWindow?.sessionID === sessionID) {
    return {
      ...previewWindow,
      preview: true,
    }
  }
  const parked = windows.find((window) => window.sessionID === sessionID)
  if (!parked) return undefined
  return {
    ...parked,
    preview: false,
  }
}

export async function setPreviewSession(input: {
  sessionID: string
  directory: string
  title: string
  paneID?: string
}) {
  const session = await getSessionName()
  await runTmux(["set-option", "-t", session, PREVIEW_SESSION_OPTION, input.sessionID])
  await runTmux(["set-option", "-t", session, PREVIEW_DIRECTORY_OPTION, input.directory])
  await runTmux(["set-option", "-t", session, PREVIEW_TITLE_OPTION, input.title])
  if (input.paneID) {
    await runTmux(["set-option", "-t", session, PREVIEW_PANE_OPTION, input.paneID])
  }
}

export async function getPreviewSession() {
  const session = await getSessionName()
  const value = await runTmux(["show-options", "-v", "-t", session, PREVIEW_SESSION_OPTION]).catch(() => "")
  return value || undefined
}

export async function getPreviewSessionMeta() {
  const sessionID = await getPreviewSession()
  if (!sessionID) return undefined
  const session = await getSessionName()
  const directory = await runTmux(["show-options", "-v", "-t", session, PREVIEW_DIRECTORY_OPTION]).catch(() => "")
  const title = await runTmux(["show-options", "-v", "-t", session, PREVIEW_TITLE_OPTION]).catch(() => "")
  const paneID = await runTmux(["show-options", "-v", "-t", session, PREVIEW_PANE_OPTION]).catch(() => "")
  return {
    sessionID,
    directory,
    title,
    paneID,
  }
}

export async function clearPreviewSession() {
  const session = await getSessionName()
  await runTmux(["set-option", "-u", "-t", session, PREVIEW_SESSION_OPTION]).catch(() => {})
  await runTmux(["set-option", "-u", "-t", session, PREVIEW_DIRECTORY_OPTION]).catch(() => {})
  await runTmux(["set-option", "-u", "-t", session, PREVIEW_TITLE_OPTION]).catch(() => {})
  await runTmux(["set-option", "-u", "-t", session, PREVIEW_PANE_OPTION]).catch(() => {})
}

export async function killSessionWindowBySessionID(sessionID: string) {
  const preview = await getPreviewSessionMeta()
  if (preview?.sessionID === sessionID && preview.paneID) {
    await clearPreviewSession()
    await killPane(preview.paneID).catch(() => {})
    return true
  }
  const target = await findAnyWindowBySessionID(sessionID)
  if (!target) return false
  if (target.preview) {
    await clearPreviewSession()
  }
  await killWindow(target.windowID)
  return true
}

export async function getCurrentWindowID() {
  return runTmux(["display-message", "-p", "#{window_id}"])
}

export async function killWindow(windowID: string) {
  await runTmux(["kill-window", "-t", windowID])
}

export async function killPane(paneID: string) {
  await runTmux(["kill-pane", "-t", paneID])
}

export async function pruneBackgroundSessions(options?: {
  keepSessionIDs?: string[]
  maxBackgroundSessions?: number
}) {
  const keep = new Set(options?.keepSessionIDs ?? [])
  const windows = await listActiveSessionWindows()
  const victims = trimBackgroundSessions(
    windows.filter((window) => !keep.has(window.sessionID)),
    options?.maxBackgroundSessions,
  )

  for (const window of victims) {
    await killWindow(window.windowID).catch(() => {})
  }

  return victims
}

export async function clearWindowSession(windowID: string) {
  await runTmux(["set-option", "-u", "-w", "-t", windowID, SESSION_OPTION]).catch(() => {})
  await runTmux(["set-option", "-u", "-w", "-t", windowID, DIRECTORY_OPTION]).catch(() => {})
  await runTmux(["set-option", "-u", "-w", "-t", windowID, TITLE_OPTION]).catch(() => {})
}

export async function setPaneSession(input: {
  paneID: string
  sessionID: string
  directory: string
  title: string
}) {
  await runTmux(["set-option", "-p", "-t", input.paneID, SESSION_OPTION, input.sessionID]).catch(() => {})
  await runTmux(["set-option", "-p", "-t", input.paneID, DIRECTORY_OPTION, input.directory]).catch(() => {})
  await runTmux(["set-option", "-p", "-t", input.paneID, TITLE_OPTION, input.title]).catch(() => {})
}

export async function getRightPaneID(selectorPaneID: string) {
  if (cachedRightPaneID) {
    const all = await runTmux(["list-panes", "-a", "-F", "#{pane_id}"]).catch(() => "")
    if (all.split("\n").includes(cachedRightPaneID)) {
      return cachedRightPaneID
    }
    cachedRightPaneID = undefined
  }

  const pane = await runTmux([
    "list-panes",
    "-t",
    selectorPaneID,
    "-F",
    "#{pane_id} #{pane_left}",
  ])

  const selectorLeft = Number(
    await runTmux([
      "display-message",
      "-p",
      "-t",
      selectorPaneID,
      "#{pane_left}",
    ]),
  )

  let nearest: { paneID: string; left: number } | undefined
  for (const line of pane.split("\n")) {
    const [paneID, left] = line.trim().split(" ")
    if (!paneID || left === undefined) continue
    if (paneID === selectorPaneID) continue
    const numericLeft = Number(left)
    if (numericLeft <= selectorLeft) continue
    if (!nearest || numericLeft < nearest.left) {
      nearest = { paneID, left: numericLeft }
    }
  }

  if (nearest) {
    cachedRightPaneID = nearest.paneID
    return nearest.paneID
  }

  return undefined
}

export async function splitRightPane(selectorPaneID: string, cwd: string) {
  const totalWidth = await getPaneWidth(selectorPaneID)
  const idealSidebarWidth = 52
  const minimumSidebarWidth = 36
  const minimumRightWidth = 44
  const sidebarWidth = Math.max(minimumSidebarWidth, Math.min(idealSidebarWidth, totalWidth - minimumRightWidth))
  const rightWidth = Math.max(1, totalWidth - sidebarWidth)

  const paneID = await runTmux([
    "split-window",
    "-h",
    "-d",
    "-t",
    selectorPaneID,
    "-l",
    String(rightWidth),
    "-c",
    cwd,
    "-P",
    "-F",
    "#{pane_id}",
    "",
  ])
  cachedRightPaneID = paneID
  return paneID
}

export async function respawnPane(paneID: string, cwd: string, command: string[]) {
  await runTmux([
    "respawn-pane",
    "-k",
    "-t",
    paneID,
    "-c",
    cwd,
    ...command,
  ])
}

export async function selectPane(paneID: string) {
  await runTmux(["select-pane", "-t", paneID])
}

export async function setPaneTitle(paneID: string, title: string) {
  await runTmux(["select-pane", "-t", paneID, "-T", title])
}

export async function getPaneWindowID(paneID: string) {
  return runTmux(["display-message", "-p", "-t", paneID, "#{window_id}"])
}

export async function bindToggleKeys(selectorPaneID: string) {
  const rightPaneID = await getRightPaneID(selectorPaneID)
  if (!rightPaneID) return
  const session = await getSessionName()
  await runTmux(["bind-key", "-n", "M-]", "select-pane", "-t", rightPaneID])
  await runTmux(["bind-key", "-n", "M-b", "select-window", "-t", `${session}:0`])
}

export async function ensureTmuxLayout(cwd: string) {
  const selectorPaneID = await getCurrentPaneID()
  let rightPaneID = await getRightPaneID(selectorPaneID)
  if (!rightPaneID) {
    rightPaneID = await splitRightPane(selectorPaneID, cwd)
  }
  await bindToggleKeys(selectorPaneID)
  return {
    selectorPaneID,
    rightPaneID,
  }
}

export async function swapPreviewWithSessionPane(input: {
  previewPaneID: string
  sessionPaneID: string
  hiddenWindowID: string
  previewSession?: {
    sessionID: string
    directory: string
    title: string
    paneID?: string
  }
  nextSession: {
    sessionID: string
    directory: string
    title: string
  }
}) {
  await runTmux(["swap-pane", "-d", "-s", input.sessionPaneID, "-t", input.previewPaneID])

  cachedRightPaneID = input.sessionPaneID

  await setPreviewSession({
    ...input.nextSession,
    paneID: input.sessionPaneID,
  })
  await setPaneSession({
    paneID: input.sessionPaneID,
    sessionID: input.nextSession.sessionID,
    directory: input.nextSession.directory,
    title: input.nextSession.title,
  })
  const launcherWindowID = await getCurrentWindowID()
  await clearWindowSession(launcherWindowID)

  if (input.previewSession) {
    await runTmux(["rename-window", "-t", input.hiddenWindowID, tmuxWindowName(input.previewSession.directory, input.previewSession.title)]).catch(() => {})
    await runTmux(["set-option", "-w", "-t", input.hiddenWindowID, SESSION_OPTION, input.previewSession.sessionID]).catch(() => {})
    await runTmux(["set-option", "-w", "-t", input.hiddenWindowID, DIRECTORY_OPTION, input.previewSession.directory]).catch(() => {})
    await runTmux(["set-option", "-w", "-t", input.hiddenWindowID, TITLE_OPTION, input.previewSession.title]).catch(() => {})
  } else {
    await killWindow(input.hiddenWindowID)
  }

  await setPaneTitle(input.sessionPaneID, sessionWindowTitle(input.nextSession.directory, input.nextSession.title))
}

export async function parkPreviewSession(input: {
  previewPaneID: string
  sessionID: string
  directory: string
  title: string
}) {
  const output = await runTmux([
    "break-pane",
    "-d",
    "-s",
    input.previewPaneID,
    "-P",
    "-F",
    "#{window_id}\t#{pane_id}",
  ])
  const [windowID, paneID] = output.split("\t")
  cachedRightPaneID = undefined
  await runTmux(["rename-window", "-t", windowID, tmuxWindowName(input.directory, input.title)]).catch(() => {})
  await runTmux(["set-option", "-w", "-t", windowID, SESSION_OPTION, input.sessionID]).catch(() => {})
  await runTmux(["set-option", "-w", "-t", windowID, DIRECTORY_OPTION, input.directory]).catch(() => {})
  await runTmux(["set-option", "-w", "-t", windowID, TITLE_OPTION, input.title]).catch(() => {})
  await clearPreviewSession()
  return {
    windowID,
    paneID,
  }
}
