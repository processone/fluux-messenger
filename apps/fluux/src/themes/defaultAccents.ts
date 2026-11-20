import type { AccentPreset } from './types'

/**
 * Universal accent presets used when a theme doesn't provide its own.
 *
 * One list serves every such theme, so it is tuned against all of their
 * surfaces at once rather than one palette:
 *
 * - Dark: luminous fills in one luminance band (0.50 to 0.60), so none glows
 *   or sinks next to the others, each takes black text, and each reads as
 *   accent text (4.5:1) on the lightest dark chat canvas (Nord's).
 * - Light: deep fills in one band where white text sits at 6.0 to 6.8:1, so
 *   every fill takes white text and reads as accent text on the darkest light
 *   chat canvas (Tokyo Night's). Yellow therefore turns gold in light mode:
 *   a true yellow cannot carry white text or read as text on a light page.
 *
 * Names are the identity a stored or synced choice is matched by; keep them.
 * accentPresets.test.ts guards all of this against every built-in theme.
 */
export const DEFAULT_ACCENT_PRESETS: AccentPreset[] = [
  { name: 'Blue',     dark: { h: 212, s: 92, l: 78 }, light: { h: 214, s: 90, l: 40 } },
  { name: 'Purple',   dark: { h: 270, s: 90, l: 85 }, light: { h: 268, s: 72, l: 52 } },
  { name: 'Pink',     dark: { h: 320, s: 80, l: 82 }, light: { h: 322, s: 72, l: 40 } },
  { name: 'Red',      dark: { h: 356, s: 95, l: 82 }, light: { h: 350, s: 82, l: 41 } },
  { name: 'Orange',   dark: { h: 22,  s: 95, l: 75 }, light: { h: 22,  s: 95, l: 33 } },
  { name: 'Yellow',   dark: { h: 43,  s: 90, l: 60 }, light: { h: 38,  s: 95, l: 27 } },
  { name: 'Green',    dark: { h: 120, s: 55, l: 66 }, light: { h: 130, s: 60, l: 27 } },
  { name: 'Teal',     dark: { h: 168, s: 60, l: 61 }, light: { h: 172, s: 85, l: 23 } },
  { name: 'Sky',      dark: { h: 192, s: 80, l: 66 }, light: { h: 196, s: 90, l: 28 } },
  { name: 'Lavender', dark: { h: 245, s: 95, l: 86 }, light: { h: 245, s: 72, l: 58 } },
]
