import { getBareJid } from '@fluux/sdk'

/** Where a tapped push notification leads, in the terms of `routeNotificationTarget`. */
export interface PushTapTarget {
  navType: 'conversation' | 'room'
  navTarget: string
}

/**
 * Reads the conversation a remote notification is about from its APNs
 * payload. The push app server puts the sender's JID in `from`; a room
 * message carries the room JID, possibly with the occupant's nickname.
 */
export function pushTapTarget(
  payload: Record<string, unknown> | null | undefined,
  isRoom: (jid: string) => boolean,
): PushTapTarget | null {
  const from = payload?.from
  if (typeof from !== 'string' || !from.includes('@')) return null
  const jid = getBareJid(from)
  return { navType: isRoom(jid) ? 'room' : 'conversation', navTarget: jid }
}
