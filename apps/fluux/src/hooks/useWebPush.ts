import { useCallback, useEffect, useRef } from 'react'
import { connectionStore } from '@fluux/sdk'
import { useXMPPContext } from '@fluux/sdk'
import type { WebPushService } from '@fluux/sdk'

/**
 * Whether Web Push is supported in the current environment.
 * Requires: not Tauri, browser with ServiceWorker and PushManager APIs.
 */
export const isWebPushSupported =
  typeof window !== 'undefined' &&
  !('__TAURI_INTERNALS__' in window) &&
  'serviceWorker' in navigator &&
  'PushManager' in window

/**
 * Perform the actual push registration with the browser and XMPP server.
 *
 * @param client - The XMPP client instance (must have webPush.registerSubscription)
 * @param service - VAPID service to register with
 * @param skipIfNoPermission - When true, skip if notification permission is 'default'
 *   (for auto-registration without user gesture). When false, request permission
 *   (requires user-gesture context on mobile).
 */
async function registerPush(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  service: WebPushService,
  skipIfNoPermission: boolean
): Promise<void> {
  console.log('[WebPush] Starting registration with service:', service)
  try {
    console.log('[WebPush] Notification.permission =', Notification.permission)
    if (Notification.permission === 'denied') {
      console.warn('[WebPush] Notification permission denied, aborting')
      return
    }
    if (Notification.permission === 'default') {
      if (skipIfNoPermission) {
        console.log('[WebPush] Permission not yet granted, needs user gesture — skipping auto-registration')
        return
      }
      const perm = await Notification.requestPermission()
      console.log('[WebPush] Permission request result:', perm)
      if (perm !== 'granted') return
    }

    console.log('[WebPush] Waiting for service worker ready...')
    const swReg = await navigator.serviceWorker.ready
    console.log('[WebPush] Service worker ready, scope:', swReg.scope)

    let subscription = await swReg.pushManager.getSubscription()
    console.log('[WebPush] Existing subscription:', subscription ? 'yes' : 'no')

    if (!subscription) {
      const vapidKeyBytes = urlBase64ToUint8Array(service.vapidKey)
      console.log('[WebPush] Subscribing with VAPID key length:', vapidKeyBytes.length)
      subscription = await swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes.buffer as ArrayBuffer,
      })
      console.log('[WebPush] New subscription created, endpoint:', subscription.endpoint)
    }

    const endpoint = subscription.endpoint
    const p256dhKey = subscription.getKey('p256dh')
    const authKey = subscription.getKey('auth')
    if (!p256dhKey || !authKey) {
      console.error('[WebPush] Missing subscription keys')
      return
    }

    const p256dh = arrayBufferToBase64(p256dhKey)
    const auth = arrayBufferToBase64(authKey)

    console.log('[WebPush] Registering with XMPP server, endpoint:', endpoint)
    await client.webPush.registerSubscription(endpoint, p256dh, auth, service.appId)
    console.log('[WebPush] Registration complete!')
  } catch (err) {
    console.error('[WebPush] Registration failed:', err)
  }
}

/**
 * Hook for automatic Web Push registration on fresh sessions.
 *
 * Auto-registers only when notification permission is already 'granted'.
 * When permission is 'default', auto-registration is skipped because
 * mobile browsers require a user gesture to request permission.
 * Use `requestWebPushRegistration` from a button handler instead.
 */
export function useWebPush(): void {
  const { client } = useXMPPContext()
  const registering = useRef(false)

  const tryRegister = useCallback(async (service: WebPushService, skipIfNoPermission: boolean) => {
    if (registering.current) return
    registering.current = true
    try {
      await registerPush(client, service, skipIfNoPermission)
    } finally {
      registering.current = false
    }
  }, [client])

  useEffect(() => {
    if (!isWebPushSupported) {
      console.log('[WebPush] Not supported in this environment',
        { hasSW: 'serviceWorker' in navigator, hasPM: 'PushManager' in window,
          isTauri: '__TAURI_INTERNALS__' in window })
      return
    }
    console.log('[WebPush] Hook active, subscribing to store changes')

    const tryAutoRegister = (status: string, services: WebPushService[]) => {
      if (status !== 'available' || services.length === 0) return
      void tryRegister(services[0], true)
    }

    const unsub = connectionStore.subscribe(
      (state) => ({ status: state.webPushStatus, services: state.webPushServices }),
      ({ status, services }) => {
        console.log('[WebPush] Store changed: status =', status,
          '| services =', services.length, '| registering =', registering.current)
        tryAutoRegister(status, services)
      },
      { equalityFn: (a, b) => a.status === b.status && a.services === b.services }
    )

    const { webPushStatus, webPushServices } = connectionStore.getState()
    console.log('[WebPush] Initial state: status =', webPushStatus,
      '| services =', webPushServices.length)
    tryAutoRegister(webPushStatus, webPushServices)

    return unsub
  }, [client, tryRegister])
}

/**
 * Trigger web push registration from a user-gesture context (button click).
 * Mobile browsers require a user gesture to call Notification.requestPermission().
 *
 * @param client - The XMPP client instance from useXMPPContext()
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requestWebPushRegistration(client: any): void {
  if (!isWebPushSupported) return
  const { webPushStatus, webPushServices } = connectionStore.getState()
  if (webPushStatus !== 'available' || webPushServices.length === 0) return
  void registerPush(client, webPushServices[0], false)
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0))
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary)
}
