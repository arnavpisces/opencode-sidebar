# OpenCode Sidebar

Tmux sidebar launcher for `opencode`.

It gives you:

- left pane: projects and sessions
- right pane: stock OpenCode TUI
- Enter-based session recall into preview
- background active sessions
- session deletion from the sidebar
- sound notifications when OpenCode needs input or finishes processing

## Requirements

- `opencode`
- `tmux`
- `bun`

## Setup

```bash
bun install
```

## Run

```bash
./bin/opencode-sidebar-tmux
```

## Controls

- `↑` / `↓`: move
- `Enter`: load or recall selected session into preview
- `n`: new session
- `d`: delete session (with confirmation)
- `k`: kill a running session window without deleting session history
- `/`: search
- `a`: add project folder
- `x`: unpin directory
- `Space`: expand or collapse project
- `q`: quit launcher

## Notes

- `▶` means currently previewed
- `◆` means active in background
- `[*]` means a session recently completed work and has unread completion state in the sidebar
- sound alerts fire when OpenCode asks a question, requests permission, or finishes a working session
- the dedicated `opencode-sidebar` tmux session is destroyed automatically when its last client closes
- background parked sessions are capped so old parked `opencode attach` panes are cleaned up automatically
- state is stored in `~/.local/share/opencode-sidebar/state.json`

## Notification Tuning

- macOS uses `afplay` with system sounds by default
- other platforms fall back to the terminal bell
- set `OPENCODE_SIDEBAR_NOTIFY=0` to disable sounds
- set `OPENCODE_SIDEBAR_NOTIFY_ATTENTION_SOUND=Glass` to change the question/approval sound
- set `OPENCODE_SIDEBAR_NOTIFY_COMPLETE_SOUND=Ping` to change the completion sound
- sound variables can be a system sound name like `Glass`, `Ping`, `Hero`, or a full path such as `~/Music/done.aiff`

## License

Apache-2.0
