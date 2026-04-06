local wezterm = require 'wezterm'

local M = {}

function M.apply_to_config(config, launcher_path)
  config.keys = config.keys or {}
  table.insert(config.keys, {
    key = 'O',
    mods = 'CMD|SHIFT',
    action = wezterm.action.SpawnCommandInNewWindow {
      cwd = launcher_path,
      args = { 'wezterm', 'start', '--workspace', 'opencode-sidebar-launcher', '--cwd', launcher_path, '--', 'bun', 'run', launcher_path .. '/src/index.tsx' },
    },
  })
end

return M
