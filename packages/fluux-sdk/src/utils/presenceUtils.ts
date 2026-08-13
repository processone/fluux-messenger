import type { PresenceShow, PresenceStatus } from '../core/types'

/**
 * Get presence rank for comparison (lower = more available)
 * Order: chat (0) > online (1) > away (2) > xa (3) > dnd (4)
 *
 * Used to determine the "best" presence when a user has multiple connections
 * or resources. The most available presence wins on priority ties.
 */
export function getPresenceRank(show: PresenceShow | null | undefined): number {
  if (show === 'chat') return 0
  if (show === null || show === undefined) return 1  // online
  if (show === 'away') return 2
  if (show === 'xa') return 3
  if (show === 'dnd') return 4
  return 5
}

/**
 * Get the best (most available) presence from an array of presence show values.
 * Returns the show value with the lowest rank (most available).
 *
 * @param showValues - Array of presence show values to compare
 * @returns The most available presence show value
 */
export function getBestPresenceShow(showValues: (PresenceShow | null | undefined)[]): PresenceShow | undefined {
  if (showValues.length === 0) return undefined

  let best: PresenceShow | null | undefined = showValues[0]
  let bestRank = getPresenceRank(best)

  for (let i = 1; i < showValues.length; i++) {
    const rank = getPresenceRank(showValues[i])
    if (rank < bestRank) {
      bestRank = rank
      best = showValues[i]
    }
  }

  // Convert null to undefined for consistency (both mean "online")
  return best === null ? undefined : best
}

/**
 * Convert PresenceShow to simplified PresenceStatus for available users.
 *
 * **Important**: This function is for converting the `<show>` element from
 * AVAILABLE presence stanzas only. It does NOT handle offline state.
 *
 * In XMPP, "offline" is indicated by `type="unavailable"` on the presence
 * stanza itself, not by the `<show>` element. The `<show>` element only
 * exists in available presence to indicate sub-states of being online:
 *
 * - null/undefined: plain "available" (no show element) → 'online'
 * - 'chat': "free to chat" (eager to communicate) → 'online'
 * - 'away': temporarily away → 'away'
 * - 'xa': extended away (gone for longer) → 'away'
 * - 'dnd': do not disturb → 'dnd'
 *
 * To determine if a contact is offline, check if you've received an
 * unavailable presence or if they have no active resources.
 *
 * @param show - The XMPP presence show value (from an available presence)
 * @returns Simplified presence status: 'online', 'away', or 'dnd' (never 'offline')
 *
 * @example
 * ```typescript
 * import type { Element } from '@fluux/sdk/xmpp'
 *
 * declare const presence: Element
 *
 * // From a presence stanza handler (after checking type !== 'unavailable')
 * const showElement = presence.getChildText('show')
 * const status = getPresenceFromShow(showElement as PresenceShow | null)
 * // status is 'online', 'away', or 'dnd'
 * ```
 */
export function getPresenceFromShow(show: PresenceShow | null | undefined): Exclude<PresenceStatus, 'offline'> {
  if (show === null || show === undefined || show === 'chat') return 'online'
  if (show === 'away' || show === 'xa') return 'away'
  if (show === 'dnd') return 'dnd'
  return 'online'
}
