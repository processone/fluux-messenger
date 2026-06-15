import { useEffect } from 'react'
import { useConnectionStore } from '@fluux/sdk/react'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'
import { isMacOSDesktop } from '@/utils/tauriPlatform'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Module-level shared state — the single source of truth for "may we post a
// desktop notification". Consumers read it via getNotificationPermissionGranted()
// rather than holding a ref, so a mid-session grant (e.g. from the Settings
// screen, or after the user flips the OS toggle) takes effect everywhere without
// an app restart.
let permissionChecked = false
let granted = false

/** Current notification permission, as last read. Read by the notification hooks. */
export function getNotificationPermissionGranted(): boolean {
  return granted
}

/**
 * Read the current permission WITHOUT prompting. macOS desktop uses the native
 * UNUserNotificationCenter command (the same source of truth as the posting
 * gate); other Tauri platforms use the notification plugin; web reads the
 * Notification API.
 */
async function readPermission(): Promise<boolean> {
  if (isTauri) {
    if (await isMacOSDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core')
      return (await invoke<string>('notification_permission_state')) === 'granted'
    }
    return await isPermissionGranted()
  }
  if (typeof Notification === 'undefined') return false
  return Notification.permission === 'granted'
}

/** Prompt for permission, showing the OS dialog when the state is undetermined. */
async function promptPermission(): Promise<boolean> {
  if (isTauri) {
    if (await isMacOSDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core')
      return (await invoke<string>('request_notification_permission')) === 'granted'
    }
    return (await requestPermission()) === 'granted'
  }
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}

/**
 * Re-read permission (no prompt) and update the shared state. Call after the
 * window regains focus or the user changes the OS setting so consumers pick up
 * the new value immediately.
 */
export async function refreshNotificationPermission(): Promise<boolean> {
  granted = await readPermission()
  return granted
}

/**
 * Prompt for permission and update the shared state. Used by the once-per-session
 * login flow and the Settings "Enable" action.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  granted = await promptPermission()
  permissionChecked = true
  return granted
}

/**
 * Request notification permission once per session, after the user comes online.
 * The module-level latch means the prompt fires only once regardless of how many
 * consumers mount. Components read the result via getNotificationPermissionGranted().
 */
export function useNotificationPermission(): void {
  const status = useConnectionStore((s) => s.status)

  useEffect(() => {
    if (status !== 'online') return
    if (permissionChecked) return
    permissionChecked = true
    void requestNotificationPermission().catch((error) => {
      console.error('[Notifications] Error requesting permission:', error)
    })
  }, [status])
}
