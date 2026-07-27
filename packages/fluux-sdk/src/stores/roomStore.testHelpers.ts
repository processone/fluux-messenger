/**
 * Fixture builders shared by the roomStore suites.
 *
 * Extracted from `roomStore.test.ts` rather than duplicated: two suites now
 * need them, and importing across `.test.ts` files would couple the suites.
 * The precedent is `core/sideEffects.testHelpers.ts`.
 */

import type { Room, RoomMessage } from '../core/types'
import { getLocalPart } from '../core/jid'

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
    messages: options.messages || [],
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
 * `isAhead` (shared/readPointer.ts:63) treats equal timestamps as NOT an
 * advance — deliberately, since MAM archives routinely put siblings in one
 * millisecond — and under fake timers `new Date()` returns the same instant
 * every call. Two same-instant messages make the second `advanceReadPointer` a
 * silent no-op that never persists.
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
