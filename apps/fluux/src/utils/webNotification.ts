/**
 * Web notification helper.
 *
 * Mobile browsers (notably Android Chrome) disallow `new Notification(...)` and
 * throw `TypeError: Failed to construct 'Notification': Illegal constructor`.
 * Only `ServiceWorkerRegistration.showNotification()` is permitted there.
 *
 * This helper prefers the service worker path when available so the same code
 * works on mobile and desktop. Clicks are routed by sw.ts via `data.from` /
 * `data.type`, which it converts into hash-route deep links.
 */

import type { NavType } from './notificationNavigation'

export interface WebNotificationNav {
  /** Target JID (conversation id or room jid). Consumed by sw.ts click handler. */
  from?: string
  /** Routing kind; the click handler resolves `from` according to it. */
  type?: NavType
  accountId?: string
  /**
   * Starting unread count for this notification. Consumed by the service
   * worker's push handler as the `existingCount` seed for coalescing, so a
   * later push that replaces this notification doesn't undercount (e.g.
   * showing "2 new messages" after the tab already displayed "4 new
   * messages"). Optional; the SW falls back to 1 when absent.
   */
  count?: number
}

export interface WebNotificationOptions {
  body: string
  icon?: string
  tag?: string
  /** Click fallback when the in-page Notification constructor is used. */
  onClick?: () => void
}

/**
 * The service worker registration, once active, or `null` when this page has
 * none. `navigator.serviceWorker.ready` never settles without a registration
 * (development server, failed registration), so it is only awaited once one
 * exists.
 */
export async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  if (!(await navigator.serviceWorker.getRegistration())) return null
  return navigator.serviceWorker.ready
}

export async function showWebNotification(
  title: string,
  options: WebNotificationOptions,
  nav: WebNotificationNav = {},
): Promise<void> {
  const { onClick, ...notificationOptions } = options
  const payload: NotificationOptions = {
    ...notificationOptions,
    data: nav,
  }

  try {
    const registration = await serviceWorkerRegistration()
    if (registration) {
      await registration.showNotification(title, payload)
      return
    }
  } catch {
    // Fall through to constructor path below.
  }

  if (typeof Notification === 'undefined') return

  try {
    const notification = new Notification(title, notificationOptions)
    notification.onclick = () => {
      window.focus()
      onClick?.()
      notification.close()
    }
    setTimeout(() => notification.close(), 5000)
  } catch {
    // Mobile browsers throw here — SW path above handles them.
  }
}
