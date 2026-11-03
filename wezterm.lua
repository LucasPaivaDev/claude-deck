local wezterm = require("wezterm")
local act = wezterm.action
local config = wezterm.config_builder()

-- Fonte
config.font = wezterm.font("JetBrainsMono Nerd Font")
config.font_size = 12.0

-- Shell padrão (PowerShell)
config.default_prog = { "powershell.exe" }

-- ── Panes em grade: ver várias sessões Claude ao mesmo tempo ──────────────
config.keys = {
  -- dividir
  { key = "\\", mods = "ALT", action = act.SplitHorizontal({ domain = "CurrentPaneDomain" }) },
  { key = "-",  mods = "ALT", action = act.SplitVertical({ domain = "CurrentPaneDomain" }) },
  -- navegar
  { key = "LeftArrow",  mods = "ALT", action = act.ActivatePaneDirection("Left") },
  { key = "RightArrow", mods = "ALT", action = act.ActivatePaneDirection("Right") },
  { key = "UpArrow",    mods = "ALT", action = act.ActivatePaneDirection("Up") },
  { key = "DownArrow",  mods = "ALT", action = act.ActivatePaneDirection("Down") },
  -- ampliar o pane atual para a tela toda (e voltar)
  { key = "z", mods = "ALT", action = act.TogglePaneZoomState },
  -- escolher um pane visualmente
  { key = "p", mods = "ALT", action = act.PaneSelect({ alphabet = "asdfghjkl" }) },
  -- fechar o pane atual
  { key = "x", mods = "ALT", action = act.CloseCurrentPane({ confirm = true }) },
}

-- ── Aba colorida pelo estado da sessão Claude ─────────────────────────────
-- ✳ = pronto/esperando você · qualquer outro glyph = frame de spinner, trabalhando
local IDLE = { ["✳"] = true }

local function first_glyph(s)
  local ok, cp = pcall(utf8.codepoint, s, 1)
  if ok then return utf8.char(cp) end
  return ""
end

config.use_fancy_tab_bar = false
config.tab_max_width = 32

wezterm.on("format-tab-title", function(tab, _, _, _, hover, max_width)
  local title = tab.active_pane.title or ""
  local glyph = first_glyph(title)
  local fg = "#7b8494"
  if IDLE[glyph] then
    fg = "#5ad17f"
  elseif glyph ~= "" and utf8.codepoint(glyph) > 0x2000 then
    fg = "#e0b254"
  end
  local bg = tab.is_active and "#272c36" or "#15171c"
  if hover then
    bg = "#1f2430"
  end
  local text = " " .. wezterm.truncate_right(title, max_width - 2) .. " "
  return {
    { Background = { Color = bg } },
    { Foreground = { Color = fg } },
    { Text = text },
  }
end)

return config
