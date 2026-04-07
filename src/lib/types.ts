export type PersistedState = {
  serverPort: number
  pinnedDirectories: string[]
}

export type ProjectRecord = {
  id?: string
  name?: string
  worktree: string
  sandboxes: string[]
}

export type SessionRecord = {
  id: string
  title: string
  directory: string
  status?: SessionRuntimeStatus
  time: {
    created: number
    updated: number
    archived?: number
  }
  project?: {
    id: string
    name?: string
    worktree: string
  } | null
}

export type PaneRecord = {
  window_id: number
  tab_id: number
  pane_id: number
  workspace: string
  title: string
  cwd?: string
}

export type ActiveSessionRecord = {
  sessionID: string
  paneID: string
  windowID: string
  windowName: string
  directory: string
  title: string
  active: boolean
}

export type SessionRuntimeStatus =
  | {
      type: "idle"
      justCompleted?: boolean
    }
  | {
      type: "busy"
    }
  | {
      type: "retry"
      attempt: number
      message: string
      next: number
    }

export type DirectoryRecord = {
  directory: string
  label: string
  subtitle: string
  pinned: boolean
  sessions: SessionRecord[]
  openSessionIDs: Set<string>
  activeSessionIDs: Set<string>
  lastUpdated?: number
}

export type Snapshot = {
  directories: DirectoryRecord[]
  activeSessions: ActiveSessionRecord[]
  previewSessionID?: string
  serverPort: number
  baseUrl: string
  loadedAt: number
}

export type DirectoryRow = {
  key: string
  kind: "directory"
  record: DirectoryRecord
}

export type SessionRow = {
  key: string
  kind: "session"
  record: DirectoryRecord
  session: SessionRecord
}

export type SidebarActionRow = {
  key: string
  kind: "action"
  action: "add-project"
  label: string
  detail: string
}

export type SidebarRow = DirectoryRow | SessionRow | SidebarActionRow

export type OpenResult = {
  action: "focused" | "opened"
  sessionID: string
  backend?: string
  windowID?: string
}

export type TerminalBackendName = "tmux"
