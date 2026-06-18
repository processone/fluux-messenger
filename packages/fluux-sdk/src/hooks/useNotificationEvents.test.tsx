/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useNotificationEvents } from './useNotificationEvents'

// Store subscribers
let chatStoreSubscribers: Array<(state: unknown) => void> = []
let roomStoreSubscribers: Array<(state: unknown) => void> = []

// Mock store state
const mockConversations = new Map()
let mockActiveConversationId: string | null = null
const mockRooms = new Map()
let mockActiveRoomJid: string | null = null
let mockWindowVisible = false

// Helper to trigger store subscriptions
const triggerChatStoreUpdate = () => {
  const state = {
    conversations: mockConversations,
    activeConversationId: mockActiveConversationId,
  }
  chatStoreSubscribers.forEach(sub => sub(state))
}

const triggerRoomStoreUpdate = () => {
  const state = {
    rooms: mockRooms,
    activeRoomJid: mockActiveRoomJid,
    allRooms: () => Array.from(mockRooms.values()),
  }
  roomStoreSubscribers.forEach(sub => sub(state))
}

// Mock the SDK stores
vi.mock('../stores', () => ({
  chatStore: {
    subscribe: (callback: (state: unknown) => void) => {
      chatStoreSubscribers.push(callback)
      return () => {
        chatStoreSubscribers = chatStoreSubscribers.filter(sub => sub !== callback)
      }
    },
  },
  roomStore: {
    subscribe: (callback: (state: unknown) => void) => {
      roomStoreSubscribers.push(callback)
      return () => {
        roomStoreSubscribers = roomStoreSubscribers.filter(sub => sub !== callback)
      }
    },
  },
  connectionStore: {
    getState: () => ({ windowVisible: mockWindowVisible }),
  },
}))

describe('useNotificationEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockConversations.clear()
    mockRooms.clear()
    mockActiveConversationId = null
    mockActiveRoomJid = null
    mockWindowVisible = false
    chatStoreSubscribers = []
    roomStoreSubscribers = []
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  describe('room message freshness checks', () => {
    it('should not notify for messages older than 5 minutes even if isDelayed is not set', () => {
      const onRoomMessage = vi.fn()
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // Add a room with an old message
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/user',
              nick: 'user',
              body: 'Old message without isDelayed',
              timestamp: tenMinutesAgo,
              isOutgoing: false,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Should NOT have notified because the message is too old
      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('should notify for fresh messages (within 5 minutes)', () => {
      const onRoomMessage = vi.fn()
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // First trigger with empty room
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [],
        })
        triggerRoomStoreUpdate()
      })

      // Add a fresh message
      act(() => {
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/user',
              nick: 'user',
              body: 'Fresh message',
              timestamp: twoMinutesAgo,
              isOutgoing: false,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Should have notified because the message is fresh
      expect(onRoomMessage).toHaveBeenCalledOnce()
      expect(onRoomMessage.mock.calls[0][1].body).toBe('Fresh message')
    })

    it('should skip messages with isDelayed set to true', () => {
      const onRoomMessage = vi.fn()
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // First trigger with empty room
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [],
        })
        triggerRoomStoreUpdate()
      })

      // Add a message with isDelayed: true
      act(() => {
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/user',
              nick: 'user',
              body: 'Delayed message',
              timestamp: twoMinutesAgo,
              isOutgoing: false,
              isDelayed: true,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Should NOT have notified because isDelayed is true
      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('should skip initial history load (many messages from empty state)', () => {
      const onRoomMessage = vi.fn()
      const now = new Date()

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // First trigger with empty room
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [],
        })
        triggerRoomStoreUpdate()
      })

      // Add many messages at once (simulating MUC history load)
      act(() => {
        const messages = Array.from({ length: 10 }, (_, i) => ({
          id: `msg${i}`,
          roomJid: 'room@conference.example.com',
          from: 'room@conference.example.com/user',
          nick: 'user',
          body: `Message ${i}`,
          timestamp: new Date(now.getTime() - i * 1000),
          isOutgoing: false,
        }))
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          messages,
        })
        triggerRoomStoreUpdate()
      })

      // Should NOT have notified because this looks like initial history load
      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('should notify for small batches of new messages', () => {
      const onRoomMessage = vi.fn()
      const now = new Date()

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // First trigger with empty room
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [],
        })
        triggerRoomStoreUpdate()
      })

      // Add just 3 messages (below the threshold)
      act(() => {
        const messages = Array.from({ length: 3 }, (_, i) => ({
          id: `msg${i}`,
          roomJid: 'room@conference.example.com',
          from: 'room@conference.example.com/user',
          nick: 'user',
          body: `Message ${i}`,
          timestamp: new Date(now.getTime() - i * 1000),
          isOutgoing: false,
        }))
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          messages,
        })
        triggerRoomStoreUpdate()
      })

      // Should have notified because it's a small batch (3 <= 5)
      expect(onRoomMessage).toHaveBeenCalledOnce()
    })
  })

  describe('conversation message freshness checks', () => {
    it('should notify for an old conversation message that is still unread (no age gate)', () => {
      const onConversationMessage = vi.fn()
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // Add a conversation with an old but unread message
      act(() => {
        mockConversations.set('user@example.com', {
          id: 'user@example.com',
          name: 'Test User',
          unreadCount: 1,
          lastMessage: {
            id: 'msg1',
            conversationId: 'user@example.com',
            from: 'user@example.com',
            body: 'Old message',
            timestamp: tenMinutesAgo,
            isOutgoing: false,
          },
        })
        triggerChatStoreUpdate()
      })

      // Should notify: message age is not a discriminator for 1:1 conversations —
      // an offline-delivered message delivered on reconnect is "new to me"
      expect(onConversationMessage).toHaveBeenCalledOnce()
    })

    it('should notify for fresh conversation messages', () => {
      const onConversationMessage = vi.fn()
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // First trigger with no conversations
      act(() => {
        triggerChatStoreUpdate()
      })

      // Add a conversation with a fresh message
      act(() => {
        mockConversations.set('user@example.com', {
          id: 'user@example.com',
          name: 'Test User',
          unreadCount: 1,
          lastMessage: {
            id: 'msg1',
            conversationId: 'user@example.com',
            from: 'user@example.com',
            body: 'Fresh message',
            timestamp: twoMinutesAgo,
            isOutgoing: false,
          },
        })
        triggerChatStoreUpdate()
      })

      // Should have notified because the message is fresh
      expect(onConversationMessage).toHaveBeenCalledOnce()
    })

    it('should NOT notify for outgoing messages (sent carbons)', () => {
      const onConversationMessage = vi.fn()
      const now = new Date()

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // First trigger with no conversations
      act(() => {
        triggerChatStoreUpdate()
      })

      // Add a conversation with an outgoing message
      act(() => {
        mockConversations.set('user@example.com', {
          id: 'user@example.com',
          name: 'Test User',
          unreadCount: 0,
          lastMessage: {
            id: 'msg1',
            conversationId: 'user@example.com',
            from: 'me@example.com',
            body: 'Message I sent from another device',
            timestamp: now,
            isOutgoing: true,
          },
        })
        triggerChatStoreUpdate()
      })

      // Should NOT have notified because the message is outgoing
      expect(onConversationMessage).not.toHaveBeenCalled()
    })

    it('should NOT notify for outgoing room messages', () => {
      const onRoomMessage = vi.fn()
      const now = new Date()

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // First trigger with empty room
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [],
        })
        triggerRoomStoreUpdate()
      })

      // Add an outgoing message
      act(() => {
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/myNick',
              nick: 'myNick',
              body: 'Message I sent',
              timestamp: now,
              isOutgoing: true,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Should NOT have notified because the message is outgoing
      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('should NOT notify for previous message when sending own message to room', () => {
      const onRoomMessage = vi.fn()
      const now = new Date()
      const oneMinuteAgo = new Date(now.getTime() - 60 * 1000)

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // First trigger with room containing a message from someone else
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/otherUser',
              nick: 'otherUser',
              body: 'Previous message from someone else',
              timestamp: oneMinuteAgo,
              isOutgoing: false,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Clear any initial calls
      onRoomMessage.mockClear()

      // Now I send a message
      act(() => {
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/otherUser',
              nick: 'otherUser',
              body: 'Previous message from someone else',
              timestamp: oneMinuteAgo,
              isOutgoing: false,
            },
            {
              id: 'msg2',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/myNick',
              nick: 'myNick',
              body: 'Message I just sent',
              timestamp: now,
              isOutgoing: true,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Should NOT have notified
      expect(onRoomMessage).not.toHaveBeenCalled()
    })

    it('should notify for new incoming message even when previous messages exist', () => {
      const onRoomMessage = vi.fn()
      const now = new Date()
      const oneMinuteAgo = new Date(now.getTime() - 60 * 1000)
      const twoMinutesAgo = new Date(now.getTime() - 120 * 1000)

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // First trigger with room containing an old message
      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/otherUser',
              nick: 'otherUser',
              body: 'Old message',
              timestamp: twoMinutesAgo,
              isOutgoing: false,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Clear any initial calls
      onRoomMessage.mockClear()

      // Someone else sends a new message
      act(() => {
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          messages: [
            {
              id: 'msg1',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/otherUser',
              nick: 'otherUser',
              body: 'Old message',
              timestamp: twoMinutesAgo,
              isOutgoing: false,
            },
            {
              id: 'msg2',
              roomJid: 'room@conference.example.com',
              from: 'room@conference.example.com/anotherUser',
              nick: 'anotherUser',
              body: 'New message from another user',
              timestamp: oneMinuteAgo,
              isOutgoing: false,
            },
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Should notify about the new incoming message
      expect(onRoomMessage).toHaveBeenCalledOnce()
      expect(onRoomMessage.mock.calls[0][1].body).toBe('New message from another user')
    })
  })

  describe('window visibility', () => {
    it('should NOT notify when window is not visible but conversation has no unread messages', () => {
      const onConversationMessage = vi.fn()
      const now = new Date()
      mockWindowVisible = false
      mockActiveConversationId = 'user@example.com'

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // First trigger with no conversations
      act(() => {
        triggerChatStoreUpdate()
      })

      // Add a conversation with a fresh message (the active one) but unreadCount: 0
      act(() => {
        mockConversations.set('user@example.com', {
          id: 'user@example.com',
          name: 'Test User',
          unreadCount: 0, // No unread — user has already seen this
          lastMessage: {
            id: 'msg1',
            conversationId: 'user@example.com',
            from: 'user@example.com',
            body: 'New message while tab is hidden',
            timestamp: now,
            isOutgoing: false,
          },
        })
        triggerChatStoreUpdate()
      })

      // Should NOT notify because unreadCount is 0 (user has already seen this message)
      expect(onConversationMessage).not.toHaveBeenCalled()
    })

    it('should notify when window is not visible and conversation has unread messages', () => {
      const onConversationMessage = vi.fn()
      const now = new Date()
      mockWindowVisible = false
      mockActiveConversationId = 'user@example.com'

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // First trigger with no conversations
      act(() => {
        triggerChatStoreUpdate()
      })

      // Add a conversation with a fresh message and unreadCount > 0
      act(() => {
        mockConversations.set('user@example.com', {
          id: 'user@example.com',
          name: 'Test User',
          unreadCount: 1, // Has unread messages — user hasn't seen this yet
          lastMessage: {
            id: 'msg1',
            conversationId: 'user@example.com',
            from: 'user@example.com',
            body: 'New message while tab is hidden',
            timestamp: now,
            isOutgoing: false,
          },
        })
        triggerChatStoreUpdate()
      })

      // Should notify because window is not visible and there are unread messages
      expect(onConversationMessage).toHaveBeenCalledOnce()
    })

    it('should NOT notify when window is visible and conversation is active', () => {
      const onConversationMessage = vi.fn()
      const now = new Date()
      mockWindowVisible = true
      mockActiveConversationId = 'user@example.com'

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // First trigger with no conversations
      act(() => {
        triggerChatStoreUpdate()
      })

      // Add a conversation with a fresh message (the active one)
      act(() => {
        mockConversations.set('user@example.com', {
          id: 'user@example.com',
          name: 'Test User',
          unreadCount: 0, // Active conversation, no unread
          lastMessage: {
            id: 'msg1',
            conversationId: 'user@example.com',
            from: 'user@example.com',
            body: 'New message while looking at conversation',
            timestamp: now,
            isOutgoing: false,
          },
        })
        triggerChatStoreUpdate()
      })

      // Should NOT notify because window is visible and conversation is active
      expect(onConversationMessage).not.toHaveBeenCalled()
    })
  })

  describe('conversation reconnect delivery', () => {
    it('notifies for a delayed, unseen incoming message', () => {
      const onConversationMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onConversationMessage }))

      act(() => {
        mockConversations.set('alice@example.com', {
          id: 'alice@example.com',
          name: 'Alice',
          unreadCount: 1,
          lastSeenMessageId: undefined,
          lastMessage: {
            id: 'm1',
            timestamp: new Date(),
            isOutgoing: false,
            isDelayed: true,
            from: 'alice@example.com',
          },
        })
        triggerChatStoreUpdate()
      })

      expect(onConversationMessage).toHaveBeenCalledTimes(1)
    })

    it('does not notify when the latest message is already seen', () => {
      const onConversationMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onConversationMessage }))

      act(() => {
        mockConversations.set('bob@example.com', {
          id: 'bob@example.com',
          name: 'Bob',
          unreadCount: 0,
          lastSeenMessageId: 'm1',
          lastMessage: {
            id: 'm1',
            timestamp: new Date(),
            isOutgoing: false,
            isDelayed: true,
            from: 'bob@example.com',
          },
        })
        triggerChatStoreUpdate()
      })

      expect(onConversationMessage).not.toHaveBeenCalled()
    })

    it('does not notify twice for the same message id', () => {
      const onConversationMessage = vi.fn()
      renderHook(() => useNotificationEvents({ onConversationMessage }))

      const conv = {
        id: 'carol@example.com',
        name: 'Carol',
        unreadCount: 1,
        lastSeenMessageId: undefined,
        lastMessage: {
          id: 'm9',
          timestamp: new Date(),
          isOutgoing: false,
          isDelayed: false,
          from: 'carol@example.com',
        },
      }
      act(() => {
        mockConversations.set('carol@example.com', conv)
        triggerChatStoreUpdate()
        triggerChatStoreUpdate() // same lastMessage id → no second notification
      })

      expect(onConversationMessage).toHaveBeenCalledTimes(1)
    })
  })
})
