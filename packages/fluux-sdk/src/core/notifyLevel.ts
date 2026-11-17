/**
 * Per-room notification level.
 *
 * - `mentions` — notify for mentions, @all and replies (the default)
 * - `all` — notify for every message
 * - `none` — Off: no notification, sound or app-icon badge contribution
 *
 * The saved level lives in the room's XEP-0402 bookmark as
 * `<notify xmlns='urn:xmpp:fluux:0'>` inside `<extensions>` (see
 * docs/XEP-ROOM_NOTIFICATIONS.md). A session choice overrides it until the
 * room is left.
 */
export type NotifyLevel = 'none' | 'mentions' | 'all'

/** The fields of a room (or its metadata) that carry a notification choice. */
export interface NotifyLevelFields {
  /** Session-only "all messages" choice (false = explicit Mentions only) */
  notifyAll?: boolean
  /** Session-only Off choice */
  notifyOff?: boolean
  /** Saved "all messages" choice */
  notifyAllPersistent?: boolean
  /** Saved Off choice */
  notifyOffPersistent?: boolean
}

/** Parse the text of a `<notify>` bookmark extension; unknown values mean Mentions only. */
export function parseNotifyLevel(text: string | undefined | null): NotifyLevel {
  return text === 'all' || text === 'none' ? text : 'mentions'
}

/** The level saved for the room (bookmark), ignoring any session choice. */
export function savedNotifyLevel(room: NotifyLevelFields | undefined): NotifyLevel {
  if (room?.notifyOffPersistent) return 'none'
  return room?.notifyAllPersistent ? 'all' : 'mentions'
}

/**
 * The level in effect for a room: session choice, then saved choice, then
 * Mentions only. Every reader (notifications, sound, badges, unread tone,
 * menu) goes through this function.
 */
export function resolveNotifyLevel(room: NotifyLevelFields | undefined): NotifyLevel {
  if (!room) return 'mentions'
  if (room.notifyOff) return 'none'
  if (room.notifyAll !== undefined) return room.notifyAll ? 'all' : 'mentions'
  return savedNotifyLevel(room)
}

/** Room fields to set when choosing `level`; a saved choice clears the session choice. */
export function notifyLevelUpdates(level: NotifyLevel, persistent: boolean): NotifyLevelFields {
  if (persistent) {
    return {
      notifyAll: undefined,
      notifyOff: undefined,
      notifyAllPersistent: level === 'all',
      notifyOffPersistent: level === 'none',
    }
  }
  return { notifyAll: level === 'all', notifyOff: level === 'none' ? true : undefined }
}

/** Counts a room's unread messages toward notifiable totals only when it notifies for all messages. */
export function notifiesForAllMessages(room: NotifyLevelFields | undefined): boolean {
  return resolveNotifyLevel(room) === 'all'
}

/**
 * Does the room count toward the app-icon badge / unread-rooms count?
 * An Off room never does, mentions included.
 */
export function hasBadgeActivity(room: NotifyLevelFields & { mentionsCount: number; unreadCount: number }): boolean {
  const level = resolveNotifyLevel(room)
  if (level === 'none') return false
  return room.mentionsCount > 0 || (level === 'all' && room.unreadCount > 0)
}

/**
 * Level to judge a just-arrived room message with. A message whose content is
 * not readable yet is held for every room except an Off one, so a mention
 * sealed in an encrypted payload can still be detected once recovered.
 */
export function notifyLevelForArrival(room: NotifyLevelFields, ready: boolean): NotifyLevel {
  const level = resolveNotifyLevel(room)
  return ready || level === 'none' ? level : 'all'
}
