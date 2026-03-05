import { useEffect, useRef } from 'react'
import { useEvents } from '@fluux/sdk'
import { sendNotification } from '@tauri-apps/plugin-notification'
import { useNotificationPermission, isTauri } from './useNotificationPermission'

/**
 * Hook to show desktop notifications for new events (subscription requests).
 * - Requests permission on mount (after login)
 * - Shows notification when a new subscription request arrives
 * - Uses Tauri notification API when available, falls back to web API
 */
export function useEventsDesktopNotifications(): void {
  const { subscriptionRequests } = useEvents()
  const prevRequestsRef = useRef<typeof subscriptionRequests>([])
  const permissionGranted = useNotificationPermission()

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
  }, [subscriptionRequests, permissionGranted])
}
