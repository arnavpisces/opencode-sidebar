export type ThemeScheme = {
  id: string
  name: string
  base: {
    background: string
    foreground: string
    cursor: string
  }
  semantic: {
    panelBg: string
    border: string
    selectionBg: string
    selectionFg: string
    highlight: string
    match: string
    muted: string
    error: string
    success: string
    warning: string
    info: string
  }
  ansi: {
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
  }
}

export const DEFAULT_THEME_ID = "nordic-frost"

export const THEMES: ThemeScheme[] = [
  {
    id: "nordic-frost",
    name: "Nordic Frost",
    base: {
      background: "#2E3440",
      foreground: "#D8DEE9",
      cursor: "#88C0D0",
    },
    semantic: {
      panelBg: "#3B4252",
      border: "#4C566A",
      selectionBg: "#434C5E",
      selectionFg: "#ECEFF4",
      highlight: "#88C0D0",
      match: "#EBCB8B",
      muted: "#616E88",
      error: "#BF616A",
      success: "#A3BE8C",
      warning: "#EBCB8B",
      info: "#81A1C1",
    },
    ansi: {
      black: "#3B4252",
      red: "#BF616A",
      green: "#A3BE8C",
      yellow: "#EBCB8B",
      blue: "#81A1C1",
      magenta: "#B48EAD",
      cyan: "#88C0D0",
      white: "#E5E9F0",
    },
  },
  {
    id: "solar-ember",
    name: "Solar Ember",
    base: {
      background: "#1A1410",
      foreground: "#FCE8C3",
      cursor: "#FFB454",
    },
    semantic: {
      panelBg: "#2A1F1A",
      border: "#3A2A22",
      selectionBg: "#3A2A22",
      selectionFg: "#FFFFFF",
      highlight: "#FFB454",
      match: "#FFD166",
      muted: "#A68A64",
      error: "#FF6B6B",
      success: "#C3E88D",
      warning: "#FFD166",
      info: "#82AAFF",
    },
    ansi: {
      black: "#2A1F1A",
      red: "#FF6B6B",
      green: "#C3E88D",
      yellow: "#FFD166",
      blue: "#82AAFF",
      magenta: "#C792EA",
      cyan: "#89DDFF",
      white: "#FFFFFF",
    },
  },
  {
    id: "matrix-pulse",
    name: "Matrix Pulse",
    base: {
      background: "#000000",
      foreground: "#00FF9C",
      cursor: "#00FF9C",
    },
    semantic: {
      panelBg: "#001A00",
      border: "#003B00",
      selectionBg: "#003B00",
      selectionFg: "#00FF9C",
      highlight: "#00FF9C",
      match: "#CCFF00",
      muted: "#007A4D",
      error: "#FF3B3B",
      success: "#00FF9C",
      warning: "#CCFF00",
      info: "#0099FF",
    },
    ansi: {
      black: "#003B00",
      red: "#FF3B3B",
      green: "#00FF9C",
      yellow: "#CCFF00",
      blue: "#0099FF",
      magenta: "#FF00FF",
      cyan: "#00FFFF",
      white: "#E0FFE0",
    },
  },
  {
    id: "pastel-breeze",
    name: "Pastel Breeze",
    base: {
      background: "#1E1E2E",
      foreground: "#CDD6F4",
      cursor: "#F5C2E7",
    },
    semantic: {
      panelBg: "#313244",
      border: "#45475A",
      selectionBg: "#45475A",
      selectionFg: "#F5E0DC",
      highlight: "#F5C2E7",
      match: "#F9E2AF",
      muted: "#6C7086",
      error: "#F38BA8",
      success: "#A6E3A1",
      warning: "#F9E2AF",
      info: "#89B4FA",
    },
    ansi: {
      black: "#45475A",
      red: "#F38BA8",
      green: "#A6E3A1",
      yellow: "#F9E2AF",
      blue: "#89B4FA",
      magenta: "#F5C2E7",
      cyan: "#94E2D5",
      white: "#BAC2DE",
    },
  },
  {
    id: "copper-harbor",
    name: "Copper Harbor",
    base: {
      background: "#1C1714",
      foreground: "#F4E8D6",
      cursor: "#4ECDC4",
    },
    semantic: {
      panelBg: "#2A211C",
      border: "#6B4F3F",
      selectionBg: "#3A2A20",
      selectionFg: "#FFF7ED",
      highlight: "#F4A261",
      match: "#FFD166",
      muted: "#A78B78",
      error: "#EF476F",
      success: "#80ED99",
      warning: "#FFD166",
      info: "#4ECDC4",
    },
    ansi: {
      black: "#2A211C",
      red: "#EF476F",
      green: "#80ED99",
      yellow: "#FFD166",
      blue: "#4ECDC4",
      magenta: "#C77DFF",
      cyan: "#64DFDF",
      white: "#FFF7ED",
    },
  },
  {
    id: "jade-circuit",
    name: "Jade Circuit",
    base: {
      background: "#10201A",
      foreground: "#D8F3DC",
      cursor: "#52B788",
    },
    semantic: {
      panelBg: "#183027",
      border: "#2D6A4F",
      selectionBg: "#1B4332",
      selectionFg: "#F1FAEE",
      highlight: "#52B788",
      match: "#FFD166",
      muted: "#74A892",
      error: "#FF6B6B",
      success: "#95D5B2",
      warning: "#FFD166",
      info: "#48CAE4",
    },
    ansi: {
      black: "#183027",
      red: "#FF6B6B",
      green: "#95D5B2",
      yellow: "#FFD166",
      blue: "#48CAE4",
      magenta: "#B5179E",
      cyan: "#64DFDF",
      white: "#F1FAEE",
    },
  },
  {
    id: "rose-noir",
    name: "Rose Noir",
    base: {
      background: "#21161B",
      foreground: "#F9E2E7",
      cursor: "#FF8FAB",
    },
    semantic: {
      panelBg: "#2D1B24",
      border: "#7A344D",
      selectionBg: "#4A2433",
      selectionFg: "#FFF1F5",
      highlight: "#FF8FAB",
      match: "#F9C74F",
      muted: "#B98998",
      error: "#FF5C8A",
      success: "#80ED99",
      warning: "#F9C74F",
      info: "#8ECAE6",
    },
    ansi: {
      black: "#2D1B24",
      red: "#FF5C8A",
      green: "#80ED99",
      yellow: "#F9C74F",
      blue: "#8ECAE6",
      magenta: "#FF8FAB",
      cyan: "#90E0EF",
      white: "#FFF1F5",
    },
  },
  {
    id: "paper-terminal",
    name: "Paper Terminal",
    base: {
      background: "#F7F4EA",
      foreground: "#1D2433",
      cursor: "#1B6B6F",
    },
    semantic: {
      panelBg: "#EFE9DA",
      border: "#B8AC91",
      selectionBg: "#D8E2DC",
      selectionFg: "#111827",
      highlight: "#1B6B6F",
      match: "#B45309",
      muted: "#6B7280",
      error: "#B91C1C",
      success: "#047857",
      warning: "#B45309",
      info: "#2563EB",
    },
    ansi: {
      black: "#CFC6B2",
      red: "#B91C1C",
      green: "#047857",
      yellow: "#B45309",
      blue: "#2563EB",
      magenta: "#9333EA",
      cyan: "#1B6B6F",
      white: "#FFFFFF",
    },
  },
  {
    id: "orchid-signal",
    name: "Orchid Signal",
    base: {
      background: "#211629",
      foreground: "#F3E8FF",
      cursor: "#E879F9",
    },
    semantic: {
      panelBg: "#2B1B35",
      border: "#6D3A8C",
      selectionBg: "#3B2445",
      selectionFg: "#FAF5FF",
      highlight: "#E879F9",
      match: "#FDE047",
      muted: "#A78BFA",
      error: "#FB7185",
      success: "#86EFAC",
      warning: "#FDE047",
      info: "#38BDF8",
    },
    ansi: {
      black: "#2B1B35",
      red: "#FB7185",
      green: "#86EFAC",
      yellow: "#FDE047",
      blue: "#38BDF8",
      magenta: "#E879F9",
      cyan: "#67E8F9",
      white: "#FAF5FF",
    },
  },
  {
    id: "monochrome-pro",
    name: "Monochrome Pro",
    base: {
      background: "#121212",
      foreground: "#E0E0E0",
      cursor: "#FFFFFF",
    },
    semantic: {
      panelBg: "#1F1F1F",
      border: "#2A2A2A",
      selectionBg: "#2A2A2A",
      selectionFg: "#FFFFFF",
      highlight: "#FFFFFF",
      match: "#B0B0B0",
      muted: "#808080",
      error: "#FF5F5F",
      success: "#87FF87",
      warning: "#FFFF87",
      info: "#5F87FF",
    },
    ansi: {
      black: "#1F1F1F",
      red: "#FF5F5F",
      green: "#87FF87",
      yellow: "#FFFF87",
      blue: "#5F87FF",
      magenta: "#FF87FF",
      cyan: "#87FFFF",
      white: "#FFFFFF",
    },
  },
]

export function getThemeScheme(themeID?: string) {
  return THEMES.find((theme) => theme.id === themeID) ?? THEMES[0]
}
