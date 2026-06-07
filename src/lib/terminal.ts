import type { ActiveSessionRecord, OpenResult, TerminalBackendName } from "./types.js"
export { getPreviewSessionMeta } from "./tmux.js"
import {
  ensureTmuxLayout,
  findAnyWindowBySessionID,
  findBackgroundWindowBySessionID,
  getOrCreateSidebarOwnerID,
  getSidebarOwnerID,
  getPreviewSessionMeta,
  isMouseModeEnabled,
  isTmux,
  killSessionWindowBySessionID,
  listOwnedSessionWindows,
  listActiveSessionWindows,
  parkPreviewSession,
  pruneBackgroundSessions,
  renameSessionWindow,
  resetCurrentPaneBackground,
  respawnPane,
  setCurrentPaneBackground,
  setPaneBackground,
  setPaneSession,
  setPreviewSession,
  setPaneTitle,
  swapPreviewWithSessionPane,
} from "./tmux.js"
import { sessionWindowTitle } from "./util.js"

type OpenInput = {
  sessionID: string
  directory: string
  title: string
  baseUrl: string
  background?: string
}

export function describeTerminalBackend(): TerminalBackendName {
  if (!isTmux()) {
    throw new Error("This launcher now supports tmux mode only")
  }
  return "tmux"
}

export async function listActiveSessions(): Promise<ActiveSessionRecord[]> {
  return listActiveSessionWindows()
}

export async function hasRunningSessionWindow(sessionID: string) {
  return Boolean(await findAnyWindowBySessionID(sessionID))
}

export async function killSessionWindow(sessionID: string) {
  return killSessionWindowBySessionID(sessionID)
}

export async function retitleSessionWindow(sessionID: string, directory: string, title: string) {
  return renameSessionWindow(sessionID, directory, title)
}

export async function cleanupSidebarSessions(sessionIDs: Iterable<string>) {
  const results = [] as boolean[]
  for (const sessionID of sessionIDs) {
    results.push(await killSessionWindowBySessionID(sessionID).catch(() => false))
  }
  return results
}

export async function listOwnedSessions() {
  const ownerID = await getSidebarOwnerID()
  if (!ownerID) return []
  return listOwnedSessionWindows(ownerID)
}

export async function getPreviewSessionID() {
  const preview = await getPreviewSessionMeta()
  return preview?.sessionID
}

export async function isTmuxMouseModeEnabled() {
  return isMouseModeEnabled()
}

export async function setTerminalBackground(background: string) {
  if (!isTmux()) return
  await setCurrentPaneBackground(background)
}

export async function resetTerminalBackground() {
  if (!isTmux()) return
  await resetCurrentPaneBackground()
}

export async function openSessionWithPreferredTerminal(input: OpenInput): Promise<OpenResult> {
  let { rightPaneID } = await ensureTmuxLayout(input.directory)
  const previewSession = await getPreviewSessionMeta()
  const ownerID = await getOrCreateSidebarOwnerID()

  if (previewSession?.paneID) {
    rightPaneID = previewSession.paneID
  }

  if (previewSession?.sessionID === input.sessionID) {
    return {
      action: "focused",
      sessionID: input.sessionID,
      backend: "tmux",
    }
  }

  const parkedSession = await findBackgroundWindowBySessionID(input.sessionID)
  if (parkedSession) {
    await swapPreviewWithSessionPane({
      previewPaneID: rightPaneID,
      sessionPaneID: parkedSession.paneID,
      hiddenWindowID: parkedSession.windowID,
      previewSession,
      nextSession: {
        sessionID: input.sessionID,
        directory: input.directory,
        title: input.title,
      },
      ownerID,
    })
    await pruneBackgroundSessions({
      keepSessionIDs: [input.sessionID],
    })
    return {
      action: "focused",
      sessionID: input.sessionID,
      backend: "tmux",
    }
  }

  if (previewSession && previewSession.sessionID !== input.sessionID) {
    await parkPreviewSession({
      previewPaneID: rightPaneID,
      sessionID: previewSession.sessionID,
      directory: previewSession.directory,
      title: previewSession.title,
      ownerID,
    })
    rightPaneID = (await ensureTmuxLayout(input.directory)).rightPaneID
  }

  if (input.background) {
    await setPaneBackground(rightPaneID, input.background)
  }

  await respawnPane(rightPaneID, input.directory, [
    "opencode",
    "attach",
    input.baseUrl,
    "--dir",
    input.directory,
    "--session",
    input.sessionID,
  ])
  await setPaneSession({
    paneID: rightPaneID,
    sessionID: input.sessionID,
    directory: input.directory,
    title: input.title,
    ownerID,
  })
  await setPaneTitle(rightPaneID, sessionWindowTitle(input.directory, input.title))
  await setPreviewSession({
    sessionID: input.sessionID,
    directory: input.directory,
    title: input.title,
    paneID: rightPaneID,
  })
  await pruneBackgroundSessions({
    keepSessionIDs: [input.sessionID],
  })

  return {
    action: "focused",
    sessionID: input.sessionID,
    backend: "tmux",
  }
}

export async function restartSession(paneID: string, cwd: string, sessionID: string, baseUrl: string) {
  await respawnPane(paneID, cwd, [
    "opencode",
    "attach",
    baseUrl,
    "--dir",
    cwd,
    "--session",
    sessionID,
  ])
}
