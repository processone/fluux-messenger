import { useEffect, useRef } from 'react'
import { useConnectionStore } from '@fluux/sdk/react'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Module-level state shared across all consumers — permission is requested once per session
let permissionChecked = false
let cachedPermission = false

/**
 * Hook that requests notification permission (Tauri or Web) once per session.
 * Returns a ref indicating whether permission was granted.
 *
 * Both useDesktopNotifications and useEventsDesktopNotifications share this
 * so the permission prompt only fires once regardless of which hook mounts first.
 */
export function useNotificationPermission(): React.RefObject<boolean> {
  const status = useConnectionStore((s) => s.status)
  const permissionGranted = useRef(cachedPermission)

  useEffect(() => {
    if (status !== 'online') return

    if (permissionChecked) {
      permissionGranted.current = cachedPermission
      return
    }

    const check = async () => {
      try {
        if (isTauri) {
          let granted = await isPermissionGranted()
          if (!granted) {
            const permission = await requestPermission()
            granted = permission === 'granted'
          }
          permissionGranted.current = granted
          if (!granted) {
            console.log(
              '[Notifications] Permission not granted. On macOS, go to System Settings → Notifications to enable.',
            )
          }
        } else {
          if (typeof Notification === 'undefined') return
          if (Notification.permission === 'granted') {
            permissionGranted.current = true
          } else if (Notification.permission !== 'denied') {
            const permission = await Notification.requestPermission()
            permissionGranted.current = permission === 'granted'
          }
        }
        cachedPermission = permissionGranted.current
        permissionChecked = true
      } catch (error) {
        console.error('[Notifications] Error requesting permission:', error)
      }
    }

    void check()
  }, [status])

  return permissionGranted
}
