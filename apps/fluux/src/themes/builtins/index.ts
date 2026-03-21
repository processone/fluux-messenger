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

/**
 * The default Fluux theme — its variables are defined in index.css (:root / .light).
 * This entry exists so the theme picker can show it alongside custom themes.
 */
export const fluuxTheme: ThemeDefinition = {
  id: 'fluux',
  name: 'Fluux',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Default Fluux color palette',
  variables: {
    // No overrides — the :root / .light CSS defaults are used
    dark: {},
    light: {},
  },
  swatches: {
    dark: ['#1e1f22', '#2b2d31', '#5865f2', '#00a8fc', '#23a559'],
    light: ['#e3e5e8', '#ebedef', '#5865f2', '#0969da', '#23a559'],
  },
}

/** All built-in themes, ordered for the theme picker */
export const builtinThemes: ThemeDefinition[] = [
  fluuxTheme,
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
