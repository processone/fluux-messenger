import { useEffect } from 'react'
import { useSettingsStore, type ThemeMode } from '@/stores/settingsStore'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Theme colors for status bar - using bg-secondary for better visual continuity */
/** In dark mode, this matches the icon rail which is at the top-left corner */
const THEME_COLORS = {
  dark: '#1a1b1e',  // --fluux-bg-secondary (darker, matches icon rail)
  light: '#d8dadf', // --fluux-bg-secondary for light mode
} as const

/**
 * Resolves the actual mode (light/dark) based on setting and system preference
 */
function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return mode
}

/**
 * Updates the theme-color meta tag to match the current mode.
 * This controls the Android status bar color and PWA title bar color.
 */
function updateThemeColorMeta(resolved: 'light' | 'dark') {
  const color = THEME_COLORS[resolved]
  // Update all theme-color meta tags (there may be multiple with media queries)
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', color)
  })
}

/**
 * Hook that applies the mode class to document.documentElement
 * and listens for system preference changes when in 'system' mode.
 *
 * Returns:
 * - mode: The current mode setting ('light' | 'dark' | 'system')
 * - setMode: Function to change the mode
 * - resolvedMode: The actual applied mode ('light' | 'dark')
 * - isDark: Convenience boolean for dark mode checks
 */
export function useMode() {
  const mode = useSettingsStore((s) => s.themeMode)
  const setMode = useSettingsStore((s) => s.setThemeMode)

  useEffect(() => {
    const root = document.documentElement

    function applyMode() {
      const resolved = resolveMode(mode)
      root.classList.remove('light', 'dark')
      if (resolved === 'light') {
        root.classList.add('light')
      }
      // No class needed for dark (it's the default in :root)

      // Sync Android/PWA status bar color with app theme
      updateThemeColorMeta(resolved)

      // Sync native window theme (affects Linux/Windows title bar color)
      if (isTauri) {
        import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
          getCurrentWindow().setTheme(resolved).catch(() => {})
        })
      }
    }

    applyMode()

    // Listen for system preference changes when in 'system' mode
    if (mode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: light)')
      const handler = () => applyMode()
      mediaQuery.addEventListener('change', handler)
      return () => mediaQuery.removeEventListener('change', handler)
    }
  }, [mode])

  const resolved = resolveMode(mode)
  return { mode, setMode, resolvedMode: resolved, isDark: resolved === 'dark' }
}
