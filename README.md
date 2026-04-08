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

## Installation

### Requirements

- `bun`
- `tmux`
- `opencode`

### Install Dependencies

```bash
bun install
```

### Start the Sidebar

```bash
./bin/opencode-sidebar-tmux
```

## Usage

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
- `OPENCODE_SIDEBAR_TEST_CONTROL`: test-only file that `src/index.tsx` polls for `open:` and `new:` commands

## Contribution

Pull requests and issues are welcome.

## License

Apache-2.0. Copyright 2026 Arnav Kumar.
