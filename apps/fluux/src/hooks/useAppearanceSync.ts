import { useEffect, useRef } from 'react'
import { useXMPP } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { useSettingsStore, type ThemeMode } from '@/stores/settingsStore'

/**
 * Syncs appearance settings with PEP (XEP-0223) when connected.
 * - Fetches settings on connect and updates local store if found
 * - Saves settings to PEP when they change (debounced)
 */
export function useAppearanceSync() {
  // Use focused selector to only subscribe to status
  const status = useConnectionStore((s) => s.status)
  const { client } = useXMPP()
  const themeMode = useSettingsStore((s) => s.themeMode)
  const setThemeMode = useSettingsStore((s) => s.setThemeMode)

  const hasLoadedRef = useRef(false)
  const lastSavedThemeRef = useRef<ThemeMode | null>(null)

  // Fetch settings on connect
  useEffect(() => {
    if (status !== 'online' || hasLoadedRef.current) return
    hasLoadedRef.current = true

    client.profile.fetchAppearance().then((settings) => {
      if (settings?.mode) {
        const mode = settings.mode as ThemeMode
        if (mode === 'light' || mode === 'dark' || mode === 'system') {
          setThemeMode(mode)
          lastSavedThemeRef.current = mode
        }
      } else {
        // No settings found, mark current mode as saved
        lastSavedThemeRef.current = themeMode
      }
    }).catch(() => {
      // Ignore errors - local storage is authoritative
      lastSavedThemeRef.current = themeMode
    })
  }, [status, client, setThemeMode, themeMode])

  // Save settings when changed (debounced)
  useEffect(() => {
    if (status !== 'online') return
    if (lastSavedThemeRef.current === null) return // Wait for initial load
    if (themeMode === lastSavedThemeRef.current) return

    const timeout = setTimeout(() => {
      lastSavedThemeRef.current = themeMode
      client.profile.setAppearance({ mode: themeMode }).catch(() => {
        // Ignore errors - local storage is authoritative
      })
    }, 1000) // Debounce to avoid rapid saves

    return () => clearTimeout(timeout)
  }, [status, client, themeMode])

  // Reset on disconnect
  useEffect(() => {
    if (status === 'disconnected') {
      hasLoadedRef.current = false
      lastSavedThemeRef.current = null
    }
  }, [status])
}
