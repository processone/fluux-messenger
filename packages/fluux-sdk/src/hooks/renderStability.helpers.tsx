/**
 * Shared test utilities for render stability tests.
 *
 * These helpers enable asserting that hooks re-render the correct
 * number of times under various store update scenarios.
 */
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { XMPPProvider } from '../provider'
import type { Conversation, Message, Room, Contact } from '../core'
import type { RoomMessage, PresenceStatus } from '../core/types'

/**
 * React hook that tracks how many times a component has rendered.
 * Place inside a test hook to count renders.
 */
export function useRenderCount(): number {
  const countRef = useRef(0)
  countRef.current += 1
  return countRef.current
}

/**
 * Wrapper component providing XMPPProvider context for hook tests.
 */
export function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

/**
 * Create a test conversation with sensible defaults.
 */
export function createConversation(id: string, options: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name: options.name ?? id.split('@')[0],
    type: options.type ?? 'chat',
    unreadCount: options.unreadCount ?? 0,
    lastMessage: options.lastMessage,
    lastReadAt: options.lastReadAt,
    lastSeenMessageId: options.lastSeenMessageId,
    firstNewMessageId: options.firstNewMessageId,
  }
}

/**
 * Create a test message for a 1:1 conversation.
 */
export function createMessage(
  conversationId: string,
  body: string,
  options: Partial<Message> = {}
): Message {
  const id = options.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    type: 'chat',
    id,
    conversationId,
    from: options.from ?? conversationId,
    body,
    timestamp: options.timestamp ?? new Date(),
    isOutgoing: options.isOutgoing ?? false,
  }
}

/**
 * Create a test room with sensible defaults.
 */
export function createRoom(jid: string, options: Partial<Room> = {}): Room {
  return {
    jid,
    name: options.name ?? jid.split('@')[0],
    nickname: options.nickname ?? 'testuser',
    joined: options.joined ?? false,
    isBookmarked: options.isBookmarked ?? false,
    autojoin: options.autojoin,
    password: options.password,
    occupants: options.occupants ?? new Map(),
    messages: options.messages ?? [],
    unreadCount: options.unreadCount ?? 0,
    mentionsCount: options.mentionsCount ?? 0,
    typingUsers: options.typingUsers ?? new Set(),
  }
}

/**
 * Create a test room message.
 */
export function createRoomMessage(
  roomJid: string,
  nick: string,
  body: string,
  options: Partial<RoomMessage> = {}
): RoomMessage {
  const id = options.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    type: 'groupchat',
    id,
    roomJid,
    from: `${roomJid}/${nick}`,
    nick,
    body,
    timestamp: options.timestamp ?? new Date(),
    isOutgoing: options.isOutgoing ?? false,
  }
}

/**
 * Create a test contact with sensible defaults.
 */
export function createContact(jid: string, options: Partial<Contact> = {}): Contact {
  return {
    jid,
    name: options.name ?? jid.split('@')[0],
    presence: options.presence ?? ('offline' as PresenceStatus),
    subscription: options.subscription ?? 'both',
    statusMessage: options.statusMessage,
    groups: options.groups,
  } as Contact
}

/**
 * Generate N test rooms with sequential JIDs.
 */
export function generateRooms(count: number, options: Partial<Room> = {}): Room[] {
  return Array.from({ length: count }, (_, i) =>
    createRoom(`room-${String(i).padStart(3, '0')}@conference.example.com`, {
      ...options,
      name: `Room ${i}`,
    })
  )
}

/**
 * Generate N test conversations with sequential JIDs.
 */
export function generateConversations(count: number, options: Partial<Conversation> = {}): Conversation[] {
  return Array.from({ length: count }, (_, i) =>
    createConversation(`user-${String(i).padStart(3, '0')}@example.com`, {
      ...options,
      name: `User ${i}`,
    })
  )
}

/**
 * Generate N test contacts with sequential JIDs.
 */
export function generateContacts(count: number, options: Partial<Contact> = {}): Contact[] {
  return Array.from({ length: count }, (_, i) =>
    createContact(`contact-${String(i).padStart(3, '0')}@example.com`, {
      ...options,
      name: `Contact ${i}`,
    })
  )
}
