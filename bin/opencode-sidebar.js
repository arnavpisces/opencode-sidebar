#!/usr/bin/env node

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { formatMissingDependencyMessage, getSystemDependencyReport } from "../scripts/system-dependencies.mjs"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const entryPath = path.join(rootDir, "dist", "index.js")
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"))
const sessionName = "opencode-sidebar"

function quoteShell(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function printHelp() {
  console.log(`OpenCode Sidebar ${packageJson.version}

Usage:
  opencode-sidebar
  opencode-sidebar --help
  opencode-sidebar --version

Requirements:
  - tmux
  - opencode

The CLI creates or attaches the tmux session '${sessionName}' and runs the sidebar inside it.`)
}

function exitWithMissingDependencies() {
  const report = getSystemDependencyReport()
  if (report.allFound) return false
  console.error(formatMissingDependencyMessage(report))
  return true
}

function spawnAndExit(command, args, options) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  })

  child.once("error", (error) => {
    console.error(`[opencode-sidebar] Failed to start ${command}: ${error.message}`)
    process.exit(1)
  })

  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp()
  process.exit(0)
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(packageJson.version)
  process.exit(0)
}

if (!fs.existsSync(entryPath)) {
  console.error("[opencode-sidebar] Missing dist build. Reinstall the package or run 'npm run build'.")
  process.exit(1)
}

if (exitWithMissingDependencies()) {
  process.exit(1)
}

const runtimeEnv = {
  ...process.env,
  OPENCODE_SIDEBAR_BACKEND: "tmux",
}

if (!process.env.TMUX) {
  const tmuxCommand = `OPENCODE_SIDEBAR_BACKEND=tmux ${quoteShell(process.execPath)} ${quoteShell(entryPath)}`
  spawnAndExit("tmux", ["new-session", "-A", "-s", sessionName, "-f", "destroy-unattached=on", "-c", process.cwd(), tmuxCommand], {
    env: runtimeEnv,
  })
} else {
  spawnAndExit(process.execPath, [entryPath], {
    env: runtimeEnv,
  })
}
