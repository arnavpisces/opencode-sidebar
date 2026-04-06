import type { ActiveSessionRecord, DirectoryRecord, PaneRecord, ProjectRecord, SessionRecord, Snapshot } from "./types.js"
import { directoryLabel, directorySubtitle } from "./util.js"

function openSessionSet(panes: PaneRecord[]) {
  const result = new Set<string>()
  for (const pane of panes) {
    if (!pane.workspace.startsWith("opencode-session-")) continue
    result.add(pane.workspace.slice("opencode-session-".length))
  }
  return result
}

function buildProjectMaps(projects: ProjectRecord[]) {
  const byDirectory = new Map<string, { label?: string; root?: string }>()
  for (const project of projects) {
    byDirectory.set(project.worktree, {
      label: project.name,
      root: project.worktree,
    })
    for (const sandbox of project.sandboxes) {
      byDirectory.set(sandbox, {
        root: project.worktree,
      })
    }
  }
  return byDirectory
}

export function buildSnapshot(input: {
  baseUrl: string
  serverPort: number
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  pinnedDirectories: string[]
  panes: PaneRecord[]
  activeSessions?: ActiveSessionRecord[]
  previewSessionID?: string
}): Snapshot {
  const projectMap = buildProjectMaps(input.projects)
  const openedSessions = openSessionSet(input.panes)
  const directoryMap = new Map<string, DirectoryRecord>()

  const ensureDirectory = (directory: string) => {
    let current = directoryMap.get(directory)
    if (current) return current
    const projectInfo = projectMap.get(directory)
    current = {
      directory,
      label: directoryLabel(directory, projectInfo?.label),
      subtitle: directorySubtitle(directory, projectInfo?.root),
      pinned: input.pinnedDirectories.includes(directory),
      sessions: [],
      openSessionIDs: new Set<string>(),
      activeSessionIDs: new Set<string>(),
    }
    directoryMap.set(directory, current)
    return current
  }

  for (const project of input.projects) {
    ensureDirectory(project.worktree)
    for (const sandbox of project.sandboxes) ensureDirectory(sandbox)
  }

  for (const directory of input.pinnedDirectories) {
    ensureDirectory(directory).pinned = true
  }

  for (const session of input.sessions) {
    const record = ensureDirectory(session.directory)
    record.sessions.push(session)
    record.lastUpdated = Math.max(record.lastUpdated ?? 0, session.time.updated)
    if (openedSessions.has(session.id)) {
      record.openSessionIDs.add(session.id)
    }
  }

  for (const activeSession of input.activeSessions ?? []) {
    const record = ensureDirectory(activeSession.directory)
    record.activeSessionIDs.add(activeSession.sessionID)
    record.openSessionIDs.add(activeSession.sessionID)
  }

  const pinnedRank = new Map(input.pinnedDirectories.map((directory, index) => [directory, index]))

  const directories = [...directoryMap.values()]
    .map((record) => ({
      ...record,
      sessions: [...record.sessions].sort((a: SessionRecord, b: SessionRecord) => b.time.updated - a.time.updated),
    }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.pinned && b.pinned) return (pinnedRank.get(a.directory) ?? 0) - (pinnedRank.get(b.directory) ?? 0)
      const recentA = a.lastUpdated ?? 0
      const recentB = b.lastUpdated ?? 0
      if (recentA !== recentB) return recentB - recentA
      return a.label.localeCompare(b.label)
    })

  return {
    directories,
    activeSessions: input.activeSessions ?? [],
    previewSessionID: input.previewSessionID,
    serverPort: input.serverPort,
    baseUrl: input.baseUrl,
    loadedAt: Date.now(),
  }
}
