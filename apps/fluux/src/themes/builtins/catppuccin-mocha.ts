import type { ThemeDefinition, AccentPreset } from '../types'

/**
 * Catppuccin canonical accent presets.
 * Dark values: Mocha palette.  Light values: Latte palette.
 * HSL values sourced from the official Catppuccin style guide.
 */
const catppuccinAccents: AccentPreset[] = [
  { name: 'Rosewater',  dark: { h: 10,  s: 56, l: 91 }, light: { h: 11,  s: 59, l: 67 } },
  { name: 'Flamingo',   dark: { h: 0,   s: 59, l: 88 }, light: { h: 0,   s: 60, l: 67 } },
  { name: 'Pink',       dark: { h: 316, s: 72, l: 86 }, light: { h: 316, s: 73, l: 69 } },
  { name: 'Mauve',      dark: { h: 267, s: 84, l: 81 }, light: { h: 266, s: 85, l: 58 } },
  { name: 'Red',        dark: { h: 343, s: 81, l: 75 }, light: { h: 347, s: 87, l: 44 } },
  { name: 'Maroon',     dark: { h: 350, s: 65, l: 77 }, light: { h: 355, s: 76, l: 59 } },
  { name: 'Peach',      dark: { h: 23,  s: 92, l: 75 }, light: { h: 22,  s: 99, l: 52 } },
  { name: 'Yellow',     dark: { h: 41,  s: 86, l: 83 }, light: { h: 35,  s: 77, l: 49 } },
  { name: 'Green',      dark: { h: 115, s: 54, l: 76 }, light: { h: 109, s: 58, l: 40 } },
  { name: 'Teal',       dark: { h: 170, s: 57, l: 73 }, light: { h: 183, s: 74, l: 35 } },
  { name: 'Sky',        dark: { h: 189, s: 71, l: 73 }, light: { h: 197, s: 97, l: 46 } },
  { name: 'Sapphire',   dark: { h: 199, s: 76, l: 69 }, light: { h: 189, s: 70, l: 42 } },
  { name: 'Blue',       dark: { h: 217, s: 92, l: 76 }, light: { h: 220, s: 91, l: 54 } },
  { name: 'Lavender',   dark: { h: 232, s: 97, l: 85 }, light: { h: 231, s: 97, l: 72 } },
]

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
  accentPresets: catppuccinAccents,
}
