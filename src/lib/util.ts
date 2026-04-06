import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function truncate(input: string, width: number) {
  if (width <= 0) return ""
  if (input.length <= width) return input
  if (width <= 1) return input.slice(0, width)
  return input.slice(0, width - 1) + "…"
}

export function relativeTime(timestamp: number, now = Date.now()) {
  const delta = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day

  if (delta < minute) return "now"
  if (delta < hour) return `${Math.floor(delta / minute)}m`
  if (delta < day) return `${Math.floor(delta / hour)}h`
  if (delta < week) return `${Math.floor(delta / day)}d`
  if (delta < month) return `${Math.floor(delta / week)}w`
  return `${Math.floor(delta / month)}mo`
}

export function normalizeDirectory(input: string) {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("Directory path is empty")
  const expanded = trimmed.startsWith("~/") ? path.join(process.env.HOME ?? "", trimmed.slice(2)) : trimmed
  return path.resolve(expanded)
}

export async function assertDirectoryExists(directory: string) {
  const stats = await fs.stat(directory)
  if (!stats.isDirectory()) {
    throw new Error(`${directory} is not a directory`)
  }
}

export function directoryLabel(directory: string, preferred?: string) {
  return preferred?.trim() || path.basename(directory) || directory
}

export function directorySubtitle(directory: string, root?: string) {
  if (!root || root === directory) return directory
  return `${directory}  ·  ${path.basename(root)}`
}

export function sessionWorkspace(sessionID: string) {
  return `opencode-session-${sessionID}`
}

export function sessionWindowTitle(directory: string, title: string) {
  const base = path.basename(directory) || directory
  return `OpenCode · ${base} · ${truncate(title || "New session", 60)}`
}

export function tmuxWindowName(directory: string, title: string) {
  const base = path.basename(directory) || directory
  return truncate(`${base} · ${title || "New session"}`, 24)
}

export function parseFileUrl(input?: string) {
  if (!input) return undefined
  if (!input.startsWith("file://")) return input
  try {
    return fileURLToPath(input)
  } catch {
    return input
  }
}

export function distinct<T>(items: T[]) {
  return [...new Set(items)]
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isPrintable(input: string) {
  return input.length === 1 && input >= " " && input !== "\u007f"
}
