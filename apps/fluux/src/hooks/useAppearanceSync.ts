import { useEffect, useRef } from 'react'
import { useXMPP } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { useSettingsStore, type ThemeMode } from '@/stores/settingsStore'
import { useThemeStore } from '@/stores/themeStore'
import type { AccentPreset } from '@/themes/types'

/** Snapshot of all appearance values for dirty-checking */
interface AppearanceSnapshot {
  mode: ThemeMode
  themeId: string
  fontSize: number
  accentPreset: AccentPreset | null
}

function snapshotsEqual(a: AppearanceSnapshot, b: AppearanceSnapshot): boolean {
  return (
    a.mode === b.mode &&
    a.themeId === b.themeId &&
    a.fontSize === b.fontSize &&
    a.accentPreset?.name === b.accentPreset?.name
  )
}

/**
 * Syncs appearance settings with PEP (XEP-0223) when connected.
 * - Fetches settings on connect and updates local stores if found
 * - Saves settings to PEP when they change (debounced)
 *
 * Synced fields: themeMode, activeThemeId, fontSize, accentPreset.
 */
export function useAppearanceSync() {
  const status = useConnectionStore((s) => s.status)
  const { client } = useXMPP()

  // Settings store
  const themeMode = useSettingsStore((s) => s.themeMode)
  const setThemeMode = useSettingsStore((s) => s.setThemeMode)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const setFontSize = useSettingsStore((s) => s.setFontSize)

  // Theme store
  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme)
  const accentPreset = useThemeStore((s) => s.accentPreset)
  const setAccentPreset = useThemeStore((s) => s.setAccentPreset)
  const clearAccentPreset = useThemeStore((s) => s.clearAccentPreset)

  const hasLoadedRef = useRef(false)
  const lastSavedRef = useRef<AppearanceSnapshot | null>(null)

  // Fetch settings on connect
  useEffect(() => {
    if (status !== 'online' || hasLoadedRef.current) return
    hasLoadedRef.current = true

    client.profile.fetchAppearance().then((settings) => {
      if (settings?.mode) {
        const mode = settings.mode as ThemeMode
        if (mode === 'light' || mode === 'dark' || mode === 'system') {
          setThemeMode(mode)
        }
        if (settings.themeId) {
          setActiveTheme(settings.themeId)
        }
        if (settings.fontSize != null && settings.fontSize >= 75 && settings.fontSize <= 150) {
          setFontSize(settings.fontSize)
        }
        if (settings.accentPreset) {
          try {
            const parsed = JSON.parse(settings.accentPreset) as AccentPreset
            if (parsed.name && parsed.dark && parsed.light) {
              setAccentPreset(parsed)
            }
          } catch {
            // Invalid accent data, ignore
          }
        } else {
          clearAccentPreset()
        }

        lastSavedRef.current = {
          mode: (settings.mode as ThemeMode) || themeMode,
          themeId: settings.themeId || activeThemeId,
          fontSize: settings.fontSize ?? fontSize,
          accentPreset: settings.accentPreset ? JSON.parse(settings.accentPreset) : null,
        }
      } else {
        // No settings found, mark current state as saved
        lastSavedRef.current = { mode: themeMode, themeId: activeThemeId, fontSize, accentPreset }
      }
    }).catch(() => {
      // Ignore errors - local storage is authoritative
      lastSavedRef.current = { mode: themeMode, themeId: activeThemeId, fontSize, accentPreset }
    })
  }, [status, client, setThemeMode, setFontSize, setActiveTheme, setAccentPreset, clearAccentPreset, themeMode, activeThemeId, fontSize, accentPreset])

  // Save settings when changed (debounced)
  useEffect(() => {
    if (status !== 'online') return
    if (lastSavedRef.current === null) return // Wait for initial load

    const current: AppearanceSnapshot = { mode: themeMode, themeId: activeThemeId, fontSize, accentPreset }
    if (snapshotsEqual(current, lastSavedRef.current)) return

    const timeout = setTimeout(() => {
      lastSavedRef.current = current
      client.profile.setAppearance({
        mode: themeMode,
        themeId: activeThemeId,
        fontSize,
        accentPreset: accentPreset ? JSON.stringify(accentPreset) : undefined,
      }).catch(() => {
        // Ignore errors - local storage is authoritative
      })
    }, 1000) // Debounce to avoid rapid saves

    return () => clearTimeout(timeout)
  }, [status, client, themeMode, activeThemeId, fontSize, accentPreset])

  // Reset on disconnect
  useEffect(() => {
    if (status === 'disconnected') {
      hasLoadedRef.current = false
      lastSavedRef.current = null
    }
  }, [status])
}
