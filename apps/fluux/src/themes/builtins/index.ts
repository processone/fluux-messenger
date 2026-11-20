import type { ThemeDefinition } from '../types'
import { nordTheme } from './nord'
import { catppuccinMochaTheme } from './catppuccin-mocha'
import { solarizedTheme } from './solarized'
import { draculaTheme } from './dracula'
import { gruvboxTheme } from './gruvbox'
import { oneDarkTheme } from './one-dark'
import { tokyoNightTheme } from './tokyo-night'
import { monokaiTheme } from './monokai'
import { rosePineTheme } from './rose-pine'
import { kanagawaTheme } from './kanagawa'
import { githubTheme } from './github'
import { indigoTheme } from './indigo'
import { pureTheme } from './pure'

/**
 * Aurora — the default Fluux theme. Its variables live in index.css (:root /
 * .light); the id stays 'fluux' for back-compat with persisted selections.
 * This entry exists so the theme picker can show it alongside custom themes.
 */
export const fluuxTheme: ThemeDefinition = {
  id: 'fluux',
  name: 'Aurora',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Aurora — the default Fluux identity: luminous periwinkle on deep ink',
  variables: {
    // No overrides — the :root / .light CSS defaults (Aurora) are used
    dark: {},
    light: {},
  },
  swatches: {
    dark: ['#181B27', '#1C202E', '#7C8CFF', '#38E0C4', '#A78BFA'],
    light: ['#E7EAF4', '#F1F3F9', '#3954EF', '#11A88C', '#A78BFA'],
  },
  // Curated accent presets tuned to the Aurora surfaces, one family per mode.
  // Dark: luminous fills at an even OKLCH lightness (~0.74) that carry dark ink
  // text (8:1 or more) and read as accent text on the chat canvas (6:1 or more).
  // Light: deep fills at an even WCAG luminance that carry white text (~5.9:1)
  // and stay AA as accent text on the white canvas and its hover row. Periwinkle
  // equals the CSS default in both modes. accentPresets.test.ts guards all of it.
  // (The generic DEFAULT_ACCENT_PRESETS remain the fallback for themes that
  // don't ship their own.)
  accentPresets: [
    { name: 'Periwinkle', dark: { h: 231, s: 100, l: 64 }, light: { h: 231, s: 85, l: 58 } },
    { name: 'Violet',     dark: { h: 254, s: 98,  l: 80 }, light: { h: 259, s: 60, l: 55 } },
    { name: 'Mauve',      dark: { h: 291, s: 62,  l: 71 }, light: { h: 292, s: 44, l: 45 } },
    { name: 'Magenta',    dark: { h: 329, s: 94,  l: 72 }, light: { h: 324, s: 70, l: 43 } },
    { name: 'Rose',       dark: { h: 349, s: 99,  l: 74 }, light: { h: 340, s: 78, l: 43 } },
    { name: 'Coral',      dark: { h: 14,  s: 93,  l: 68 }, light: { h: 18,  s: 98, l: 36 } },
    { name: 'Amber',      dark: { h: 36,  s: 74,  l: 54 }, light: { h: 38,  s: 97, l: 28 } },
    { name: 'Mint',       dark: { h: 151, s: 55,  l: 52 }, light: { h: 156, s: 95, l: 23 } },
    { name: 'Teal',       dark: { h: 174, s: 60,  l: 48 }, light: { h: 175, s: 95, l: 23 } },
    { name: 'Sky',        dark: { h: 199, s: 84,  l: 59 }, light: { h: 196, s: 93, l: 29 } },
  ],
}

/** All built-in themes, ordered for the theme picker */
export const builtinThemes: ThemeDefinition[] = [
  fluuxTheme,
  indigoTheme,
  draculaTheme,
  nordTheme,
  gruvboxTheme,
  catppuccinMochaTheme,
  solarizedTheme,
  oneDarkTheme,
  tokyoNightTheme,
  monokaiTheme,
  rosePineTheme,
  kanagawaTheme,
  githubTheme,
  pureTheme,
]

/** Look up a built-in theme by ID */
export function getBuiltinTheme(id: string): ThemeDefinition | undefined {
  return builtinThemes.find((t) => t.id === id)
}
