import { useEffect, useRef } from 'react'
import { useSettingsStore, type ThemeMode } from '@/stores/settingsStore'
import { useThemeStore } from '@/stores/themeStore'
import type { AccentPreset } from '@/themes/types'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Theme colors for status bar — using bg-secondary for visual continuity */
const FALLBACK_THEME_COLORS = {
  dark: '#1a1b1e',
  light: '#d8dadf',
} as const

/**
 * Resolves the actual mode (light/dark) based on setting and system preference.
 */
function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return mode
}

/**
 * Updates the theme-color meta tag for Android status bar / PWA title bar.
 */
function updateThemeColorMeta(resolved: 'light' | 'dark') {
  const color = FALLBACK_THEME_COLORS[resolved]
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', color)
  })
}

/**
 * Apply a theme's CSS variable overrides to document.documentElement.
 * For the default 'fluux' theme, clears any inline overrides so :root defaults apply.
 */
function applyThemeVariables(variables: Record<string, string> | undefined, previousVarsRef: React.MutableRefObject<string[]>) {
  const root = document.documentElement

  // Clear previously applied theme variables
  for (const name of previousVarsRef.current) {
    root.style.removeProperty(name)
  }
  previousVarsRef.current = []

  // Apply new theme variables (if any)
  if (variables && Object.keys(variables).length > 0) {
    for (const [name, value] of Object.entries(variables)) {
      root.style.setProperty(name, value)
      previousVarsRef.current.push(name)
    }
  }
}

/**
 * Apply accent color override to document.documentElement.
 * Uses the dark or light HSL values depending on the resolved mode.
 */
function applyAccentOverride(accent: AccentPreset | null, resolved: 'light' | 'dark', previousAccentVarsRef: React.MutableRefObject<string[]>) {
  const root = document.documentElement

  // Clear previously applied accent overrides
  for (const name of previousAccentVarsRef.current) {
    root.style.removeProperty(name)
  }
  previousAccentVarsRef.current = []

  if (!accent) return

  const hsl = resolved === 'light' ? accent.light : accent.dark
  const vars: [string, string][] = [
    ['--fluux-accent-h', `${hsl.h}`],
    ['--fluux-accent-s', `${hsl.s}%`],
    ['--fluux-accent-l', `${hsl.l}%`],
  ]
  for (const [name, value] of vars) {
    root.style.setProperty(name, value)
    previousAccentVarsRef.current.push(name)
  }
}

/** Snippet <style> element data attribute */
const SNIPPET_ATTR = 'data-fluux-snippet'

/**
 * Inject/remove snippet <style> elements in <head>.
 */
function syncSnippets(snippets: { id: string; enabled: boolean; css: string }[]) {
  const head = document.head

  // Remove all existing snippet styles
  head.querySelectorAll(`style[${SNIPPET_ATTR}]`).forEach((el) => el.remove())

  // Inject enabled snippets
  for (const snippet of snippets) {
    if (!snippet.enabled) continue
    const style = document.createElement('style')
    style.setAttribute(SNIPPET_ATTR, snippet.id)
    style.textContent = snippet.css
    head.appendChild(style)
  }
}

/**
 * Main theme hook — applies the active theme's CSS variables, manages
 * dark/light mode classes, injects CSS snippets, and syncs with Tauri.
 *
 * This is the single source of truth for visual theming.
 *
 * Returns:
 * - mode: The current mode setting ('light' | 'dark' | 'system')
 * - setMode: Function to change the mode
 * - resolvedMode: The actual applied mode ('light' | 'dark')
 * - isDark: Convenience boolean for dark mode checks
 * - activeThemeId: ID of the currently active theme
 */
export function useTheme() {
  const mode = useSettingsStore((s) => s.themeMode)
  const setMode = useSettingsStore((s) => s.setThemeMode)
  const fontSize = useSettingsStore((s) => s.fontSize)

  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const getActiveTheme = useThemeStore((s) => s.getActiveTheme)
  const accentPreset = useThemeStore((s) => s.accentPreset)
  const snippets = useThemeStore((s) => s.snippets)

  // Track which CSS variables we've set inline so we can clean them up on theme change
  const previousVarsRef = useRef<string[]>([])
  const previousAccentVarsRef = useRef<string[]>([])

  // Apply mode class + theme variables
  useEffect(() => {
    const root = document.documentElement
    const resolved = resolveMode(mode)

    // 1. Apply mode class
    root.classList.remove('light', 'dark')
    if (resolved === 'light') {
      root.classList.add('light')
    }

    // 2. Apply theme variable overrides
    const theme = getActiveTheme()
    const modeVars = theme?.variables?.[resolved]
    applyThemeVariables(modeVars, previousVarsRef)

    // 3. Apply accent color override (after theme variables)
    applyAccentOverride(accentPreset, resolved, previousAccentVarsRef)

    // 4. Sync status bar color
    updateThemeColorMeta(resolved)

    // 5. Sync Tauri native title bar
    if (isTauri) {
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => {
          const tauriTheme = mode === 'system' ? null : resolved
          void getCurrentWindow().setTheme(tauriTheme).catch(() => {})
        })
        .catch(() => {})
    }
  }, [mode, activeThemeId, getActiveTheme, accentPreset])

  // Listen for system preference changes when in 'system' mode
  useEffect(() => {
    if (mode !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => {
      const resolved = resolveMode(mode)
      const root = document.documentElement
      root.classList.remove('light', 'dark')
      if (resolved === 'light') root.classList.add('light')

      // Re-apply theme variables for the new mode
      const theme = getActiveTheme()
      const modeVars = theme?.variables?.[resolved]
      applyThemeVariables(modeVars, previousVarsRef)

      // Re-apply accent override for the new mode
      applyAccentOverride(accentPreset, resolved, previousAccentVarsRef)

      updateThemeColorMeta(resolved)
    }

    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [mode, activeThemeId, getActiveTheme, accentPreset])

  // Apply font size
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}%`
  }, [fontSize])

  // Sync CSS snippets
  useEffect(() => {
    syncSnippets(snippets)
  }, [snippets])

  const resolved = resolveMode(mode)
  return {
    mode,
    setMode,
    resolvedMode: resolved,
    isDark: resolved === 'dark',
    activeThemeId,
  }
}
