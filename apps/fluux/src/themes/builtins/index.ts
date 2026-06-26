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
]

/** Look up a built-in theme by ID */
export function getBuiltinTheme(id: string): ThemeDefinition | undefined {
  return builtinThemes.find((t) => t.id === id)
}
