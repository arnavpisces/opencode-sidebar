# Changelog

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
