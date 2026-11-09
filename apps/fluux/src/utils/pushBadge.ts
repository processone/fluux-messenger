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
  /** Bare signed-in account; absent only while signed out or for legacy callers. */
  account?: string
  /** Snapshot time shared with the widget, to reject app work queued before a newer push. */
  updated?: number
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

export type BadgeDiagnosticStep = 'issued' | 'acknowledged' | 'rejected'

let shared: string | null = null

/** Sets the badge unless unchanged; `force` rechecks extension-writable state and requires acknowledgement. */
export async function sharePushBadge(state: PushBadgeState, { force = false, observe }: {
  force?: boolean
  observe?: (step: BadgeDiagnosticStep) => void
} = {}): Promise<void> {
  const note = (step: BadgeDiagnosticStep) => { try { observe?.(step) } catch { /* Diagnostics never control publication. */ } }
  const serialized = JSON.stringify(state)
  if (!force && serialized === shared) return
  shared = serialized
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    note('issued')
    await invoke('plugin:push|set_badge', { badge: state })
    note('acknowledged')
  } catch (err) {
    note('rejected')
    shared = null
    console.warn('[NativePush] Badge not set:', err)
    if (force) throw err
  }
}

/** Forgets what was last shared, so the next state is sent. For tests. */
export function resetSharedPushBadge(): void {
  shared = null
}
