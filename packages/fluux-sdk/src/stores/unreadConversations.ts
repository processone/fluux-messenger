/**
 * The conversations the app icon badge counts, with what a widget shows of each.
 *
 * Follows the badge's rule through {@link roomSelectors.roomsWithUnread}, so the
 * list and the badge cannot disagree: a chat with unread messages, a joined room
 * with a mention, or a joined room set to notify on every message and unread.
 *
 * @module Stores/UnreadConversations
 */

import type { Conversation } from '../core/types'
import { roomSelectors } from './roomSelectors'
import type { RoomState } from './roomStore'

/** One row of the unread list. */
export interface UnreadConversation {
  /** Bare JID of the contact or room. */
  id: string
  kind: 'chat' | 'groupchat'
  name: string
  unreadCount: number
  mentionsCount: number
  /** Time of the latest message, in milliseconds since the epoch; 0 when unknown. */
  lastActivity: number
}

/**
 * Pure selector over the chat and room state. Newest activity first; ties keep
 * the order of their ids so the result is stable.
 */
export function unreadConversations(
  conversations: Iterable<Pick<Conversation, 'id' | 'name' | 'unreadCount'> & { lastMessage?: { timestamp?: Date } }>,
  rooms: RoomState,
): UnreadConversation[] {
  const rows: UnreadConversation[] = []
  for (const conversation of conversations) {
    if (conversation.unreadCount <= 0) continue
    rows.push({
      id: conversation.id,
      kind: 'chat',
      name: conversation.name,
      unreadCount: conversation.unreadCount,
      mentionsCount: 0,
      lastActivity: conversation.lastMessage?.timestamp?.getTime() ?? 0,
    })
  }
  for (const jid of roomSelectors.roomsWithUnread(rooms)) {
    const entity = rooms.roomEntities.get(jid)
    const meta = rooms.roomMeta.get(jid)
    if (!entity || !meta) continue
    rows.push({
      id: jid,
      kind: 'groupchat',
      name: entity.name,
      unreadCount: meta.unreadCount,
      mentionsCount: meta.mentionsCount,
      lastActivity: (meta.lastMessage?.timestamp ?? meta.lastInteractedAt)?.getTime() ?? 0,
    })
  }
  return rows.sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id))
}
