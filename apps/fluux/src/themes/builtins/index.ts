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
    dark: ['#0B1020', '#0E1326', '#7C8CFF', '#38E0C4', '#A78BFA'],
    light: ['#E7EAF4', '#EEF0F8', '#5B6CF0', '#11A88C', '#A78BFA'],
  },
  // Curated accent presets tuned to the Aurora palette — saturated jewel tones
  // that read as luminous fills on the deep-ink base. (The generic
  // DEFAULT_ACCENT_PRESETS are paler, tuned for accent-as-foreground, and remain
  // the fallback for themes that don't ship their own.)
  accentPresets: [
    { name: 'Periwinkle', dark: { h: 231, s: 90, l: 66 }, light: { h: 231, s: 85, l: 58 } },
    { name: 'Violet',     dark: { h: 258, s: 85, l: 70 }, light: { h: 258, s: 72, l: 56 } },
    { name: 'Mauve',      dark: { h: 294, s: 60, l: 73 }, light: { h: 294, s: 50, l: 58 } },
    { name: 'Magenta',    dark: { h: 322, s: 80, l: 66 }, light: { h: 322, s: 72, l: 50 } },
    { name: 'Rose',       dark: { h: 344, s: 85, l: 68 }, light: { h: 344, s: 78, l: 52 } },
    { name: 'Coral',      dark: { h: 14,  s: 88, l: 66 }, light: { h: 14,  s: 82, l: 52 } },
    { name: 'Amber',      dark: { h: 40,  s: 95, l: 60 }, light: { h: 40,  s: 90, l: 46 } },
    { name: 'Mint',       dark: { h: 152, s: 60, l: 52 }, light: { h: 152, s: 55, l: 38 } },
    { name: 'Teal',       dark: { h: 174, s: 70, l: 52 }, light: { h: 174, s: 65, l: 36 } },
    { name: 'Sky',        dark: { h: 196, s: 90, l: 58 }, light: { h: 196, s: 85, l: 42 } },
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
