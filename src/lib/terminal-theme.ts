type WritableStreamLike = {
  write(chunk: string): unknown
}

function normalizeHexColor(color: string) {
  const trimmed = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed
  return undefined
}

function hexToRgb(color: string) {
  const hex = normalizeHexColor(color)
  if (!hex) return undefined
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  }
}

export function terminalBackgroundSequence(color: string) {
  const hex = normalizeHexColor(color)
  const rgb = hexToRgb(color)
  if (!hex || !rgb) return ""
  return `\u001b]11;${hex}\u001b\\\u001b[48;2;${rgb.red};${rgb.green};${rgb.blue}m`
}

export function terminalBackgroundResetSequence() {
  return "\u001b]111\u001b\\\u001b[49m"
}

export function writeTerminalBackground(stream: WritableStreamLike | undefined, color: string) {
  const sequence = terminalBackgroundSequence(color)
  if (!stream || !sequence) return
  try {
    stream.write(sequence)
  } catch {
    // Terminal color control is best-effort.
  }
}

export function resetTerminalBackground(stream: WritableStreamLike | undefined) {
  if (!stream) return
  try {
    stream.write(terminalBackgroundResetSequence())
  } catch {
    // Terminal color control is best-effort.
  }
}
