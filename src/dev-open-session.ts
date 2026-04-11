#!/usr/bin/env node
import { LauncherService } from "./lib/opencode.js"

const service = new LauncherService()
const snapshot = await service.getSnapshot()

const directory = snapshot.directories.find((item) => item.sessions.length > 0)
if (!directory) {
  throw new Error("No directory with sessions found")
}

const session = directory.sessions[0]
if (!session) {
  throw new Error("No session found in selected directory")
}

const result = await service.openSession(directory.directory, session)
console.log(JSON.stringify({ directory: directory.directory, sessionID: session.id, result }, null, 2))
