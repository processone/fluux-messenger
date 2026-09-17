/**
 * Shared, platform-agnostic helpers for turning a Web Push / Notification
 * `data` payload into an in-app navigation target.
 *
 * Imported by BOTH the service worker (`sw.ts`, `notificationclick` handler) and
 * the in-page listener (`useServiceWorkerNavigation`) so the two always agree on
 * the exact route format and the SW->client message shape. Keeping the logic in
 * one pure module lets us unit-test it without a service-worker runtime.
 */

import { routeNotificationTarget, voiceRequestRoom } from './notificationRouting'

/** Routing data attached to a notification (by `showWebNotification` or the push payload). */
export interface NotificationNavData {
  /** Bare JID (1:1 contact) or room JID (MUC). */
  from?: string
  /** A {@link NavType}; any unknown value (or absent) is treated as a 1:1 conversation. */
  type?: string
  accountId?: string
}

/**
 * Notification kinds for pending events the user must act on. Their target is
 * the requester JID (contact request), the room JID (invitation), or the
 * requesting occupant JID `room@service/nick` (voice request).
 */
export type EventNavType = 'contact-request' | 'room-invitation' | 'voice-request'

/** Navigation kind for a notification target. */
export type NavType = 'conversation' | 'room' | EventNavType

const NAV_TYPES: readonly NavType[] = [
  'conversation', 'room', 'contact-request', 'room-invitation', 'voice-request',
]

function toNavType(type: string | undefined): NavType {
  return NAV_TYPES.find((t) => t === type) ?? 'conversation'
}

/**
 * Tag used by the web Notification API for a conversation/room. Shared by the
 * push handler (sw.ts), the app notification path (useDesktopNotifications),
 * and read-dismissal (dismissNotification) so they always address the same
 * notification. Differs from the macOS native identifier.
 */
export function webTag(navType: NavType, navTarget: string, accountId?: string | null): string {
  const tag = navType === 'conversation' ? navTarget : `${navType}-${navTarget}`
  return accountId && navType !== 'conversation' && navType !== 'room'
    ? `${tag}:account:${encodeURIComponent(accountId)}`
    : tag
}

/** Discriminator for the message the service worker posts to a live client. */
export const NOTIFICATION_NAVIGATE = 'notification-navigate' as const
export const NOTIFICATION_CLIENT_ACCOUNT = 'notification-client-account' as const

/** Message posted from the service worker to a focused client to route it. */
export interface NotificationNavigateMessage {
  type: typeof NOTIFICATION_NAVIGATE
  navType: NavType
  target: string
}

export interface NotificationClientAccountMessage {
  type: typeof NOTIFICATION_CLIENT_ACCOUNT
  accountId: string | null
}

export function notificationClientAccountMessage(accountId: string | null): NotificationClientAccountMessage {
  return { type: NOTIFICATION_CLIENT_ACCOUNT, accountId }
}

export function selectNotificationClient<T extends { id: string; url: string }>(
  clients: readonly T[],
  origin: string,
  accountId: string | undefined,
  clientAccountId: (clientId: string) => string | undefined,
): { client: T | undefined; canNavigate: boolean } {
  const sameOrigin = clients.filter((client) => client.url.startsWith(origin))
  if (!accountId) return { client: sameOrigin[0], canNavigate: true }
  const client = sameOrigin.find((candidate) => clientAccountId(candidate.id) === accountId)
  return { client: client ?? sameOrigin[0], canNavigate: client !== undefined }
}

export interface NotificationTarget {
  navType: NavType
  /** Bare JID (1:1), room JID (MUC), or the event target described on {@link EventNavType}. */
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
  const navType = toNavType(data?.type)
  const hashPath = hashPathFor(navType, from)
  return {
    navType,
    target: from,
    hashPath,
    deepLink: `./${hashPath}`,
  }
}

function hashPathFor(navType: NavType, target: string): string {
  switch (navType) {
    case 'room':
      return `#/rooms/${encodeURIComponent(target)}`
    case 'contact-request':
      // Pending requests are listed at the top of the contact list.
      return '#/contacts'
    case 'room-invitation':
      // Invitations are listed at the top of the room list.
      return '#/rooms'
    case 'voice-request':
      return `#/rooms/${encodeURIComponent(voiceRequestRoom(target))}`
    case 'conversation':
      return `#/messages/${encodeURIComponent(target)}`
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
    navigateToContactRequests?: () => void
    navigateToRoomInvitations?: () => void
  },
): boolean {
  if (!data || typeof data !== 'object') return false
  const msg = data as Partial<NotificationNavigateMessage>
  if (msg.type !== NOTIFICATION_NAVIGATE || typeof msg.target !== 'string') return false
  routeNotificationTarget(msg.navType, msg.target, {
    navigateToConversation: (jid) => handlers.navigateToConversation(jid),
    navigateToRoom: (jid) => handlers.navigateToRoom(jid),
    navigateToContactRequests: () => handlers.navigateToContactRequests?.(),
    navigateToRoomInvitations: () => handlers.navigateToRoomInvitations?.(),
  })
  return true
}
