#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/test/tmux-flow.log"
SESSION_NAME="opencode-sidebar-test-$$"
WAIT_KEY="opencode-sidebar-test-done-$$"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-sidebar-flow.XXXXXX")"
STATE_DIR="$TEST_ROOT/sidebar-state"

rm -f "$LOG"

cleanup() {
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  rm -rf "$TEST_ROOT"
}

trap cleanup EXIT

tmux new-session -d -s "$SESSION_NAME" "cd \"$ROOT\" && OPENCODE_SIDEBAR_BACKEND=tmux OPENCODE_SIDEBAR_DIR=\"$STATE_DIR\" OPENCODE_SIDEBAR_TEST_ROOT=\"$TEST_ROOT\" bun run \"$ROOT/test/tmux-flow.ts\" >\"$LOG\" 2>&1; tmux wait-for -S \"$WAIT_KEY\""
tmux wait-for "$WAIT_KEY"

cat "$LOG"
