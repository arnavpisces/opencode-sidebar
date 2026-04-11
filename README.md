# OpenCode Sidebar

Tmux sidebar launcher for `opencode`.

## Why Does This Exist?

OpenCode is easier to use when the session list, preview pane, and TUI stay together. This launcher keeps them in one tmux session so you can move between the sidebar and OpenCode without losing context.

## Features

- Left pane for projects and sessions
- Right pane for the stock OpenCode TUI
- Enter-based session recall into preview
- Background active sessions
- Session deletion from the sidebar
- Sound notifications when OpenCode needs input or finishes work
- Automatic cleanup of parked `opencode attach` panes

## Quick Start

### Prerequisites
- Node.js 20+
- `tmux`
- `opencode`

Make sure they are installed and available in your PATH.

### Install from npm

```bash
npm install -g opencode-sidebar
opencode-sidebar
```

The CLI checks for `tmux` and `opencode` at runtime. If either command is missing, it prints a clear error instead of failing silently.

### npm Docs

Install:

```bash
npm install -g opencode-sidebar
```

Run:

```bash
opencode-sidebar
```

Update:

```bash
npm update -g opencode-sidebar
```

Remove:

```bash
npm uninstall -g opencode-sidebar
```

### Run from source

```bash
git clone https://github.com/arnavpisces/opencode-sidebar.git
cd opencode-sidebar
bun install
npm run start
```

`npm run start` builds the local `dist/` output and launches the same tmux-backed CLI used by the published package.

## Usage

![OpenCode Sidebar screenshot](https://raw.githubusercontent.com/arnavpisces/opencode-sidebar/main/static/screenshot.jpg)

```bash
opencode-sidebar
```

### Shortcuts

- `↑` / `↓`: move
- `Enter`: load or recall the selected session into preview
- `n`: new session
- `d`: delete session with confirmation
- `k`: kill a running session window without deleting history
- `/`: search
- `a`: add a project folder
- `Space`: expand or collapse a project
- `Ctrl-b` then arrow keys: switch between the sidebar and the OpenCode pane
- `q`: quit

### Status Symbols

- `▶` means currently previewed
- `◆` means active in background
- `[*]` means a session recently completed work and still has unread completion state

## Configuration

- `OPENCODE_SIDEBAR_DIR`: override the local state and log directory
- `OPENCODE_SIDEBAR_NOTIFY=0`: disable sounds
- `OPENCODE_SIDEBAR_NOTIFY_ATTENTION_SOUND`: custom sound for questions and approval requests
- `OPENCODE_SIDEBAR_NOTIFY_COMPLETE_SOUND`: custom sound for completion
- Sound values can be a system sound name like `Glass` or `Ping`, or a full path such as `~/Music/done.aiff`

## Release Checks

- `npm run verify`: typecheck, unit tests, and build
- `npm run verify:tmux`: manual tmux integration checks in isolated temp workspaces
- `npm run verify:release`: full maintainer-only release check

## Contribution

Pull requests and opening issues are welcome. For details, see:

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [.github/ISSUE_TEMPLATE/bug_report.md](./.github/ISSUE_TEMPLATE/bug_report.md)
- [.github/pull_request_template.md](./.github/pull_request_template.md)

## License

Apache-2.0 © 2026 Arnav Kumar

If this repo helped you, consider giving it a ⭐. Happy Vibing :)
