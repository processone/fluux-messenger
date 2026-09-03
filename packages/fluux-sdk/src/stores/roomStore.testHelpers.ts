/**
 * Fixture builders shared by the roomStore suites.
 *
 * Extracted from `roomStore.test.ts` rather than duplicated: two suites now
 * need them, and importing across `.test.ts` files would couple the suites.
 * The precedent is `core/sideEffects.testHelpers.ts`.
 */

import type { Room, RoomMessage } from '../core/types'
import { getLocalPart } from '../core/jid'
import { roomStore } from './roomStore'

/** Helper to create test rooms */
export function createRoom(jid: string, options: Partial<Room> = {}): Room {
  return {
    jid,
    name: options.name || getLocalPart(jid),
    nickname: options.nickname || 'testuser',
    joined: options.joined ?? false,
    isBookmarked: options.isBookmarked ?? false,
    isQuickChat: options.isQuickChat,
    autojoin: options.autojoin,
    password: options.password,
    occupants: options.occupants || new Map(),
    unreadCount: options.unreadCount || 0,
    mentionsCount: options.mentionsCount || 0,
    subject: options.subject,
    selfOccupant: options.selfOccupant,
    typingUsers: options.typingUsers || new Set(),
    readPointer: options.readPointer,
    notifyAll: options.notifyAll,
    notifyAllPersistent: options.notifyAllPersistent,
    lastInteractedAt: options.lastInteractedAt,
    lastMessage: options.lastMessage,
    muted: options.muted,
  }
}

/**
 * Helper to create test messages.
 *
 * `timestamp` defaults to `new Date()` for the existing call sites, but pass it
 * EXPLICITLY whenever a test advances a read pointer across two messages.
 *
 * NOT because a same-millisecond pair can never advance. Two EXACT positions
 * sharing a millisecond break the tie on the cache order key: `isAhead` (shared/readPointer.ts) does
 * it, and `advanceReadPointer` routes through `onMessageSeen`'s exact-order
 * `mayAdvanceTo`, which does it too. The bare "equal timestamps are NOT an
 * advance" rule now applies ONLY when either side is a FLOOR — i.e. a pointer
 * migrated from the pre-#1081 `lastSeenMessageId` + `lastReadAt` pair, whose
 * timestamp cannot certify its own position.
 *
 * The reason to be explicit is that these occupant-less fixtures use the first
 * two rungs of the ROOM tie-break, `(from, id, occupantId)`. Under fake timers
 * `new Date()` returns the same instant every call, so the order of two
 * same-instant messages is then decided by sender JID and, for one sender, by
 * LEXICOGRAPHIC id — 'msg-10' sorts before 'msg-2'. Distinct timestamps keep the
 * fixture's intended order the one the pointer actually sees.
 */
export function createMessage(
  id: string,
  roomJid: string,
  nick: string,
  body: string,
  isOutgoing = false,
  timestamp: Date = new Date()
): RoomMessage {
  return {
    type: 'groupchat',
    id,
    roomJid,
    from: `${roomJid}/${nick}`,
    nick,
    body,
    timestamp,
    isOutgoing,
  }
}

/**
 * The room's resident message window. The store keeps it in `messages`, keyed
 * by room JID; the room entry itself carries no timeline.
 */
export function roomWindow(jid: string): RoomMessage[] {
  return roomStore.getState().messages.get(jid) ?? []
}

/** Seed a room's resident window on an entry that already exists. */
export function seedRoomWindow(jid: string, messages: RoomMessage[]): void {
  roomStore.setState((s) => ({ messages: new Map(s.messages).set(jid, messages) }))
}
