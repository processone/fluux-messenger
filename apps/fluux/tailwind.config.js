/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Fluux color palette - uses CSS variables for theme switching
        fluux: {
          // Backgrounds
          'bg': 'var(--fluux-bg)',
          'bg-secondary': 'var(--fluux-bg-secondary)',
          'sidebar': 'var(--fluux-sidebar)',
          'chat': 'var(--fluux-chat)',
          'hover': 'var(--fluux-hover)',
          'active': 'var(--fluux-active)',
          'selection': 'var(--fluux-selection)',
          // Text
          'text': 'var(--fluux-text)',
          'muted': 'var(--fluux-muted)',
          'link': 'var(--fluux-link)',
          // Accents
          'brand': 'var(--fluux-brand)',
          'brand-hover': 'var(--fluux-brand-hover)',
          'green': 'var(--fluux-green)',
          'yellow': 'var(--fluux-yellow)',
          'red': 'var(--fluux-red)',
          'gray': 'var(--fluux-gray)',
          'border': 'var(--fluux-border)',
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
