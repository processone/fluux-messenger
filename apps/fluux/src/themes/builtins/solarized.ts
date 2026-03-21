import type { ThemeDefinition } from '../types'

export const solarizedTheme: ThemeDefinition = {
  id: 'solarized',
  name: 'Solarized',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Ethan Schoonover\'s precision color scheme for readability',
  variables: {
    dark: {
      // Foundation — neutral ramp (Solarized dark)
      '--fluux-base-00': '#002129',
      '--fluux-base-05': '#00212b',
      '--fluux-base-10': '#002b36', // base03
      '--fluux-base-20': '#073642', // base02
      '--fluux-base-30': '#0a4050',
      '--fluux-base-40': '#586e75', // base01
      '--fluux-base-50': '#657b83', // base00
      '--fluux-base-60': '#839496', // base0
      '--fluux-base-70': '#93a1a1', // base1
      '--fluux-base-80': '#93a1a1', // base1
      '--fluux-base-90': '#eee8d5', // base2
      '--fluux-base-100': '#fdf6e3', // base3
      // Foundation — accent (Solarized blue)
      '--fluux-accent-h': '205',
      '--fluux-accent-s': '69%',
      '--fluux-accent-l': '49%',
      // Foundation — palette
      '--fluux-color-red': '#dc322f',
      '--fluux-color-green': '#859900',
      '--fluux-color-yellow': '#b58900',
      '--fluux-color-blue': '#268bd2',
      '--fluux-color-purple': '#6c71c4',
      '--fluux-color-gray': '#657b83',
      '--fluux-color-red-rgb': '220, 50, 47',
      '--fluux-color-green-rgb': '133, 153, 0',
      '--fluux-color-yellow-rgb': '181, 137, 0',
      '--fluux-color-blue-rgb': '38, 139, 210',
      '--fluux-color-purple-rgb': '108, 113, 196',
    },
    light: {
      // Foundation — neutral ramp (Solarized light — flipped)
      '--fluux-base-00': '#ffffff',
      '--fluux-base-05': '#f5efdc',
      '--fluux-base-10': '#fdf6e3', // base3
      '--fluux-base-20': '#eee8d5', // base2
      '--fluux-base-30': '#ffffff',
      '--fluux-base-40': '#d6cdb7',
      '--fluux-base-50': '#c5bca6',
      '--fluux-base-60': '#93a1a1', // base1
      '--fluux-base-70': '#839496', // base0
      '--fluux-base-80': '#657b83', // base00
      '--fluux-base-90': '#586e75', // base01
      '--fluux-base-100': '#002b36', // base03
      // Foundation — accent (Solarized blue, adjusted)
      '--fluux-accent-h': '205',
      '--fluux-accent-s': '69%',
      '--fluux-accent-l': '42%',
      // Foundation — palette
      '--fluux-color-red': '#dc322f',
      '--fluux-color-green': '#718c00',
      '--fluux-color-yellow': '#a07800',
      '--fluux-color-blue': '#268bd2',
      '--fluux-color-purple': '#6c71c4',
      '--fluux-color-gray': '#839496',
      '--fluux-color-red-rgb': '220, 50, 47',
      '--fluux-color-green-rgb': '113, 140, 0',
      '--fluux-color-yellow-rgb': '160, 120, 0',
      '--fluux-color-blue-rgb': '38, 139, 210',
      '--fluux-color-purple-rgb': '108, 113, 196',
      // Semantic overrides
      '--fluux-bg-secondary': '#e8e1cd',
      '--fluux-border-color': 'rgba(88, 110, 117, 0.15)',
      '--fluux-selection-bg': 'hsla(205, 69%, 42%, 0.15)',
      '--fluux-scrollbar-thumb': '#c5bca6',
      '--fluux-scrollbar-thumb-hover': '#b3a992',
    },
  },
  swatches: {
    dark: ['#002b36', '#073642', '#268bd2', '#2aa198', '#859900'],
    light: ['#fdf6e3', '#eee8d5', '#268bd2', '#2aa198', '#718c00'],
  },
}
