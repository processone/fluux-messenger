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
          'selection': 'var(--fluux-selection-bg)',
          // Text
          'text': 'var(--fluux-text-normal)',
          'muted': 'var(--fluux-text-muted)',
          'link': 'var(--fluux-text-link)',
          // Accents
          'brand': 'var(--fluux-bg-accent)',
          'brand-hover': 'var(--fluux-bg-accent-hover)',
          // Status (semantic purpose, not color)
          'green': 'var(--fluux-status-success)',
          'yellow': 'var(--fluux-status-warning)',
          'red': 'var(--fluux-status-error)',
          'gray': 'var(--fluux-color-gray)',
          'border': 'var(--fluux-border-color)',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
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
      },
      animation: {
        'tooltip-in': 'tooltip-in 150ms ease-out',
        'toast-in': 'toast-in 200ms ease-out',
      },
    },
  },
  plugins: [],
}
