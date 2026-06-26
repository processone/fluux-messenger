import type { ThemeDefinition } from '../types'

/**
 * Indigo — the classic Fluux palette that shipped before Aurora.
 *
 * Neutral grey surfaces with an indigo/blurple accent. Preserved as a built-in
 * so anyone who preferred the original look can keep it. It overrides only what
 * Aurora changed in the defaults (the neutral ramp, the accent, own-message and
 * accent-2 colors, the unread-badge color, and the light secondary surface);
 * everything else cascades from the semantic/component tiers.
 */
export const indigoTheme: ThemeDefinition = {
  id: 'indigo',
  name: 'Indigo',
  author: 'Fluux',
  version: '1.0.0',
  description: 'The classic Fluux palette — indigo accent on neutral grey',
  variables: {
    dark: {
      // Neutral ramp (00 = darkest, 100 = lightest)
      '--fluux-base-00': '#111214',
      '--fluux-base-05': '#1a1b1e',
      '--fluux-base-10': '#1e1f22',
      '--fluux-base-20': '#2b2d31',
      '--fluux-base-30': '#313338',
      '--fluux-base-40': '#35373c',
      '--fluux-base-50': '#404249',
      '--fluux-base-60': '#4e5058',
      '--fluux-base-70': '#6d6f78',
      '--fluux-base-80': '#949ba4',
      '--fluux-base-90': '#dbdee1',
      '--fluux-base-100': '#f2f3f5',
      // Accent (blurple)
      '--fluux-accent-h': '235',
      '--fluux-accent-s': '86%',
      '--fluux-accent-l': '65%',
      // Companion + own-message name
      '--fluux-accent-2': '#00a8fc',
      '--fluux-text-self': '#a5b4fc',
      // Unread badge stays red (classic behavior)
      '--fluux-badge-bg': 'var(--fluux-status-error)',
    },
    light: {
      // Neutral ramp (00 = lightest, 100 = darkest)
      '--fluux-base-00': '#ffffff',
      '--fluux-base-05': '#f2f3f5',
      '--fluux-base-10': '#e3e5e8',
      '--fluux-base-20': '#ebedef',
      '--fluux-base-30': '#ffffff',
      '--fluux-base-40': '#dcdee3',
      '--fluux-base-50': '#d0d3d8',
      '--fluux-base-60': '#b5bac1',
      '--fluux-base-70': '#80848e',
      '--fluux-base-80': '#4a4d54',
      '--fluux-base-90': '#2e3338',
      '--fluux-base-100': '#1e1f22',
      // Accent (blurple)
      '--fluux-accent-h': '235',
      '--fluux-accent-s': '86%',
      '--fluux-accent-l': '65%',
      // Companion + own-message name
      '--fluux-accent-2': '#0969da',
      '--fluux-text-self': '#4f46e5',
      // Restore the original warm-grey secondary surface
      '--fluux-bg-secondary': '#d8dadf',
      // Unread badge stays red (classic behavior)
      '--fluux-badge-bg': 'var(--fluux-status-error)',
    },
  },
  swatches: {
    dark: ['#1e1f22', '#2b2d31', '#5865f2', '#00a8fc', '#23a559'],
    light: ['#e3e5e8', '#ebedef', '#5865f2', '#0969da', '#23a559'],
  },
}
