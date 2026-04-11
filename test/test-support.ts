#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { LauncherService } from "../src/lib/opencode.js"

type TestSession = {
  directory: string
  sessionID: string
}

export function getTestRoot() {
  const root = process.env.OPENCODE_SIDEBAR_TEST_ROOT
  if (!root) {
    throw new Error("OPENCODE_SIDEBAR_TEST_ROOT is required for tmux integration tests")
  }
  return root
}

export async function createTestWorkspace(name: string) {
  const directory = path.join(getTestRoot(), name)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

export async function cleanupTestSessions(service: LauncherService, sessions: TestSession[]) {
  for (const session of sessions) {
    await service.deleteSession(session.directory, session.sessionID).catch(() => {})
  }
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
