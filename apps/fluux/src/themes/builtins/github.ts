import type { ThemeDefinition } from '../types'

export const githubTheme: ThemeDefinition = {
  id: 'github',
  name: 'GitHub',
  author: 'Fluux',
  version: '1.0.0',
  description: 'GitHub\'s clean design system from the Primer color palette',
  variables: {
    dark: {
      // Foundation — typography (GitHub system font stack)
      '--fluux-font-ui': '"SF Pro Display", "Segoe UI", system-ui, sans-serif',
      // Foundation — neutral ramp (GitHub Dark Default)
      '--fluux-base-00': '#010409',
      '--fluux-base-05': '#0d1117', // canvas.default
      '--fluux-base-10': '#0d1117', // canvas.default
      '--fluux-base-20': '#151b23', // canvas.muted
      '--fluux-base-30': '#151b23', // canvas.muted (chat surface)
      '--fluux-base-40': '#212830',
      '--fluux-base-50': '#262c36',
      '--fluux-base-60': '#2a313c',
      '--fluux-base-70': '#7d8590', // fg.muted
      '--fluux-base-80': '#7d8590', // fg.muted
      '--fluux-base-90': '#e6edf3', // fg.default
      '--fluux-base-100': '#ffffff',
      // Foundation — accent (blue)
      '--fluux-accent-h': '214',
      '--fluux-accent-s': '93%',
      '--fluux-accent-l': '62%',
      // Foundation — palette
      '--fluux-color-red': '#da3633',
      '--fluux-color-green': '#238636',
      '--fluux-color-yellow': '#9e6a03',
      '--fluux-color-blue': '#4493f8', // accent
      '--fluux-color-purple': '#8957e5',
      '--fluux-color-gray': '#7d8590',
      '--fluux-color-red-rgb': '218, 54, 51',
      '--fluux-color-green-rgb': '35, 134, 54',
      '--fluux-color-yellow-rgb': '158, 106, 3',
      '--fluux-color-blue-rgb': '68, 147, 248',
      '--fluux-color-purple-rgb': '137, 87, 229',
      // Syntax highlighting
      '--syntax-token-keyword': '#ff7b72',
      '--syntax-token-string': '#a5d6ff',
      '--syntax-token-string-expression': '#a5d6ff',
      '--syntax-token-comment': '#8b949e',
      '--syntax-token-function': '#d2a8ff',
      '--syntax-token-constant': '#79c0ff',
      '--syntax-token-parameter': '#ffa657',
      '--syntax-token-punctuation': '#e6edf3',
      '--syntax-token-link': '#4493f8',
    },
    light: {
      // Foundation — typography (GitHub system font stack)
      '--fluux-font-ui': '"SF Pro Display", "Segoe UI", system-ui, sans-serif',
      // Foundation — neutral ramp (GitHub Light Default)
      '--fluux-base-00': '#ffffff', // canvas.default
      '--fluux-base-05': '#f6f8fa', // canvas.muted
      '--fluux-base-10': '#f6f8fa', // canvas.muted
      '--fluux-base-20': '#eff2f5', // canvas.inset
      '--fluux-base-30': '#ffffff', // canvas.default (content surface)
      '--fluux-base-40': '#e0e6eb',
      '--fluux-base-50': '#dae0e7',
      '--fluux-base-60': '#818b98',
      '--fluux-base-70': '#59636e', // fg.muted
      '--fluux-base-80': '#59636e', // fg.muted
      '--fluux-base-90': '#1f2328', // fg.default
      '--fluux-base-100': '#010409',
      // Foundation — accent (blue)
      '--fluux-accent-h': '212',
      '--fluux-accent-s': '92%',
      '--fluux-accent-l': '45%',
      // Foundation — palette (Light)
      '--fluux-color-red': '#cf222e',
      '--fluux-color-green': '#1a7f37',
      '--fluux-color-yellow': '#9a6700',
      '--fluux-color-blue': '#0969da',
      '--fluux-color-purple': '#8250df',
      '--fluux-color-gray': '#59636e',
      '--fluux-color-red-rgb': '207, 34, 46',
      '--fluux-color-green-rgb': '26, 127, 55',
      '--fluux-color-yellow-rgb': '154, 103, 0',
      '--fluux-color-blue-rgb': '9, 105, 218',
      '--fluux-color-purple-rgb': '130, 80, 223',
      // Semantic overrides
      '--fluux-bg-secondary': '#eff2f5',
      '--fluux-border-color': 'rgba(31, 35, 40, 0.12)',
      '--fluux-selection-bg': 'hsla(212, 92%, 45%, 0.15)',
      '--fluux-scrollbar-thumb': '#dae0e7',
      '--fluux-scrollbar-thumb-hover': '#c8ced5',
      '--fluux-scrollbar-thumb-sidebar': '#c8ced5',
      '--fluux-scrollbar-thumb-sidebar-hover': '#b0b8c2',
      // Syntax highlighting
      '--syntax-token-keyword': '#cf222e',
      '--syntax-token-string': '#0a3069',
      '--syntax-token-string-expression': '#0a3069',
      '--syntax-token-comment': '#6e7781',
      '--syntax-token-function': '#8250df',
      '--syntax-token-constant': '#0550ae',
      '--syntax-token-parameter': '#953800',
      '--syntax-token-punctuation': '#1f2328',
      '--syntax-token-link': '#0969da',
    },
  },
  swatches: {
    dark: ['#0d1117', '#151b23', '#4493f8', '#238636', '#da3633'],
    light: ['#f6f8fa', '#ffffff', '#0969da', '#1a7f37', '#cf222e'],
  },
}
