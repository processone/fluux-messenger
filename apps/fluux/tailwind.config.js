import plugin from 'tailwindcss/plugin'
import containerQueries from '@tailwindcss/container-queries'

// Theme colours are runtime CSS variables, which Tailwind cannot parse, so an
// opacity modifier on a plain 'var(...)' string (bg-fluux-brand/20) compiles to
// nothing. Each colour is instead a function: without a modifier it is the bare
// variable, exactly as before; with one it mixes the variable with transparent.
// color-mix accepts every token format the themes use (hex, rgb/rgba, hsl/hsla,
// var() chains, color-mix) and multiplies any alpha the token already carries.
// The opacityVariable branch is the unmodified utility, where Tailwind passes
// var(--tw-*-opacity): keep the bare variable there so plain classes are unchanged.
export const alphaVar = (name) => ({ opacityValue, opacityVariable } = {}) =>
  opacityVariable !== undefined || opacityValue === undefined || String(opacityValue) === '1'
    ? `var(${name})`
    : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Accent AS TEXT reads --fluux-text-accent, which may differ from the fill
      // (bg/border/ring-fluux-brand keep --fluux-bg-accent). See index.css.
      textColor: {
        fluux: {
          brand: alphaVar('--fluux-text-accent'),
          // Accent text that sits on an accent tint (bg-fluux-brand/10, /20).
          'brand-on-tint': alphaVar('--fluux-text-accent-on-tint'),
        },
      },
      colors: {
        // Fluux color palette — 3-tier design tokens (Foundation → Semantic → Component)
        // Tailwind aliases point to the most specific tier available.
        fluux: {
          // Backgrounds
          'bg': alphaVar('--fluux-bg-primary'),
          'bg-secondary': alphaVar('--fluux-bg-secondary'),
          'sidebar': alphaVar('--fluux-sidebar-bg'),
          'chat': alphaVar('--fluux-chat-bg'),
          'surface': alphaVar('--fluux-bg-tertiary'),
          'hover': alphaVar('--fluux-bg-hover'),
          'message-hover': alphaVar('--fluux-message-hover'),
          'active': alphaVar('--fluux-bg-active'),
          'float': alphaVar('--fluux-bg-float'),
          'float-hover': alphaVar('--fluux-bg-float-hover'),
          'sidebar-item-active': alphaVar('--fluux-sidebar-item-active'),
          'sidebar-item-active-accent': alphaVar('--fluux-sidebar-item-active-accent'),
          'selection': alphaVar('--fluux-selection-bg'),
          // Text
          'text': alphaVar('--fluux-text-normal'),
          'muted': alphaVar('--fluux-text-muted'),
          'link': alphaVar('--fluux-text-link'),
          // Accents
          'brand': alphaVar('--fluux-bg-accent'),
          'brand-hover': alphaVar('--fluux-bg-accent-hover'),
          'text-on-accent': alphaVar('--fluux-text-on-accent'),
          // Private (whisper): pre-composed alpha variants, tuned per theme
          'private': alphaVar('--fluux-private'),
          'private-soft': alphaVar('--fluux-private-soft'),
          'private-border': alphaVar('--fluux-private-border'),
          'private-hover': alphaVar('--fluux-private-hover'),
          // Badge
          'badge': alphaVar('--fluux-badge-bg'),
          'badge-text': alphaVar('--fluux-badge-text'),
          'badge-strong': alphaVar('--fluux-badge-strong'),
          // Aurora identity tokens
          'accent-2': alphaVar('--fluux-accent-2'),
          // Encryption affordance (shields, locks) — single source of truth so
          // the header shield, composer lock, and per-message lock match.
          'encryption': alphaVar('--fluux-text-encryption'),
          // Status (semantic purpose, not color)
          'green': alphaVar('--fluux-status-success'),
          'yellow': alphaVar('--fluux-status-warning'),
          'presence-away': alphaVar('--fluux-presence-away'),
          'presence-dnd': alphaVar('--fluux-presence-dnd'),
          'red': alphaVar('--fluux-status-error'),
          // Error AS TEXT/icon. Split from `red` (status-error): that token is the
          // fill (danger button, toast border), tuned dark so white text
          // on it clears AA, which leaves it sub-AA as red text on dark surfaces.
          // Use text-fluux-error for error text/icons; bg-fluux-red for fills.
          'error': alphaVar('--fluux-text-error'),
          'gray': alphaVar('--fluux-color-gray'),
          'border': alphaVar('--fluux-border-color'),
        }
      },
      fontFamily: {
        sans: ['var(--fluux-font-ui)'],
        mono: ['var(--fluux-font-mono)'],
        display: ['var(--fluux-font-display)'],
      },
      transitionDuration: {
        fast: 'var(--fluux-duration-fast)',
        base: 'var(--fluux-duration-base)',
        slow: 'var(--fluux-duration-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--fluux-ease-standard)',
        emphasized: 'var(--fluux-ease-emphasized)',
        spring: 'var(--fluux-ease-spring)',
      },
      keyframes: {
        'tooltip-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(-16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'sheet-up': {
          '0%': { opacity: '0', transform: 'translateY(100%)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Translate only: the touch menu measures these blocks while they animate.
        'pop-from-below': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '55%': { opacity: '1', transform: 'translateY(-4px)' },
          '80%': { transform: 'translateY(1.5px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pop-from-above': {
          '0%': { opacity: '0', transform: 'translateY(-14px)' },
          '55%': { opacity: '1', transform: 'translateY(4px)' },
          '80%': { transform: 'translateY(-1.5px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pop: {
          '0%': { transform: 'scale(1)' },
          '45%': { transform: 'scale(1.04)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        'tooltip-in': 'tooltip-in var(--fluux-duration-fast) var(--fluux-ease-standard)',
        'toast-in': 'toast-in var(--fluux-duration-base) var(--fluux-ease-standard)',
        'sheet-up': 'sheet-up 220ms var(--fluux-ease-emphasized)',
        'pop-from-below': 'pop-from-below var(--fluux-duration-slow) var(--fluux-ease-standard) both',
        'pop-from-above': 'pop-from-above var(--fluux-duration-slow) var(--fluux-ease-standard) both',
        pop: 'pop var(--fluux-duration-slow) var(--fluux-ease-standard)',
      },
    },
  },
  plugins: [
    containerQueries,
    plugin(({ addVariant }) => {
      // Pointer/hover capability variants. These distinguish a precise hovering
      // pointer (mouse/trackpad) from a touch screen, independently of viewport
      // width or platform. Use `can-hover:` to keep desktop hover affordances and
      // `touch:` to add the touch-only fallback — so desktop behaviour is never
      // altered, while touch laptops, tablets and a future Tauri-mobile build all
      // get the touch experience. (Distinct from useIsMobileWeb, which is a
      // width+platform *layout* query, not a *capability* query.)
      addVariant('can-hover', '@media (hover: hover) and (pointer: fine)')
      addVariant('touch', '@media (hover: none), (pointer: coarse)')
    }),
  ],
}
