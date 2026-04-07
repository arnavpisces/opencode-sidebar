#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/test/sidebar-sigint-cleanup.log"

rm -f "$LOG"

cd "$ROOT"
OPENCODE_SIDEBAR_BACKEND=tmux bun run "$ROOT/test/sidebar-sigint-cleanup.ts" >"$LOG" 2>&1

cat "$LOG"
