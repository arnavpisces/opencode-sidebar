# OpenCode Sidebar

Tmux sidebar launcher for `opencode`.

It gives you:

- left pane: projects and sessions
- right pane: stock OpenCode TUI
- Enter-based session recall into preview
- background active sessions
- session deletion from the sidebar

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
- `/`: search
- `a`: pin directory
- `x`: unpin directory
- `Space`: expand or collapse project
- `Alt-b`: jump back to launcher
- `Alt-]`: jump to preview pane
- `q`: quit launcher

## Notes

- `▶` means currently previewed
- `◆` means active in background
- state is stored in `~/.local/share/opencode-sidebar/state.json`

## License

Apache-2.0
