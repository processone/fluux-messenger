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

export interface WebNotificationNav {
  /** Target JID (conversation id or room jid). Consumed by sw.ts click handler. */
  from?: string
  /** 'room' for MUC, otherwise treated as a 1:1 conversation. */
  type?: 'room' | 'conversation'
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

const canUseServiceWorker = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator

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

  if (canUseServiceWorker()) {
    try {
      const registration = await navigator.serviceWorker.ready
      await registration.showNotification(title, payload)
      return
    } catch {
      // Fall through to constructor path below.
    }
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
