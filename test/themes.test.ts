import { expect, test } from "bun:test"
import { THEMES } from "../src/lib/themes.js"

function channels(hex: string) {
  return hex.slice(1).match(/../g)!.map(channel => Number.parseInt(channel, 16) / 255)
}

function hue(hex: string) {
  const [r, g, b] = channels(hex)
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  if (!delta) return -1
  const sector = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return (sector * 60 + 360) % 360
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

for (const theme of THEMES) {
  test(`${theme.name} keeps recognizable and visible semantic accents`, () => {
    expect(hue(theme.semantic.success)).toBeGreaterThanOrEqual(75)
    expect(hue(theme.semantic.success)).toBeLessThanOrEqual(170)
    const error = hue(theme.semantic.error)
    expect(error >= 340 || error <= 15).toBe(true)
    expect(hue(theme.semantic.warning)).toBeGreaterThanOrEqual(25)
    expect(hue(theme.semantic.warning)).toBeLessThanOrEqual(65)
    for (const role of ["success", "error", "warning", "info"] as const) {
      for (const background of [theme.base.background, theme.semantic.panelBg]) {
        const foregroundLuminance = luminance(theme.semantic[role])
        const backgroundLuminance = luminance(background)
        const contrast = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
        expect(contrast).toBeGreaterThanOrEqual(3)
      }
    }
  })
}
