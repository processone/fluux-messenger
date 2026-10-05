import { roomSelectors } from '@fluux/sdk'
import type { Conversation } from '@fluux/sdk'

type RoomState = Parameters<typeof roomSelectors.roomsWithUnread>[0]

/**
 * What the iOS app icon badge counts, shared with the notification service
 * extension so pushes can raise it while the app is suspended.
 *
 * The badge is `unread.length + events`. A push from a conversation not yet in
 * `unread` adds it, unless it comes from a room outside `notifyAllRooms`: those
 * count only on a mention, which the push does not reveal.
 */
export interface PushBadgeState {
  /** Conversations and rooms counted in the badge. */
  unread: string[]
  /** Pending events (subscription requests, invitations, ...). */
  events: number
  /** Joined rooms where every message counts, not only mentions. */
  notifyAllRooms: string[]
}

export function pushBadgeState(
  conversations: Iterable<Pick<Conversation, 'id' | 'unreadCount'>>,
  rooms: RoomState,
  events: number,
): PushBadgeState {
  const unread: string[] = []
  for (const conversation of conversations) {
    if (conversation.unreadCount > 0) unread.push(conversation.id)
  }
  unread.push(...roomSelectors.roomsWithUnread(rooms))

  const notifyAllRooms: string[] = []
  for (const [jid, entity] of rooms.roomEntities) {
    const meta = rooms.roomMeta.get(jid)
    if (entity.joined && (meta?.notifyAll || meta?.notifyAllPersistent)) notifyAllRooms.push(jid)
  }

  return { unread, events, notifyAllRooms }
}

let shared: string | null = null

/** Sets the app icon badge and shares its state, unless it is unchanged. */
export async function sharePushBadge(state: PushBadgeState): Promise<void> {
  const serialized = JSON.stringify(state)
  if (serialized === shared) return
  shared = serialized
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:push|set_badge', { badge: state })
  } catch (err) {
    shared = null
    console.warn('[NativePush] Badge not set:', err)
  }
}

/** Forgets what was last shared, so the next state is sent. For tests. */
export function resetSharedPushBadge(): void {
  shared = null
}
