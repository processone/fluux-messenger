import { describe, it, expect, beforeEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import type { Room, RoomMessage } from '../core/types'
import { getLocalPart } from '../core/jid'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    get _store() {
      return store
    },
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Helper to create test rooms
function createRoom(
  jid: string,
  options: Partial<Room> = {}
): Room {
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
    lastReadAt: options.lastReadAt,
    notifyAll: options.notifyAll,
    notifyAllPersistent: options.notifyAllPersistent,
  }
}

// Helper to create test messages
function createMessage(
  id: string,
  roomJid: string,
  nick: string,
  body: string,
  isOutgoing = false
): RoomMessage {
  return {
    type: 'groupchat',
    id,
    roomJid,
    from: `${roomJid}/${nick}`,
    nick,
    body,
    timestamp: new Date(),
    isOutgoing,
  }
}

describe('roomStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
    })
  })

  describe('addRoom', () => {
    it('should add a room to the store', () => {
      const room = createRoom('test@conference.example.com')

      roomStore.getState().addRoom(room)

      expect(roomStore.getState().rooms.size).toBe(1)
      expect(roomStore.getState().rooms.get('test@conference.example.com')).toBeDefined()
    })

    it('should preserve existing rooms when adding new ones', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com'))

      expect(roomStore.getState().rooms.size).toBe(2)
    })
  })

  describe('updateRoom', () => {
    it('should update an existing room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { name: 'Test' }))

      roomStore.getState().updateRoom('test@conference.example.com', { name: 'Updated Name' })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.name).toBe('Updated Name')
    })

    it('should not create a room if it does not exist', () => {
      roomStore.getState().updateRoom('nonexistent@conference.example.com', { name: 'Test' })

      expect(roomStore.getState().rooms.size).toBe(0)
    })

    it('should clear occupants when rejoining a room (prevents stale data)', () => {
      // Setup: room with existing occupants from previous session
      const staleOccupants = new Map([
        ['alice', { nick: 'alice', affiliation: 'member' as const, role: 'participant' as const }],
        ['bob', { nick: 'bob', affiliation: 'member' as const, role: 'participant' as const }],
      ])
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        occupants: staleOccupants,
        selfOccupant: { nick: 'me', affiliation: 'member' as const, role: 'participant' as const },
        typingUsers: new Set(['alice']),
      }))

      // Verify stale data exists
      const roomBefore = roomStore.getState().rooms.get('test@conference.example.com')
      expect(roomBefore?.occupants.size).toBe(2)
      expect(roomBefore?.selfOccupant).toBeDefined()
      expect(roomBefore?.typingUsers.size).toBe(1)

      // When rejoining, clear occupants (as XMPPClient.joinRoom does)
      roomStore.getState().updateRoom('test@conference.example.com', {
        isJoining: true,
        occupants: new Map(),
        selfOccupant: undefined,
        typingUsers: new Set(),
      })

      // Verify occupants are cleared
      const roomAfter = roomStore.getState().rooms.get('test@conference.example.com')
      expect(roomAfter?.occupants.size).toBe(0)
      expect(roomAfter?.selfOccupant).toBeUndefined()
      expect(roomAfter?.typingUsers.size).toBe(0)
      expect(roomAfter?.isJoining).toBe(true)
    })
  })

  describe('removeRoom', () => {
    it('should remove a room from the store', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().removeRoom('test@conference.example.com')

      expect(roomStore.getState().rooms.size).toBe(0)
    })
  })

  describe('setRoomJoined', () => {
    it('should update the joined status of a room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: false }))

      roomStore.getState().setRoomJoined('test@conference.example.com', true)

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.joined).toBe(true)
    })
  })

  // ==================== Bookmark Tests ====================

  describe('setBookmark', () => {
    it('should create a new room from bookmark if room does not exist', () => {
      roomStore.getState().setBookmark('newroom@conference.example.com', {
        name: 'New Room',
        nick: 'mynick',
        autojoin: true,
        password: 'secret',
      })

      const room = roomStore.getState().rooms.get('newroom@conference.example.com')
      expect(room).toBeDefined()
      expect(room?.name).toBe('New Room')
      expect(room?.nickname).toBe('mynick')
      expect(room?.isBookmarked).toBe(true)
      expect(room?.autojoin).toBe(true)
      expect(room?.password).toBe('secret')
      expect(room?.joined).toBe(false)
      expect(room?.messages).toEqual([])
      expect(room?.unreadCount).toBe(0)
    })

    it('should update existing room with bookmark info', () => {
      // First add a room that was joined manually
      roomStore.getState().addRoom(createRoom('existing@conference.example.com', {
        name: 'Existing Room',
        nickname: 'oldnick',
        joined: true,
        isBookmarked: false,
      }))

      // Now bookmark it
      roomStore.getState().setBookmark('existing@conference.example.com', {
        name: 'Bookmarked Name',
        nick: 'newnick',
        autojoin: true,
      })

      const room = roomStore.getState().rooms.get('existing@conference.example.com')
      expect(room?.name).toBe('Bookmarked Name')
      expect(room?.nickname).toBe('newnick')
      expect(room?.isBookmarked).toBe(true)
      expect(room?.autojoin).toBe(true)
      expect(room?.joined).toBe(true) // Should preserve joined status
    })

    it('should use existing name if bookmark name is empty', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        name: 'Original Name',
      }))

      roomStore.getState().setBookmark('test@conference.example.com', {
        name: '',
        nick: 'nick',
      })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.name).toBe('Original Name')
    })

    it('should use existing nickname if bookmark nick is empty', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        nickname: 'originalnick',
      }))

      roomStore.getState().setBookmark('test@conference.example.com', {
        name: 'Test',
        nick: '',
      })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.nickname).toBe('originalnick')
    })
  })

  describe('removeBookmark', () => {
    it('should remove bookmark flag from joined room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        isBookmarked: true,
        autojoin: true,
        password: 'secret',
      }))

      roomStore.getState().removeBookmark('test@conference.example.com')

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room).toBeDefined() // Room should still exist
      expect(room?.isBookmarked).toBe(false)
      expect(room?.autojoin).toBeUndefined()
      expect(room?.password).toBeUndefined()
      expect(room?.joined).toBe(true) // Should still be joined
    })

    it('should remove room entirely if not joined and no longer bookmarked', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: false,
        isBookmarked: true,
      }))

      roomStore.getState().removeBookmark('test@conference.example.com')

      expect(roomStore.getState().rooms.get('test@conference.example.com')).toBeUndefined()
      expect(roomStore.getState().rooms.size).toBe(0)
    })

    it('should do nothing if room does not exist', () => {
      roomStore.getState().removeBookmark('nonexistent@conference.example.com')

      expect(roomStore.getState().rooms.size).toBe(0)
    })

    it('should clear notifyAllPersistent when removing bookmark', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        isBookmarked: true,
      }))
      // Set persistent notify
      roomStore.getState().setNotifyAll('test@conference.example.com', true, true)

      roomStore.getState().removeBookmark('test@conference.example.com')

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAllPersistent).toBeUndefined()
    })
  })

  describe('setNotifyAll', () => {
    it('should set session-only notifyAll when persistent is false', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))

      roomStore.getState().setNotifyAll('test@conference.example.com', true, false)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAll).toBe(true)
      expect(room?.notifyAllPersistent).toBeUndefined()
    })

    it('should set persistent notifyAll when persistent is true', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))

      roomStore.getState().setNotifyAll('test@conference.example.com', true, true)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAll).toBeUndefined()
      expect(room?.notifyAllPersistent).toBe(true)
    })

    it('should toggle session-only notifyAll off', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))

      roomStore.getState().setNotifyAll('test@conference.example.com', true, false)
      roomStore.getState().setNotifyAll('test@conference.example.com', false, false)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAll).toBe(false)
    })

    it('should toggle persistent notifyAll off', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))

      roomStore.getState().setNotifyAll('test@conference.example.com', true, true)
      roomStore.getState().setNotifyAll('test@conference.example.com', false, true)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAllPersistent).toBe(false)
    })

    it('should not override persistent setting when setting session-only', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))

      // First set persistent
      roomStore.getState().setNotifyAll('test@conference.example.com', true, true)
      // Then set session-only
      roomStore.getState().setNotifyAll('test@conference.example.com', false, false)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      // Session-only should be set
      expect(room?.notifyAll).toBe(false)
      // Persistent should be preserved
      expect(room?.notifyAllPersistent).toBe(true)
    })
  })

  describe('setRoomJoined', () => {
    it('should reset session-only notifyAll when leaving room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))
      roomStore.getState().setNotifyAll('test@conference.example.com', true, false)

      roomStore.getState().setRoomJoined('test@conference.example.com', false)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAll).toBeUndefined()
    })

    it('should preserve persistent notifyAll when leaving room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        isBookmarked: true,
      }))
      roomStore.getState().setNotifyAll('test@conference.example.com', true, true)

      roomStore.getState().setRoomJoined('test@conference.example.com', false)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAllPersistent).toBe(true)
    })
  })

  describe('setBookmark with notifyAll', () => {
    it('should set notifyAllPersistent when bookmark has notifyAll', () => {
      roomStore.getState().setBookmark('test@conference.example.com', {
        name: 'Test Room',
        nick: 'user',
        notifyAll: true,
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAllPersistent).toBe(true)
    })

    it('should update existing room notifyAllPersistent from bookmark', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))

      roomStore.getState().setBookmark('test@conference.example.com', {
        name: 'Test Room',
        nick: 'user',
        notifyAll: true,
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.notifyAllPersistent).toBe(true)
    })
  })

  describe('joinedRooms', () => {
    it('should return only joined rooms', () => {
      roomStore.getState().addRoom(createRoom('joined1@conference.example.com', { joined: true }))
      roomStore.getState().addRoom(createRoom('joined2@conference.example.com', { joined: true }))
      roomStore.getState().addRoom(createRoom('notjoined@conference.example.com', { joined: false }))

      const joined = roomStore.getState().joinedRooms()

      expect(joined.length).toBe(2)
      expect(joined.map(r => r.jid)).toContain('joined1@conference.example.com')
      expect(joined.map(r => r.jid)).toContain('joined2@conference.example.com')
      expect(joined.map(r => r.jid)).not.toContain('notjoined@conference.example.com')
    })

    it('should return empty array when no rooms are joined', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: false }))

      expect(roomStore.getState().joinedRooms()).toEqual([])
    })
  })

  describe('bookmarkedRooms', () => {
    it('should return only bookmarked rooms', () => {
      roomStore.getState().addRoom(createRoom('bookmarked1@conference.example.com', { isBookmarked: true }))
      roomStore.getState().addRoom(createRoom('bookmarked2@conference.example.com', { isBookmarked: true }))
      roomStore.getState().addRoom(createRoom('notbookmarked@conference.example.com', { isBookmarked: false }))

      const bookmarked = roomStore.getState().bookmarkedRooms()

      expect(bookmarked.length).toBe(2)
      expect(bookmarked.map(r => r.jid)).toContain('bookmarked1@conference.example.com')
      expect(bookmarked.map(r => r.jid)).toContain('bookmarked2@conference.example.com')
    })

    it('should return empty array when no rooms are bookmarked', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { isBookmarked: false }))

      expect(roomStore.getState().bookmarkedRooms()).toEqual([])
    })
  })

  describe('allRooms', () => {
    it('should return all rooms that are either bookmarked or joined', () => {
      roomStore.getState().addRoom(createRoom('joined@conference.example.com', {
        joined: true,
        isBookmarked: false,
      }))
      roomStore.getState().addRoom(createRoom('bookmarked@conference.example.com', {
        joined: false,
        isBookmarked: true,
      }))
      roomStore.getState().addRoom(createRoom('both@conference.example.com', {
        joined: true,
        isBookmarked: true,
      }))

      const all = roomStore.getState().allRooms()

      expect(all.length).toBe(3)
      expect(all.map(r => r.jid)).toContain('joined@conference.example.com')
      expect(all.map(r => r.jid)).toContain('bookmarked@conference.example.com')
      expect(all.map(r => r.jid)).toContain('both@conference.example.com')
    })

    it('should not include rooms that are neither joined nor bookmarked', () => {
      // This shouldn't happen in practice, but let's test the filter
      roomStore.getState().addRoom(createRoom('orphan@conference.example.com', {
        joined: false,
        isBookmarked: false,
      }))

      const all = roomStore.getState().allRooms()

      expect(all.length).toBe(0)
    })

    it('should return empty array when store is empty', () => {
      expect(roomStore.getState().allRooms()).toEqual([])
    })
  })

  describe('quickChatRooms', () => {
    it('should return only quick chat rooms', () => {
      roomStore.getState().addRoom(createRoom('quickchat1@conference.example.com', {
        joined: true,
        isQuickChat: true,
      }))
      roomStore.getState().addRoom(createRoom('quickchat2@conference.example.com', {
        joined: true,
        isQuickChat: true,
      }))
      roomStore.getState().addRoom(createRoom('regular@conference.example.com', {
        joined: true,
        isBookmarked: true,
        isQuickChat: false,
      }))

      const quickChats = roomStore.getState().quickChatRooms()

      expect(quickChats.length).toBe(2)
      expect(quickChats.map(r => r.jid)).toContain('quickchat1@conference.example.com')
      expect(quickChats.map(r => r.jid)).toContain('quickchat2@conference.example.com')
      expect(quickChats.map(r => r.jid)).not.toContain('regular@conference.example.com')
    })

    it('should return empty array when no quick chats exist', () => {
      roomStore.getState().addRoom(createRoom('regular@conference.example.com', {
        joined: true,
        isBookmarked: true,
      }))

      expect(roomStore.getState().quickChatRooms()).toEqual([])
    })

    it('should return empty array when store is empty', () => {
      expect(roomStore.getState().quickChatRooms()).toEqual([])
    })

    it('should include quick chats regardless of joined state', () => {
      // Quick chats should always be joined, but test the filter works on isQuickChat
      roomStore.getState().addRoom(createRoom('quickchat@conference.example.com', {
        joined: true,
        isQuickChat: true,
      }))

      const quickChats = roomStore.getState().quickChatRooms()

      expect(quickChats.length).toBe(1)
      expect(quickChats[0].isQuickChat).toBe(true)
    })
  })

  // ==================== Message Tests ====================

  describe('addMessage', () => {
    it('should add a message to a room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')

      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages.length).toBe(1)
      expect(room?.messages[0].body).toBe('Hello!')
    })

    it('should increment unread count for non-active rooms', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.setState({ activeRoomJid: 'other@conference.example.com' })

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')
      roomStore.getState().addMessage('test@conference.example.com', message)

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(1)
    })

    it('should not increment unread count for active room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')
      roomStore.getState().addMessage('test@conference.example.com', message)

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(0)
    })

    it('should not increment unread count for outgoing messages', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const message = createMessage('msg1', 'test@conference.example.com', 'me', 'Hello!', true)
      roomStore.getState().addMessage('test@conference.example.com', message)

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(0)
    })

    it('should not increment unread count for delayed (historical) messages', () => {
      // Regression test: delayed messages from room history on join should not show as unread
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const message = {
        ...createMessage('msg1', 'test@conference.example.com', 'alice', 'Historical message'),
        isDelayed: true,
      }
      roomStore.getState().addMessage('test@conference.example.com', message)

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(0)
    })

    it('should not increment mentions count for delayed (historical) messages', () => {
      // Regression test: mentions in historical messages should not trigger badge
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const message = {
        ...createMessage('msg1', 'test@conference.example.com', 'alice', '@myNick hello'),
        isDelayed: true,
        isMention: true,
      }
      roomStore.getState().addMessage('test@conference.example.com', message, { incrementMentions: true })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.mentionsCount).toBe(0)
    })

    it('should deduplicate messages by stanzaId', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const msg1: RoomMessage = {
        type: 'groupchat',
        id: 'msg-1',
        stanzaId: 'server-id-123',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/alice',
        nick: 'alice',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same stanzaId, different message id (server duplicate)
      const msg2: RoomMessage = {
        type: 'groupchat',
        id: 'msg-2',
        stanzaId: 'server-id-123',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/alice',
        nick: 'alice',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      roomStore.getState().addMessage('test@conference.example.com', msg1)
      roomStore.getState().addMessage('test@conference.example.com', msg2)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages.length).toBe(1)
      expect(room?.messages[0].id).toBe('msg-1')
    })

    it('should deduplicate messages by from + id when no stanzaId', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const msg1: RoomMessage = {
        type: 'groupchat',
        id: 'msg-same-id',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/alice',
        nick: 'alice',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same from + id (client duplicate)
      const msg2: RoomMessage = {
        type: 'groupchat',
        id: 'msg-same-id',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/alice',
        nick: 'alice',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      roomStore.getState().addMessage('test@conference.example.com', msg1)
      roomStore.getState().addMessage('test@conference.example.com', msg2)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages.length).toBe(1)
    })

    it('should allow same message id from different senders', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const msg1: RoomMessage = {
        type: 'groupchat',
        id: 'msg-same-id',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/alice',
        nick: 'alice',
        body: 'Hello from Alice!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same id but different sender (not a duplicate)
      const msg2: RoomMessage = {
        type: 'groupchat',
        id: 'msg-same-id',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/bob',
        nick: 'bob',
        body: 'Hello from Bob!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      roomStore.getState().addMessage('test@conference.example.com', msg1)
      roomStore.getState().addMessage('test@conference.example.com', msg2)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages.length).toBe(2)
    })

    it('should not increment unreadCount for duplicate messages', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const msg1: RoomMessage = {
        type: 'groupchat',
        id: 'msg-1',
        stanzaId: 'server-id-123',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/alice',
        nick: 'alice',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      const msg2: RoomMessage = {
        type: 'groupchat',
        id: 'msg-2',
        stanzaId: 'server-id-123',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/alice',
        nick: 'alice',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      roomStore.getState().addMessage('test@conference.example.com', msg1)
      roomStore.getState().addMessage('test@conference.example.com', msg2)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.unreadCount).toBe(1) // Only incremented once
    })

    it('should set lastReadAt to epoch when undefined and inactive room gets first message', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      // Room is inactive (activeRoomJid is not set)

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')
      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastReadAt).toEqual(new Date(0)) // Epoch - marker will show
    })

    it('should preserve lastReadAt when inactive room gets new message', () => {
      const existingLastReadAt = new Date('2025-01-15T08:00:00Z')
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        lastReadAt: existingLastReadAt,
      }))
      // Room is inactive

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')
      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastReadAt).toEqual(existingLastReadAt) // Preserved
    })

    it('should update lastReadAt to message timestamp when active room gets new message', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      const msgTimestamp = new Date('2025-01-15T10:30:00Z')
      const message = {
        ...createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!'),
        timestamp: msgTimestamp,
      }
      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastReadAt).toEqual(msgTimestamp) // Updated to message time
    })
  })

  describe('markAsRead', () => {
    it('should reset unread count to zero', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { unreadCount: 5 }))

      roomStore.getState().markAsRead('test@conference.example.com')

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(0)
    })

    it('should also reset mentions count to zero', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        unreadCount: 5,
        mentionsCount: 3,
      }))

      roomStore.getState().markAsRead('test@conference.example.com')

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.mentionsCount).toBe(0)
    })

    it('should update lastReadAt to last message timestamp (resets new messages marker)', () => {
      // markAsRead should reset counts AND update lastReadAt
      // This clears the "new messages" marker when switching back to a room
      const msgTimestamp = new Date('2025-01-15T10:30:00Z')
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        unreadCount: 2,
        mentionsCount: 1,
        lastReadAt: new Date('2025-01-15T08:00:00Z'),
      }))
      roomStore.getState().addMessage('test@conference.example.com', {
        ...createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello'),
        timestamp: msgTimestamp,
      })

      roomStore.getState().markAsRead('test@conference.example.com')

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastReadAt).toEqual(msgTimestamp) // lastReadAt updated to last message
    })

    it('should set lastReadAt to current time when no messages exist', () => {
      const beforeMark = new Date()
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        unreadCount: 1,
      }))

      roomStore.getState().markAsRead('test@conference.example.com')

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastReadAt).toBeDefined()
      expect(room!.lastReadAt!.getTime()).toBeGreaterThanOrEqual(beforeMark.getTime())
    })

    it('should update lastReadAt even when unreadCount is already 0', () => {
      // Bug fix: when switching to a room with 0 unread but stale lastReadAt,
      // the "new messages" marker would show incorrectly
      const oldLastReadAt = new Date('2025-01-15T08:00:00Z')
      const msgTimestamp = new Date('2025-01-15T10:30:00Z')

      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        unreadCount: 0, // Already read
        mentionsCount: 0,
        lastReadAt: oldLastReadAt,
      }))

      // Add a newer message
      roomStore.getState().addMessage('test@conference.example.com', {
        ...createMessage('msg1', 'test@conference.example.com', 'alice', 'New message'),
        timestamp: msgTimestamp,
      })

      // markAsRead should update lastReadAt to the new message timestamp
      roomStore.getState().markAsRead('test@conference.example.com')

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastReadAt).toEqual(msgTimestamp)
    })

    it('should not trigger state update when called multiple times with same timestamp (regression test for infinite loop)', () => {
      // Regression test: Date objects were compared by reference (!==) instead of value (.getTime())
      // This caused infinite re-render loops because new Date() !== new Date() is always true
      const msgTimestamp = new Date('2025-01-15T10:30:00Z')
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        unreadCount: 1,
        mentionsCount: 1,
      }))
      roomStore.getState().addMessage('test@conference.example.com', {
        ...createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello'),
        timestamp: msgTimestamp,
      })

      // First call - should update state (unreadCount > 0)
      roomStore.getState().markAsRead('test@conference.example.com')
      const roomAfterFirst = roomStore.getState().rooms.get('test@conference.example.com')
      expect(roomAfterFirst?.unreadCount).toBe(0)
      expect(roomAfterFirst?.mentionsCount).toBe(0)
      expect(roomAfterFirst?.lastReadAt).toEqual(msgTimestamp)

      // Capture rooms Map reference after first markAsRead
      const roomsMapAfterFirst = roomStore.getState().rooms

      // Second call - should NOT update rooms (same timestamp, already read)
      roomStore.getState().markAsRead('test@conference.example.com')
      const roomsMapAfterSecond = roomStore.getState().rooms

      // Rooms Map reference should be the same (no unnecessary update)
      // This prevents infinite re-render loops in React when using selectors
      expect(roomsMapAfterSecond).toBe(roomsMapAfterFirst)

      // Room object should also be the same reference
      const roomAfterSecond = roomStore.getState().rooms.get('test@conference.example.com')
      expect(roomAfterSecond).toBe(roomAfterFirst)
    })
  })

  describe('mentions tracking', () => {
    it('should increment mentions count when incrementMentions option is true', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.setState({ activeRoomJid: 'other@conference.example.com' })

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hey @testuser!')
      roomStore.getState().addMessage('test@conference.example.com', message, { incrementMentions: true })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.mentionsCount).toBe(1)
    })

    it('should not increment mentions count for active room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hey @testuser!')
      roomStore.getState().addMessage('test@conference.example.com', message, { incrementMentions: true })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.mentionsCount).toBe(0)
    })

    it('should not increment mentions count for outgoing messages', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      const message = createMessage('msg1', 'test@conference.example.com', 'me', 'Hey @testuser!', true)
      roomStore.getState().addMessage('test@conference.example.com', message, { incrementMentions: true })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.mentionsCount).toBe(0)
    })

    it('should not increment unread when incrementUnread is false', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.setState({ activeRoomJid: 'other@conference.example.com' })

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')
      roomStore.getState().addMessage('test@conference.example.com', message, { incrementUnread: false })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(0)
    })
  })

  describe('totalMentionsCount', () => {
    it('should return total mentions count across all joined rooms', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        mentionsCount: 2,
      }))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com', {
        joined: true,
        mentionsCount: 3,
      }))
      roomStore.getState().addRoom(createRoom('room3@conference.example.com', {
        joined: true,
        mentionsCount: 1,
      }))

      expect(roomStore.getState().totalMentionsCount()).toBe(6)
    })

    it('should not count mentions from non-joined rooms', () => {
      roomStore.getState().addRoom(createRoom('joined@conference.example.com', {
        joined: true,
        mentionsCount: 2,
      }))
      roomStore.getState().addRoom(createRoom('notjoined@conference.example.com', {
        joined: false,
        isBookmarked: true,
        mentionsCount: 5, // Should not be counted
      }))

      expect(roomStore.getState().totalMentionsCount()).toBe(2)
    })

    it('should return 0 when no rooms have mentions', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        mentionsCount: 0,
      }))

      expect(roomStore.getState().totalMentionsCount()).toBe(0)
    })

    it('should return 0 when no rooms exist', () => {
      expect(roomStore.getState().totalMentionsCount()).toBe(0)
    })
  })

  describe('totalNotifiableUnreadCount', () => {
    it('should only count unread from rooms with notifyAll enabled', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        unreadCount: 5,
        notifyAll: true, // Session-only notifyAll
      }))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com', {
        joined: true,
        unreadCount: 3,
        // No notifyAll - should not count
      }))
      roomStore.getState().addRoom(createRoom('room3@conference.example.com', {
        joined: true,
        unreadCount: 2,
        notifyAllPersistent: true, // Persistent notifyAll
      }))

      expect(roomStore.getState().totalNotifiableUnreadCount()).toBe(7) // 5 + 2, not 3
    })

    it('should not count unread from non-joined rooms with notifyAll', () => {
      roomStore.getState().addRoom(createRoom('joined@conference.example.com', {
        joined: true,
        unreadCount: 4,
        notifyAll: true,
      }))
      roomStore.getState().addRoom(createRoom('notjoined@conference.example.com', {
        joined: false,
        isBookmarked: true,
        unreadCount: 10,
        notifyAllPersistent: true,
      }))

      expect(roomStore.getState().totalNotifiableUnreadCount()).toBe(4)
    })

    it('should return 0 when no rooms have notifyAll enabled', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        unreadCount: 5,
      }))

      expect(roomStore.getState().totalNotifiableUnreadCount()).toBe(0)
    })

    it('should return 0 when no rooms exist', () => {
      expect(roomStore.getState().totalNotifiableUnreadCount()).toBe(0)
    })
  })

  describe('setActiveRoom', () => {
    it('should set the active room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().setActiveRoom('test@conference.example.com')

      expect(roomStore.getState().activeRoomJid).toBe('test@conference.example.com')
    })

    it('should mark room as read when becoming active', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { unreadCount: 3 }))

      roomStore.getState().setActiveRoom('test@conference.example.com')

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(0)
    })

    it('should allow clearing active room with null', () => {
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      roomStore.getState().setActiveRoom(null)

      expect(roomStore.getState().activeRoomJid).toBeNull()
    })
  })

  describe('activeRoom', () => {
    it('should return the active room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { name: 'Test Room' }))
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      const active = roomStore.getState().activeRoom()

      expect(active?.jid).toBe('test@conference.example.com')
      expect(active?.name).toBe('Test Room')
    })

    it('should return undefined when no room is active', () => {
      expect(roomStore.getState().activeRoom()).toBeUndefined()
    })
  })

  describe('activeMessages', () => {
    it('should return messages from active room', () => {
      const messages = [
        createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello'),
        createMessage('msg2', 'test@conference.example.com', 'bob', 'Hi there'),
      ]
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages }))
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      const activeMessages = roomStore.getState().activeMessages()

      expect(activeMessages.length).toBe(2)
      expect(activeMessages[0].body).toBe('Hello')
      expect(activeMessages[1].body).toBe('Hi there')
    })

    it('should return empty array when no room is active', () => {
      expect(roomStore.getState().activeMessages()).toEqual([])
    })
  })

  describe('reset', () => {
    it('should clear all rooms and active room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      roomStore.getState().reset()

      expect(roomStore.getState().rooms.size).toBe(0)
      expect(roomStore.getState().activeRoomJid).toBeNull()
    })
  })

  // ==================== Occupant Tests ====================

  describe('addOccupant', () => {
    it('should add an occupant to a room', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'alice',
        affiliation: 'member',
        role: 'participant',
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.occupants.size).toBe(1)
      expect(room?.occupants.get('alice')?.nick).toBe('alice')
    })
  })

  describe('removeOccupant', () => {
    it('should remove an occupant from a room', () => {
      const occupants = new Map([['alice', { nick: 'alice', affiliation: 'member' as const, role: 'participant' as const }]])
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { occupants }))

      roomStore.getState().removeOccupant('test@conference.example.com', 'alice')

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.occupants.size).toBe(0)
    })
  })

  // ==================== Nick→JID Cache Tests ====================

  describe('nickToJidCache', () => {
    it('should cache nick→jid mapping when occupant has real JID', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'alice',
        jid: 'alice@example.com/resource',
        affiliation: 'member',
        role: 'participant',
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.nickToJidCache?.get('alice')).toBe('alice@example.com')
    })

    it('should not create cache for occupants without real JID (anonymous rooms)', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'alice',
        // No jid - anonymous room
        affiliation: 'member',
        role: 'participant',
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.nickToJidCache).toBeUndefined()
    })

    it('should preserve cache when occupant leaves', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      // Occupant joins with real JID
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'alice',
        jid: 'alice@example.com/mobile',
        affiliation: 'member',
        role: 'participant',
      })

      // Occupant leaves
      roomStore.getState().removeOccupant('test@conference.example.com', 'alice')

      // Cache should still have the mapping
      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.occupants.has('alice')).toBe(false)
      expect(room?.nickToJidCache?.get('alice')).toBe('alice@example.com')
    })

    it('should update cache when occupant rejoins with different resource', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      // First join
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'alice',
        jid: 'alice@example.com/mobile',
        affiliation: 'member',
        role: 'participant',
      })

      // Rejoin with different resource (same bare JID)
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'alice',
        jid: 'alice@example.com/desktop',
        affiliation: 'member',
        role: 'participant',
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      // Should still be bare JID
      expect(room?.nickToJidCache?.get('alice')).toBe('alice@example.com')
    })
  })

  // ==================== Reaction Tests ====================

  describe('updateReactions', () => {
    it('should add reactions to a message', () => {
      const messages = [createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello')]
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages }))

      roomStore.getState().updateReactions('test@conference.example.com', 'msg1', 'bob', ['👍', '❤️'])

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages[0].reactions).toEqual({ '👍': ['bob'], '❤️': ['bob'] })
    })

    it('should replace reactions from the same reactor', () => {
      const messages = [createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello')]
      messages[0].reactions = { '👍': ['bob'] }
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages }))

      roomStore.getState().updateReactions('test@conference.example.com', 'msg1', 'bob', ['❤️'])

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages[0].reactions).toEqual({ '❤️': ['bob'] })
    })

    it('should remove all reactions when empty array is passed', () => {
      const messages = [createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello')]
      messages[0].reactions = { '👍': ['bob'] }
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages }))

      roomStore.getState().updateReactions('test@conference.example.com', 'msg1', 'bob', [])

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages[0].reactions).toBeUndefined()
    })
  })

  describe('setTyping', () => {
    it('should add a user to typing set when isTyping is true', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().setTyping('test@conference.example.com', 'alice', true)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.typingUsers.has('alice')).toBe(true)
    })

    it('should remove a user from typing set when isTyping is false', () => {
      roomStore.getState().addRoom(
        createRoom('test@conference.example.com', {
          typingUsers: new Set(['alice', 'bob']),
        })
      )

      roomStore.getState().setTyping('test@conference.example.com', 'alice', false)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.typingUsers.has('alice')).toBe(false)
      expect(room?.typingUsers.has('bob')).toBe(true)
    })

    it('should handle multiple users typing', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().setTyping('test@conference.example.com', 'alice', true)
      roomStore.getState().setTyping('test@conference.example.com', 'bob', true)
      roomStore.getState().setTyping('test@conference.example.com', 'charlie', true)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.typingUsers.size).toBe(3)
      expect(room?.typingUsers.has('alice')).toBe(true)
      expect(room?.typingUsers.has('bob')).toBe(true)
      expect(room?.typingUsers.has('charlie')).toBe(true)
    })

    it('should do nothing for non-existent room', () => {
      roomStore.getState().setTyping('nonexistent@conference.example.com', 'alice', true)

      expect(roomStore.getState().rooms.size).toBe(0)
    })

    it('should not duplicate user when setting typing true twice', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      roomStore.getState().setTyping('test@conference.example.com', 'alice', true)
      roomStore.getState().setTyping('test@conference.example.com', 'alice', true)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.typingUsers.size).toBe(1)
    })
  })

  describe('removeOccupant clears typing', () => {
    it('should remove user from typingUsers when occupant leaves', () => {
      const occupants = new Map([
        ['alice', { jid: 'room@conf/alice', nick: 'alice', affiliation: 'member' as const, role: 'participant' as const }],
      ])
      roomStore.getState().addRoom(
        createRoom('test@conference.example.com', {
          occupants,
          typingUsers: new Set(['alice']),
        })
      )

      roomStore.getState().removeOccupant('test@conference.example.com', 'alice')

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.typingUsers.has('alice')).toBe(false)
      expect(room?.occupants.has('alice')).toBe(false)
    })
  })

  describe('draft management', () => {
    beforeEach(() => {
      // Reset drafts state and localStorage mock
      localStorageMock.clear()
      vi.clearAllMocks()
      roomStore.setState({ drafts: new Map() })
    })

    it('should save a draft for a room', () => {
      roomStore.getState().setDraft('room1@conference.example.com', 'Hello room!')

      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('Hello room!')
    })

    it('should return empty string for room without draft', () => {
      expect(roomStore.getState().getDraft('nonexistent@conference.example.com')).toBe('')
    })

    it('should update existing draft when setting new text', () => {
      roomStore.getState().setDraft('room1@conference.example.com', 'First draft')
      roomStore.getState().setDraft('room1@conference.example.com', 'Updated draft')

      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('Updated draft')
    })

    it('should maintain separate drafts for different rooms', () => {
      roomStore.getState().setDraft('room1@conference.example.com', 'Message for Room 1')
      roomStore.getState().setDraft('room2@conference.example.com', 'Message for Room 2')
      roomStore.getState().setDraft('room3@conference.example.com', 'Message for Room 3')

      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('Message for Room 1')
      expect(roomStore.getState().getDraft('room2@conference.example.com')).toBe('Message for Room 2')
      expect(roomStore.getState().getDraft('room3@conference.example.com')).toBe('Message for Room 3')
    })

    it('should delete draft when setting empty string', () => {
      roomStore.getState().setDraft('room1@conference.example.com', 'Some text')
      roomStore.getState().setDraft('room1@conference.example.com', '')

      const state = roomStore.getState()
      expect(state.drafts.has('room1@conference.example.com')).toBe(false)
      expect(state.getDraft('room1@conference.example.com')).toBe('')
    })

    it('should delete draft when setting whitespace-only string', () => {
      roomStore.getState().setDraft('room1@conference.example.com', 'Some text')
      roomStore.getState().setDraft('room1@conference.example.com', '   ')

      const state = roomStore.getState()
      expect(state.drafts.has('room1@conference.example.com')).toBe(false)
    })

    it('should clear draft for a specific room', () => {
      roomStore.getState().setDraft('room1@conference.example.com', 'Draft for Room 1')
      roomStore.getState().setDraft('room2@conference.example.com', 'Draft for Room 2')

      roomStore.getState().clearDraft('room1@conference.example.com')

      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('')
      expect(roomStore.getState().getDraft('room2@conference.example.com')).toBe('Draft for Room 2')
    })

    it('should not throw when clearing non-existent draft', () => {
      expect(() => {
        roomStore.getState().clearDraft('nonexistent@conference.example.com')
      }).not.toThrow()
    })

    it('should clear all drafts on reset', () => {
      roomStore.getState().setDraft('room1@conference.example.com', 'Draft for Room 1')
      roomStore.getState().setDraft('room2@conference.example.com', 'Draft for Room 2')

      roomStore.getState().reset()

      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('')
      expect(roomStore.getState().getDraft('room2@conference.example.com')).toBe('')
      expect(roomStore.getState().drafts.size).toBe(0)
    })

    it('should preserve drafts when switching active room', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com'))
      roomStore.getState().setDraft('room1@conference.example.com', 'Draft for Room 1')

      // Switch active room
      roomStore.getState().setActiveRoom('room2@conference.example.com')

      // Draft should still be preserved for Room 1
      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('Draft for Room 1')
    })

    // localStorage persistence tests
    describe('localStorage persistence', () => {
      it('should persist draft to localStorage when setting', () => {
        roomStore.getState().setDraft('room1@conference.example.com', 'My draft message')

        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'fluux-room-drafts',
          JSON.stringify([['room1@conference.example.com', 'My draft message']])
        )
      })

      it('should persist multiple drafts to localStorage', () => {
        roomStore.getState().setDraft('room1@conference.example.com', 'Draft 1')
        roomStore.getState().setDraft('room2@conference.example.com', 'Draft 2')

        // Last call should contain both drafts
        const lastCall = localStorageMock.setItem.mock.calls.at(-1)
        expect(lastCall?.[0]).toBe('fluux-room-drafts')
        const storedData = JSON.parse(lastCall?.[1] ?? '[]')
        expect(storedData).toHaveLength(2)
        expect(storedData).toContainEqual(['room1@conference.example.com', 'Draft 1'])
        expect(storedData).toContainEqual(['room2@conference.example.com', 'Draft 2'])
      })

      it('should update localStorage when clearing a draft', () => {
        // Set two drafts
        roomStore.getState().setDraft('room1@conference.example.com', 'Draft 1')
        roomStore.getState().setDraft('room2@conference.example.com', 'Draft 2')
        vi.clearAllMocks()

        // Clear one draft
        roomStore.getState().clearDraft('room1@conference.example.com')

        // localStorage should be updated with only the remaining draft
        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'fluux-room-drafts',
          JSON.stringify([['room2@conference.example.com', 'Draft 2']])
        )
      })

      it('should update localStorage when setting empty draft', () => {
        roomStore.getState().setDraft('room1@conference.example.com', 'Initial draft')
        vi.clearAllMocks()

        roomStore.getState().setDraft('room1@conference.example.com', '')

        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'fluux-room-drafts',
          JSON.stringify([])
        )
      })

      it('should remove localStorage key on reset', () => {
        roomStore.getState().setDraft('room1@conference.example.com', 'Draft to clear')
        vi.clearAllMocks()

        roomStore.getState().reset()

        expect(localStorageMock.removeItem).toHaveBeenCalledWith('fluux-room-drafts')
      })

      it('should load drafts from localStorage on store initialization', () => {
        // Note: The store is already initialized, so we test the loadDraftsFromStorage
        // behavior indirectly by verifying localStorage.getItem is called with the right key
        // The actual initialization happens when the module is loaded.
        // This test validates the storage key is correct by checking what setItem uses.
        roomStore.getState().setDraft('test@conference.example.com', 'Test')
        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'fluux-room-drafts',
          expect.any(String)
        )
      })
    })
  })

  describe('message routing safety', () => {
    // These tests ensure messages are sent to the correct room
    // and drafts don't accidentally get sent to wrong rooms

    it('should keep draft isolated to its room when switching', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com'))

      // Set draft for Room 1 while viewing it
      roomStore.getState().setActiveRoom('room1@conference.example.com')
      roomStore.getState().setDraft('room1@conference.example.com', 'Secret message for Room 1 only')

      // Switch to Room 2
      roomStore.getState().setActiveRoom('room2@conference.example.com')

      // Room 1's draft should be intact
      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('Secret message for Room 1 only')
      // Room 2 should have no draft
      expect(roomStore.getState().getDraft('room2@conference.example.com')).toBe('')
    })

    it('should not mix up drafts between rooms', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room3@conference.example.com'))

      // Set drafts for multiple rooms
      roomStore.getState().setDraft('room1@conference.example.com', 'PRIVATE: Room 1 draft')
      roomStore.getState().setDraft('room2@conference.example.com', 'PRIVATE: Room 2 draft')

      // Switch between rooms multiple times
      roomStore.getState().setActiveRoom('room1@conference.example.com')
      roomStore.getState().setActiveRoom('room3@conference.example.com')
      roomStore.getState().setActiveRoom('room2@conference.example.com')
      roomStore.getState().setActiveRoom('room1@conference.example.com')

      // All drafts should still be correctly associated
      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('PRIVATE: Room 1 draft')
      expect(roomStore.getState().getDraft('room2@conference.example.com')).toBe('PRIVATE: Room 2 draft')
      expect(roomStore.getState().getDraft('room3@conference.example.com')).toBe('')
    })

    it('should add message to correct room regardless of active room', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com'))

      // View Room 1
      roomStore.getState().setActiveRoom('room1@conference.example.com')

      // Add message to Room 2 (e.g., incoming message)
      const msgForRoom2 = createMessage('msg1', 'room2@conference.example.com', 'alice', 'Message for Room 2')
      roomStore.getState().addMessage('room2@conference.example.com', msgForRoom2)

      // Message should be in Room 2, not Room 1
      expect(roomStore.getState().rooms.get('room2@conference.example.com')?.messages.length).toBe(1)
      expect(roomStore.getState().rooms.get('room1@conference.example.com')?.messages.length).toBe(0)
    })

    it('should correctly track which room has unread messages', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com'))

      // View Room 1
      roomStore.getState().setActiveRoom('room1@conference.example.com')

      // Messages to inactive room should increment unread
      roomStore.getState().addMessage(
        'room2@conference.example.com',
        createMessage('msg1', 'room2@conference.example.com', 'alice', 'Hi from Room 2')
      )
      roomStore.getState().addMessage(
        'room2@conference.example.com',
        createMessage('msg2', 'room2@conference.example.com', 'bob', 'Another message')
      )

      // Messages to active room should not increment unread
      roomStore.getState().addMessage(
        'room1@conference.example.com',
        createMessage('msg3', 'room1@conference.example.com', 'charlie', 'Hi Room 1')
      )

      expect(roomStore.getState().rooms.get('room2@conference.example.com')?.unreadCount).toBe(2)
      expect(roomStore.getState().rooms.get('room1@conference.example.com')?.unreadCount).toBe(0)
    })

    it('should maintain draft-message association across rapid switching', () => {
      // Simulate rapid conversation switching to ensure no race conditions
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().addRoom(createRoom('room2@conference.example.com'))

      // Rapid switches with drafts
      roomStore.getState().setActiveRoom('room1@conference.example.com')
      roomStore.getState().setDraft('room1@conference.example.com', 'Typing to room 1...')
      roomStore.getState().setActiveRoom('room2@conference.example.com')
      roomStore.getState().setDraft('room2@conference.example.com', 'Now typing to room 2...')
      roomStore.getState().setActiveRoom('room1@conference.example.com')
      roomStore.getState().setActiveRoom('room2@conference.example.com')
      roomStore.getState().setActiveRoom('room1@conference.example.com')

      // Verify drafts are still correctly mapped
      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('Typing to room 1...')
      expect(roomStore.getState().getDraft('room2@conference.example.com')).toBe('Now typing to room 2...')
    })
  })

  describe('roomsWithUnreadCount', () => {
    it('should return 0 when no rooms exist', () => {
      expect(roomStore.getState().roomsWithUnreadCount()).toBe(0)
    })

    it('should return 0 when rooms have no unread and no mentions', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        unreadCount: 0,
        mentionsCount: 0,
      }))

      expect(roomStore.getState().roomsWithUnreadCount()).toBe(0)
    })

    it('should count rooms with mentions', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        unreadCount: 0,
        mentionsCount: 2,
      }))

      expect(roomStore.getState().roomsWithUnreadCount()).toBe(1)
    })

    it('should count rooms with notifyAll enabled and unread messages', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        unreadCount: 5,
        mentionsCount: 0,
        notifyAll: true,
      }))

      expect(roomStore.getState().roomsWithUnreadCount()).toBe(1)
    })

    it('should count rooms with notifyAllPersistent enabled and unread messages', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        unreadCount: 3,
        mentionsCount: 0,
        notifyAllPersistent: true,
      }))

      expect(roomStore.getState().roomsWithUnreadCount()).toBe(1)
    })

    it('should NOT count rooms with unread but no notifyAll and no mentions', () => {
      // This was the bug: rooms with unreadCount but no mentions and no notifyAll
      // should NOT contribute to the badge count
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        unreadCount: 10,
        mentionsCount: 0,
        notifyAll: false,
        notifyAllPersistent: false,
      }))

      expect(roomStore.getState().roomsWithUnreadCount()).toBe(0)
    })

    it('should only count joined rooms', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: false, // Not joined
        unreadCount: 5,
        mentionsCount: 3,
      }))

      expect(roomStore.getState().roomsWithUnreadCount()).toBe(0)
    })

    it('should count multiple qualifying rooms correctly', () => {
      // Room with mentions
      roomStore.getState().addRoom(createRoom('room1@conference.example.com', {
        joined: true,
        mentionsCount: 1,
      }))
      // Room with notifyAll and unread
      roomStore.getState().addRoom(createRoom('room2@conference.example.com', {
        joined: true,
        unreadCount: 5,
        notifyAll: true,
      }))
      // Room with unread but no notifyAll (should NOT count)
      roomStore.getState().addRoom(createRoom('room3@conference.example.com', {
        joined: true,
        unreadCount: 10,
      }))
      // Room not joined (should NOT count)
      roomStore.getState().addRoom(createRoom('room4@conference.example.com', {
        joined: false,
        mentionsCount: 5,
      }))

      expect(roomStore.getState().roomsWithUnreadCount()).toBe(2)
    })
  })

  describe('getMessage', () => {
    it('should find message by id', () => {
      const roomJid = 'room@conference.example.com'
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))

      const message = createMessage('msg-123', roomJid, 'alice', 'Hello')
      roomStore.getState().addMessage(roomJid, message)

      const found = roomStore.getState().getMessage(roomJid, 'msg-123')
      expect(found).toBeDefined()
      expect(found?.body).toBe('Hello')
    })

    it('should find message by stanzaId (for MAM corrections)', () => {
      const roomJid = 'room@conference.example.com'
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))

      const message: RoomMessage = {
        type: 'groupchat',
        id: 'original-uuid',
        stanzaId: 'mam-archive-id-12345',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: false,
      }
      roomStore.getState().addMessage(roomJid, message)

      // Should find by stanzaId when correction references the MAM archive ID
      const found = roomStore.getState().getMessage(roomJid, 'mam-archive-id-12345')
      expect(found).toBeDefined()
      expect(found?.body).toBe('Original message')
      expect(found?.id).toBe('original-uuid')
    })

    it('should return undefined when message not found', () => {
      const roomJid = 'room@conference.example.com'
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))

      const found = roomStore.getState().getMessage(roomJid, 'nonexistent')
      expect(found).toBeUndefined()
    })
  })

  describe('reference stability (prevents infinite re-renders)', () => {
    // These tests ensure computed selectors return stable array references
    // when empty, preventing Zustand from triggering infinite re-renders.
    // Using toBe() checks reference equality, not just value equality.

    it('activeMessages() should return same reference when no active room', () => {
      const result1 = roomStore.getState().activeMessages()
      const result2 = roomStore.getState().activeMessages()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('activeMessages() should return same reference when active room has no messages', () => {
      roomStore.getState().addRoom(createRoom('room@conference.example.com'))
      roomStore.getState().setActiveRoom('room@conference.example.com')

      const result1 = roomStore.getState().activeMessages()
      const result2 = roomStore.getState().activeMessages()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('joinedRooms() should return same reference when no rooms joined', () => {
      const result1 = roomStore.getState().joinedRooms()
      const result2 = roomStore.getState().joinedRooms()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('joinedRooms() should return same reference when rooms exist but none joined', () => {
      roomStore.getState().addRoom(createRoom('room@conference.example.com', { joined: false }))

      const result1 = roomStore.getState().joinedRooms()
      const result2 = roomStore.getState().joinedRooms()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('bookmarkedRooms() should return same reference when no bookmarks', () => {
      const result1 = roomStore.getState().bookmarkedRooms()
      const result2 = roomStore.getState().bookmarkedRooms()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('allRooms() should return same reference when no rooms', () => {
      const result1 = roomStore.getState().allRooms()
      const result2 = roomStore.getState().allRooms()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('quickChatRooms() should return same reference when no quick chats', () => {
      const result1 = roomStore.getState().quickChatRooms()
      const result2 = roomStore.getState().quickChatRooms()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('quickChatRooms() should return same reference when rooms exist but none are quick chats', () => {
      roomStore.getState().addRoom(createRoom('room@conference.example.com', { joined: true }))

      const result1 = roomStore.getState().quickChatRooms()
      const result2 = roomStore.getState().quickChatRooms()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })
  })

  describe('mergeRoomMAMMessages', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))
    })

    it('should merge older MAM messages at the start with direction backward', () => {
      // Add a recent message first
      const recentMessage: RoomMessage = {
        type: 'groupchat',
        id: 'recent-msg',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Recent message',
        timestamp: new Date('2024-01-15T15:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().addMessage(roomJid, recentMessage)

      // Merge older MAM messages (pagination / scroll up)
      const olderMamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'mam-old-1',
          roomJid,
          from: `${roomJid}/bob`,
          nick: 'bob',
          body: 'Old message 1',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
        },
        {
          type: 'groupchat',
          id: 'mam-old-2',
          roomJid,
          from: `${roomJid}/charlie`,
          nick: 'charlie',
          body: 'Old message 2',
          timestamp: new Date('2024-01-15T11:00:00Z'),
          isOutgoing: false,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(
        roomJid,
        olderMamMessages,
        { count: 2 },
        true,
        'backward'
      )

      const room = roomStore.getState().rooms.get(roomJid)
      const messages = room?.messages || []
      expect(messages.length).toBe(3)
      // Oldest messages at the start
      expect(messages[0].body).toBe('Old message 1')
      expect(messages[1].body).toBe('Old message 2')
      // Recent message at the end
      expect(messages[messages.length - 1].body).toBe('Recent message')
    })

    it('should append newer MAM messages when direction is forward (catch-up scenario)', () => {
      // This tests the catch-up scenario: user has old messages locally,
      // MAM fetches newer messages that occurred while offline.
      // Direction 'forward' is used when start= filter is set

      // Add an old message that we already have locally
      const oldMessage: RoomMessage = {
        type: 'groupchat',
        id: 'old-local-msg',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Old local message',
        timestamp: new Date('2024-01-15T08:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().addMessage(roomJid, oldMessage)

      // MAM catches up with newer messages (direction='forward')
      const newerMamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'mam-new-1',
          roomJid,
          from: `${roomJid}/bob`,
          nick: 'bob',
          body: 'New message 1',
          timestamp: new Date('2024-01-15T14:00:00Z'),
          isOutgoing: false,
        },
        {
          type: 'groupchat',
          id: 'mam-new-2',
          roomJid,
          from: `${roomJid}/charlie`,
          nick: 'charlie',
          body: 'New message 2',
          timestamp: new Date('2024-01-15T15:00:00Z'),
          isOutgoing: false,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(
        roomJid,
        newerMamMessages,
        { count: 2 },
        true,
        'forward'
      )

      const room = roomStore.getState().rooms.get(roomJid)
      const messages = room?.messages || []
      expect(messages.length).toBe(3)
      // Old local message at the start
      expect(messages[0].body).toBe('Old local message')
      // Newer MAM messages at the end, sorted by timestamp
      expect(messages[1].body).toBe('New message 1')
      expect(messages[2].body).toBe('New message 2')
      // Last message (for sidebar preview) should be the newest
      expect(messages[messages.length - 1].body).toBe('New message 2')
    })

    it('should correctly sort messages when forward MAM includes out-of-order timestamps', () => {
      // Edge case: MAM might return messages that interleave with existing ones

      // Existing messages at 10:00 and 14:00
      roomStore.getState().addMessage(roomJid, {
        type: 'groupchat',
        id: 'existing-1',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Existing at 10:00',
        timestamp: new Date('2024-01-15T10:00:00Z'),
        isOutgoing: false,
      })
      roomStore.getState().addMessage(roomJid, {
        type: 'groupchat',
        id: 'existing-2',
        roomJid,
        from: `${roomJid}/bob`,
        nick: 'bob',
        body: 'Existing at 14:00',
        timestamp: new Date('2024-01-15T14:00:00Z'),
        isOutgoing: false,
      })

      // MAM returns messages at 12:00 and 16:00 (interleaved)
      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'mam-1',
          roomJid,
          from: `${roomJid}/charlie`,
          nick: 'charlie',
          body: 'MAM at 12:00',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: false,
        },
        {
          type: 'groupchat',
          id: 'mam-2',
          roomJid,
          from: `${roomJid}/dave`,
          nick: 'dave',
          body: 'MAM at 16:00',
          timestamp: new Date('2024-01-15T16:00:00Z'),
          isOutgoing: false,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(
        roomJid,
        mamMessages,
        { count: 2 },
        true,
        'forward'
      )

      const room = roomStore.getState().rooms.get(roomJid)
      const messages = room?.messages || []
      expect(messages.length).toBe(4)
      // Should be sorted chronologically
      expect(messages[0].body).toBe('Existing at 10:00')
      expect(messages[1].body).toBe('MAM at 12:00')
      expect(messages[2].body).toBe('Existing at 14:00')
      expect(messages[3].body).toBe('MAM at 16:00')
      // Newest message is last
      expect(messages[messages.length - 1].body).toBe('MAM at 16:00')
    })
  })

  describe('updateLastMessagePreview', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().reset()
      const room: Room = {
        jid: roomJid,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        isJoining: false,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      }
      roomStore.getState().addRoom(room)
    })

    it('should update lastMessage when room has no previous lastMessage', () => {
      const lastMessage: RoomMessage = {
        type: 'groupchat',
        id: 'preview-1',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Latest message',
        timestamp: new Date('2024-01-15T10:00:00Z'),
        isOutgoing: false,
      }

      roomStore.getState().updateLastMessagePreview(roomJid, lastMessage)

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.lastMessage?.body).toBe('Latest message')

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.lastMessage?.body).toBe('Latest message')
    })

    it('should update lastMessage when new message is newer', () => {
      // Set initial lastMessage
      const oldMessage: RoomMessage = {
        type: 'groupchat',
        id: 'old-1',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Old message',
        timestamp: new Date('2024-01-15T09:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().updateLastMessagePreview(roomJid, oldMessage)

      // Update with newer message
      const newMessage: RoomMessage = {
        type: 'groupchat',
        id: 'new-1',
        roomJid,
        from: `${roomJid}/bob`,
        nick: 'bob',
        body: 'New message',
        timestamp: new Date('2024-01-15T10:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().updateLastMessagePreview(roomJid, newMessage)

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.lastMessage?.body).toBe('New message')
    })

    it('should NOT update lastMessage when new message is older', () => {
      // Set initial lastMessage
      const newMessage: RoomMessage = {
        type: 'groupchat',
        id: 'new-1',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'New message',
        timestamp: new Date('2024-01-15T10:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().updateLastMessagePreview(roomJid, newMessage)

      // Try to update with older message
      const oldMessage: RoomMessage = {
        type: 'groupchat',
        id: 'old-1',
        roomJid,
        from: `${roomJid}/bob`,
        nick: 'bob',
        body: 'Old message',
        timestamp: new Date('2024-01-15T09:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().updateLastMessagePreview(roomJid, oldMessage)

      // Should still have the new message
      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.lastMessage?.body).toBe('New message')
    })

    it('should do nothing for non-existent room', () => {
      const message: RoomMessage = {
        type: 'groupchat',
        id: 'preview-1',
        roomJid: 'nonexistent@conference.example.com',
        from: 'nonexistent@conference.example.com/alice',
        nick: 'alice',
        body: 'Message',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Should not throw
      roomStore.getState().updateLastMessagePreview('nonexistent@conference.example.com', message)

      // Room should not be created
      expect(roomStore.getState().rooms.get('nonexistent@conference.example.com')).toBeUndefined()
    })
  })
})
