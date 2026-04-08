import type { ActiveSessionRecord, OpenResult, TerminalBackendName } from "./types.js"
import {
  ensureTmuxLayout,
  findAnyWindowBySessionID,
  findBackgroundWindowBySessionID,
  getPreviewSessionMeta,
  isTmux,
  killSessionWindowBySessionID,
  listActiveSessionWindows,
  parkPreviewSession,
  pruneBackgroundSessions,
  respawnPane,
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

export async function cleanupSidebarSessions(sessionIDs: Iterable<string>) {
  const results = [] as boolean[]
  for (const sessionID of sessionIDs) {
    results.push(await killSessionWindowBySessionID(sessionID).catch(() => false))
  }
  return results
}

export async function getPreviewSessionID() {
  const preview = await getPreviewSessionMeta()
  return preview?.sessionID
}

export async function openSessionWithPreferredTerminal(input: OpenInput): Promise<OpenResult> {
  let { rightPaneID } = await ensureTmuxLayout(input.directory)
  const previewSession = await getPreviewSessionMeta()

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
    })
    rightPaneID = (await ensureTmuxLayout(input.directory)).rightPaneID
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
