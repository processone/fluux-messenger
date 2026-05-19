import { useEffect, useRef, useCallback } from 'react'
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

    const json = subscription.toJSON()
    const endpoint = json.endpoint ?? subscription.endpoint
    const p256dh = json.keys?.p256dh
    const auth = json.keys?.auth
    if (!p256dh || !auth) {
      console.error('[WebPush] Missing subscription keys')
      return
    }

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
      return
    }
    console.log('[WebPush] Hook active, subscribing to store changes')

    const tryAutoRegister = (status: string, services: WebPushService[], enabled: boolean) => {
      if (!enabled || status !== 'available' || services.length === 0) return
      void tryRegister(services[0], true)
    }

    const unsub = connectionStore.subscribe(
      (state) => ({ status: state.webPushStatus, services: state.webPushServices, enabled: state.webPushEnabled }),
      ({ status, services, enabled }) => {
        console.log('[WebPush] Store changed: status =', status,
          '| services =', services.length, '| enabled =', enabled, '| registering =', registering.current)
        tryAutoRegister(status, services, enabled)
      },
      { equalityFn: (a, b) => a.status === b.status && a.services === b.services && a.enabled === b.enabled }
    )

    const { webPushStatus, webPushServices, webPushEnabled } = connectionStore.getState()
    console.log('[WebPush] Initial state: status =', webPushStatus,
      '| services =', webPushServices.length, '| enabled =', webPushEnabled)
    tryAutoRegister(webPushStatus, webPushServices, webPushEnabled)

    return unsub
  }, [client, tryRegister])
}

/**
 * Trigger web push registration from a user-gesture context (button click).
 * Mobile browsers require a user gesture to call Notification.requestPermission().
 *
 * @param client - The XMPP client instance from useXMPPContext()
 */
export function requestWebPushRegistration(client: any): void {
  if (!isWebPushSupported) return
  const { webPushServices } = connectionStore.getState()
  if (webPushServices.length === 0) return
  void registerPush(client, webPushServices[0], false)
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0))
}
