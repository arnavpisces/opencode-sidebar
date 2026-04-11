#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/test/sidebar-sigint-cleanup.log"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opencode-sidebar-sigint.XXXXXX")"
STATE_DIR="$TEST_ROOT/sidebar-state"

rm -f "$LOG"

cleanup() {
  rm -rf "$TEST_ROOT"
}

trap cleanup EXIT

cd "$ROOT"
OPENCODE_SIDEBAR_BACKEND=tmux OPENCODE_SIDEBAR_DIR="$STATE_DIR" OPENCODE_SIDEBAR_TEST_ROOT="$TEST_ROOT" bun run "$ROOT/test/sidebar-sigint-cleanup.ts" >"$LOG" 2>&1

cat "$LOG"
