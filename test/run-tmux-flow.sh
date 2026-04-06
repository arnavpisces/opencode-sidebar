#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/test/tmux-flow.log"

rm -f "$LOG"

OPENCODE_SIDEBAR_BACKEND=tmux bun run "$ROOT/test/tmux-flow.ts" >"$LOG" 2>&1 || true

sleep 2
cat "$LOG"
