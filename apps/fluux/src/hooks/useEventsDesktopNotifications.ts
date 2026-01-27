import { useEffect, useRef } from 'react'
import { useEvents } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

// Check if we're running in Tauri (v2 uses __TAURI_INTERNALS__)
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Hook to show desktop notifications for new events (subscription requests).
 * - Requests permission on mount (after login)
 * - Shows notification when a new subscription request arrives
 * - Uses Tauri notification API when available, falls back to web API
 */
export function useEventsDesktopNotifications(): void {
  const { subscriptionRequests } = useEvents()
  // Use focused selector to only subscribe to status
  const status = useConnectionStore((s) => s.status)
  const prevRequestsRef = useRef<typeof subscriptionRequests>([])
  const permissionGranted = useRef(false)

  // Request notification permission when connected
  useEffect(() => {
    if (status !== 'online') return

    const requestNotificationPermission = async () => {
      try {
        if (isTauri) {
          // Tauri notification API
          let granted = await isPermissionGranted()
          console.log('[EventsNotifications] Initial permission status:', granted ? 'granted' : 'not granted')
          if (!granted) {
            console.log('[EventsNotifications] Requesting permission...')
            const permission = await requestPermission()
            granted = permission === 'granted'
            console.log('[EventsNotifications] Permission request result:', permission)
          }
          permissionGranted.current = granted
        } else {
          // Web Notification API
          if (typeof Notification === 'undefined') return
          console.log('[EventsNotifications] Web API permission:', Notification.permission)
          if (Notification.permission === 'granted') {
            permissionGranted.current = true
          } else if (Notification.permission !== 'denied') {
            console.log('[EventsNotifications] Requesting permission...')
            const permission = await Notification.requestPermission()
            permissionGranted.current = permission === 'granted'
            console.log('[EventsNotifications] Permission request result:', permission)
          }
        }
      } catch (error) {
        console.error('[EventsNotifications] Error requesting permission:', error)
      }
    }

    requestNotificationPermission()
  }, [status])

  // Watch for new subscription requests
  useEffect(() => {
    if (!permissionGranted.current) return

    const prevRequests = prevRequestsRef.current

    // Find new requests (in current but not in previous)
    for (const request of subscriptionRequests) {
      const isNew = !prevRequests.some(r => r.from === request.from)

      if (isNew) {
        const senderName = request.from.split('@')[0]
        const title = 'Contact Request'
        const body = `${senderName} wants to add you as a contact`

        if (isTauri) {
          sendNotification({ title, body })
        } else {
          if (typeof Notification === 'undefined') continue

          const notification = new Notification(title, {
            body,
            icon: '/icon-512.png',
            tag: `subscription-${request.from}`,
          })

          notification.onclick = () => {
            window.focus()
            notification.close()
          }

          // Auto-close after 5 seconds
          setTimeout(() => notification.close(), 5000)
        }
      }
    }

    prevRequestsRef.current = subscriptionRequests
  }, [subscriptionRequests])
}
