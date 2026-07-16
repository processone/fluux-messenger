/**
 * Shared, platform-agnostic helpers for turning a Web Push / Notification
 * `data` payload into an in-app navigation target.
 *
 * Imported by BOTH the service worker (`sw.ts`, `notificationclick` handler) and
 * the in-page listener (`useServiceWorkerNavigation`) so the two always agree on
 * the exact route format and the SW->client message shape. Keeping the logic in
 * one pure module lets us unit-test it without a service-worker runtime.
 */

/** Routing data attached to a notification (by `showWebNotification` or the push payload). */
export interface NotificationNavData {
  /** Bare JID (1:1 contact) or room JID (MUC). */
  from?: string
  /** 'room' for MUC; any other value (or absent) is treated as a 1:1 conversation. */
  type?: string
}

/** Navigation kind for a notification target. */
export type NavType = 'conversation' | 'room'

/**
 * Tag used by the web Notification API for a conversation/room. Shared by the
 * push handler (sw.ts), the app notification path (useDesktopNotifications),
 * and read-dismissal (dismissNotification) so they always address the same
 * notification. Differs from the macOS native identifier.
 */
export function webTag(navType: NavType, navTarget: string): string {
  return navType === 'room' ? `room-${navTarget}` : navTarget
}

/** Discriminator for the message the service worker posts to a live client. */
export const NOTIFICATION_NAVIGATE = 'notification-navigate' as const

/** Message posted from the service worker to a focused client to route it. */
export interface NotificationNavigateMessage {
  type: typeof NOTIFICATION_NAVIGATE
  navType: 'room' | 'conversation'
  target: string
}

export interface NotificationTarget {
  navType: 'room' | 'conversation'
  /** Bare JID (1:1) or room JID (MUC). */
  target: string
  /** Hash-router path, e.g. `#/messages/user%40example.com`. */
  hashPath: string
  /** Scope-relative deep link for `openWindow`/`navigate`, e.g. `./#/messages/...`. */
  deepLink: string
}

/**
 * Resolve a notification's routing data into a concrete navigation target.
 *
 * Returns `null` when there is no target JID (e.g. a push payload that omitted
 * `from`), in which case callers should just focus/open the app at its default
 * view rather than deep-linking nowhere.
 */
export function resolveNotificationTarget(
  data: NotificationNavData | undefined | null,
): NotificationTarget | null {
  const from = data?.from
  if (!from) return null
  const navType = data?.type === 'room' ? 'room' : 'conversation'
  const route = navType === 'room' ? 'rooms' : 'messages'
  const hashPath = `#/${route}/${encodeURIComponent(from)}`
  return {
    navType,
    target: from,
    hashPath,
    deepLink: `./${hashPath}`,
  }
}

/** Build the SW->client message for a resolved target. */
export function notificationNavigateMessage(
  target: NotificationTarget,
): NotificationNavigateMessage {
  return { type: NOTIFICATION_NAVIGATE, navType: target.navType, target: target.target }
}

/**
 * Apply a service-worker message to the app router. Returns `true` when the
 * message was a recognised navigation request and was dispatched, `false`
 * otherwise (unrelated messages such as SKIP_WAITING are ignored).
 */
export function handleNotificationNavigateMessage(
  data: unknown,
  handlers: {
    navigateToConversation: (jid: string) => void
    navigateToRoom: (jid: string) => void
  },
): boolean {
  if (!data || typeof data !== 'object') return false
  const msg = data as Partial<NotificationNavigateMessage>
  if (msg.type !== NOTIFICATION_NAVIGATE || typeof msg.target !== 'string') return false
  if (msg.navType === 'room') {
    handlers.navigateToRoom(msg.target)
  } else {
    handlers.navigateToConversation(msg.target)
  }
  return true
}
