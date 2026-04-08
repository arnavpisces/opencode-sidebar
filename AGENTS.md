# OpenCode Sidebar

- Single-package Bun + Ink tmux sidebar for OpenCode.
- Main entrypoints: `bin/opencode-sidebar-tmux` for users, `src/index.tsx` for the CLI app, `src/lib/opencode.ts` for server/snapshot orchestration, `src/lib/tmux.ts` for tmux pane/window plumbing, and `src/lib/notifications.ts` for sounds.
- Runtime is tmux-only. `src/lib/terminal.ts` throws outside tmux, so use the wrapper script for manual runs.
- Local state and server logs live under `~/.local/share/opencode-sidebar/` by default, or `OPENCODE_SIDEBAR_DIR` if set. Do not commit those files.
- Notifications use `/usr/bin/afplay` on macOS and the terminal bell elsewhere. `OPENCODE_SIDEBAR_NOTIFY=0` disables sound; `...ATTENTION_SOUND` and `...COMPLETE_SOUND` accept a system sound name or a file path.
- `src/index.tsx` has a test control channel via `OPENCODE_SIDEBAR_TEST_CONTROL`; it polls a file and consumes `open:` and `new:` commands.
- `tsconfig.json` excludes `test/`, so `./node_modules/.bin/tsc --noEmit` only typechecks `src/`. Use `bun test` for the test files.
- There is no lint task in `package.json`; the main checks are typecheck and tests.
- Verify source changes with `./node_modules/.bin/tsc --noEmit` first, then `bun test`. If tmux/session lifecycle changed, also run `./test/run-tmux-flow.sh`, `./test/run-tmux-cleanup.sh`, and `./test/run-sidebar-sigint-cleanup.sh`.
- The tmux integration scripts assume `tmux` and `opencode` are installed and write logs to `test/*.log`.
- Prefer the executable scripts and source over README prose when they differ.
- Use `./bin/opencode-sidebar-tmux` for local manual testing; it creates or attaches the `opencode-sidebar` tmux session with `destroy-unattached=on`.
- If the user explicitly asks for a commit or push, use a concise, accurate commit message and only push when explicitly requested.
