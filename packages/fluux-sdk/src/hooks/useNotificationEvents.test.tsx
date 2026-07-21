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

// Simulated chatStore.lastArrivedMessage — the store's "a message was
// delivered" signal, which addMessage writes and no merge or preview swap
// touches.
//
// Default: a conversation's lastMessage is also treated as its latest arrival,
// which is the ordinary case and keeps every test that just sets a lastMessage
// exercising the real decision path (rather than passing vacuously because no
// arrival was ever recorded). A test that needs a preview to move WITHOUT a
// delivery pins the arrival with pinArrival() — the pin then wins over the
// derived value for that conversation.
const mockArrivedMessages = new Map()

const pinArrival = (conversationId: string, message: unknown) => {
  mockArrivedMessages.set(conversationId, message)
}

// Helper to trigger store subscriptions
const triggerChatStoreUpdate = () => {
  const lastArrivedMessage = new Map(mockArrivedMessages)
  for (const [id, conv] of mockConversations) {
    if (!lastArrivedMessage.has(id) && conv.lastMessage) {
      lastArrivedMessage.set(id, conv.lastMessage)
    }
  }
  const state = {
    conversations: mockConversations,
    activeConversationId: mockActiveConversationId,
    lastArrivedMessage,
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

// Mock the SDK stores.
// Mocks the concrete modules, not the '../stores' barrel: source modules import
// the concrete store files so the barrel is never in their module graph.
vi.mock('../stores/chatStore', () => ({
  chatStore: {
    subscribe: (callback: (state: unknown) => void) => {
      chatStoreSubscribers.push(callback)
      return () => {
        chatStoreSubscribers = chatStoreSubscribers.filter(sub => sub !== callback)
      }
    },
  },
}))

vi.mock('../stores/roomStore', () => ({
  roomStore: {
    subscribe: (callback: (state: unknown) => void) => {
      roomStoreSubscribers.push(callback)
      return () => {
        roomStoreSubscribers = roomStoreSubscribers.filter(sub => sub !== callback)
      }
    },
  },
}))

vi.mock('../stores/connectionStore', () => ({
  connectionStore: {
    getState: () => ({ windowVisible: mockWindowVisible }),
  },
}))

describe('useNotificationEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockConversations.clear()
    mockArrivedMessages.clear()
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

  describe('conversation unseen-gate (no age gate)', () => {
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
            body: 'Offline message',
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
          body: 'Hello',
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

  // Read-transition signal: fires when an entity's unreadCount drops from >0 to
  // 0 for ANY reason — local read, a sent carbon from another device (mobile),
  // or a synced MDS read marker. Consumers use it to dismiss a delivered native
  // notification that the navigation/focus paths would otherwise miss.
  describe('entity read → dismiss signal', () => {
    it('fires onConversationRead when a conversation unreadCount drops from >0 to 0', () => {
      const onConversationRead = vi.fn()
      renderHook(() => useNotificationEvents({ onConversationRead }))

      // Unread message present.
      act(() => {
        mockConversations.set('alice@example.com', {
          id: 'alice@example.com',
          name: 'Alice',
          unreadCount: 1,
          lastMessage: {
            id: 'm1',
            timestamp: new Date(),
            isOutgoing: false,
            from: 'alice@example.com',
          },
        })
        triggerChatStoreUpdate()
      })
      expect(onConversationRead).not.toHaveBeenCalled()

      // Read elsewhere (e.g. reply sent from mobile → sent carbon) clears unread.
      act(() => {
        mockConversations.set('alice@example.com', {
          ...mockConversations.get('alice@example.com'),
          unreadCount: 0,
        })
        triggerChatStoreUpdate()
      })
      expect(onConversationRead).toHaveBeenCalledWith('alice@example.com')
      expect(onConversationRead).toHaveBeenCalledTimes(1)
    })

    it('does not fire onConversationRead when unreadCount was already 0', () => {
      const onConversationRead = vi.fn()
      renderHook(() => useNotificationEvents({ onConversationRead }))

      act(() => {
        mockConversations.set('bob@example.com', {
          id: 'bob@example.com',
          name: 'Bob',
          unreadCount: 0,
        })
        triggerChatStoreUpdate()
        // A later unrelated update, still read.
        mockConversations.set('bob@example.com', {
          id: 'bob@example.com',
          name: 'Bob',
          unreadCount: 0,
        })
        triggerChatStoreUpdate()
      })

      expect(onConversationRead).not.toHaveBeenCalled()
    })

    it('fires onRoomRead when a room unreadCount drops from >0 to 0', () => {
      const onRoomRead = vi.fn()
      renderHook(() => useNotificationEvents({ onRoomRead }))

      act(() => {
        mockRooms.set('room@conference.example.com', {
          jid: 'room@conference.example.com',
          name: 'Test Room',
          joined: true,
          unreadCount: 2,
          mentionsCount: 1,
          messages: [],
        })
        triggerRoomStoreUpdate()
      })
      expect(onRoomRead).not.toHaveBeenCalled()

      // Read elsewhere clears unread.
      act(() => {
        mockRooms.set('room@conference.example.com', {
          ...mockRooms.get('room@conference.example.com'),
          unreadCount: 0,
          mentionsCount: 0,
        })
        triggerRoomStoreUpdate()
      })
      expect(onRoomRead).toHaveBeenCalledWith('room@conference.example.com')
      expect(onRoomRead).toHaveBeenCalledTimes(1)
    })
  })

  // A room notification must fire at most once per message id. The room path
  // detects "new activity" by message-array length growth, which a cache
  // re-hydration (activateRoom → loadMessagesFromCache, prepending older
  // history) also trips — even though the newest message is unchanged. Without
  // an identity guard this resurrects a banner for a message already delivered,
  // matching the observed "notification reappears when I open the room" bug.
  // The 1:1 path detects arrivals by lastMessage.id and has its own guard —
  // see "conversation notification idempotency" below.
  describe('room notification idempotency', () => {
    const roomJid = 'tech@conference.example.com'

    const roomMsg = (id: string, body: string, timestamp: Date, nick = 'jerome') => ({
      id,
      roomJid,
      from: `${roomJid}/${nick}`,
      nick,
      body,
      timestamp,
      isOutgoing: false,
    })

    it('does not notify twice for the same room message when the window is re-hydrated from cache', () => {
      const onRoomMessage = vi.fn()
      const now = new Date()
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000)

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      // Seed one prior message so the next arrival is an incremental notify
      // (not an initial-history batch, which the >5 guard would skip).
      act(() => {
        mockRooms.set(roomJid, {
          jid: roomJid,
          name: 'Tech',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [roomMsg('seed', 'earlier', twoMinutesAgo, 'old')],
        })
        triggerRoomStoreUpdate()
      })
      onRoomMessage.mockClear()

      // A fresh message arrives → exactly one notification.
      act(() => {
        mockRooms.set(roomJid, {
          ...mockRooms.get(roomJid),
          messages: [
            ...mockRooms.get(roomJid).messages,
            roomMsg('fresh', 'Yes, but we should add Content-Disposition', now),
          ],
        })
        triggerRoomStoreUpdate()
      })
      expect(onRoomMessage).toHaveBeenCalledTimes(1)

      // Opening the room re-hydrates its resident window from cache, prepending
      // older history. The array grows (length-based detection sees "new
      // messages") but the newest message is the SAME one already delivered.
      act(() => {
        const older = Array.from({ length: 20 }, (_, i) =>
          roomMsg(`hist-${i}`, `history ${i}`, new Date(now.getTime() - (300 + i) * 1000), 'old'),
        )
        mockRooms.set(roomJid, {
          ...mockRooms.get(roomJid),
          messages: [
            ...older,
            roomMsg('seed', 'earlier', twoMinutesAgo, 'old'),
            roomMsg('fresh', 'Yes, but we should add Content-Disposition', now),
          ],
        })
        triggerRoomStoreUpdate()
      })

      // Re-hydration is not a new message — still a single notification.
      expect(onRoomMessage).toHaveBeenCalledTimes(1)
    })

    it('still notifies when a genuinely new message arrives after re-hydration', () => {
      const onRoomMessage = vi.fn()
      const now = new Date()

      renderHook(() => useNotificationEvents({ onRoomMessage }))

      act(() => {
        mockRooms.set(roomJid, {
          jid: roomJid,
          name: 'Tech',
          joined: true,
          notifyAllPersistent: true,
          mentionsCount: 0,
          messages: [roomMsg('first', 'first', now)],
        })
        triggerRoomStoreUpdate()
      })
      expect(onRoomMessage).toHaveBeenCalledTimes(1)

      // A second, distinct message must still notify (the guard is per id).
      act(() => {
        mockRooms.set(roomJid, {
          ...mockRooms.get(roomJid),
          messages: [
            ...mockRooms.get(roomJid).messages,
            roomMsg('second', 'second', now),
          ],
        })
        triggerRoomStoreUpdate()
      })
      expect(onRoomMessage).toHaveBeenCalledTimes(2)
      expect(onRoomMessage.mock.calls[1][1].id).toBe('second')
    })
  })

  // The 1:1 twin of the room re-hydration bug (#999). The conversation path
  // dedupes on lastMessage.id, which holds only while that id is stable across a
  // cache re-hydration. It is not always stable: when the stored preview is a
  // NON-previewable placeholder (a bodiless encrypted signal), the reopen merge
  // runs derivePreviewAfterMerge → shouldReplaceLastMessage, whose
  // `!isPreviewableMessage(existing)` branch swaps the preview to the newest
  // *previewable* message — an OLDER message with a DIFFERENT id. That id change
  // reads as "new message" to the dedupe.
  //
  // Nothing downstream catches it during the reopen window: activateConversation
  // awaits loadMessagesFromCache BEFORE setActiveConversation, so isActive is
  // still false and unreadCount is not yet zeroed.
  describe('conversation notification idempotency', () => {
    const convId = 'dave@example.com'

    it('does not notify for a bodiless encrypted control placeholder', () => {
      const onConversationMessage = vi.fn()
      const now = new Date()
      const real = { id: 'real', body: 'ping', timestamp: new Date(now.getTime() - 60 * 1000), isOutgoing: false }
      const placeholder = {
        id: 'signal',
        body: '',
        timestamp: now,
        isOutgoing: false,
        encryptedPayload: '<message><openpgp>...</openpgp></message>',
      }

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      act(() => {
        pinArrival(convId, real)
        mockConversations.set(convId, {
          id: convId,
          name: 'Dave',
          unreadCount: 1,
          lastSeenMessageId: undefined,
          lastMessage: real,
        })
        triggerChatStoreUpdate()
      })
      expect(onConversationMessage).toHaveBeenCalledTimes(1)

      act(() => {
        pinArrival(convId, placeholder)
        mockConversations.set(convId, {
          ...mockConversations.get(convId),
          unreadCount: 2,
          // addMessage keeps the real message as the preview because the
          // encrypted placeholder has no displayable content.
          lastMessage: real,
        })
        triggerChatStoreUpdate()
      })

      expect(onConversationMessage).toHaveBeenCalledTimes(1)
    })

    it('does not re-notify when a reopen swaps the preview off a bodiless placeholder', () => {
      const onConversationMessage = vi.fn()
      const now = new Date()
      const earlier = new Date(now.getTime() - 60 * 1000)
      const real1 = { id: 'real-1', body: 'ping', timestamp: earlier, isOutgoing: false }
      const signal2 = { id: 'signal-2', body: '', timestamp: now, isOutgoing: false }

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // A real incoming message arrives and is notified.
      act(() => {
        pinArrival(convId, real1)
        mockConversations.set(convId, {
          id: convId,
          name: 'Dave',
          unreadCount: 1,
          lastSeenMessageId: undefined,
          lastMessage: real1,
        })
        triggerChatStoreUpdate()
      })
      expect(onConversationMessage).toHaveBeenCalledTimes(1)

      // A bodiless encrypted signal is delivered: newest, but NOT previewable.
      act(() => {
        pinArrival(convId, signal2)
        mockConversations.set(convId, {
          ...mockConversations.get(convId),
          unreadCount: 2,
          lastMessage: signal2,
        })
        triggerChatStoreUpdate()
      })
      onConversationMessage.mockClear()

      // Reopen: loadMessagesFromCache merges the cached slice and the preview
      // policy demotes the placeholder back to the newest previewable message
      // ('real-1' — older, different id). setActiveConversation has NOT run yet,
      // so isActive is false and unreadCount is still > 0. Crucially NOTHING was
      // delivered, so the arrival signal stays pinned on 'signal-2'.
      act(() => {
        mockConversations.set(convId, {
          ...mockConversations.get(convId),
          lastMessage: real1,
        })
        triggerChatStoreUpdate()
      })

      // A preview demotion is not a delivery — no banner may be re-posted.
      expect(onConversationMessage).not.toHaveBeenCalled()
    })

    // Second, wider trigger — no placeholder and no E2EE required. addMessage
    // sets the preview from the incoming message with NO timestamp guard
    // (chatStore.ts:1035), unlike every merge path, so a delayed/offline-replay
    // message moves lastMessage BACKWARDS. Notifying for that delayed message is
    // intended (#586). The damage comes on the next merge: shouldReplaceLastMessage
    // sees a strictly-newer candidate and restores the previous newest message,
    // whose id differs from the regressed preview — so a message already notified
    // is notified a second time.
    it('does not re-notify the newest message when a merge restores it after a regressed preview', () => {
      const onConversationMessage = vi.fn()
      const newestAt = new Date()
      const olderAt = new Date(newestAt.getTime() - 5 * 60 * 1000)
      const newest = { id: 'newest', body: 'latest', timestamp: newestAt, isOutgoing: false }
      const offline = { id: 'offline', body: 'sent while you were away', timestamp: olderAt, isOutgoing: false }

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      // Newest message arrives and is notified.
      act(() => {
        pinArrival(convId, newest)
        mockConversations.set(convId, {
          id: convId,
          name: 'Dave',
          unreadCount: 1,
          lastSeenMessageId: undefined,
          lastMessage: newest,
        })
        triggerChatStoreUpdate()
      })
      expect(onConversationMessage).toHaveBeenCalledTimes(1)

      // Offline replay: an OLDER message is delivered via addMessage, which has
      // no timestamp guard — the preview regresses. This IS a delivery and must
      // still notify (#586), even though it moves the preview backwards.
      act(() => {
        pinArrival(convId, offline)
        mockConversations.set(convId, {
          ...mockConversations.get(convId),
          unreadCount: 2,
          lastMessage: offline,
        })
        triggerChatStoreUpdate()
      })
      expect(onConversationMessage).toHaveBeenCalledTimes(2)
      expect(onConversationMessage.mock.calls[1][1].id).toBe('offline')
      onConversationMessage.mockClear()

      // Any later merge (reopen cache load or MAM page) picks the newest
      // previewable message and restores 'newest' — already notified above.
      // Nothing was delivered, so the arrival stays pinned on 'offline'.
      act(() => {
        mockConversations.set(convId, {
          ...mockConversations.get(convId),
          lastMessage: newest,
        })
        triggerChatStoreUpdate()
      })

      expect(onConversationMessage).not.toHaveBeenCalled()
    })

    // The arrival signal also carries the notification BODY. Previously the
    // banner was built from conv.lastMessage, so a delivery landing while the
    // preview pointed elsewhere (a bodiless placeholder demoted to an older
    // message) announced the wrong text.
    it('notifies with the delivered message, not the current preview', () => {
      const onConversationMessage = vi.fn()
      const now = new Date()
      const preview = { id: 'preview-old', body: 'an older previewable line', timestamp: new Date(now.getTime() - 60 * 1000), isOutgoing: false }
      const delivered = { id: 'delivered', body: 'the actual new message', timestamp: now, isOutgoing: false }

      renderHook(() => useNotificationEvents({ onConversationMessage }))

      act(() => {
        pinArrival(convId, delivered)
        mockConversations.set(convId, {
          id: convId,
          name: 'Dave',
          unreadCount: 1,
          lastSeenMessageId: undefined,
          lastMessage: preview,
        })
        triggerChatStoreUpdate()
      })

      expect(onConversationMessage).toHaveBeenCalledTimes(1)
      expect(onConversationMessage.mock.calls[0][1].id).toBe('delivered')
      expect(onConversationMessage.mock.calls[0][1].body).toBe('the actual new message')
    })
  })
})
