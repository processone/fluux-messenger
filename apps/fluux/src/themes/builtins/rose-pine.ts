import type { ThemeDefinition } from '../types'

export const rosePineTheme: ThemeDefinition = {
  id: 'rose-pine',
  name: 'Rosé Pine',
  author: 'Fluux',
  version: '1.0.0',
  description: 'All natural pine, faux fur, and a bit of soho vibes',
  variables: {
    dark: {
      // Foundation — neutral ramp (Main variant)
      '--fluux-base-00': '#191724', // base
      '--fluux-base-05': '#1f1d2e', // surface
      '--fluux-base-10': '#1f1d2e', // surface
      '--fluux-base-20': '#26233a', // overlay
      '--fluux-base-30': '#26233a', // overlay (chat surface)
      '--fluux-base-40': '#403d52', // highlight_med
      '--fluux-base-50': '#524f67', // highlight_high
      '--fluux-base-60': '#6e6a86', // muted
      '--fluux-base-70': '#6e6a86', // muted
      '--fluux-base-80': '#908caa', // subtle
      '--fluux-base-90': '#e0def4', // text
      '--fluux-base-100': '#f0eef8',
      // Foundation — accent (iris / purple)
      '--fluux-accent-h': '267',
      '--fluux-accent-s': '57%',
      '--fluux-accent-l': '78%',
      // Foundation — palette
      '--fluux-color-red': '#eb6f92',    // love
      '--fluux-color-green': '#31748f',  // pine
      '--fluux-color-yellow': '#f6c177', // gold
      '--fluux-color-blue': '#9ccfd8',   // foam
      '--fluux-color-purple': '#c4a7e7', // iris
      '--fluux-color-gray': '#6e6a86',   // muted
      '--fluux-color-red-rgb': '235, 111, 146',
      '--fluux-color-green-rgb': '49, 116, 143',
      '--fluux-color-yellow-rgb': '246, 193, 119',
      '--fluux-color-blue-rgb': '156, 207, 216',
      '--fluux-color-purple-rgb': '196, 167, 231',
      // Semantic — rose pink for links
      '--fluux-text-link': '#ebbcba',
    },
    light: {
      // Foundation — neutral ramp (Dawn variant)
      '--fluux-base-00': '#faf4ed', // base
      '--fluux-base-05': '#f4ede8', // highlight_low
      '--fluux-base-10': '#f2e9e1', // overlay
      '--fluux-base-20': '#f2e9e1', // overlay
      '--fluux-base-30': '#fffaf3', // surface (content area)
      '--fluux-base-40': '#dfdad9', // highlight_med
      '--fluux-base-50': '#cecacd', // highlight_high
      '--fluux-base-60': '#9893a5', // muted
      '--fluux-base-70': '#9893a5', // muted
      '--fluux-base-80': '#797593', // subtle
      '--fluux-base-90': '#575279', // text
      '--fluux-base-100': '#26233a',
      // Foundation — accent (iris, adjusted for light)
      '--fluux-accent-h': '267',
      '--fluux-accent-s': '22%',
      '--fluux-accent-l': '57%',
      // Foundation — palette (Dawn)
      '--fluux-color-red': '#b4637a',    // love
      '--fluux-color-green': '#286983',  // pine
      '--fluux-color-yellow': '#ea9d34', // gold
      '--fluux-color-blue': '#56949f',   // foam
      '--fluux-color-purple': '#907aa9', // iris
      '--fluux-color-gray': '#9893a5',   // muted
      '--fluux-color-red-rgb': '180, 99, 122',
      '--fluux-color-green-rgb': '40, 105, 131',
      '--fluux-color-yellow-rgb': '234, 157, 52',
      '--fluux-color-blue-rgb': '86, 148, 159',
      '--fluux-color-purple-rgb': '144, 122, 169',
      // Semantic overrides
      '--fluux-bg-secondary': '#f4ede8',
      '--fluux-border-color': 'rgba(87, 82, 121, 0.10)',
      '--fluux-selection-bg': 'hsla(267, 22%, 57%, 0.15)',
      '--fluux-scrollbar-thumb': '#dfdad9',
      '--fluux-scrollbar-thumb-hover': '#cecacd',
      '--fluux-text-link': '#d7827e',
    },
  },
  swatches: {
    dark: ['#191724', '#26233a', '#c4a7e7', '#eb6f92', '#9ccfd8'],
    light: ['#f2e9e1', '#fffaf3', '#907aa9', '#b4637a', '#56949f'],
  },
}
