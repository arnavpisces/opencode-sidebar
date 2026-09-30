import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(!Bun.which("tmux"))("tmux scopes sidebar windows to its own pane session", async () => {
  const binary = Bun.which("tmux")
  if (!binary) throw new Error("tmux is unavailable")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidebar-tmux-scope-"))
  const socket = `sidebar-scope-${process.pid}-${Date.now()}`
  const tmux = (...args: string[]) => execFileSync(binary, ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" }).trim()
  try {
    tmux("new-session", "-d", "-s", "local", "sleep 60")
    const pane = tmux("display-message", "-p", "-t", "local", "#{pane_id}")
    const window = tmux("display-message", "-p", "-t", "local", "#{window_id}")
    tmux("set-option", "-w", "-t", "local", "@opencode_session_id", "local-session")
    tmux("new-session", "-d", "-s", "foreign", "sleep 60")
    tmux("set-option", "-w", "-t", "foreign", "@opencode_session_id", "foreign-session")
    await fs.writeFile(path.join(directory, "tmux"), `#!/bin/sh\nexec '${binary}' -L '${socket}' -f /dev/null "$@"\n`, { mode: 0o700 })
    const child = Bun.spawn([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { getSessionName, getCurrentWindowID, listActiveSessionWindows, listAllActiveSessionWindows } from "./src/lib/tmux.ts";
      assert.equal(await getSessionName(), "local");
      assert.equal(await getCurrentWindowID(), ${JSON.stringify(window)});
      assert.deepEqual((await listActiveSessionWindows()).map(record => record.sessionID), ["local-session"]);
      assert.equal((await listAllActiveSessionWindows()).length, 2);
    `], { cwd: path.resolve(import.meta.dir, ".."), env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TMUX_PANE: pane }, stderr: "pipe" })
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
  } finally {
    try { tmux("kill-server") } catch {}
    await fs.rm(directory, { recursive: true, force: true })
  }
})
