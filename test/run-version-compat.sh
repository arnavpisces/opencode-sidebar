#!/usr/bin/env bash
# Run the real tmux flows against a specific OpenCode binary without touching
# the user's OpenCode database, configuration, tmux server, or sidebar state.
set -euo pipefail
if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "Usage: $0 /absolute/path/to/opencode" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_BINARY="$1"
TMUX_BINARY="$(command -v tmux)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sidebar-compat.XXXXXX")"
SOCKET="sidebar-compat-$$"
cleanup() {
  "$TMUX_BINARY" -L "$SOCKET" kill-server 2>/dev/null || true
  if [ -f "$WORK/smoke-sidebar/opencode-server.log" ]; then
    for pid in $(lsof -t "$WORK/smoke-sidebar/opencode-server.log" 2>/dev/null | sort -u); do
      kill "$pid" 2>/dev/null || true
    done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/bin" "$WORK/home" "$WORK/data" "$WORK/config" "$WORK/cache" "$WORK/state"
printf '#!/bin/sh\nexec "%s" -L "%s" "$@"\n' "$TMUX_BINARY" "$SOCKET" > "$WORK/bin/tmux"
chmod +x "$WORK/bin/tmux"
ln -s "$OPENCODE_BINARY" "$WORK/bin/opencode"
export PATH="$WORK/bin:$PATH"
export HOME="$WORK/home" XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" XDG_STATE_HOME="$WORK/state"
export OPENCODE_DB="$WORK/data/opencode.db" OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_SIDEBAR_NOTIFY=0
unset TMUX OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD OPENCODE_SERVER_USERNAME OPENCODE_BIN_PATH OPENCODE_CONFIG OPENCODE_CONFIG_DIR OPENCODE_CONFIG_CONTENT
cd "$ROOT"
VERSION="$(opencode --version)"
echo "Testing $VERSION"
for script in test/run-tmux-flow.sh test/run-tmux-cleanup.sh test/run-sidebar-sigint-cleanup.sh; do
  "$WORK/bin/tmux" kill-server 2>/dev/null || true
  "$script"
done
if [[ "$VERSION" =~ (^|[[:space:]])v?2\. ]]; then
  "$WORK/bin/tmux" kill-server 2>/dev/null || true
  test/run-tmux-model-flow.sh
fi

# Exercise the published Node entry point and wait for a completed first sync.
"$WORK/bin/tmux" kill-server 2>/dev/null || true
mkdir -p "$WORK/smoke-data"
export XDG_DATA_HOME="$WORK/smoke-data" OPENCODE_DB="$WORK/smoke-data/opencode.db" OPENCODE_SIDEBAR_DIR="$WORK/smoke-sidebar"
SIDEBAR_BIN="${OPENCODE_SIDEBAR_TEST_BIN:-$ROOT/bin/opencode-sidebar.js}"
"$WORK/bin/tmux" new-session -d -s sidebar-smoke -x 120 -y 40 node "$SIDEBAR_BIN"
ready=0
for _ in $(seq 1 100); do
  screen=$("$WORK/bin/tmux" capture-pane -p -t sidebar-smoke 2>/dev/null || true)
  if [[ "$screen" == *"Connected"* && "$screen" == *"projects ·"* ]]; then ready=1; break; fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  printf 'Built sidebar did not finish its initial sync:\n%s\n' "$screen" >&2
  exit 1
fi
"$WORK/bin/tmux" send-keys -t sidebar-smoke q
for _ in $(seq 1 100); do
  if ! "$WORK/bin/tmux" has-session -t sidebar-smoke 2>/dev/null; then break; fi
  sleep 0.1
done
if "$WORK/bin/tmux" has-session -t sidebar-smoke 2>/dev/null; then
  echo "Built sidebar did not shut down" >&2
  exit 1
fi
if lsof -t "$WORK/smoke-sidebar/opencode-server.log" 2>/dev/null | rg -q .; then
  echo "Built sidebar left its server running" >&2
  exit 1
fi
echo "published-launcher-smoke-ok"
