import { useEffect, useRef } from 'react'
import { connectionStore } from '@fluux/sdk'
import { useXMPPContext } from '@fluux/sdk'
import type { WebPushService } from '@fluux/sdk'

/**
 * Whether Web Push is supported in the current environment.
 * Requires: not Tauri, browser with ServiceWorker and PushManager APIs.
 */
const isWebPushSupported =
  typeof window !== 'undefined' &&
  !('__TAURI_INTERNALS__' in window) &&
  'serviceWorker' in navigator &&
  'PushManager' in window

/**
 * Hook to manage Web Push notification registration.
 *
 * Automatically subscribes to push notifications when:
 * 1. Running in browser (not Tauri)
 * 2. Server supports p1:push:webpush
 * 3. VAPID services are available
 * 4. Browser notification permission is granted
 * 5. Service worker is registered
 *
 * The hook registers once per fresh session. On SM resumption the server
 * retains the push registration, so no re-registration is needed.
 */
export function useWebPush(): void {
  const { client } = useXMPPContext()
  const registering = useRef(false)

  useEffect(() => {
    // Skip in environments without Web Push support (Tauri, tests, old browsers)
    if (!isWebPushSupported) return

    // Subscribe to webPushStatus changes to trigger registration
    const unsub = connectionStore.subscribe(
      (state) => ({ status: state.webPushStatus, services: state.webPushServices }),
      ({ status, services }) => {
        if (status !== 'available') return
        if (services.length === 0) return
        if (registering.current) return

        registerPush(services[0])
      },
      { equalityFn: (a, b) => a.status === b.status && a.services === b.services }
    )

    // Also check current state immediately (in case services were already discovered)
    const { webPushStatus, webPushServices } = connectionStore.getState()
    if (
      webPushStatus === 'available' &&
      webPushServices.length > 0 &&
      !registering.current
    ) {
      registerPush(webPushServices[0])
    }

    return unsub
  }, [client])

  async function registerPush(service: WebPushService): Promise<void> {
    registering.current = true
    try {
      // Ensure notification permission
      if (Notification.permission === 'denied') return
      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission()
        if (perm !== 'granted') return
      }

      // Get service worker registration
      const swReg = await navigator.serviceWorker.ready

      // Check for existing subscription first, or create a new one
      let subscription = await swReg.pushManager.getSubscription()

      if (!subscription) {
        // Convert VAPID key from base64url to Uint8Array
        const vapidKeyBytes = urlBase64ToUint8Array(service.vapidKey)

        subscription = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBytes.buffer as ArrayBuffer,
        })
      }

      // Extract subscription details
      const endpoint = subscription.endpoint
      const p256dhKey = subscription.getKey('p256dh')
      const authKey = subscription.getKey('auth')

      if (!p256dhKey || !authKey) {
        console.error('[WebPush] Missing subscription keys')
        return
      }

      const p256dh = arrayBufferToBase64(p256dhKey)
      const auth = arrayBufferToBase64(authKey)

      // Register with XMPP server via p1:push
      await client.webPush.registerSubscription(endpoint, p256dh, auth, service.appId)
    } catch (err) {
      console.error('[WebPush] Registration failed:', err)
    } finally {
      registering.current = false
    }
  }
}

/**
 * Convert a base64url-encoded string to a Uint8Array.
 * Used for VAPID applicationServerKey conversion.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0))
}

/**
 * Convert an ArrayBuffer to a base64-encoded string.
 * Used for encoding PushSubscription keys.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary)
}
