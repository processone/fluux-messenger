import { eventsStore } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'
import type { ToastType } from '@/stores/toastStore'

/**
 * Types that are kept in the store and surfaced by StatusDisplay as a persistent
 * alert line. Everything else is transient — toasted and immediately removed.
 *
 * Persistent: 'auth-error', 'resource-conflict'
 * Transient:  'connection-error', 'subscription-denied' (and any future additions)
 */
const PERSISTENT_TYPES = new Set(['auth-error', 'resource-conflict'])

const TOAST_DURATION_MS = 6000

function toToastType(notificationType: string): ToastType {
  if (notificationType === 'connection-error') return 'error'
  return 'info'
}

/**
 * Routes eventsStore.systemNotifications to toasts (transient) / status line (persistent).
 * Returns a cleanup function that unsubscribes from the store.
 */
export function startSystemNotificationEffect(): () => void {
  const seen = new Set<string>()
  const handle = () => {
    const { systemNotifications, removeSystemNotification } = eventsStore.getState()
    for (const n of systemNotifications) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      if (PERSISTENT_TYPES.has(n.type)) continue // shown by StatusDisplay
      useToastStore.getState().addToast(toToastType(n.type), n.message, TOAST_DURATION_MS)
      removeSystemNotification(n.id)
    }
  }
  handle() // process any already-present notifications
  return eventsStore.subscribe(handle)
}
