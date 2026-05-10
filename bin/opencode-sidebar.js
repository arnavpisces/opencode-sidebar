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
const RESTART_DELAY_MS = 350

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  })

  child.once("error", (error) => {
    reject(error)
  })

  child.once("exit", (code, signal) => {
    resolve({ code: code ?? 0, signal })
  })
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

async function runSidebarSupervised() {
  let restartCount = 0

  while (true) {
    const result = await spawnAndWait(process.execPath, [entryPath], {
      env: runtimeEnv,
    }).catch((error) => {
      console.error(`[opencode-sidebar] Failed to start sidebar runtime: ${error.message}`)
      process.exit(1)
    })

    if (!result) return

    if (result.signal) {
      process.kill(process.pid, result.signal)
      return
    }

    if (result.code === 0) {
      process.exit(0)
    }

    restartCount += 1
    console.error(`[opencode-sidebar] Sidebar exited unexpectedly with code ${result.code}. Restarting (${restartCount})...`)
    await wait(RESTART_DELAY_MS)
  }
}

if (!process.env.TMUX) {
  const tmuxCommand = `while true; do OPENCODE_SIDEBAR_BACKEND=tmux ${quoteShell(process.execPath)} ${quoteShell(entryPath)}; code=$?; if [ "$code" -eq 0 ]; then exit 0; fi; printf '\n[opencode-sidebar] sidebar exited unexpectedly with code %s; restarting...\n' "$code"; sleep 0.35; done`
  spawnAndWait("tmux", ["new-session", "-A", "-s", sessionName, "-f", "destroy-unattached=on", "-c", process.cwd(), tmuxCommand], {
    env: runtimeEnv,
  })
    .then((result) => {
      if (result.signal) {
        process.kill(process.pid, result.signal)
        return
      }
      process.exit(result.code)
    })
    .catch((error) => {
      console.error(`[opencode-sidebar] Failed to start tmux: ${error.message}`)
      process.exit(1)
    })
} else {
  void runSidebarSupervised()
}
