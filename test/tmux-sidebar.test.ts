import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(!Bun.which("tmux") || !Bun.which("python3"))("sidebar collapse keeps a rail, restores width and focus, and follows recalled sessions", async () => {
  const binary = Bun.which("tmux")!
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sidebar-tmux-toggle-"))
  const socket = `sidebar-toggle-${process.pid}-${Date.now()}`
  const tmux = (...args: string[]) => execFileSync(binary, ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" }).trim()
  let terminal: ReturnType<typeof Bun.spawn> | undefined
  try {
    tmux("new-session", "-d", "-s", "sidebar", "-x", "140", "-y", "40", "sleep 60")
    const pane = tmux("display-message", "-p", "-t", "sidebar", "#{pane_id}")
    await fs.writeFile(path.join(directory, "tmux"), `#!/bin/sh\nexec '${binary}' -L '${socket}' -f /dev/null "$@"\n`, { mode: 0o700 })
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TERM: "xterm-256color", TMUX: "", TMUX_PANE: pane }
    // A PTY gives tmux a real client so send-keys -K exercises the binding itself.
    terminal = Bun.spawn(["python3", "-c", `
import os, pty
pid, fd = pty.fork()
if pid == 0:
    os.execvp("tmux", ["tmux", "attach-session", "-t", "sidebar"])
try:
    while os.read(fd, 65536):
        pass
except OSError:
    pass
`], { env, stdout: "ignore", stderr: "pipe" })
    let client = ""
    const attachDeadline = Date.now() + 10_000
    while (!client && Date.now() < attachDeadline && terminal.exitCode === null) {
      await Bun.sleep(20)
      client = tmux("list-clients", "-F", "#{client_name}")
    }
    if (!client) {
      terminal.kill()
      const detail = await new Response(terminal.stderr).text()
      throw new Error(`Could not attach a tmux client for shortcut testing: ${detail}`)
    }
    tmux("resize-window", "-t", "sidebar", "-x", "140", "-y", "40")
    const child = Bun.spawn([process.execPath, "--eval", `
      import { strict as assert } from "node:assert";
      import { execFileSync } from "node:child_process";
      import { bindSidebarToggleKey, clearSidebarLayout, ensureTmuxLayout, getSidebarLayoutState, sidebarWidths, swapPreviewWithSessionPane } from "./src/lib/tmux.ts";
      const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
      const sidebar = process.env.TMUX_PANE;
      const get = (target, format) => tmux("display-message", "-p", "-t", target, format);
      const active = () => tmux("list-panes", "-t", sidebar, "-F", "#{?pane_active,#{pane_id},}").trim();
      const waitFor = async (condition) => {
        const deadline = Date.now() + 10_000;
        while (!condition() && Date.now() < deadline) await Bun.sleep(50);
        assert.ok(condition(), "tmux layout settled before checking it");
      };
      tmux("bind-key", "-T", "prefix", "Tab", "set-option", "-w", "@test_tab", "preserved");
      tmux("bind-key", "-n", "M-l", "if-shell", "-F", "#{@opencode_sidebar_pane_id}", "", "");
      tmux("bind-key", "-n", "M-\\\\", "display-message", "user-custom-binding");
      await bindSidebarToggleKey();
      assert.ok(tmux("list-keys", "-T", "prefix").includes("@opencode_sidebar_pane_id"), "prefix shortcut is installed before the first session");
      assert.ok(!tmux("list-keys", "-T", "root").split("\\n").some(line => line.includes("M-l") && line.includes("@opencode_sidebar_pane_id")), "old app Meta binding is retired");
      assert.ok(tmux("list-keys", "-T", "root").includes("user-custom-binding"), "custom Meta bindings remain intact");
      const toggle = async (target = sidebar) => {
        const registered = get(target, "#{@opencode_sidebar_pane_id}") === sidebar;
        const hasPreview = Number(get(sidebar, "#{window_panes}")) > 1;
        const wasCollapsed = get(sidebar, "#{@opencode_sidebar_collapsed}") === "1";
        const preferred = Number(get(sidebar, "#{@opencode_sidebar_expanded_width}")) || Number(get(sidebar, "#{pane_width}"));
        const widths = sidebarWidths(Number(get(sidebar, "#{window_width}")), wasCollapsed ? preferred : Number(get(sidebar, "#{pane_width}")));
        tmux("switch-client", "-c", process.env.SIDEBAR_TOGGLE_TEST_CLIENT, "-t", get(target, "#{session_name}"));
        tmux("select-pane", "-t", target);
        tmux("send-keys", "-K", "-t", process.env.SIDEBAR_TOGGLE_TEST_CLIENT, get(target, "#{prefix}"), "Tab");
        if (registered && hasPreview) {
          const expected = [wasCollapsed ? widths.expanded : widths.collapsed, wasCollapsed ? "0" : "1", wasCollapsed ? "1" : "0"].join("|");
          await waitFor(() => get(sidebar, "#{pane_width}|#{@opencode_sidebar_collapsed}|#{pane_active}") === expected);
        } else await Bun.sleep(350);
      };
      await toggle();
      assert.equal(get(sidebar, "#{window_panes}"), "1", "empty sidebar is left intact");
      const { rightPaneID: right } = await ensureTmuxLayout(process.cwd());
      const geometry = () => tmux("list-panes", "-t", sidebar, "-F", "#{pane_left},#{pane_top},#{pane_width},#{pane_height}");
      const layout = geometry();
      const pids = tmux("list-panes", "-t", sidebar, "-F", "#{pane_id}:#{pane_pid}");
      const checkCollapsed = (content) => {
        assert.equal(get(sidebar, "#{window_zoomed_flag}"), "0", "collapsing never hides panes with zoom");
        assert.equal(get(sidebar, "#{pane_width}"), "5", "sidebar stays visible as a five-column icon rail");
        assert.equal(active(), content, "collapsing focuses OpenCode");
        assert.equal(Number(get(content, "#{pane_width}")), Number(get(content, "#{window_width}")) - 6, "OpenCode gains the freed width");
      };
      const checkShown = () => {
        assert.equal(get(sidebar, "#{window_zoomed_flag}"), "0");
        assert.equal(active(), sidebar, "expanding focuses the sidebar");
        assert.equal(geometry(), layout, "original pane widths are restored");
      };
      for (let i = 0; i < 3; i++) {
        await toggle(sidebar);
        checkCollapsed(right);
        await toggle(right);
        checkShown();
      }
      tmux("select-pane", "-t", right);
      await toggle(right);
      checkCollapsed(right);
      await toggle(right);
      checkShown();
      assert.equal(tmux("list-panes", "-t", sidebar, "-F", "#{pane_id}:#{pane_pid}"), pids, "neither process is restarted");
      tmux("resize-pane", "-t", sidebar, "-x", "64");
      await toggle();
      checkCollapsed(right);
      tmux("resize-window", "-t", sidebar, "-x", "100", "-y", "30");
      await waitFor(() => get(sidebar, "#{pane_width}") === "5");
      checkCollapsed(right);
      await toggle(right);
      assert.equal(get(sidebar, "#{pane_width}"), "55", "restored width is clamped to preserve space for OpenCode");
      tmux("resize-window", "-t", sidebar, "-x", "140", "-y", "40");
      await waitFor(() => get(sidebar, "#{pane_width}") === "64");
      assert.equal(get(sidebar, "#{pane_width}"), "64", "preferred width returns on a larger terminal");
      tmux("resize-pane", "-t", sidebar, "-x", "52");
      tmux("set-option", "-w", "-t", sidebar, "@opencode_sidebar_expanded_width", "52");
      const parked = tmux("new-window", "-d", "-t", "sidebar", "-P", "-F", "#{window_id} #{pane_id}", "sleep 60").split(" ");
      await toggle();
      checkCollapsed(right);
      await swapPreviewWithSessionPane({
        previewPaneID: right, sessionPaneID: parked[1], hiddenWindowID: parked[0],
        previewSession: { sessionID: "first", directory: process.cwd(), title: "First", paneID: right },
        nextSession: { sessionID: "recalled", directory: process.cwd(), title: "Recalled" },
      });
      await ensureTmuxLayout(process.cwd());
      tmux("select-pane", "-t", parked[1]);
      checkCollapsed(parked[1]);
      assert.equal((await getSidebarLayoutState()).collapsed, true, "recalling a session preserves collapsed state");
      assert.equal(get(right, "#{window_zoomed_flag}"), "0", "the parked session stays untouched");
      await toggle(parked[1]);
      checkShown();
      tmux("set-option", "-t", "sidebar", "prefix", "C-a");
      assert.equal((await getSidebarLayoutState()).shortcut, "Ctrl-a Tab", "hint follows a custom tmux prefix");
      await toggle();
      checkCollapsed(parked[1]);
      await toggle(parked[1]);
      checkShown();
      const foreign = tmux("new-session", "-d", "-s", "foreign", "-P", "-F", "#{pane_id}", "sleep 60");
      tmux("split-window", "-h", "-d", "-t", foreign, "sleep 60");
      await toggle(foreign);
      assert.equal(get(foreign, "#{window_zoomed_flag}"), "0", "unrelated tmux sessions are unaffected");
      assert.equal(get(foreign, "#{@test_tab}"), "preserved", "previous prefix binding works in unrelated sessions");
      assert.equal(get(sidebar, "#{window_zoomed_flag}"), "0");
      await clearSidebarLayout();
      assert.equal(get(sidebar, "#{@opencode_sidebar_pane_id}#{@opencode_sidebar_right_pane_id}"), "", "shutdown clears shortcut targets");
      await toggle();
      assert.equal(get(sidebar, "#{@test_tab}"), "preserved", "previous prefix binding works after shutdown");
    `], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...env, SIDEBAR_TOGGLE_TEST_CLIENT: client },
      stderr: "pipe",
    })
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
  } finally {
    try { tmux("kill-server") } catch {}
    terminal?.kill()
    await terminal?.exited
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 90_000)
