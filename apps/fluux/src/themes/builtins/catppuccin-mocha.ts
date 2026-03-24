import type { ThemeDefinition } from '../types'

export const catppuccinMochaTheme: ThemeDefinition = {
  id: 'catppuccin-mocha',
  name: 'Catppuccin Mocha',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Warm, soothing pastel dark theme from the Catppuccin palette',
  variables: {
    dark: {
      // Foundation — neutral ramp (Mocha base)
      '--fluux-base-00': '#11111b', // crust
      '--fluux-base-05': '#181825', // mantle
      '--fluux-base-10': '#1e1e2e', // base
      '--fluux-base-20': '#313244', // surface0
      '--fluux-base-30': '#45475a', // surface1
      '--fluux-base-40': '#585b70', // surface2
      '--fluux-base-50': '#6c7086', // overlay0
      '--fluux-base-60': '#7f849c', // overlay1
      '--fluux-base-70': '#9399b2', // overlay2
      '--fluux-base-80': '#a6adc8', // subtext0
      '--fluux-base-90': '#cdd6f4', // text
      '--fluux-base-100': '#f5f5f5',
      // Foundation — accent (mauve)
      '--fluux-accent-h': '267',
      '--fluux-accent-s': '84%',
      '--fluux-accent-l': '81%',
      // Foundation — palette
      '--fluux-color-red': '#f38ba8',    // red
      '--fluux-color-green': '#a6e3a1',  // green
      '--fluux-color-yellow': '#f9e2af', // yellow
      '--fluux-color-blue': '#89b4fa',   // blue
      '--fluux-color-purple': '#cba6f7', // mauve
      '--fluux-color-gray': '#7f849c',
      '--fluux-color-red-rgb': '243, 139, 168',
      '--fluux-color-green-rgb': '166, 227, 161',
      '--fluux-color-yellow-rgb': '249, 226, 175',
      '--fluux-color-blue-rgb': '137, 180, 250',
      '--fluux-color-purple-rgb': '203, 166, 247',
      // Syntax highlighting
      '--shiki-token-keyword': '#cba6f7',
      '--shiki-token-string': '#a6e3a1',
      '--shiki-token-string-expression': '#a6e3a1',
      '--shiki-token-comment': '#6c7086',
      '--shiki-token-function': '#89b4fa',
      '--shiki-token-constant': '#fab387',
      '--shiki-token-parameter': '#f2cdcd',
      '--shiki-token-punctuation': '#9399b2',
      '--shiki-token-link': '#89b4fa',
    },
    light: {
      // Foundation — neutral ramp (Latte base)
      '--fluux-base-00': '#eff1f5', // base
      '--fluux-base-05': '#e6e9ef', // mantle
      '--fluux-base-10': '#dce0e8', // crust
      '--fluux-base-20': '#d4d7e2',
      '--fluux-base-30': '#eff1f5', // base (content surface)
      '--fluux-base-40': '#ccd0da', // surface0
      '--fluux-base-50': '#bcc0cc', // surface1
      '--fluux-base-60': '#acb0be', // surface2
      '--fluux-base-70': '#8c8fa1', // overlay0
      '--fluux-base-80': '#6c6f85', // subtext0
      '--fluux-base-90': '#4c4f69', // text
      '--fluux-base-100': '#1e1e2e',
      // Foundation — accent (mauve, adjusted for light)
      '--fluux-accent-h': '267',
      '--fluux-accent-s': '83%',
      '--fluux-accent-l': '58%',
      // Foundation — palette (Latte)
      '--fluux-color-red': '#d20f39',
      '--fluux-color-green': '#40a02b',
      '--fluux-color-yellow': '#df8e1d',
      '--fluux-color-blue': '#1e66f5',
      '--fluux-color-purple': '#8839ef',
      '--fluux-color-gray': '#8c8fa1',
      '--fluux-color-red-rgb': '210, 15, 57',
      '--fluux-color-green-rgb': '64, 160, 43',
      '--fluux-color-yellow-rgb': '223, 142, 29',
      '--fluux-color-blue-rgb': '30, 102, 245',
      '--fluux-color-purple-rgb': '136, 57, 239',
      // Semantic overrides
      '--fluux-bg-secondary': '#dce0e8',
      '--fluux-border-color': 'rgba(76, 79, 105, 0.12)',
      '--fluux-selection-bg': 'hsla(267, 83%, 58%, 0.15)',
      '--fluux-scrollbar-thumb': '#bcc0cc',
      '--fluux-scrollbar-thumb-hover': '#acb0be',
      // Syntax highlighting
      '--shiki-token-keyword': '#8839ef',
      '--shiki-token-string': '#40a02b',
      '--shiki-token-string-expression': '#40a02b',
      '--shiki-token-comment': '#8c8fa1',
      '--shiki-token-function': '#1e66f5',
      '--shiki-token-constant': '#fe640b',
      '--shiki-token-parameter': '#dd7878',
      '--shiki-token-punctuation': '#6c6f85',
      '--shiki-token-link': '#1e66f5',
    },
  },
  swatches: {
    dark: ['#1e1e2e', '#313244', '#cba6f7', '#89b4fa', '#a6e3a1'],
    light: ['#dce0e8', '#eff1f5', '#8839ef', '#1e66f5', '#40a02b'],
  },
}
