import type { ThemeDefinition } from '../types'

export const monokaiTheme: ThemeDefinition = {
  id: 'monokai',
  name: 'Monokai',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Sublime Text\'s iconic warm dark theme with vivid accents',
  variables: {
    dark: {
      // Foundation — neutral ramp
      '--fluux-base-00': '#1a1a1a',
      '--fluux-base-05': '#1e1f1c',
      '--fluux-base-10': '#272822', // classic Monokai background
      '--fluux-base-20': '#2e2f2a',
      '--fluux-base-30': '#3e3d32', // line highlight
      '--fluux-base-40': '#49483e',
      '--fluux-base-50': '#58574c',
      '--fluux-base-60': '#75715e', // comment
      '--fluux-base-70': '#8f8a7a',
      '--fluux-base-80': '#a8a497',
      '--fluux-base-90': '#f8f8f2', // foreground
      '--fluux-base-100': '#ffffff',
      // Foundation — accent (pink/magenta)
      '--fluux-accent-h': '338',
      '--fluux-accent-s': '95%',
      '--fluux-accent-l': '56%',
      // Foundation — palette
      '--fluux-color-red': '#f92672',    // pink/red
      '--fluux-color-green': '#a6e22e',  // green
      '--fluux-color-yellow': '#e6db74', // yellow
      '--fluux-color-blue': '#66d9ef',   // cyan/blue
      '--fluux-color-purple': '#ae81ff', // purple
      '--fluux-color-gray': '#75715e',
      '--fluux-color-red-rgb': '249, 38, 114',
      '--fluux-color-green-rgb': '166, 226, 46',
      '--fluux-color-yellow-rgb': '230, 219, 116',
      '--fluux-color-blue-rgb': '102, 217, 239',
      '--fluux-color-purple-rgb': '174, 129, 255',
      // Semantic — orange for links (distinctive Monokai choice)
      '--fluux-text-link': '#fd971f',
      // Syntax highlighting
      '--shiki-token-keyword': '#f92672',
      '--shiki-token-string': '#e6db74',
      '--shiki-token-string-expression': '#e6db74',
      '--shiki-token-comment': '#75715e',
      '--shiki-token-function': '#a6e22e',
      '--shiki-token-constant': '#ae81ff',
      '--shiki-token-parameter': '#fd971f',
      '--shiki-token-punctuation': '#f8f8f2',
      '--shiki-token-link': '#fd971f',
    },
    // Monokai has no official light variant — derive a warm light from the palette
    light: {
      '--fluux-base-00': '#fdf8f0',
      '--fluux-base-05': '#f5f0e6',
      '--fluux-base-10': '#eeeadf',
      '--fluux-base-20': '#e4dfd4',
      '--fluux-base-30': '#fdf8f0', // content surface
      '--fluux-base-40': '#d5d0c4',
      '--fluux-base-50': '#c0bbb0',
      '--fluux-base-60': '#a8a497',
      '--fluux-base-70': '#8f8a7a',
      '--fluux-base-80': '#665e4e',
      '--fluux-base-90': '#272822',
      '--fluux-base-100': '#1a1a1a',
      '--fluux-accent-h': '338',
      '--fluux-accent-s': '75%',
      '--fluux-accent-l': '42%',
      '--fluux-color-red': '#c41854',
      '--fluux-color-green': '#5f8c0c',
      '--fluux-color-yellow': '#9e8e10',
      '--fluux-color-blue': '#0f8da6',
      '--fluux-color-purple': '#7540c9',
      '--fluux-color-gray': '#8f8a7a',
      '--fluux-color-red-rgb': '196, 24, 84',
      '--fluux-color-green-rgb': '95, 140, 12',
      '--fluux-color-yellow-rgb': '158, 142, 16',
      '--fluux-color-blue-rgb': '15, 141, 166',
      '--fluux-color-purple-rgb': '117, 64, 201',
      // Semantic overrides
      '--fluux-bg-secondary': '#e4dfd4',
      '--fluux-border-color': 'rgba(39, 40, 34, 0.12)',
      '--fluux-selection-bg': 'hsla(338, 75%, 42%, 0.15)',
      '--fluux-scrollbar-thumb': '#c8c4b8',
      '--fluux-scrollbar-thumb-hover': '#b0aca0',
      '--fluux-text-link': '#b86e0a',
      // Syntax highlighting
      '--shiki-token-keyword': '#c41854',
      '--shiki-token-string': '#9e8e10',
      '--shiki-token-string-expression': '#9e8e10',
      '--shiki-token-comment': '#a8a497',
      '--shiki-token-function': '#5f8c0c',
      '--shiki-token-constant': '#7540c9',
      '--shiki-token-parameter': '#b86e0a',
      '--shiki-token-punctuation': '#272822',
      '--shiki-token-link': '#b86e0a',
    },
  },
  swatches: {
    dark: ['#272822', '#3e3d32', '#f92672', '#a6e22e', '#66d9ef'],
    light: ['#eeeadf', '#fdf8f0', '#c41854', '#5f8c0c', '#0f8da6'],
  },
}
