#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/test/tmux-cleanup.log"
SESSION_NAME="opencode-sidebar-cleanup-test-$$"
WAIT_KEY="opencode-sidebar-cleanup-done-$$"

rm -f "$LOG"

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
}

trap cleanup EXIT

tmux new-session -d -s "$SESSION_NAME" "cd \"$ROOT\" && OPENCODE_SIDEBAR_BACKEND=tmux bun run \"$ROOT/test/tmux-cleanup.ts\" >\"$LOG\" 2>&1; tmux wait-for -S \"$WAIT_KEY\""
tmux wait-for "$WAIT_KEY"

cat "$LOG"
