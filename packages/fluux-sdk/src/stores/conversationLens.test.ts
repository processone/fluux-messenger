import { describe, it, expect, beforeEach } from 'vitest'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import {
  conversationKind,
  conversationMessages,
  conversationMetadata,
  conversationLastMessage,
  conversationIds,
} from './conversationLens'
import type { Conversation, Message } from '../core/types'
import { createRoom, createMessage } from './roomStore.testHelpers'

const CHAT = 'alice@example.com'
const ROOM = 'team@conference.example.com'

function chatMessage(id: string, at: number): Message {
  return {
    type: 'chat',
    id,
    conversationId: CHAT,
    from: CHAT,
    body: id,
    timestamp: new Date(at),
    isOutgoing: false,
  }
}

function conversation(id: string, extra: Partial<Conversation> = {}): Conversation {
  return { id, name: id, type: 'chat', unreadCount: 0, ...extra }
}

describe('conversationLens', () => {
  beforeEach(() => {
    chatStore.setState({
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
    })
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(),
      messages: new Map(), windowAtLiveEdge: new Map(), activeRoomJid: null,
      firstNewMessageMarkers: new Map(),
    })
  })

  describe('conversationKind', () => {
    it('names the store that owns the id', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      chatStore.getState().addConversation(conversation(CHAT))

      expect(conversationKind(ROOM)).toBe('room')
      expect(conversationKind(CHAT)).toBe('chat')
    })

    it('is undefined for an id neither store knows', () => {
      // Bookmarks load late, so an unclassifiable id is "not yet known" — a
      // caller must not read it as 1:1.
      expect(conversationKind('nobody@example.com')).toBeUndefined()
    })
  })

  describe('conversationMessages', () => {
    it('reads the window of whichever store owns the id', () => {
      const resident = [createMessage('r1', ROOM, 'alice', 'hello')]
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }), resident)
      chatStore.getState().addConversation(conversation(CHAT))
      chatStore.getState().addMessage(chatMessage('c1', 1000))

      expect(conversationMessages(ROOM).map((m) => m.id)).toEqual(['r1'])
      expect(conversationMessages(CHAT).map((m) => m.id)).toEqual(['c1'])
    })

    it('hands back the same empty array for a conversation with no window', () => {
      // A fresh array per call would re-render every subscriber for nothing.
      expect(conversationMessages('unknown@example.com')).toBe(conversationMessages(CHAT))
    })
  })

  describe('conversationMetadata', () => {
    it('reads the split map for both kinds', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.setState((s) => ({
        roomMeta: new Map(s.roomMeta).set(ROOM, { ...s.roomMeta.get(ROOM)!, unreadCount: 4 }),
      }))
      chatStore.getState().addConversation(conversation(CHAT))
      chatStore.setState((s) => ({
        conversationMeta: new Map(s.conversationMeta).set(CHAT, {
          ...s.conversationMeta.get(CHAT)!,
          unreadCount: 7,
        }),
      }))

      expect(conversationMetadata(ROOM)?.unreadCount).toBe(4)
      expect(conversationMetadata(CHAT)?.unreadCount).toBe(7)
    })

    it('falls back to the combined entry when the split map has no row', () => {
      // The persist middleware rehydrates the combined map; a room from a
      // bookmark has an entry there before `roomMeta` is written.
      roomStore.setState((s) => ({
        rooms: new Map(s.rooms).set(ROOM, createRoom(ROOM, { joined: true, unreadCount: 3 })),
      }))

      expect(roomStore.getState().roomMeta.has(ROOM)).toBe(false)
      expect(conversationMetadata(ROOM)?.unreadCount).toBe(3)
    })

    it('is undefined for an id neither store knows', () => {
      expect(conversationMetadata('nobody@example.com')).toBeUndefined()
    })
  })

  describe('conversationLastMessage', () => {
    it('prefers the split map', () => {
      const newest = createMessage('m2', ROOM, 'alice', 'newest')
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.setState((s) => ({
        roomMeta: new Map(s.roomMeta).set(ROOM, { ...s.roomMeta.get(ROOM)!, lastMessage: newest }),
      }))

      expect(conversationLastMessage(ROOM)?.id).toBe('m2')
    })

    it('falls back FIELD-wise, not record-wise', () => {
      // A metadata record can exist carrying no preview while the combined
      // entry still has one — a record-wise `??` would return undefined here.
      const preview = createMessage('m1', ROOM, 'alice', 'preview')
      roomStore.setState((s) => ({
        rooms: new Map(s.rooms).set(ROOM, createRoom(ROOM, { joined: true, lastMessage: preview })),
        roomMeta: new Map(s.roomMeta).set(ROOM, {
          unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>(),
        }),
      }))

      expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage).toBeUndefined()
      expect(conversationLastMessage(ROOM)?.id).toBe('m1')
    })
  })

  describe('conversationIds', () => {
    it('unions 1:1 entities and known rooms', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      chatStore.getState().addConversation(conversation(CHAT))

      expect([...conversationIds()].sort()).toEqual([CHAT, ROOM].sort())
    })
  })
})
