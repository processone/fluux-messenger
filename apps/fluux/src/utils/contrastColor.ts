/** Color contrast helpers (WCAG). Shared by Avatar and sender-color generation. */

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : null
}

/** Relative luminance (0-1) per WCAG. */
export function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function toHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/**
 * Darken `hex` until it reaches `ratio` contrast against a background of
 * luminance `bgLuminance`. Returns the original if it already passes.
 */
export function ensureContrast(hex: string, bgLuminance: number, ratio = 4.5): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  let factor = 0
  let r = rgb.r, g = rgb.g, b = rgb.b
  while (contrastRatio(getLuminance(r, g, b), bgLuminance) < ratio && factor < 0.92) {
    factor += 0.08
    r = Math.round(rgb.r * (1 - factor))
    g = Math.round(rgb.g * (1 - factor))
    b = Math.round(rgb.b * (1 - factor))
  }
  return toHex(r, g, b)
}

/** Convenience: AA (4.5:1) against pure white. */
export function ensureContrastWithWhite(hex: string): string {
  return ensureContrast(hex, 1.0, 4.5)
}

/**
 * Lighten `hex` (blend toward white) until it reaches `ratio` contrast against a
 * background of luminance `bgLuminance`. The dark-surface counterpart of
 * `ensureContrast`: on a dark background a color clears AA by getting brighter,
 * not darker. Returns the original if it already passes.
 */
export function ensureContrastOnDark(hex: string, bgLuminance: number, ratio = 4.5): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  let factor = 0
  let r = rgb.r, g = rgb.g, b = rgb.b
  while (contrastRatio(getLuminance(r, g, b), bgLuminance) < ratio && factor < 0.92) {
    factor += 0.08
    r = Math.round(rgb.r + (255 - rgb.r) * factor)
    g = Math.round(rgb.g + (255 - rgb.g) * factor)
    b = Math.round(rgb.b + (255 - rgb.b) * factor)
  }
  return toHex(r, g, b)
}
