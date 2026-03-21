import type { ThemeDefinition } from '../types'

export const kanagawaTheme: ThemeDefinition = {
  id: 'kanagawa',
  name: 'Kanagawa',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Dark theme inspired by Hokusai\'s The Great Wave off Kanagawa',
  variables: {
    dark: {
      // Foundation — neutral ramp (Wave variant)
      '--fluux-base-00': '#16161D', // sumiInk0
      '--fluux-base-05': '#181820', // sumiInk1
      '--fluux-base-10': '#1F1F28', // sumiInk3 (default bg)
      '--fluux-base-20': '#2A2A37', // sumiInk4
      '--fluux-base-30': '#2A2A37', // sumiInk4 (chat surface)
      '--fluux-base-40': '#363646', // sumiInk5
      '--fluux-base-50': '#54546D', // sumiInk6
      '--fluux-base-60': '#727169', // fujiGray (comments)
      '--fluux-base-70': '#727169', // fujiGray
      '--fluux-base-80': '#C8C093', // oldWhite
      '--fluux-base-90': '#DCD7BA', // fujiWhite (fg)
      '--fluux-base-100': '#EDEAD4',
      // Foundation — accent (crystalBlue)
      '--fluux-accent-h': '222',
      '--fluux-accent-s': '49%',
      '--fluux-accent-l': '67%',
      // Foundation — palette
      '--fluux-color-red': '#E46876',    // waveRed
      '--fluux-color-green': '#98BB6C',  // springGreen
      '--fluux-color-yellow': '#E6C384', // carpYellow
      '--fluux-color-blue': '#7E9CD8',   // crystalBlue
      '--fluux-color-purple': '#957FB8', // oniViolet
      '--fluux-color-gray': '#727169',   // fujiGray
      '--fluux-color-red-rgb': '228, 104, 118',
      '--fluux-color-green-rgb': '152, 187, 108',
      '--fluux-color-yellow-rgb': '230, 195, 132',
      '--fluux-color-blue-rgb': '126, 156, 216',
      '--fluux-color-purple-rgb': '149, 127, 184',
      // Semantic — warm orange for links
      '--fluux-text-link': '#FFA066', // surimiOrange
    },
    light: {
      // Foundation — neutral ramp (Lotus variant)
      '--fluux-base-00': '#e5ddb0', // lotusWhite2
      '--fluux-base-05': '#e7dba0', // lotusWhite4
      '--fluux-base-10': '#f2ecbc', // lotusWhite3 (default bg)
      '--fluux-base-20': '#e5ddb0', // lotusWhite2
      '--fluux-base-30': '#f2ecbc', // lotusWhite3 (content surface)
      '--fluux-base-40': '#d5cea3', // lotusWhite0
      '--fluux-base-50': '#c9cbd1', // lotusViolet3
      '--fluux-base-60': '#8a8980', // lotusGray3 (comments)
      '--fluux-base-70': '#8a8980', // lotusGray3
      '--fluux-base-80': '#716e61', // lotusGray2
      '--fluux-base-90': '#545464', // lotusInk1 (fg)
      '--fluux-base-100': '#43436c', // lotusInk2
      // Foundation — accent (lotusBlue4 / functions)
      '--fluux-accent-h': '219',
      '--fluux-accent-s': '36%',
      '--fluux-accent-l': '45%',
      // Foundation — palette (Lotus)
      '--fluux-color-red': '#c84053',    // lotusRed
      '--fluux-color-green': '#6f894e',  // lotusGreen
      '--fluux-color-yellow': '#de9800', // lotusYellow3
      '--fluux-color-blue': '#4d699b',   // lotusBlue4
      '--fluux-color-purple': '#624c83', // lotusViolet4
      '--fluux-color-gray': '#8a8980',   // lotusGray3
      '--fluux-color-red-rgb': '200, 64, 83',
      '--fluux-color-green-rgb': '111, 137, 78',
      '--fluux-color-yellow-rgb': '222, 152, 0',
      '--fluux-color-blue-rgb': '77, 105, 155',
      '--fluux-color-purple-rgb': '98, 76, 131',
      // Semantic overrides
      '--fluux-bg-secondary': '#dcd5ac',
      '--fluux-border-color': 'rgba(84, 84, 100, 0.12)',
      '--fluux-selection-bg': 'hsla(219, 36%, 45%, 0.15)',
      '--fluux-scrollbar-thumb': '#d5cea3',
      '--fluux-scrollbar-thumb-hover': '#c9c297',
      '--fluux-text-link': '#cc6d00', // lotusOrange
    },
  },
  swatches: {
    dark: ['#1F1F28', '#2A2A37', '#7E9CD8', '#957FB8', '#98BB6C'],
    light: ['#f2ecbc', '#e5ddb0', '#4d699b', '#624c83', '#6f894e'],
  },
}
