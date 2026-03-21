import type { ThemeDefinition } from '../types'

export const gruvboxTheme: ThemeDefinition = {
  id: 'gruvbox',
  name: 'Gruvbox',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Retro groove color scheme with warm earthy tones',
  variables: {
    dark: {
      // Foundation — neutral ramp (dark mode)
      '--fluux-base-00': '#1d2021', // bg0_hard
      '--fluux-base-05': '#282828', // bg0
      '--fluux-base-10': '#32302f', // bg0_soft
      '--fluux-base-20': '#3c3836', // bg1
      '--fluux-base-30': '#3c3836', // bg1 (chat surface)
      '--fluux-base-40': '#504945', // bg2
      '--fluux-base-50': '#665c54', // bg3
      '--fluux-base-60': '#7c6f64', // bg4
      '--fluux-base-70': '#928374', // gray
      '--fluux-base-80': '#a89984', // fg4
      '--fluux-base-90': '#ebdbb2', // fg1
      '--fluux-base-100': '#fbf1c7', // fg0
      // Foundation — accent (orange)
      '--fluux-accent-h': '27',
      '--fluux-accent-s': '99%',
      '--fluux-accent-l': '55%',
      // Foundation — palette (bright variants)
      '--fluux-color-red': '#fb4934',
      '--fluux-color-green': '#b8bb26',
      '--fluux-color-yellow': '#fabd2f',
      '--fluux-color-blue': '#83a598',
      '--fluux-color-purple': '#d3869b',
      '--fluux-color-gray': '#928374',
      '--fluux-color-red-rgb': '251, 73, 52',
      '--fluux-color-green-rgb': '184, 187, 38',
      '--fluux-color-yellow-rgb': '250, 189, 47',
      '--fluux-color-blue-rgb': '131, 165, 152',
      '--fluux-color-purple-rgb': '211, 134, 155',
    },
    light: {
      // Foundation — neutral ramp (light mode)
      '--fluux-base-00': '#fbf1c7', // bg0
      '--fluux-base-05': '#f2e5bc', // bg0_soft
      '--fluux-base-10': '#ebdbb2', // bg1
      '--fluux-base-20': '#d5c4a1', // bg2
      '--fluux-base-30': '#fbf1c7', // bg0 (content surface)
      '--fluux-base-40': '#d5c4a1', // bg2
      '--fluux-base-50': '#bdae93', // bg3
      '--fluux-base-60': '#a89984', // bg4
      '--fluux-base-70': '#928374', // gray
      '--fluux-base-80': '#665c54', // fg3
      '--fluux-base-90': '#3c3836', // fg1
      '--fluux-base-100': '#282828', // fg0
      // Foundation — accent (orange, darkened for light)
      '--fluux-accent-h': '24',
      '--fluux-accent-s': '88%',
      '--fluux-accent-l': '35%',
      // Foundation — palette (faded variants for light)
      '--fluux-color-red': '#9d0006',
      '--fluux-color-green': '#79740e',
      '--fluux-color-yellow': '#b57614',
      '--fluux-color-blue': '#076678',
      '--fluux-color-purple': '#8f3f71',
      '--fluux-color-gray': '#928374',
      '--fluux-color-red-rgb': '157, 0, 6',
      '--fluux-color-green-rgb': '121, 116, 14',
      '--fluux-color-yellow-rgb': '181, 118, 20',
      '--fluux-color-blue-rgb': '7, 102, 120',
      '--fluux-color-purple-rgb': '143, 63, 113',
      // Semantic overrides
      '--fluux-bg-secondary': '#e8d8a8',
      '--fluux-border-color': 'rgba(60, 56, 54, 0.15)',
      '--fluux-selection-bg': 'hsla(24, 88%, 35%, 0.15)',
      '--fluux-scrollbar-thumb': '#bdae93',
      '--fluux-scrollbar-thumb-hover': '#a89984',
    },
  },
  swatches: {
    dark: ['#282828', '#3c3836', '#fe8019', '#b8bb26', '#83a598'],
    light: ['#ebdbb2', '#fbf1c7', '#af3a03', '#79740e', '#076678'],
  },
}
