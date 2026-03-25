import type { ThemeDefinition } from '../types'

export const draculaTheme: ThemeDefinition = {
  id: 'dracula',
  name: 'Dracula',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Dark theme with purple, pink, and green accents',
  variables: {
    dark: {
      // Foundation — neutral ramp
      '--fluux-base-00': '#1e1f29',
      '--fluux-base-05': '#21222c',
      '--fluux-base-10': '#282a36', // background
      '--fluux-base-20': '#343746',
      '--fluux-base-30': '#383a4a',
      '--fluux-base-40': '#44475a', // current line
      '--fluux-base-50': '#555972',
      '--fluux-base-60': '#6272a4', // comment
      '--fluux-base-70': '#7e88b3',
      '--fluux-base-80': '#9da5c7',
      '--fluux-base-90': '#f8f8f2', // foreground
      '--fluux-base-100': '#ffffff',
      // Foundation — accent (purple)
      '--fluux-accent-h': '265',
      '--fluux-accent-s': '89%',
      '--fluux-accent-l': '78%',
      // Foundation — palette
      '--fluux-color-red': '#ff5555',
      '--fluux-color-green': '#50fa7b',
      '--fluux-color-yellow': '#f1fa8c',
      '--fluux-color-blue': '#8be9fd', // cyan
      '--fluux-color-purple': '#bd93f9',
      '--fluux-color-gray': '#6272a4',
      '--fluux-color-red-rgb': '255, 85, 85',
      '--fluux-color-green-rgb': '80, 250, 123',
      '--fluux-color-yellow-rgb': '241, 250, 140',
      '--fluux-color-blue-rgb': '139, 233, 253',
      '--fluux-color-purple-rgb': '189, 147, 249',
      // Semantic — link color uses pink instead of blue/cyan
      '--fluux-text-link': '#ff79c6',
      // Syntax highlighting
      '--syntax-token-keyword': '#ff79c6',
      '--syntax-token-string': '#f1fa8c',
      '--syntax-token-string-expression': '#f1fa8c',
      '--syntax-token-comment': '#6272a4',
      '--syntax-token-function': '#50fa7b',
      '--syntax-token-constant': '#bd93f9',
      '--syntax-token-parameter': '#ffb86c',
      '--syntax-token-punctuation': '#f8f8f2',
      '--syntax-token-link': '#ff79c6',
    },
    // Dracula has no official light variant — derive a soft light from the palette
    light: {
      '--fluux-base-00': '#f8f8f2',
      '--fluux-base-05': '#f0f0ea',
      '--fluux-base-10': '#e8e8e2',
      '--fluux-base-20': '#ddddd7',
      '--fluux-base-30': '#f8f8f2',
      '--fluux-base-40': '#d0d0ca',
      '--fluux-base-50': '#bfbfba',
      '--fluux-base-60': '#9da5c7',
      '--fluux-base-70': '#6272a4',
      '--fluux-base-80': '#505670',
      '--fluux-base-90': '#282a36',
      '--fluux-base-100': '#1e1f29',
      '--fluux-accent-h': '265',
      '--fluux-accent-s': '70%',
      '--fluux-accent-l': '55%',
      '--fluux-color-red': '#d1383e',
      '--fluux-color-green': '#2b9e4a',
      '--fluux-color-yellow': '#b8960f',
      '--fluux-color-blue': '#0f8fa8',
      '--fluux-color-purple': '#7c50c7',
      '--fluux-color-gray': '#6272a4',
      '--fluux-color-red-rgb': '209, 56, 62',
      '--fluux-color-green-rgb': '43, 158, 74',
      '--fluux-color-yellow-rgb': '184, 150, 15',
      '--fluux-color-blue-rgb': '15, 143, 168',
      '--fluux-color-purple-rgb': '124, 80, 199',
      '--fluux-bg-secondary': '#ddddd7',
      '--fluux-border-color': 'rgba(40, 42, 54, 0.12)',
      '--fluux-selection-bg': 'hsla(265, 70%, 55%, 0.15)',
      '--fluux-scrollbar-thumb': '#c8c8c2',
      '--fluux-scrollbar-thumb-hover': '#b0b0aa',
      '--fluux-text-link': '#a8308c',
      // Syntax highlighting
      '--syntax-token-keyword': '#a8308c',
      '--syntax-token-string': '#b8960f',
      '--syntax-token-string-expression': '#b8960f',
      '--syntax-token-comment': '#9da5c7',
      '--syntax-token-function': '#2b9e4a',
      '--syntax-token-constant': '#7c50c7',
      '--syntax-token-parameter': '#c07020',
      '--syntax-token-punctuation': '#282a36',
      '--syntax-token-link': '#a8308c',
    },
  },
  swatches: {
    dark: ['#282a36', '#44475a', '#bd93f9', '#ff79c6', '#50fa7b'],
    light: ['#e8e8e2', '#f8f8f2', '#7c50c7', '#a8308c', '#2b9e4a'],
  },
}
