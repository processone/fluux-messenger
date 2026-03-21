import type { ThemeDefinition } from '../types'

export const tokyoNightTheme: ThemeDefinition = {
  id: 'tokyo-night',
  name: 'Tokyo Night',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Clean dark palette inspired by Tokyo city lights at night',
  variables: {
    dark: {
      // Foundation — neutral ramp (Night variant)
      '--fluux-base-00': '#16161e', // bg_dark
      '--fluux-base-05': '#1a1b26', // bg
      '--fluux-base-10': '#1a1b26', // bg
      '--fluux-base-20': '#24283b', // storm bg / highlight
      '--fluux-base-30': '#292e42', // bg_highlight
      '--fluux-base-40': '#3b4261', // fg_gutter
      '--fluux-base-50': '#414868', // terminal_black
      '--fluux-base-60': '#545c7e', // dark3
      '--fluux-base-70': '#565f89', // comment
      '--fluux-base-80': '#737aa2', // dark5
      '--fluux-base-90': '#c0caf5', // fg
      '--fluux-base-100': '#e0e4ff',
      // Foundation — accent (blue)
      '--fluux-accent-h': '225',
      '--fluux-accent-s': '89%',
      '--fluux-accent-l': '73%',
      // Foundation — palette
      '--fluux-color-red': '#f7768e',
      '--fluux-color-green': '#9ece6a',
      '--fluux-color-yellow': '#e0af68',
      '--fluux-color-blue': '#7aa2f7',
      '--fluux-color-purple': '#bb9af7',
      '--fluux-color-gray': '#545c7e',
      '--fluux-color-red-rgb': '247, 118, 142',
      '--fluux-color-green-rgb': '158, 206, 106',
      '--fluux-color-yellow-rgb': '224, 175, 104',
      '--fluux-color-blue-rgb': '122, 162, 247',
      '--fluux-color-purple-rgb': '187, 154, 247',
    },
    light: {
      // Foundation — neutral ramp (Day variant)
      '--fluux-base-00': '#e1e2e7', // bg
      '--fluux-base-05': '#d5d6db',
      '--fluux-base-10': '#d0d5e3', // bg_dark
      '--fluux-base-20': '#c4c8da', // bg_highlight
      '--fluux-base-30': '#e1e2e7', // bg (content surface)
      '--fluux-base-40': '#b4b5b9', // terminal_black
      '--fluux-base-50': '#a8aecb', // fg_gutter
      '--fluux-base-60': '#8990b3', // dark3
      '--fluux-base-70': '#848cb5', // comment
      '--fluux-base-80': '#68709a', // dark5
      '--fluux-base-90': '#3760bf', // fg
      '--fluux-base-100': '#1a1b26',
      // Foundation — accent (blue, adjusted for light)
      '--fluux-accent-h': '220',
      '--fluux-accent-s': '72%',
      '--fluux-accent-l': '52%',
      // Foundation — palette (Day)
      '--fluux-color-red': '#f52a65',
      '--fluux-color-green': '#587539',
      '--fluux-color-yellow': '#8c6c3e',
      '--fluux-color-blue': '#2e7de9',
      '--fluux-color-purple': '#7847bd',
      '--fluux-color-gray': '#8990b3',
      '--fluux-color-red-rgb': '245, 42, 101',
      '--fluux-color-green-rgb': '88, 117, 57',
      '--fluux-color-yellow-rgb': '140, 108, 62',
      '--fluux-color-blue-rgb': '46, 125, 233',
      '--fluux-color-purple-rgb': '120, 71, 189',
      // Semantic overrides
      '--fluux-bg-secondary': '#c4c8da',
      '--fluux-border-color': 'rgba(55, 96, 191, 0.12)',
      '--fluux-selection-bg': 'hsla(220, 72%, 52%, 0.15)',
      '--fluux-scrollbar-thumb': '#b4b5b9',
      '--fluux-scrollbar-thumb-hover': '#a0a1a5',
    },
  },
  swatches: {
    dark: ['#1a1b26', '#24283b', '#7aa2f7', '#bb9af7', '#9ece6a'],
    light: ['#d0d5e3', '#e1e2e7', '#2e7de9', '#7847bd', '#587539'],
  },
}
