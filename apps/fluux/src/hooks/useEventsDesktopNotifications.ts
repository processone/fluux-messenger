import { useEffect, useRef } from 'react'
import { useEvents, usePresence, getLocalPart } from '@fluux/sdk'
import {
  useNotificationPermission,
  getNotificationPermissionGranted,
  isTauri,
} from './useNotificationPermission'
import { postPluginNotification } from '@/utils/postPluginNotification'

/**
 * Hook to show desktop notifications for new events (subscription requests).
 * - Requests permission on mount (after login)
 * - Shows notification when a new subscription request arrives
 * - Uses Tauri notification API when available, falls back to web API
 */
export function useEventsDesktopNotifications(): void {
  const { subscriptionRequests } = useEvents()
  const { presenceStatus } = usePresence()
  const prevRequestsRef = useRef<typeof subscriptionRequests>([])
  useNotificationPermission()

  // Watch for new subscription requests
  useEffect(() => {
    if (!getNotificationPermissionGranted()) return
    if (presenceStatus === 'dnd') {
      prevRequestsRef.current = subscriptionRequests
      return
    }

    const prevRequests = prevRequestsRef.current

    // Find new requests (in current but not in previous)
    for (const request of subscriptionRequests) {
      const isNew = !prevRequests.some(r => r.from === request.from)

      if (isNew) {
        const senderName = getLocalPart(request.from)
        const title = 'Contact Request'
        const body = `${senderName} wants to add you as a contact`

        if (isTauri) {
          void postPluginNotification({ title, body })
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
  }, [subscriptionRequests, presenceStatus])
}
