import type { ThemeDefinition } from '../types'

export const oneDarkTheme: ThemeDefinition = {
  id: 'one-dark',
  name: 'One Dark',
  author: 'Fluux',
  version: '1.0.0',
  description: 'Atom editor\'s iconic dark theme with clean contrast',
  variables: {
    dark: {
      // Foundation — neutral ramp
      '--fluux-base-00': '#1e2127',
      '--fluux-base-05': '#21252b',
      '--fluux-base-10': '#282c34', // syntax-bg
      '--fluux-base-20': '#2c313a',
      '--fluux-base-30': '#313640',
      '--fluux-base-40': '#3e4451',
      '--fluux-base-50': '#4b5263',
      '--fluux-base-60': '#5c6370', // mono-3 / comment
      '--fluux-base-70': '#737984',
      '--fluux-base-80': '#828997', // mono-2
      '--fluux-base-90': '#abb2bf', // mono-1 / fg
      '--fluux-base-100': '#d7dae0',
      // Foundation — accent (blue)
      '--fluux-accent-h': '220',
      '--fluux-accent-s': '100%',
      '--fluux-accent-l': '66%',
      // Foundation — palette
      '--fluux-color-red': '#e06c75',
      '--fluux-color-green': '#98c379',
      '--fluux-color-yellow': '#e5c07b',
      '--fluux-color-blue': '#61afef',
      '--fluux-color-purple': '#c678dd',
      '--fluux-color-gray': '#5c6370',
      '--fluux-color-red-rgb': '224, 108, 117',
      '--fluux-color-green-rgb': '152, 195, 121',
      '--fluux-color-yellow-rgb': '229, 192, 123',
      '--fluux-color-blue-rgb': '97, 175, 239',
      '--fluux-color-purple-rgb': '198, 120, 221',
      // Syntax highlighting
      '--syntax-token-keyword': '#c678dd',
      '--syntax-token-string': '#98c379',
      '--syntax-token-string-expression': '#98c379',
      '--syntax-token-comment': '#5c6370',
      '--syntax-token-function': '#61afef',
      '--syntax-token-constant': '#d19a66',
      '--syntax-token-parameter': '#abb2bf',
      '--syntax-token-punctuation': '#abb2bf',
      '--syntax-token-link': '#61afef',
    },
    light: {
      // Foundation — neutral ramp (One Light)
      '--fluux-base-00': '#ffffff',
      '--fluux-base-05': '#f5f5f5',
      '--fluux-base-10': '#fafafa', // syntax-bg
      '--fluux-base-20': '#eaeaeb',
      '--fluux-base-30': '#fafafa', // content surface
      '--fluux-base-40': '#dbdbdc',
      '--fluux-base-50': '#c8c8c9',
      '--fluux-base-60': '#a0a1a7', // mono-3
      '--fluux-base-70': '#8b8c92',
      '--fluux-base-80': '#696c77', // mono-2
      '--fluux-base-90': '#383a42', // mono-1 / fg
      '--fluux-base-100': '#1e2127',
      // Foundation — accent (blue, adjusted for light)
      '--fluux-accent-h': '224',
      '--fluux-accent-s': '100%',
      '--fluux-accent-l': '56%',
      // Foundation — palette (One Light)
      '--fluux-color-red': '#e45649',
      '--fluux-color-green': '#50a14f',
      '--fluux-color-yellow': '#c18401',
      '--fluux-color-blue': '#4078f2',
      '--fluux-color-purple': '#a626a4',
      '--fluux-color-gray': '#a0a1a7',
      '--fluux-color-red-rgb': '228, 86, 73',
      '--fluux-color-green-rgb': '80, 161, 79',
      '--fluux-color-yellow-rgb': '193, 132, 1',
      '--fluux-color-blue-rgb': '64, 120, 242',
      '--fluux-color-purple-rgb': '166, 38, 164',
      // Semantic overrides
      '--fluux-bg-secondary': '#e8e8e9',
      '--fluux-border-color': 'rgba(56, 58, 66, 0.10)',
      '--fluux-selection-bg': 'hsla(224, 100%, 56%, 0.12)',
      '--fluux-scrollbar-thumb': '#c8c8c9',
      '--fluux-scrollbar-thumb-hover': '#b0b0b1',
      // Syntax highlighting
      '--syntax-token-keyword': '#a626a4',
      '--syntax-token-string': '#50a14f',
      '--syntax-token-string-expression': '#50a14f',
      '--syntax-token-comment': '#a0a1a7',
      '--syntax-token-function': '#4078f2',
      '--syntax-token-constant': '#986801',
      '--syntax-token-parameter': '#383a42',
      '--syntax-token-punctuation': '#383a42',
      '--syntax-token-link': '#4078f2',
    },
  },
  swatches: {
    dark: ['#282c34', '#2c313a', '#528bff', '#61afef', '#98c379'],
    light: ['#fafafa', '#eaeaeb', '#4078f2', '#526fff', '#50a14f'],
  },
}
