import type { ActiveSessionRecord, OpenResult, TerminalBackendName } from "./types.js"
import {
  ensureTmuxLayout,
  findBackgroundWindowBySessionID,
  getPreviewSessionMeta,
  isTmux,
  listActiveSessionWindows,
  parkPreviewSession,
  respawnPane,
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
  await setPaneTitle(rightPaneID, sessionWindowTitle(input.directory, input.title))
  await setPreviewSession({
    sessionID: input.sessionID,
    directory: input.directory,
    title: input.title,
    paneID: rightPaneID,
  })

  return {
    action: "focused",
    sessionID: input.sessionID,
    backend: "tmux",
  }
}
