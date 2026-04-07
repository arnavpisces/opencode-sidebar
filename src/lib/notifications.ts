import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Event as OpenCodeEvent, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { Snapshot } from "./types.js"

type SessionMeta = {
  sessionID: string
  title: string
  directory: string
  updated: number
}

export type NotificationEffect = {
  id: string
  kind: "attention" | "completion"
  title: string
  detail: string
}

const MACOS_SOUND_DIR = "/System/Library/Sounds"
const DEFAULT_ATTENTION_SOUND = "Glass"
const DEFAULT_COMPLETION_SOUND = "Ping"
const COMPLETION_SUPPRESSION_WINDOW_MS = 4_000

function sessionIsWorking(status?: Snapshot["directories"][number]["sessions"][number]["status"]) {
  return status?.type === "busy" || status?.type === "retry"
}

function resolveConfiguredSoundPath(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const expanded = trimmed.startsWith("~/") ? path.join(process.env.HOME ?? "", trimmed.slice(2)) : trimmed
  if (expanded.includes("/") || expanded.startsWith(".")) {
    return path.resolve(expanded)
  }

  const fileName = /\.(aiff|wav|caf|mp3|m4a)$/i.test(expanded) ? expanded : `${expanded}.aiff`
  return path.join(MACOS_SOUND_DIR, fileName)
}

function playTerminalBell() {
  try {
    process.stdout.write("\u0007")
  } catch {
    // Ignore notifier fallback errors.
  }
}

export function notificationAudioMode() {
  if (process.env.OPENCODE_SIDEBAR_NOTIFY === "0") return "off" as const
  if (process.platform === "darwin") return "afplay" as const
  return "bell" as const
}

export function playNotificationEffect(effect: NotificationEffect) {
  const mode = notificationAudioMode()
  if (mode === "off") return
  if (mode === "bell") {
    playTerminalBell()
    return
  }

  const configuredSound =
    effect.kind === "attention"
      ? process.env.OPENCODE_SIDEBAR_NOTIFY_ATTENTION_SOUND ?? DEFAULT_ATTENTION_SOUND
      : process.env.OPENCODE_SIDEBAR_NOTIFY_COMPLETE_SOUND ?? DEFAULT_COMPLETION_SOUND
  const soundPath = resolveConfiguredSoundPath(configuredSound)
  if (!soundPath || !fs.existsSync(soundPath)) {
    playTerminalBell()
    return
  }

  const child = spawn("/usr/bin/afplay", [soundPath], {
    stdio: "ignore",
  })
  child.once("error", () => {
    playTerminalBell()
  })
  child.unref()
}

export class NotificationTracker {
  private initialized = false
  private busySessionIDs = new Set<string>()
  private sessionByID = new Map<string, SessionMeta>()
  private seenQuestionRequestIDs = new Set<string>()
  private seenPermissionRequestIDs = new Set<string>()
  private lastCompletionAt = new Map<string, number>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  syncSnapshot(snapshot: Snapshot) {
    const nextBusySessionIDs = new Set<string>()
    const nextSessionByID = new Map<string, SessionMeta>()
    const effects: NotificationEffect[] = []

    for (const record of snapshot.directories) {
      for (const session of record.sessions) {
        nextSessionByID.set(session.id, {
          sessionID: session.id,
          title: session.title || "New session",
          directory: record.directory,
          updated: session.time.updated,
        })
        if (sessionIsWorking(session.status)) {
          nextBusySessionIDs.add(session.id)
        }
      }
    }

    if (this.initialized) {
      for (const sessionID of this.busySessionIDs) {
        if (nextBusySessionIDs.has(sessionID)) continue
        const session = nextSessionByID.get(sessionID)
        if (!session) continue
        const effect = this.maybeEmitCompletion(session)
        if (effect) effects.push(effect)
      }
    } else {
      this.initialized = true
    }

    this.busySessionIDs = nextBusySessionIDs
    this.sessionByID = nextSessionByID
    return effects
  }

  syncPendingRequests(input: { questions: QuestionRequest[]; permissions: PermissionRequest[] }) {
    const effects: NotificationEffect[] = []
    const nextQuestionRequestIDs = new Set<string>()
    const nextPermissionRequestIDs = new Set<string>()

    for (const request of input.questions) {
      nextQuestionRequestIDs.add(request.id)
      if (this.seenQuestionRequestIDs.has(request.id)) continue
      const session = this.sessionByID.get(request.sessionID)
      effects.push(
        this.createAttentionEffect(
          `question:${request.id}`,
          session?.title || "OpenCode needs input",
          session?.directory || "Pending question",
        ),
      )
    }

    for (const request of input.permissions) {
      nextPermissionRequestIDs.add(request.id)
      if (this.seenPermissionRequestIDs.has(request.id)) continue
      const session = this.sessionByID.get(request.sessionID)
      effects.push(
        this.createAttentionEffect(
          `permission:${request.id}`,
          session?.title || "OpenCode needs approval",
          session?.directory || "Pending permission",
        ),
      )
    }

    this.seenQuestionRequestIDs = nextQuestionRequestIDs
    this.seenPermissionRequestIDs = nextPermissionRequestIDs
    return effects
  }

  handleEvent(input: { directory: string; event: OpenCodeEvent }) {
    const { directory, event } = input
    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.updateSessionMeta({
          sessionID: event.properties.sessionID,
          title: event.properties.info.title || "New session",
          directory: event.properties.info.directory || directory,
          updated: event.properties.info.time.updated,
        })
        return []

      case "session.deleted":
        this.sessionByID.delete(event.properties.sessionID)
        this.busySessionIDs.delete(event.properties.sessionID)
        this.lastCompletionAt.delete(event.properties.sessionID)
        return []

      case "question.asked": {
        if (this.seenQuestionRequestIDs.has(event.properties.id)) return []
        this.seenQuestionRequestIDs.add(event.properties.id)
        const session = this.sessionByID.get(event.properties.sessionID)
        return [
          this.createAttentionEffect(
            `question:${event.properties.id}`,
            session?.title || "OpenCode needs input",
            session?.directory || directory,
          ),
        ]
      }

      case "question.replied":
      case "question.rejected":
        this.seenQuestionRequestIDs.delete(event.properties.requestID)
        return []

      case "permission.asked": {
        if (this.seenPermissionRequestIDs.has(event.properties.id)) return []
        this.seenPermissionRequestIDs.add(event.properties.id)
        const session = this.sessionByID.get(event.properties.sessionID)
        return [
          this.createAttentionEffect(
            `permission:${event.properties.id}`,
            session?.title || "OpenCode needs approval",
            session?.directory || directory,
          ),
        ]
      }

      case "permission.replied":
        this.seenPermissionRequestIDs.delete(event.properties.requestID)
        return []

      case "session.status":
        if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
          this.busySessionIDs.add(event.properties.sessionID)
          return []
        }
        return this.completeFromEvent(event.properties.sessionID, directory)

      case "session.idle":
        return this.completeFromEvent(event.properties.sessionID, directory)

      default:
        return []
    }
  }

  private completeFromEvent(sessionID: string, directory: string) {
    if (!this.busySessionIDs.has(sessionID)) return []
    this.busySessionIDs.delete(sessionID)
    const session = this.sessionByID.get(sessionID)
    const effect = this.maybeEmitCompletion(
      session ?? {
        sessionID,
        title: "OpenCode finished processing",
        directory,
        updated: this.now(),
      },
    )
    return effect ? [effect] : []
  }

  private createAttentionEffect(id: string, title: string, detail: string): NotificationEffect {
    return {
      id,
      kind: "attention",
      title,
      detail,
    }
  }

  private updateSessionMeta(session: SessionMeta) {
    this.sessionByID.set(session.sessionID, session)
  }

  private maybeEmitCompletion(session: SessionMeta) {
    const now = this.now()
    const lastCompletion = this.lastCompletionAt.get(session.sessionID) ?? 0
    if (now - lastCompletion < COMPLETION_SUPPRESSION_WINDOW_MS) {
      return undefined
    }
    this.lastCompletionAt.set(session.sessionID, now)
    return {
      id: `completion:${session.sessionID}:${session.updated}`,
      kind: "completion",
      title: session.title || "OpenCode finished processing",
      detail: session.directory,
    } as const satisfies NotificationEffect
  }
}

export class SoundNotifier {
  private readonly tracker: NotificationTracker

  constructor(private readonly dispatch: (effect: NotificationEffect) => void = playNotificationEffect) {
    this.tracker = new NotificationTracker()
  }

  syncSnapshot(snapshot: Snapshot) {
    for (const effect of this.tracker.syncSnapshot(snapshot)) {
      this.dispatch(effect)
    }
  }

  syncPendingRequests(input: { questions: QuestionRequest[]; permissions: PermissionRequest[] }) {
    for (const effect of this.tracker.syncPendingRequests(input)) {
      this.dispatch(effect)
    }
  }

  handleEvent(input: { directory: string; event: OpenCodeEvent }) {
    for (const effect of this.tracker.handleEvent(input)) {
      this.dispatch(effect)
    }
  }
}
