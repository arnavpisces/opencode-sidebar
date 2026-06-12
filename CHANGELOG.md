# Changelog

## 0.3.5 - 2026-06-13

- Fixed root cause of terminal flickering: render at rows-1 so Ink always uses incremental log-update diffing instead of full clear-and-repaint (ESC[2J) on every frame.
- Gated animation timer on activity: `useFrame(250)` only runs when sessions are busy, user is active, or search mode is on. Idle sidebar re-renders once per minute instead of 4×/sec.
- Collapsed two independent animation timers (250ms + 800ms) into one: `slowFrame` derived as `Math.floor(animFrame / 3)`.
- Added snapshot fingerprinting: unchanged snapshots return the same object reference so `setSnapshot` bails and downstream `useMemo` caches are preserved.
- Added `setExpanded` bail-out: returns current state when no directory was added or removed, defeating React's reconciliation skip.
- Batched tmux spawns: `getPreviewSessionMeta` collapsed from 6 spawns to 1, `isMouseModeEnabled` collapsed from 3 to 2, `getSessionName` cached at module level.
- Re-keyed mouse mode polling from `snapshot?.loadedAt` to a 60s interval.
- SSE reconnect: per-attempt `AbortController` prevents listener accumulation across reconnects; exponential backoff (1s→30s cap) replaces fixed 1s retry.
- Killed orphaned `opencode serve` processes: `ensureReady` now stops the old server before spawning a replacement.
- Added optional instrumentation (`OPENCODE_SIDEBAR_MEMLOG=1`): periodic RSS/heap logging to memlog.txt and SIGUSR2 heap snapshot support.
- Fixed mouse click offset: adjusted `projectRowsStartY` to account for root box `paddingTop`, so clicks land on the correct row.
- Fixed mouse mode detection: restored fallback to global `mouse` option since `mouse_any_flag` only reflects active button presses, not the enabled setting.

## 0.3.4 - 2026-06-13

- Eliminated animation timer proliferation: replaced N independent `setInterval` hooks (one per animated component) with 2 shared timers (250ms and 800ms), cutting React reconciliations from ~4/sec to 2/sec and removing the primary flickering source.
- Stabilized `useInput` handler via ref pattern so stdin subscribe/unsubscribe no longer fires on every animation-driven render.
- Fixed SSE stream leak: added `finally` block with `stream.return()` to release zombie HTTP response references after reconnects.
- Cleared `lastSnapshot` before rebuilding to prevent peak memory holding two full snapshots simultaneously.
- Added `pruneStaleEntries()` to `NotificationTracker` to evict sessions and busy/completion maps for deleted sessions between snapshot syncs.
- Memoized 10 computed arrays in the render tree (`statusLines`, `statusMessageLines`, `toolsLines`, modal line arrays, prompt arrays) to avoid ~40 allocations/second from animation-triggered re-renders.
- Simplified `mouseContextRef` to a single typed ref assignment, removing duplicate 20-field object literal on every render.
- Cached `loadState()` with 10s TTL to eliminate redundant disk I/O on every snapshot refresh; cache invalidated on writes.
- Hoisted static `ADD_PROJECT_ROW` to module scope to avoid recreating identical object on every `buildRows` call.
- Optimized `toggleDirectory` to short-circuit when expanded value is unchanged.
- Increased `useNowTick` interval from 30s to 60s to match `relativeTime()` minute granularity.

## 0.3.3 - 2026-06-12

- Eliminated terminal flickering: enabled Ink's incremental renderer so only changed lines are redrawn, removing the erase-repaint gap.
- Deferred terminal background color changes to theme confirmation (Enter) instead of firing on every scroll keypress, preventing OSC 11 / SGR race conditions.
- Bracket direct terminal background writes with synchronized output escapes to prevent interleaving with Ink's pipeline.

## 0.3.2 - 2026-06-12

- Drastically reduced memory footprint: moved animation timers from App into isolated leaf components, cutting React reconciliations from 14,400/hr to ~720/hr and preventing yoga-layout C-heap accumulation.
- Stabilized mouse event handler with useRef to stop stdin listener re-subscription cascade on every render.
- Fixed mouse scrolling accuracy: scroll delta is now tracked imperatively via `scrollIndexRef` to avoid race conditions when multiple SGR chunks arrive before React re-renders.
- Centered scroll window at viewport midpoint for smoother scroll feel.
- Capped session fetch volume: added `MAX_TOTAL_SESSIONS=150`, `MAX_SESSIONS_PER_DIRECTORY=15`, and trimmed session objects to only needed fields.
- Replaced `Set<string>` with `string[]` for small ID collections to reduce per-object overhead.
- Increased refresh intervals: `WINDOW_POLL_INTERVAL_MS` 2s→5s, `MIN_REFRESH_MS` 1s→2s, `SNAPSHOT_DEBOUNCE_MS` 150ms→300ms.
- Added `--max-old-space-size=512` to both Node launch paths to force aggressive V8 GC.
- Fixed `launchedSessionIDs` leak on session delete; added `setRawMode(false)` on stdin teardown.
- Cleaned stale entries from `expanded` state when directories are removed from the snapshot.

## 0.3.1 - 2026-06-08

- Updated npm keywords.

## 0.3.0 - 2026-06-08

- Added project folder hiding: press `H` on a directory row to hide it from the sidebar (with confirmation dialog). Hidden folders can be re-added via the Add project folder flow.
- Changed `R` from refresh to restart: kills and respawns the opencode process in the preview pane for the current session.
- Renamed the shortcuts panel from "TOOLS / MODES" to "SHORTCUTS" with keys colored in info and descriptions in muted.
- Implemented smooth mouse wheel scrolling with accumulate-and-flush delta handling, clamped at list edges (no wrapping).
- Added unit test for scroll delta clamping at both boundaries.

## 0.2.0 - 2026-05-10

- Added a persisted theme selector opened with `T`, including keyboard navigation and Enter/Esc apply/cancel behavior.
- Added live theme preview while moving through theme options.
- Added five new themes: Copper Harbor, Jade Circuit, Rose Noir, Paper Terminal, and Orchid Signal.
- Synced terminal, sidebar pane, and session launch pane backgrounds with the selected theme to reduce black flicker.
- Added directory autocomplete for the add-project flow, including partial absolute and `~/` paths.
- Fixed add-project Enter behavior so highlighted autocomplete matches are added instead of partial typed paths.
- Fixed add-project dropdown layout so selection markers stay beside the first directory line and wrapped paths align cleanly.
- Fixed modal repainting with fixed-width lines so long path input no longer overlaps stale title text.
- Added whole-input clearing with Opt+Delete, Opt+Backspace, and Shift+Delete in text entry modes.
- Added tmux mouse support for row selection, directory toggles, double-click open, and clicking Add project folder.
- Added mouse escape filtering so mouse input is not inserted into text fields.
- Added persisted pinned project folders so manually added directories appear even before sessions exist.
- Added theme state persistence in the sidebar state file.
- Added safer sidebar process handling with fatal-error cleanup and supervised CLI restarts.
- Added SIGINT cleanup coverage for the sidebar test entry.
- Scoped `npm test` to sidebar tests so nested checkouts are not collected accidentally.
- Added contributor setup notes for local Bun, tmux, OpenCode, and LLM-assisted development.
