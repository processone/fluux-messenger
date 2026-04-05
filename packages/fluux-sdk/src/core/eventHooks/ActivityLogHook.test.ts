import { describe, it, expect, beforeEach } from 'vitest'
import { localStorageMock } from '../sideEffects.testHelpers'

// Mock localStorage before importing stores (roomStore.reset() calls localStorage.removeItem)
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { ActivityLogHook } from './ActivityLogHook'
import { activityLogStore } from '../../stores/activityLogStore'
import { chatStore } from '../../stores/chatStore'
import { roomStore } from '../../stores/roomStore'
import { connectionStore } from '../../stores/connectionStore'
import type { ReactionReceivedPayload } from '../types/activity'
import type { Message } from '../types/chat'
import type { RoomMessage } from '../types/room'
import type { XMPPClient } from '../XMPPClient'
import type { SDKEvents, SDKEventHandler } from '../types/sdk-events'

// ---------------------------------------------------------------------------
// Mock XMPPClient — captures event subscriptions so we can fire them in tests
// ---------------------------------------------------------------------------

type HandlerMap = Map<keyof SDKEvents, Set<SDKEventHandler<keyof SDKEvents>>>

function createMockClient(): XMPPClient & { fire: <K extends keyof SDKEvents>(event: K, data: SDKEvents[K]) => void } {
  const handlers: HandlerMap = new Map()

  const client = {
    subscribe<K extends keyof SDKEvents>(event: K, handler: SDKEventHandler<K>): () => void {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(handler as SDKEventHandler<keyof SDKEvents>)
      return () => handlers.get(event)?.delete(handler as SDKEventHandler<keyof SDKEvents>)
    },
    fire<K extends keyof SDKEvents>(event: K, data: SDKEvents[K]): void {
      for (const h of handlers.get(event) ?? []) {
        (h as SDKEventHandler<K>)(data)
      }
    },
  }
  return client as unknown as XMPPClient & { fire: <K extends keyof SDKEvents>(event: K, data: SDKEvents[K]) => void }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MY_JID = 'me@example.com'

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    from: 'other@example.com',
    body: 'Hello world',
    timestamp: new Date(),
    isOutgoing: true,
    ...overrides,
  } as Message
}

function makeRoomMessage(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: 'room-msg-1',
    from: 'room@conference.example.com/nick',
    nick: 'me',
    body: 'Room message',
    timestamp: new Date(),
    ...overrides,
  } as RoomMessage
}

function getLastReactionPayload(): ReactionReceivedPayload | undefined {
  const events = activityLogStore.getState().events
  const reactionEvent = events.find((e) => e.type === 'reaction-received')
  return reactionEvent?.payload as ReactionReceivedPayload | undefined
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityLogHook', () => {
  let client: ReturnType<typeof createMockClient>
  let hook: ActivityLogHook

  beforeEach(() => {
    activityLogStore.getState().reset()
    chatStore.getState().reset()
    roomStore.getState().reset()
    connectionStore.setState({ jid: MY_JID })

    client = createMockClient()
    hook = new ActivityLogHook(client)
    hook.onload()
  })

  describe('chat:reactions — regular messages', () => {
    it('creates a reaction event for outgoing messages', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true, body: 'Test message' })
      chatStore.getState().messages.set('alice@example.com', [message])

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
      })

      const payload = getLastReactionPayload()
      expect(payload).toBeDefined()
      expect(payload!.conversationId).toBe('alice@example.com')
      expect(payload!.messageId).toBe('msg-1')
      expect(payload!.reactors).toEqual([{ reactorJid: 'alice@example.com', emojis: ['👍'] }])
      expect(payload!.messagePreview).toBe('Test message')
      expect(payload!.pollTitle).toBeUndefined()
    })

    it('ignores reactions to non-outgoing messages', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: false })
      chatStore.getState().messages.set('alice@example.com', [message])

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
      })

      expect(activityLogStore.getState().events).toHaveLength(0)
    })

    it('ignores own reactions', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true })
      chatStore.getState().messages.set('alice@example.com', [message])

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: MY_JID,
        emojis: ['👍'],
      })

      expect(activityLogStore.getState().events).toHaveLength(0)
    })

    it('ignores empty emoji arrays', () => {
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: [],
      })

      expect(activityLogStore.getState().events).toHaveLength(0)
    })

    it('includes pollTitle for poll messages', () => {
      const message = makeMessage({
        id: 'poll-msg-1',
        isOutgoing: true,
        body: 'What should we do?',
        poll: {
          title: 'Friday lunch',
          options: [
            { emoji: '1️⃣', label: 'Pizza' },
            { emoji: '2️⃣', label: 'Sushi' },
          ],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
        },
      })
      chatStore.getState().messages.set('alice@example.com', [message])

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'poll-msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['1️⃣'],
      })

      const payload = getLastReactionPayload()
      expect(payload).toBeDefined()
      expect(payload!.pollTitle).toBe('Friday lunch')
    })

    it('does not set pollTitle for non-poll messages', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true, body: 'Nice!' })
      chatStore.getState().messages.set('alice@example.com', [message])

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['❤️'],
      })

      const payload = getLastReactionPayload()
      expect(payload!.pollTitle).toBeUndefined()
    })

    it('groups multiple reactors on the same message', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true, body: 'Hello' })
      chatStore.getState().messages.set('alice@example.com', [message])

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
      })
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'bob@example.com',
        emojis: ['❤️'],
      })

      // Should have exactly 1 event (grouped), not 2
      const reactionEvents = activityLogStore.getState().events.filter((e) => e.type === 'reaction-received')
      expect(reactionEvents).toHaveLength(1)

      const payload = reactionEvents[0].payload as ReactionReceivedPayload
      expect(payload.reactors).toHaveLength(2)
      expect(payload.reactors[0]).toEqual({ reactorJid: 'alice@example.com', emojis: ['👍'] })
      expect(payload.reactors[1]).toEqual({ reactorJid: 'bob@example.com', emojis: ['❤️'] })
    })

    it('preserves pollTitle when grouping reactions', () => {
      const message = makeMessage({
        id: 'poll-msg-1',
        isOutgoing: true,
        poll: { title: 'Team outing', options: [{ emoji: '1️⃣', label: 'Park' }, { emoji: '2️⃣', label: 'Beach' }], settings: { allowMultiple: false, hideResultsBeforeVote: false } },
      })
      chatStore.getState().messages.set('alice@example.com', [message])

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'poll-msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['1️⃣'],
      })
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'poll-msg-1',
        reactorJid: 'bob@example.com',
        emojis: ['2️⃣'],
      })

      const payload = getLastReactionPayload()
      expect(payload!.pollTitle).toBe('Team outing')
      expect(payload!.reactors).toHaveLength(2)
    })
  })

  describe('room:reactions', () => {
    beforeEach(() => {
      // Set up a room with our nickname
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Dev Room',
        nickname: 'me',
        joined: true,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        occupants: new Map(),
        messages: [],
      })
    })

    it('creates a reaction event for own room messages', () => {
      const message = makeRoomMessage({ id: 'room-msg-1', nick: 'me', body: 'My room message' })
      roomStore.getState().addMessage('room@conference.example.com', message)

      client.fire('room:reactions', {
        roomJid: 'room@conference.example.com',
        messageId: 'room-msg-1',
        reactorNick: 'alice',
        emojis: ['👍'],
      })

      const payload = getLastReactionPayload()
      expect(payload).toBeDefined()
      expect(payload!.conversationId).toBe('room@conference.example.com')
      expect(payload!.reactors).toEqual([{ reactorJid: 'alice', emojis: ['👍'] }])
      expect(payload!.pollTitle).toBeUndefined()
    })

    it('ignores reactions to other people\'s messages', () => {
      const message = makeRoomMessage({ id: 'room-msg-1', nick: 'someone-else' })
      roomStore.getState().addMessage('room@conference.example.com', message)

      client.fire('room:reactions', {
        roomJid: 'room@conference.example.com',
        messageId: 'room-msg-1',
        reactorNick: 'alice',
        emojis: ['👍'],
      })

      expect(activityLogStore.getState().events).toHaveLength(0)
    })

    it('ignores own reactions in rooms', () => {
      const message = makeRoomMessage({ id: 'room-msg-1', nick: 'me' })
      roomStore.getState().addMessage('room@conference.example.com', message)

      client.fire('room:reactions', {
        roomJid: 'room@conference.example.com',
        messageId: 'room-msg-1',
        reactorNick: 'me',
        emojis: ['👍'],
      })

      expect(activityLogStore.getState().events).toHaveLength(0)
    })

    it('includes pollTitle for poll messages in rooms', () => {
      const message = makeRoomMessage({
        id: 'room-poll-1',
        nick: 'me',
        body: 'Vote now!',
        poll: {
          title: 'Meeting time',
          options: [{ emoji: '1️⃣', label: '10am' }, { emoji: '2️⃣', label: '2pm' }],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
        },
      })
      roomStore.getState().addMessage('room@conference.example.com', message)

      client.fire('room:reactions', {
        roomJid: 'room@conference.example.com',
        messageId: 'room-poll-1',
        reactorNick: 'alice',
        emojis: ['1️⃣'],
      })

      const payload = getLastReactionPayload()
      expect(payload).toBeDefined()
      expect(payload!.pollTitle).toBe('Meeting time')
    })
  })

  describe('reaction timestamps', () => {
    it('uses the event timestamp when provided (e.g. from XEP-0203 delay)', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true, body: 'Test' })
      chatStore.getState().messages.set('alice@example.com', [message])

      const sentAt = new Date('2024-01-15T10:00:00Z')
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
        timestamp: sentAt,
      })

      const event = activityLogStore.getState().events.find((e) => e.type === 'reaction-received')
      expect(event).toBeDefined()
      expect(event!.timestamp).toEqual(sentAt)
    })

    it('falls back to current time when no timestamp is provided', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true, body: 'Test' })
      chatStore.getState().messages.set('alice@example.com', [message])

      const before = new Date()
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
      })
      const after = new Date()

      const event = activityLogStore.getState().events.find((e) => e.type === 'reaction-received')
      expect(event).toBeDefined()
      expect(event!.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(event!.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('advances the grouped event timestamp to the latest reaction in the group', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true, body: 'Test' })
      chatStore.getState().messages.set('alice@example.com', [message])

      const older = new Date('2024-01-15T10:00:00Z')
      const newer = new Date('2024-01-15T11:00:00Z')

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
        timestamp: older,
      })
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'bob@example.com',
        emojis: ['❤️'],
        timestamp: newer,
      })

      const event = activityLogStore.getState().events.find((e) => e.type === 'reaction-received')
      expect(event).toBeDefined()
      expect(event!.timestamp).toEqual(newer)
    })

    it('keeps the existing event timestamp when a later reaction has an older timestamp', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true, body: 'Test' })
      chatStore.getState().messages.set('alice@example.com', [message])

      const newer = new Date('2024-01-15T11:00:00Z')
      const older = new Date('2024-01-15T10:00:00Z')

      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
        timestamp: newer,
      })
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'bob@example.com',
        emojis: ['❤️'],
        timestamp: older,
      })

      const event = activityLogStore.getState().events.find((e) => e.type === 'reaction-received')
      expect(event).toBeDefined()
      expect(event!.timestamp).toEqual(newer)
    })
  })

  describe('cleanup', () => {
    it('unsubscribes all handlers on unload', () => {
      const message = makeMessage({ id: 'msg-1', isOutgoing: true })
      chatStore.getState().messages.set('alice@example.com', [message])

      hook.onunload()

      // Fire after unload — should not create any events
      client.fire('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-1',
        reactorJid: 'alice@example.com',
        emojis: ['👍'],
      })

      expect(activityLogStore.getState().events).toHaveLength(0)
    })
  })
})
