import plugin from 'tailwindcss/plugin'
import containerQueries from '@tailwindcss/container-queries'

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Fluux color palette — 3-tier design tokens (Foundation → Semantic → Component)
        // Tailwind aliases point to the most specific tier available.
        fluux: {
          // Backgrounds
          'bg': 'var(--fluux-bg-primary)',
          'bg-secondary': 'var(--fluux-bg-secondary)',
          'sidebar': 'var(--fluux-sidebar-bg)',
          'chat': 'var(--fluux-chat-bg)',
          'surface': 'var(--fluux-bg-tertiary)',
          'hover': 'var(--fluux-bg-hover)',
          'active': 'var(--fluux-bg-active)',
          'float': 'var(--fluux-bg-float)',
          'float-hover': 'var(--fluux-bg-float-hover)',
          'sidebar-item-active': 'var(--fluux-sidebar-item-active)',
          'sidebar-item-active-accent': 'var(--fluux-sidebar-item-active-accent)',
          'selection': 'var(--fluux-selection-bg)',
          // Text
          'text': 'var(--fluux-text-normal)',
          'muted': 'var(--fluux-text-muted)',
          'link': 'var(--fluux-text-link)',
          // Accents
          'brand': 'var(--fluux-bg-accent)',
          'brand-hover': 'var(--fluux-bg-accent-hover)',
          'text-on-accent': 'var(--fluux-text-on-accent)',
          // Private (whisper) — pre-composed alpha variants (Tailwind opacity
          // modifiers don't apply to var() colors, so each tint is its own token)
          'private': 'var(--fluux-private)',
          'private-soft': 'var(--fluux-private-soft)',
          'private-border': 'var(--fluux-private-border)',
          'private-hover': 'var(--fluux-private-hover)',
          // Badge
          'badge': 'var(--fluux-badge-bg)',
          'badge-text': 'var(--fluux-badge-text)',
          // Aurora identity tokens
          'accent-2': 'var(--fluux-accent-2)',
          'sender-1': 'var(--fluux-sender-1)',
          'sender-2': 'var(--fluux-sender-2)',
          'sender-3': 'var(--fluux-sender-3)',
          'sender-4': 'var(--fluux-sender-4)',
          'sender-5': 'var(--fluux-sender-5)',
          'sender-6': 'var(--fluux-sender-6)',
          // Status (semantic purpose, not color)
          'green': 'var(--fluux-status-success)',
          'yellow': 'var(--fluux-status-warning)',
          'red': 'var(--fluux-status-error)',
          // Error AS TEXT/icon. Split from `red` (status-error): that token is the
          // fill (danger button, toast border, dnd dot), tuned dark so white text
          // on it clears AA, which leaves it sub-AA as red text on dark surfaces.
          // Use text-fluux-error for error text/icons; bg-fluux-red for fills.
          'error': 'var(--fluux-text-error)',
          'gray': 'var(--fluux-color-gray)',
          'border': 'var(--fluux-border-color)',
        }
      },
      fontFamily: {
        sans: ['var(--fluux-font-ui)'],
        mono: ['var(--fluux-font-mono)'],
        display: ['var(--fluux-font-display)'],
      },
      keyframes: {
        'tooltip-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'sheet-up': {
          '0%': { opacity: '0', transform: 'translateY(100%)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'tooltip-in': 'tooltip-in 150ms ease-out',
        'toast-in': 'toast-in 200ms ease-out',
        'sheet-up': 'sheet-up 220ms cubic-bezier(0.32, 0.72, 0, 1)',
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
