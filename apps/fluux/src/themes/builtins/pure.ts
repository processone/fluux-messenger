import type { ThemeDefinition } from '../types'

/**
 * Pure — true-black for OLED (dark) and flat-white for e-ink (light).
 *
 * Dark: chat + all chrome surfaces are #000000 so OLED panels power those pixels
 * off (battery + no light bleed). Depth is carried by hairline borders and the
 * inherited alpha divider, not by surface luminance — the surface-hierarchy guard
 * requires luminance(sidebar) <= luminance(chat), so the chrome is deliberately
 * flat black. Elevated non-chrome surfaces (float/popover/hover rows) get a hair
 * of lift for affordance. Accent is Aurora's teal preset — restrained but vivid,
 * it pops on black.
 *
 * Light: everything is #ffffff, flat, with strong dark structure and a near-black
 * "ink" accent so interactive elements read as high-contrast bold and survive
 * e-ink's shallow grayscale rendering. Muted text stays dark (not light gray).
 *
 * transparency: 'reduced' forces every glass surface solid (see resolveTransparency)
 * — frosted translucency would break true black on OLED and does not render on e-ink.
 *
 * The palette (--fluux-color-*), syntax tokens, and --fluux-text-error are
 * intentionally inherited: on pure black / pure white they clear the per-theme
 * WCAG contrast guards by construction, so overriding them adds risk without benefit.
 */
export const pureTheme: ThemeDefinition = {
  id: 'pure',
  name: 'Pure',
  author: 'Fluux',
  version: '1.0.0',
  description: 'True black for OLED, flat white for e-ink — maximum-contrast minimalism',
  transparency: 'reduced',
  variables: {
    dark: {
      // Foundation — neutral ramp. base-00..base-30 are true black so every
      // chrome surface (bg-primary=base-10, sidebar=base-20, chat=base-30) is #000.
      '--fluux-base-00': '#000000',
      '--fluux-base-05': '#000000',
      '--fluux-base-10': '#000000',
      '--fluux-base-20': '#000000',
      '--fluux-base-30': '#000000',
      '--fluux-base-40': '#141414', // hover rows — subtle lift on the black canvas
      '--fluux-base-50': '#1c1c1c', // float / popover surface
      '--fluux-base-60': '#262626', // float hover
      '--fluux-base-70': '#6e6e6e',
      '--fluux-base-80': '#9a9a9a', // text-muted (≈7:1 on #000)
      '--fluux-base-90': '#fafafa', // text-normal (just under #fff to soften halation)
      '--fluux-base-100': '#ffffff',
      // Foundation — accent (Aurora teal: pops on true black)
      '--fluux-accent-h': '174',
      '--fluux-accent-s': '70%',
      '--fluux-accent-l': '52%',
      // Borders — hairlines carry the depth the flat surfaces don't.
      '--fluux-border-color': 'rgba(255, 255, 255, 0.14)',
      '--fluux-glass-border': 'rgba(255, 255, 255, 0.18)',
      // Pin the chrome surfaces to true black directly so the intent is explicit
      // and independent of ramp-derivation changes.
      '--fluux-chat-bg': '#000000',
      '--fluux-sidebar-bg': '#000000',
      '--fluux-bg-float': '#1c1c1c',
    },
    light: {
      // Foundation — neutral ramp inverted; base-00..base-30 flat white so every
      // chrome surface is #fff. Text ramp (base-90/100) is pure black ink.
      '--fluux-base-00': '#ffffff',
      '--fluux-base-05': '#ffffff',
      '--fluux-base-10': '#ffffff',
      '--fluux-base-20': '#ffffff',
      '--fluux-base-30': '#ffffff',
      '--fluux-base-40': '#f2f2f2', // hover rows — faint lift
      '--fluux-base-50': '#ffffff', // float / popover (border carries elevation)
      '--fluux-base-60': '#ebebeb',
      '--fluux-base-70': '#8a8a8a',
      '--fluux-base-80': '#3a3a3a', // text-muted kept dark for e-ink depth
      '--fluux-base-90': '#000000', // text-normal ink
      '--fluux-base-100': '#000000',
      // Foundation — accent (near-black "ink"; text-on-accent computes to white)
      '--fluux-accent-h': '0',
      '--fluux-accent-s': '0%',
      '--fluux-accent-l': '10%',
      // Strong dark structure.
      '--fluux-border-color': 'rgba(0, 0, 0, 0.22)',
      '--fluux-glass-border': 'rgba(0, 0, 0, 0.18)',
      // The .light block sets --fluux-bg-secondary to a tinted value; pin it and
      // the chrome surfaces flat white.
      '--fluux-bg-secondary': '#ffffff',
      '--fluux-chat-bg': '#ffffff',
      '--fluux-sidebar-bg': '#ffffff',
      '--fluux-bg-float': '#ffffff',
    },
  },
  swatches: {
    dark: ['#000000', '#0a0a0a', '#38E0C4', '#fafafa'],
    light: ['#ffffff', '#f2f2f2', '#1a1a1a', '#000000'],
  },
}
