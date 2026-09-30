import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { reconcileSidebarLayout, toggleSidebarLayout } from "./lib/tmux.js"

const paneID = process.argv[2]
if (!paneID || !/^%\d+$/.test(paneID)) throw new Error("A sidebar pane ID is required")

try {
  if (process.argv.includes("--reconcile")) await reconcileSidebarLayout(paneID)
  else await toggleSidebarLayout(paneID)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  await promisify(execFile)("tmux", ["display-message", "-t", paneID, `Sidebar resize failed: ${detail}`]).catch(() => {})
  process.exitCode = 1
}
