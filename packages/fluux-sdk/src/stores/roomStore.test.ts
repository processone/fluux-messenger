import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import type { Room, RoomMessage } from '../core/types'
import { isNoLocalStore } from '../core/types/message-internal'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { setResidentWindowSize } from './shared/residentWindow'

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

// Mock messageCache to verify IndexedDB operations
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    saveRoomMessage: vi.fn().mockResolvedValue(undefined),
    saveRoomMessages: vi.fn().mockResolvedValue(undefined),
    getRoomMessages: vi.fn().mockResolvedValue([]),
    getRoomMessagesAround: vi.fn().mockResolvedValue([]),
    updateRoomMessage: vi.fn().mockResolvedValue(undefined),
    deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  }
})

// Import the mocked module for assertions
import * as messageCache from '../utils/messageCache'

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
    lastInteractedAt: options.lastInteractedAt,
    lastMessage: options.lastMessage,
    muted: options.muted,
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
    _resetStorageScopeForTesting()
    // Reset store state before each test
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
    })
    vi.clearAllMocks()
  })

  describe('message eviction on deactivation (memory windowing)', () => {
    it('evicts the previous room messages from RAM when switching away, keeping meta', () => {
      const roomA = 'a@conference.example.com'
      const roomB = 'b@conference.example.com'
      const msgs = [
        createMessage('m1', roomA, 'nick', 'hello'),
        createMessage('m2', roomA, 'nick', 'world'),
      ]
      roomStore.getState().addRoom(createRoom(roomA, { joined: true, messages: msgs, lastMessage: msgs[1] }))
      roomStore.getState().addRoom(createRoom(roomB, { joined: true }))
      roomStore.setState({ activeRoomJid: roomA })

      // Sanity: A is resident before switching away.
      expect(roomStore.getState().roomRuntime.get(roomA)?.messages).toHaveLength(2)

      roomStore.getState().setActiveRoom(roomB)

      // A's messages are evicted from both mirrors (rooms + roomRuntime)...
      expect(roomStore.getState().roomRuntime.get(roomA)?.messages).toEqual([])
      expect(roomStore.getState().rooms.get(roomA)?.messages).toEqual([])
      // ...but its sidebar preview / identity are preserved.
      expect(roomStore.getState().rooms.get(roomA)?.lastMessage).toEqual(msgs[1])
      expect(roomStore.getState().rooms.get(roomA)?.joined).toBe(true)
      expect(roomStore.getState().activeRoomJid).toBe(roomB)
    })

    it('keeps the newly-activated room messages resident', () => {
      const roomA = 'a@conference.example.com'
      const msgs = [createMessage('m1', roomA, 'nick', 'hello')]
      roomStore.getState().addRoom(createRoom(roomA, { joined: true, messages: msgs }))
      roomStore.setState({ activeRoomJid: null })

      // Activating A (no previous active room) must not evict A.
      roomStore.getState().setActiveRoom(roomA)

      expect(roomStore.getState().roomRuntime.get(roomA)?.messages).toHaveLength(1)
      expect(roomStore.getState().activeRoomJid).toBe(roomA)
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

  describe('supportsModeration entity propagation (F3 / XEP-0425)', () => {
    it('propagates supportsModeration to the room entity on addRoom', () => {
      roomStore.getState().addRoom({ ...createRoom('mod@conference.example.com'), supportsModeration: true })
      expect(roomStore.getState().roomEntities.get('mod@conference.example.com')?.supportsModeration).toBe(true)
    })

    it('updates supportsModeration on the entity via updateRoom', () => {
      roomStore.getState().addRoom({ ...createRoom('mod@conference.example.com'), supportsModeration: undefined })
      roomStore.getState().updateRoom('mod@conference.example.com', { supportsModeration: false })
      expect(roomStore.getState().roomEntities.get('mod@conference.example.com')?.supportsModeration).toBe(false)
    })
  })

  describe('anonymity flag entity propagation (F6)', () => {
    it('propagates isNonAnonymous/isPrivate to the room entity on addRoom', () => {
      roomStore.getState().addRoom({ ...createRoom('r@conference.example.com'), isNonAnonymous: true, isPrivate: false })
      const entity = roomStore.getState().roomEntities.get('r@conference.example.com')
      expect(entity?.isNonAnonymous).toBe(true)
      expect(entity?.isPrivate).toBe(false)
    })

    it('updates isNonAnonymous/isPrivate on the entity via updateRoom', () => {
      roomStore.getState().addRoom(createRoom('r@conference.example.com'))
      roomStore.getState().updateRoom('r@conference.example.com', { isNonAnonymous: true, isPrivate: true })
      const entity = roomStore.getState().roomEntities.get('r@conference.example.com')
      expect(entity?.isNonAnonymous).toBe(true)
      expect(entity?.isPrivate).toBe(true)
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

    it('should NOT set lastInteractedAt when joining room with messages', () => {
      // MUC history arrives before the join confirmation, so room.messages may
      // already have content. But these are history messages, not user interaction.
      // Only setActiveRoom (user clicking) should set lastInteractedAt.
      const messageTime = new Date(Date.now() - 30 * 60 * 1000) // 30 minutes ago

      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: false,
        messages: [{
          type: 'groupchat',
          id: 'msg1',
          from: 'test@conference.example.com/user',
          roomJid: 'test@conference.example.com',
          nick: 'user',
          body: 'Hello',
          timestamp: messageTime,
          isOutgoing: false,
        }],
      }))

      roomStore.getState().setRoomJoined('test@conference.example.com', true)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      const meta = roomStore.getState().roomMeta.get('test@conference.example.com')

      // lastInteractedAt should remain undefined - sorting falls back to lastMessage.timestamp
      expect(room?.lastInteractedAt).toBeUndefined()
      expect(meta?.lastInteractedAt).toBeUndefined()
    })

    it('should NOT set lastInteractedAt when joining room with no messages', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: false,
        messages: [],
      }))

      roomStore.getState().setRoomJoined('test@conference.example.com', true)

      const room = roomStore.getState().rooms.get('test@conference.example.com')

      expect(room?.lastInteractedAt).toBeUndefined()
    })

    it('should preserve existing lastInteractedAt when joining or leaving', () => {
      const interactionTime = new Date(Date.now() - 60 * 60 * 1000) // 1 hour ago

      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        lastInteractedAt: interactionTime,
      }))

      // Leave
      roomStore.getState().setRoomJoined('test@conference.example.com', false)
      let room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastInteractedAt?.getTime()).toBe(interactionTime.getTime())

      // Rejoin
      roomStore.getState().setRoomJoined('test@conference.example.com', true)
      room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastInteractedAt?.getTime()).toBe(interactionTime.getTime())
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

  describe('setSelfOccupant', () => {
    it('should update nickname with server-reflected value', () => {
      // Add room with initial nickname (as stored when joining)
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        nickname: 'MyNickname', // Initial case
      }))

      // Server reflects back with different case (some servers normalize)
      roomStore.getState().setSelfOccupant('test@conference.example.com', {
        nick: 'mynickname', // Server-reflected (different case)
        affiliation: 'member',
        role: 'participant',
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      const entity = roomStore.getState().roomEntities.get('test@conference.example.com')

      // Nickname should be updated to match server's version
      expect(room?.nickname).toBe('mynickname')
      expect(entity?.nickname).toBe('mynickname')
      expect(room?.selfOccupant?.nick).toBe('mynickname')
    })

    it('should set selfOccupant correctly', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        nickname: 'user',
      }))

      roomStore.getState().setSelfOccupant('test@conference.example.com', {
        nick: 'user',
        affiliation: 'owner',
        role: 'moderator',
        jid: 'me@example.com/resource',
      })

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.selfOccupant).toEqual({
        nick: 'user',
        affiliation: 'owner',
        role: 'moderator',
        jid: 'me@example.com/resource',
      })
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

    it('should sort rooms by lastInteractedAt (most recent first)', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)

      roomStore.getState().addRoom(createRoom('oldest@conference.example.com', {
        joined: true,
        lastInteractedAt: twoHoursAgo,
      }))
      roomStore.getState().addRoom(createRoom('newest@conference.example.com', {
        joined: true,
        lastInteractedAt: now,
      }))
      roomStore.getState().addRoom(createRoom('middle@conference.example.com', {
        joined: true,
        lastInteractedAt: oneHourAgo,
      }))

      const all = roomStore.getState().allRooms()

      expect(all.length).toBe(3)
      expect(all[0].jid).toBe('newest@conference.example.com')
      expect(all[1].jid).toBe('middle@conference.example.com')
      expect(all[2].jid).toBe('oldest@conference.example.com')
    })

    it('should fall back to lastMessage timestamp when lastInteractedAt is not set', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      roomStore.getState().addRoom(createRoom('with-interaction@conference.example.com', {
        joined: true,
        lastInteractedAt: oneHourAgo, // User opened 1 hour ago
      }))
      roomStore.getState().addRoom(createRoom('with-message@conference.example.com', {
        joined: true,
        // No lastInteractedAt - should use lastMessage timestamp
        lastMessage: {
          type: 'groupchat',
          id: 'msg1',
          from: 'with-message@conference.example.com/user',
          roomJid: 'with-message@conference.example.com',
          nick: 'user',
          body: 'Hello',
          timestamp: now, // Recent message
          isOutgoing: false,
        },
      }))

      const all = roomStore.getState().allRooms()

      expect(all.length).toBe(2)
      // Room with recent message but no interaction should be first (fallback to lastMessage)
      expect(all[0].jid).toBe('with-message@conference.example.com')
      expect(all[1].jid).toBe('with-interaction@conference.example.com')
    })

    it('should move non-muted room to top when messages arrive', () => {
      const now = new Date()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      // Room-b was interacted with more recently
      roomStore.getState().addRoom(createRoom('room-a@conference.example.com', {
        joined: true,
        lastInteractedAt: twoHoursAgo,
      }))
      roomStore.getState().addRoom(createRoom('room-b@conference.example.com', {
        joined: true,
        lastInteractedAt: oneHourAgo,
      }))

      // New message arrives in non-active room-a — should bubble it to top
      roomStore.getState().addMessage('room-a@conference.example.com', {
        type: 'groupchat',
        id: 'new-msg',
        from: 'room-a@conference.example.com/otheruser',
        roomJid: 'room-a@conference.example.com',
        nick: 'otheruser',
        body: 'New message!',
        timestamp: now,
        isOutgoing: false,
      })

      const all = roomStore.getState().allRooms()
      expect(all[0].jid).toBe('room-a@conference.example.com')
      expect(all[0].lastInteractedAt?.getTime()).toBe(now.getTime())
      expect(all[1].jid).toBe('room-b@conference.example.com')
    })

    it('should NOT move muted room to top when messages arrive', () => {
      const now = new Date()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      // Room-a is muted, room-b is not
      roomStore.getState().addRoom(createRoom('room-a@conference.example.com', {
        joined: true,
        lastInteractedAt: twoHoursAgo,
        muted: true,
      }))
      roomStore.getState().addRoom(createRoom('room-b@conference.example.com', {
        joined: true,
        lastInteractedAt: oneHourAgo,
      }))

      // New message arrives in muted room-a — should NOT change order
      roomStore.getState().addMessage('room-a@conference.example.com', {
        type: 'groupchat',
        id: 'new-msg',
        from: 'room-a@conference.example.com/otheruser',
        roomJid: 'room-a@conference.example.com',
        nick: 'otheruser',
        body: 'New message!',
        timestamp: now,
        isOutgoing: false,
      })

      const all = roomStore.getState().allRooms()
      // Muted room stays in place
      expect(all[0].jid).toBe('room-b@conference.example.com')
      expect(all[1].jid).toBe('room-a@conference.example.com')
      expect(all[1].lastInteractedAt?.getTime()).toBe(twoHoursAgo.getTime())
    })

    it('should move muted room to top when user opens it', () => {
      const now = new Date()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000)

      roomStore.getState().addRoom(createRoom('room-a@conference.example.com', {
        joined: true,
        lastInteractedAt: twoHoursAgo,
        muted: true,
        messages: [{
          type: 'groupchat',
          id: 'msg1',
          from: 'room-a@conference.example.com/user',
          roomJid: 'room-a@conference.example.com',
          nick: 'user',
          body: 'Recent message',
          timestamp: fiveMinAgo,
          isOutgoing: false,
        }],
      }))
      roomStore.getState().addRoom(createRoom('room-b@conference.example.com', {
        joined: true,
        lastInteractedAt: oneHourAgo,
      }))

      // Verify room-a is below room-b initially
      expect(roomStore.getState().allRooms()[0].jid).toBe('room-b@conference.example.com')

      // User opens the muted room — should update lastInteractedAt
      roomStore.getState().setActiveRoom('room-a@conference.example.com')

      const all = roomStore.getState().allRooms()
      expect(all[0].jid).toBe('room-a@conference.example.com')
      expect(all[0].lastInteractedAt?.getTime()).toBe(fiveMinAgo.getTime())
    })

    it('should move active room to top when message arrives', () => {
      const now = new Date()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      // Room-b was interacted with more recently
      roomStore.getState().addRoom(createRoom('room-a@conference.example.com', {
        joined: true,
        lastInteractedAt: twoHoursAgo,
      }))
      roomStore.getState().addRoom(createRoom('room-b@conference.example.com', {
        joined: true,
        lastInteractedAt: oneHourAgo,
      }))

      // Room-a is the active room
      roomStore.setState({ activeRoomJid: 'room-a@conference.example.com' })

      // New message arrives in active room-a
      roomStore.getState().addMessage('room-a@conference.example.com', {
        type: 'groupchat',
        id: 'new-msg',
        from: 'room-a@conference.example.com/otheruser',
        roomJid: 'room-a@conference.example.com',
        nick: 'otheruser',
        body: 'New message!',
        timestamp: now,
        isOutgoing: false,
      })

      const all = roomStore.getState().allRooms()
      // Active room should move to top because lastInteractedAt was updated
      expect(all[0].jid).toBe('room-a@conference.example.com')
      expect(all[0].lastInteractedAt?.getTime()).toBe(now.getTime())
      expect(all[1].jid).toBe('room-b@conference.example.com')
    })
  })

  describe('setActiveRoom lastInteractedAt', () => {
    it('should set lastInteractedAt to last message timestamp when room is opened', () => {
      const messageTime = new Date(Date.now() - 30 * 60 * 1000) // 30 minutes ago

      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        messages: [{
          type: 'groupchat',
          id: 'msg1',
          from: 'test@conference.example.com/user',
          roomJid: 'test@conference.example.com',
          nick: 'user',
          body: 'Hello',
          timestamp: messageTime,
          isOutgoing: false,
        }],
      }))

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.lastInteractedAt).toBeUndefined()

      roomStore.getState().setActiveRoom('test@conference.example.com')

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      const meta = roomStore.getState().roomMeta.get('test@conference.example.com')

      // lastInteractedAt should be set to last message timestamp, not current time
      expect(room?.lastInteractedAt).toBeDefined()
      expect(room?.lastInteractedAt!.getTime()).toBe(messageTime.getTime())

      // Also check metadata is updated
      expect(meta?.lastInteractedAt).toBeDefined()
      expect(meta?.lastInteractedAt!.getTime()).toBe(messageTime.getTime())
    })

    it('should NOT set lastInteractedAt when room has no messages (prevents jumping to top)', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        messages: [], // No messages
      }))

      roomStore.getState().setActiveRoom('test@conference.example.com')

      const room = roomStore.getState().rooms.get('test@conference.example.com')

      // Should NOT set lastInteractedAt when no messages - this prevents rooms
      // from jumping to top when opened before messages have loaded
      expect(room?.lastInteractedAt).toBeUndefined()
    })

    it('should update lastInteractedAt on new message for non-muted room even when not active', () => {
      const oldMessageTime = new Date(Date.now() - 60 * 60 * 1000) // 1 hour ago
      const newMessageTime = new Date(Date.now() - 5 * 60 * 1000) // 5 minutes ago

      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        joined: true,
        messages: [{
          type: 'groupchat',
          id: 'msg1',
          from: 'test@conference.example.com/user',
          roomJid: 'test@conference.example.com',
          nick: 'user',
          body: 'Old message',
          timestamp: oldMessageTime,
          isOutgoing: false,
        }],
      }))

      // Open room first time
      roomStore.getState().setActiveRoom('test@conference.example.com')
      expect(roomStore.getState().rooms.get('test@conference.example.com')?.lastInteractedAt?.getTime()).toBe(oldMessageTime.getTime())

      // Close room
      roomStore.getState().setActiveRoom(null)

      // Add new message — non-muted room should update lastInteractedAt immediately
      roomStore.getState().addMessage('test@conference.example.com', {
        type: 'groupchat',
        id: 'msg2',
        from: 'test@conference.example.com/otheruser',
        roomJid: 'test@conference.example.com',
        nick: 'otheruser',
        body: 'New message',
        timestamp: newMessageTime,
        isOutgoing: false,
      })

      // lastInteractedAt should already reflect the new message
      expect(roomStore.getState().rooms.get('test@conference.example.com')?.lastInteractedAt?.getTime()).toBe(newMessageTime.getTime())
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

    it('should clear unread count when sending outgoing message', () => {
      // Room starts with unread messages
      roomStore.getState().addRoom(createRoom('test@conference.example.com', {
        unreadCount: 5,
        mentionsCount: 2,
      }))

      // Send an outgoing message
      const message = createMessage('msg1', 'test@conference.example.com', 'me', 'My reply', true)
      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      // Sending a message clears unread state - user is engaging with the room
      expect(room?.unreadCount).toBe(0)
      expect(room?.mentionsCount).toBe(0)
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

    it('should deduplicate messages by originId (XEP-0359)', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      // Outgoing message stored locally with originId
      const msg1: RoomMessage = {
        type: 'groupchat',
        id: 'client-uuid-1',
        originId: 'client-uuid-1',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/me',
        nick: 'me',
        body: 'Hello room!',
        timestamp: new Date(),
        isOutgoing: true,
      }

      // MUC echo with stanzaId + matching originId but different id
      const msg2: RoomMessage = {
        type: 'groupchat',
        id: 'different-id',
        originId: 'client-uuid-1',
        stanzaId: 'muc-stanza-456',
        roomJid: 'test@conference.example.com',
        from: 'test@conference.example.com/me',
        nick: 'me',
        body: 'Hello room!',
        timestamp: new Date(),
        isOutgoing: true,
      }

      roomStore.getState().addMessage('test@conference.example.com', msg1)
      roomStore.getState().addMessage('test@conference.example.com', msg2)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages.length).toBe(1)
      expect(room?.messages[0].id).toBe('client-uuid-1')
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

    it('should leave lastReadAt undefined when inactive room gets first message', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      // Room is inactive (activeRoomJid is not set)

      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')
      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.lastReadAt).toBeUndefined() // Stays undefined; marker placed via unreadCount on activate
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

    it('should save message to IndexedDB when noLocalStore is false', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      const message = createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello!')

      roomStore.getState().addMessage('test@conference.example.com', message)

      expect(messageCache.saveRoomMessage).toHaveBeenCalled()
    })

    it('should not save message to IndexedDB when noLocalStore is true (XEP-0334)', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      const message = { ...createMessage('msg1', 'test@conference.example.com', 'alice', 'Ephemeral'), noLocalStore: true }

      roomStore.getState().addMessage('test@conference.example.com', message)

      expect(messageCache.saveRoomMessage).not.toHaveBeenCalled()
    })

    it('should set noLocalStore=true on messages for Quick Chat rooms', () => {
      roomStore.getState().addRoom(createRoom('quickchat@conference.example.com', { isQuickChat: true }))
      const message = createMessage('msg1', 'quickchat@conference.example.com', 'alice', 'Quick chat message')

      roomStore.getState().addMessage('quickchat@conference.example.com', message)

      // Message should not be saved to IndexedDB
      expect(messageCache.saveRoomMessage).not.toHaveBeenCalled()

      // But message should still be in memory with noLocalStore flag
      const room = roomStore.getState().rooms.get('quickchat@conference.example.com')
      expect(room?.messages.length).toBe(1)
      expect(isNoLocalStore(room!.messages[0])).toBe(true)
    })

    it('should still add noLocalStore message to in-memory store', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      const message = { ...createMessage('msg1', 'test@conference.example.com', 'alice', 'Ephemeral'), noLocalStore: true }

      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages.length).toBe(1)
      expect(room?.messages[0].body).toBe('Ephemeral')
    })

    it('should still increment unreadCount for noLocalStore messages', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      const message = { ...createMessage('msg1', 'test@conference.example.com', 'alice', 'Ephemeral'), noLocalStore: true }

      roomStore.getState().addMessage('test@conference.example.com', message)

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.unreadCount).toBe(1)
    })
  })

  describe('clearMessageStanzaId', () => {
    const ROOM = 'test@conference.example.com'

    it('strips a stale stanzaId from the in-memory message, the preview, and IndexedDB', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      const msg = { ...createMessage('m1', ROOM, 'me', 'sent', true), stanzaId: 'uuid-sent', originId: 'uuid-sent' }
      roomStore.getState().addMessage(ROOM, msg)

      roomStore.getState().clearMessageStanzaId(ROOM, 'uuid-sent')

      expect(roomStore.getState().rooms.get(ROOM)?.messages[0].stanzaId).toBeUndefined()
      expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage?.stanzaId).toBeUndefined()
      expect(messageCache.updateRoomMessage).toHaveBeenCalledWith('m1', { stanzaId: undefined })
    })

    it('is a no-op when no message carries the given stanzaId', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      const msg = { ...createMessage('m1', ROOM, 'alice', 'real'), stanzaId: 'archive-1' }
      roomStore.getState().addMessage(ROOM, msg)
      vi.mocked(messageCache.updateRoomMessage).mockClear()

      roomStore.getState().clearMessageStanzaId(ROOM, 'not-present')

      expect(roomStore.getState().rooms.get(ROOM)?.messages[0].stanzaId).toBe('archive-1')
      expect(messageCache.updateRoomMessage).not.toHaveBeenCalled()
    })
  })

  describe('getRoomLastTimestamp', () => {
    const ROOM = 'test@conference.example.com'

    it('returns the meta lastMessage timestamp in epoch ms', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      const ts = new Date('2026-05-14T09:00:00.000Z')
      roomStore.getState().addMessage(ROOM, { ...createMessage('m1', ROOM, 'alice', 'hi'), timestamp: ts })

      expect(roomStore.getState().getRoomLastTimestamp(ROOM)).toBe(ts.getTime())
    })

    it('falls back to the combined rooms map when no meta entry exists', () => {
      const ts = new Date('2026-05-14T09:00:00.000Z')
      const lastMessage = { ...createMessage('m1', ROOM, 'alice', 'hi'), timestamp: ts }
      roomStore.setState({
        roomMeta: new Map(),
        rooms: new Map([[ROOM, createRoom(ROOM, { lastMessage })]]),
      })

      expect(roomStore.getState().getRoomLastTimestamp(ROOM)).toBe(ts.getTime())
    })

    it('returns undefined when the room has no last message', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      expect(roomStore.getState().getRoomLastTimestamp(ROOM)).toBeUndefined()
      expect(roomStore.getState().getRoomLastTimestamp('unknown@conference.example.com')).toBeUndefined()
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

  describe('markReadToNewest / markAllRoomsRead', () => {
    it('advances the pointer to the newest message, zeroes counts, clears the divider', () => {
      const roomJid = 'test@conference.example.com'
      const messages = [
        createMessage('m1', roomJid, 'alice', 'first'),
        createMessage('m2', roomJid, 'alice', 'second'),
        createMessage('m3', roomJid, 'alice', 'third'),
      ]
      roomStore.getState().addRoom(createRoom(roomJid, {
        joined: true,
        messages,
        lastMessage: messages[2],
        unreadCount: 2,
        mentionsCount: 1,
        lastSeenMessageId: 'm1',
      }))
      roomStore.setState((state) => {
        const newMarkers = new Map(state.firstNewMessageMarkers)
        newMarkers.set(roomJid, 'm2')
        return { firstNewMessageMarkers: newMarkers }
      })

      roomStore.getState().markReadToNewest(roomJid)

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.lastSeenMessageId).toBe('m3')
      expect(meta?.unreadCount).toBe(0)
      expect(meta?.mentionsCount).toBe(0)
      expect(roomStore.getState().firstNewMessageMarkers.has(roomJid)).toBe(false)
    })

    it('is a no-op (same Map references) when the room is already read to newest', () => {
      const roomJid = 'test@conference.example.com'
      const messages = [
        createMessage('m1', roomJid, 'alice', 'first'),
        createMessage('m2', roomJid, 'alice', 'second'),
        createMessage('m3', roomJid, 'alice', 'third'),
      ]
      roomStore.getState().addRoom(createRoom(roomJid, {
        joined: true,
        messages,
        lastMessage: messages[2],
        unreadCount: 2,
        mentionsCount: 1,
        lastSeenMessageId: 'm1',
      }))
      roomStore.setState((state) => {
        const newMarkers = new Map(state.firstNewMessageMarkers)
        newMarkers.set(roomJid, 'm2')
        return { firstNewMessageMarkers: newMarkers }
      })

      // First call actually advances the pointer and clears the divider.
      roomStore.getState().markReadToNewest(roomJid)

      const { roomMeta, rooms } = roomStore.getState()

      // Second call: room is already fully read, nothing should change.
      roomStore.getState().markReadToNewest(roomJid)

      const stateAfter = roomStore.getState()
      expect(stateAfter.roomMeta).toBe(roomMeta)
      expect(stateAfter.rooms).toBe(rooms)
    })

    it('falls back to lastMessage for an evicted (non-active) room', () => {
      const roomJid = 'evicted@conference.example.com'
      const m9 = createMessage('m9', roomJid, 'alice', 'latest before eviction')
      roomStore.getState().addRoom(createRoom(roomJid, {
        joined: true,
        messages: [],
        lastMessage: m9,
        unreadCount: 3,
        mentionsCount: 1,
      }))
      // Simulate eviction: runtime messages array is empty (non-active room).
      roomStore.setState((state) => {
        const newRuntime = new Map(state.roomRuntime)
        const existingRuntime = newRuntime.get(roomJid)
        if (existingRuntime) newRuntime.set(roomJid, { ...existingRuntime, messages: [] })
        return { roomRuntime: newRuntime }
      })

      roomStore.getState().markReadToNewest(roomJid)

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.lastSeenMessageId).toBe('m9')
      expect(meta?.unreadCount).toBe(0)
      expect(meta?.mentionsCount).toBe(0)
    })

    it('markAllRoomsRead marks every joined room with unread, skips clean and unjoined rooms', () => {
      const unreadJoined = 'unread-joined@conference.example.com'
      const cleanJoined = 'clean-joined@conference.example.com'
      const unreadUnjoined = 'unread-unjoined@conference.example.com'

      const unreadMsgs = [createMessage('u1', unreadJoined, 'alice', 'hi')]
      const cleanMsgs = [createMessage('c1', cleanJoined, 'alice', 'hi')]
      const unjoinedMsgs = [createMessage('j1', unreadUnjoined, 'alice', 'hi')]

      roomStore.getState().addRoom(createRoom(unreadJoined, {
        joined: true, messages: unreadMsgs, lastMessage: unreadMsgs[0], unreadCount: 2,
      }))
      roomStore.getState().addRoom(createRoom(cleanJoined, {
        joined: true, messages: cleanMsgs, lastMessage: cleanMsgs[0], unreadCount: 0, mentionsCount: 0,
      }))
      roomStore.getState().addRoom(createRoom(unreadUnjoined, {
        joined: false, messages: unjoinedMsgs, lastMessage: unjoinedMsgs[0], unreadCount: 5,
      }))

      roomStore.getState().markAllRoomsRead()

      expect(roomStore.getState().roomMeta.get(unreadJoined)?.unreadCount).toBe(0)
      expect(roomStore.getState().roomMeta.get(unreadJoined)?.lastSeenMessageId).toBe('u1')
      // Clean room was already at 0 — no change expected (and no crash).
      expect(roomStore.getState().roomMeta.get(cleanJoined)?.unreadCount).toBe(0)
      // Unjoined room is skipped even though it has unread messages.
      expect(roomStore.getState().roomMeta.get(unreadUnjoined)?.unreadCount).toBe(5)
      expect(roomStore.getState().roomMeta.get(unreadUnjoined)?.lastSeenMessageId).toBeUndefined()
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

  describe('roomTabIndicator', () => {
    it("returns 'none' when there are no rooms", () => {
      expect(roomStore.getState().roomTabIndicator()).toBe('none')
    })

    it("returns 'neutral' for plain unread in a non-muted joined room", () => {
      roomStore.getState().addRoom(createRoom('r1@conference.example.com', {
        joined: true,
        unreadCount: 3,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('neutral')
    })

    it("returns 'accent' when a room has a mention", () => {
      roomStore.getState().addRoom(createRoom('r1@conference.example.com', {
        joined: true,
        unreadCount: 3,
        mentionsCount: 1,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('accent')
    })

    it("returns 'accent' for unread in a notifyAll room (no mention)", () => {
      roomStore.getState().addRoom(createRoom('r1@conference.example.com', {
        joined: true,
        unreadCount: 2,
        notifyAllPersistent: true,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('accent')
    })

    it('lets accent win over neutral across rooms', () => {
      roomStore.getState().addRoom(createRoom('plain@conference.example.com', {
        joined: true,
        unreadCount: 5,
      }))
      roomStore.getState().addRoom(createRoom('mention@conference.example.com', {
        joined: true,
        unreadCount: 1,
        mentionsCount: 1,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('accent')
    })

    it("keeps muted rooms silent, even with a mention ('none')", () => {
      roomStore.getState().addRoom(createRoom('muted@conference.example.com', {
        joined: true,
        unreadCount: 4,
        mentionsCount: 2,
        muted: true,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('none')
    })

    it('ignores non-joined rooms', () => {
      roomStore.getState().addRoom(createRoom('bookmarked@conference.example.com', {
        joined: false,
        isBookmarked: true,
        unreadCount: 9,
        mentionsCount: 3,
      }))
      expect(roomStore.getState().roomTabIndicator()).toBe('none')
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

  describe('activateRoom', () => {
    afterEach(() => {
      // Restore the factory default so later tests get a clean resolved-[] mock
      vi.mocked(messageCache.getRoomMessages).mockReset()
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([])
    })

    it('should hydrate messages from cache before marking the room active', async () => {
      const roomJid = 'test@conference.example.com'
      roomStore.getState().addRoom(createRoom(roomJid))
      const cached: RoomMessage = {
        type: 'groupchat',
        id: 'cached-1',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Cached history',
        timestamp: new Date(),
        isOutgoing: false,
      }
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([cached])

      // Snapshot the in-memory messages at the exact moment activation happens —
      // the unread marker is computed from them, so they must be loaded first
      let messagesAtActivation: RoomMessage[] | undefined
      const unsubscribe = roomStore.subscribe(
        (state) => state.activeRoomJid,
        (activeJid) => {
          if (activeJid === roomJid) {
            messagesAtActivation = roomStore.getState().rooms.get(roomJid)?.messages
          }
        }
      )

      await roomStore.getState().activateRoom(roomJid)
      unsubscribe()

      expect(roomStore.getState().activeRoomJid).toBe(roomJid)
      expect(messagesAtActivation?.map((m) => m.id)).toEqual(['cached-1'])
    })

    it('should deactivate immediately without touching the cache when passed null', async () => {
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })
      vi.clearAllMocks()

      await roomStore.getState().activateRoom(null)

      expect(roomStore.getState().activeRoomJid).toBeNull()
      expect(messageCache.getRoomMessages).not.toHaveBeenCalled()
    })

    it('should drop a stale activation that resolves after a newer one', async () => {
      roomStore.getState().addRoom(createRoom('slow@conference.example.com'))
      roomStore.getState().addRoom(createRoom('fast@conference.example.com'))

      let resolveSlow: (value: RoomMessage[]) => void = () => {}
      vi.mocked(messageCache.getRoomMessages).mockImplementation((roomJid) =>
        roomJid === 'slow@conference.example.com'
          ? new Promise((resolve) => { resolveSlow = resolve })
          : Promise.resolve([])
      )

      const stale = roomStore.getState().activateRoom('slow@conference.example.com')
      const fresh = roomStore.getState().activateRoom('fast@conference.example.com')
      await fresh
      resolveSlow([])
      await stale

      expect(roomStore.getState().activeRoomJid).toBe('fast@conference.example.com')
    })

    it('flags activationPending while the cache read is in flight, then clears it', async () => {
      const roomJid = 'test@conference.example.com'
      roomStore.getState().addRoom(createRoom(roomJid))

      // Hold the cache read open so we can observe the in-flight window — this is
      // the gap during which ChatLayout would otherwise flash the empty state.
      let resolveRead: (value: RoomMessage[]) => void = () => {}
      vi.mocked(messageCache.getRoomMessages).mockReturnValue(
        new Promise((resolve) => { resolveRead = resolve })
      )

      expect(roomStore.getState().activationPending).toBe(false)

      const activation = roomStore.getState().activateRoom(roomJid)

      // Synchronously after the call: read is in flight, active room not set yet
      expect(roomStore.getState().activationPending).toBe(true)
      expect(roomStore.getState().activeRoomJid).toBeNull()

      resolveRead([])
      await activation

      // Once the active room lands the flag clears, atomically with activation
      expect(roomStore.getState().activationPending).toBe(false)
      expect(roomStore.getState().activeRoomJid).toBe(roomJid)
    })

    it('does not flag activationPending when deactivating with null', async () => {
      roomStore.setState({ activeRoomJid: 'test@conference.example.com' })

      await roomStore.getState().activateRoom(null)

      expect(roomStore.getState().activationPending).toBe(false)
      expect(roomStore.getState().activeRoomJid).toBeNull()
    })

    it('activateRoom reloads the window around a pointer deeper than the latest slice', async () => {
      // Arrange: cache holds 300 messages; the latest-100 slice (returned by
      // loadMessagesFromCache) does NOT contain meta.lastSeenMessageId
      // ('msg-150') — the reader left off deep in history. Seeding
      // roomMeta.lastSeenMessageId directly mimics a persisted read pointer
      // from a prior session (no live activation has run yet in this test).
      const roomJid = 'test@conference.example.com'
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))
      roomStore.setState((state) => {
        const meta = new Map(state.roomMeta)
        meta.set(roomJid, { ...meta.get(roomJid)!, lastSeenMessageId: 'msg-150' })
        return { roomMeta: meta }
      })

      // Base offsets in minutes-since-epoch so message order matches id order
      // (msg-149 < msg-150 < msg-151 < ... < msg-299) with no collisions.
      const roomMsgAt = (id: string, offsetMinutes: number): RoomMessage => ({
        type: 'groupchat',
        id,
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: id,
        timestamp: new Date(offsetMinutes * 60_000),
        isOutgoing: false,
      })

      const latestSlice: RoomMessage[] = Array.from({ length: 100 }, (_, i) => roomMsgAt(`msg-${200 + i}`, 200 + i))
      const aroundSlice: RoomMessage[] = [
        roomMsgAt('msg-149', 149),
        roomMsgAt('msg-150', 150),
        roomMsgAt('msg-151', 151),
      ]
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(latestSlice)
      vi.mocked(messageCache.getRoomMessagesAround).mockResolvedValue(aroundSlice)

      await roomStore.getState().activateRoom(roomJid)

      expect(messageCache.getRoomMessagesAround).toHaveBeenCalledWith(
        roomJid,
        'msg-150',
        expect.any(Object)
      )
      const resident = roomStore.getState().roomRuntime.get(roomJid)?.messages
      expect(resident?.some((m) => m.id === 'msg-150')).toBe(true)
      expect(roomStore.getState().firstNewMessageMarkers.get(roomJid)).toBe('msg-151')
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

  describe('mergeRoomMAMMessages gap tracking (persisted roomGaps)', () => {
    const jid = 'room@conference.example.com'

    it('records a persisted GapInterval when a forward catch-up ends incomplete', () => {
      const recent: RoomMessage = {
        type: 'groupchat', id: 'recent', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'recent', timestamp: new Date('2026-06-10T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { messages: [recent] }))

      const fetched: RoomMessage = {
        type: 'groupchat', id: 'edge', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'edge', timestamp: new Date('2026-05-14T09:00:00Z'), isOutgoing: false,
      }
      // Forward catch-up truncated (complete=false) at the edge message.
      roomStore.getState().mergeRoomMAMMessages(jid, [fetched], {}, false, 'forward')

      const gap = roomStore.getState().roomGaps.get(jid)
      expect(gap).toEqual({
        start: new Date('2026-05-14T09:00:00Z').getTime(), // newest fetched
        end: new Date('2026-06-10T00:00:00Z').getTime(),   // oldest held above the gap
      })
    })

    it('clears the persisted gap when a forward catch-up completes', () => {
      roomStore.getState().addRoom(createRoom(jid))
      roomStore.setState({ roomGaps: new Map([[jid, { start: 1000, end: 5000 }]]) })

      roomStore.getState().mergeRoomMAMMessages(jid, [], {}, true, 'forward')

      expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
    })

    it('plants a seam when a fetch-latest page lands disjoint above held history', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'held', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'held', timestamp: new Date('2026-07-06T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { joined: true, messages: [held], lastMessage: held }))

      const fetched: RoomMessage = {
        type: 'groupchat', id: 'fresh', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z'), isOutgoing: false,
      }
      // backward + isFetchLatest=true = a `before:''` fetch-latest page
      roomStore.getState().mergeRoomMAMMessages(jid, [fetched], {}, true, 'backward', false, true)

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-15T00:00:00Z').getTime(),
      })
    })

    it('does NOT plant a seam when the fetch-latest page overlaps held history (dedupe)', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'shared', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'shared', timestamp: new Date('2026-07-14T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { joined: true, messages: [held], lastMessage: held }))

      const fresh: RoomMessage = {
        type: 'groupchat', id: 'fresh', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z'), isOutgoing: false,
      }
      const dupe: RoomMessage = { ...held } // same id → dedupe hit → connection proof
      roomStore.getState().mergeRoomMAMMessages(jid, [dupe, fresh], {}, true, 'backward', false, true)

      expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
    })

    it('does NOT plant a seam for a plain backward pagination page (isFetchLatest omitted)', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'held', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'held', timestamp: new Date('2026-07-06T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { joined: true, messages: [held], lastMessage: held }))
      const older: RoomMessage = {
        type: 'groupchat', id: 'older', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'older', timestamp: new Date('2026-07-01T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [older], {}, false, 'backward')

      expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
    })

    it('falls back to the persisted preview timestamp when the resident array is empty', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'held', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'held', timestamp: new Date('2026-07-06T00:00:00Z'), isOutgoing: false,
      }
      // Fresh-run shape: resident array EMPTY, preview (meta.lastMessage) persisted.
      roomStore.getState().addRoom(createRoom(jid, { joined: true, lastMessage: held }))

      const fetched: RoomMessage = {
        type: 'groupchat', id: 'fresh', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [fetched], {}, true, 'backward', false, true)

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-15T00:00:00Z').getTime(),
      })
    })

    it('backward closure: a scroll-up page reaching into the gap shrinks it; crossing clears it', async () => {
      roomStore.getState().addRoom(createRoom(jid))
      roomStore.setState({ roomGaps: new Map([[jid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }]]) })

      const mid: RoomMessage = {
        type: 'groupchat', id: 'mid', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'mid', timestamp: new Date('2026-07-10T00:00:00Z'), isOutgoing: false,
      }
      const upper: RoomMessage = {
        type: 'groupchat', id: 'upper', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'upper', timestamp: new Date('2026-07-14T06:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [mid, upper], {}, false, 'backward')
      expect(roomStore.getState().roomGaps.get(jid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-10T00:00:00Z').getTime(),
      })

      const below: RoomMessage = {
        type: 'groupchat', id: 'below', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'below', timestamp: new Date('2026-07-05T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [below, mid], {}, false, 'backward')
      // Clearance is deferred until the page is durably cached (crash-window
      // safety); the mocked saveRoomMessages resolves immediately, so waitFor.
      await vi.waitFor(() => {
        expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
      })
    })

    it('backward CLEARANCE with persistable messages is deferred until the page is durably cached', async () => {
      // Crash window: the gap deletion is persisted (localStorage) while
      // saveRoomMessages to IndexedDB is fire-and-forget. A crash in between
      // leaves cache [old][HOLE][new] with no marker. The deletion must wait
      // for the durable write.
      roomStore.getState().addRoom(createRoom(jid))
      roomStore.setState({ roomGaps: new Map([[jid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }]]) })

      let resolveSave!: () => void
      vi.mocked(messageCache.saveRoomMessages).mockReturnValue(
        new Promise<void>((resolve) => { resolveSave = resolve })
      )

      const below: RoomMessage = {
        type: 'groupchat', id: 'below', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'below', timestamp: new Date('2026-07-05T00:00:00Z'), isOutgoing: false,
      }
      const above: RoomMessage = {
        type: 'groupchat', id: 'above', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'above', timestamp: new Date('2026-07-14T06:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [below, above], {}, false, 'backward')

      // Immediately after the merge — and while the write is pending — the
      // gap must still be recorded (in the map AND in localStorage).
      expect(roomStore.getState().roomGaps.has(jid)).toBe(true)
      await Promise.resolve()
      expect(roomStore.getState().roomGaps.has(jid)).toBe(true)

      resolveSave()
      await vi.waitFor(() => {
        expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
      })
    })

    it('backward CLEARANCE with zero new persistable messages deletes immediately', () => {
      // Nothing new to persist → no crash window → no reason to defer.
      const above: RoomMessage = {
        type: 'groupchat', id: 'above', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'above', timestamp: new Date('2026-07-14T06:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { messages: [above] }))
      roomStore.setState({ roomGaps: new Map([[jid, { start: new Date('2026-07-06T00:00:00Z').getTime() }]]) })

      // complete=true from above the gap, but the page is all duplicates.
      roomStore.getState().mergeRoomMAMMessages(jid, [{ ...above }], {}, true, 'backward')

      expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
    })

    it('backward closure: an older-region page below the gap leaves it untouched', () => {
      roomStore.getState().addRoom(createRoom(jid))
      const gap = {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }
      roomStore.setState({ roomGaps: new Map([[jid, gap]]) })

      const ancient: RoomMessage = {
        type: 'groupchat', id: 'ancient', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'ancient', timestamp: new Date('2026-07-01T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [ancient], {}, true, 'backward')
      expect(roomStore.getState().roomGaps.get(jid)).toEqual(gap)
    })

    it('a signal-only incomplete forward page preserves the persisted gap and advances its coverage cursor', () => {
      // All-signal page (reactions/receipts only): zero displayable messages
      // but rsm.last IS set. The gap must survive (the page proves nothing
      // about the hole) with startId advanced to the last fetched archive id.
      roomStore.getState().addRoom(createRoom(jid))
      const start = new Date('2026-07-06T00:00:00Z').getTime()
      roomStore.setState({ roomGaps: new Map([[jid, { start, startId: 'old' }]]) })

      roomStore.getState().mergeRoomMAMMessages(jid, [], { last: 'sig-99' }, false, 'forward')

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({ start, startId: 'sig-99' })
    })

    it('leaves the persisted gap untouched when preserveGapMarker is set (bounded repair)', () => {
      roomStore.getState().addRoom(createRoom(jid))
      roomStore.setState({ roomGaps: new Map([[jid, { start: 1000, end: 5000 }]]) })

      // A bounded force repair completes within its window — must not clear an older gap.
      roomStore.getState().mergeRoomMAMMessages(jid, [], {}, true, 'forward', true)

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({ start: 1000, end: 5000 })
    })

    it('scopes persisted gaps to the user JID (no cross-account leak)', () => {
      localStorageMock.clear() // isolate from other tests' unscoped writes
      setStorageScopeJid('alice@example.com')
      try {
        const recent: RoomMessage = {
          type: 'groupchat', id: 'recent', roomJid: jid, from: `${jid}/b`, nick: 'b',
          body: 'recent', timestamp: new Date('2026-06-10T00:00:00Z'), isOutgoing: false,
        }
        roomStore.getState().addRoom(createRoom(jid, { messages: [recent] }))
        const fetched: RoomMessage = {
          type: 'groupchat', id: 'edge', roomJid: jid, from: `${jid}/a`, nick: 'a',
          body: 'edge', timestamp: new Date('2026-05-14T09:00:00Z'), isOutgoing: false,
        }
        roomStore.getState().mergeRoomMAMMessages(jid, [fetched], {}, false, 'forward')

        // Stored under the per-account key — NOT the bare key, NOT another account's key.
        expect(localStorageMock._store['fluux-room-gaps:alice@example.com']).toBeDefined()
        expect(localStorageMock._store['fluux-room-gaps']).toBeUndefined()
        expect(localStorageMock._store['fluux-room-gaps:bob@example.com']).toBeUndefined()
      } finally {
        _resetStorageScopeForTesting()
      }
    })

    it('clearRoomGapAnchor strips a MATCHING startId, keeps start, and persists the healed gap', () => {
      const start = new Date('2026-07-06T00:00:00Z').getTime()
      roomStore.setState({ roomGaps: new Map([[jid, { start, startId: 'purged' }]]) })

      roomStore.getState().clearRoomGapAnchor(jid, 'purged')

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({ start })
      // Persisted immediately: the heal must survive a reload, otherwise the
      // next session re-anchors on the purged id and re-degrades.
      const persisted = Object.entries(localStorageMock._store).find(([k]) => k.startsWith('fluux-room-gaps'))?.[1]
      expect(persisted).toBeDefined()
      expect(persisted).not.toContain('purged')
    })

    it('clearRoomGapAnchor does NOT strip a non-matching startId (anchor already advanced)', () => {
      roomStore.setState({ roomGaps: new Map([[jid, { start: 1000, startId: 'newer' }]]) })

      roomStore.getState().clearRoomGapAnchor(jid, 'purged')

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({ start: 1000, startId: 'newer' })
    })

    it('persists roomGaps to localStorage so the marker survives a reload', () => {
      const recent: RoomMessage = {
        type: 'groupchat', id: 'recent', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'recent', timestamp: new Date('2026-06-10T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { messages: [recent] }))
      const fetched: RoomMessage = {
        type: 'groupchat', id: 'edge', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'edge', timestamp: new Date('2026-05-14T09:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [fetched], {}, false, 'forward')

      const persisted = Object.values(localStorageMock._store).some(
        (v) => typeof v === 'string' && v.includes('2026-05-14') === false && v.includes(String(new Date('2026-05-14T09:00:00Z').getTime())),
      )
      expect(persisted).toBe(true)
    })
  })

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

    it('preserves a fetched avatar across a presence update (unchanged hash)', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))

      // Occupant joins, carrying only the XEP-0153 avatar hash from presence.
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'zoidberg',
        affiliation: 'member',
        role: 'participant',
        avatarHash: 'hash123',
      })

      // Async XEP-0398 fetch resolves the blob URL onto the occupant + cache.
      roomStore.getState().updateOccupantAvatar('test@conference.example.com', 'zoidberg', 'blob:zoidberg', 'hash123')
      expect(roomStore.getState().rooms.get('test@conference.example.com')?.occupants.get('zoidberg')?.avatar).toBe('blob:zoidberg')

      // A later presence update (e.g. status change) carries only the hash, never the blob.
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'zoidberg',
        affiliation: 'member',
        role: 'participant',
        show: 'away',
        avatarHash: 'hash123',
      })

      // The occupant must keep its resolved avatar — otherwise the members list drops to a letter.
      const occ = roomStore.getState().rooms.get('test@conference.example.com')?.occupants.get('zoidberg')
      expect(occ?.avatar).toBe('blob:zoidberg')
      expect(occ?.show).toBe('away')
    })

    it('preserves a fetched avatar across a presence update with no hash', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'zoidberg', affiliation: 'member', role: 'participant', avatarHash: 'hash123',
      })
      roomStore.getState().updateOccupantAvatar('test@conference.example.com', 'zoidberg', 'blob:zoidberg', 'hash123')

      // Presence update with no vcard-temp:x:update at all (avatarHash undefined).
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'zoidberg', affiliation: 'member', role: 'participant', show: 'dnd',
      })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.occupants.get('zoidberg')?.avatar).toBe('blob:zoidberg')
    })

    it('drops the avatar when the presence hash changes (a fresh one will be fetched)', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'zoidberg', affiliation: 'member', role: 'participant', avatarHash: 'hash123',
      })
      roomStore.getState().updateOccupantAvatar('test@conference.example.com', 'zoidberg', 'blob:zoidberg', 'hash123')

      // Presence carries a NEW hash → the old blob is stale and must not be kept.
      roomStore.getState().addOccupant('test@conference.example.com', {
        nick: 'zoidberg', affiliation: 'member', role: 'participant', avatarHash: 'hash999',
      })

      const occ = roomStore.getState().rooms.get('test@conference.example.com')?.occupants.get('zoidberg')
      expect(occ?.avatar).toBeUndefined()
      expect(occ?.avatarHash).toBe('hash999')
    })
  })

  describe('updateOccupantAvatars (batch)', () => {
    it('applies multiple avatar updates in a single state notification', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.getState().batchAddOccupants('test@conference.example.com', [
        { nick: 'alice', affiliation: 'member', role: 'participant', avatarHash: 'ha' },
        { nick: 'bob', affiliation: 'member', role: 'participant', avatarHash: 'hb' },
      ])

      let notifications = 0
      const unsub = roomStore.subscribe(() => { notifications++ })
      roomStore.getState().updateOccupantAvatars('test@conference.example.com', [
        { nick: 'alice', avatar: 'blob:alice', avatarHash: 'ha' },
        { nick: 'bob', avatar: 'blob:bob', avatarHash: 'hb' },
      ])
      unsub()

      expect(notifications).toBe(1)
      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.occupants.get('alice')?.avatar).toBe('blob:alice')
      expect(room?.occupants.get('bob')?.avatar).toBe('blob:bob')
      // nick→avatar cache must be updated so message rows keep avatars after occupants leave
      expect(room?.nickToAvatarCache?.get('alice')).toBe('blob:alice')
      expect(room?.nickToAvatarCache?.get('bob')).toBe('blob:bob')
    })

    it('skips unknown occupants while applying known ones', () => {
      roomStore.getState().addRoom(createRoom('test@conference.example.com'))
      roomStore.getState().batchAddOccupants('test@conference.example.com', [
        { nick: 'alice', affiliation: 'member', role: 'participant' },
      ])

      roomStore.getState().updateOccupantAvatars('test@conference.example.com', [
        { nick: 'ghost', avatar: 'blob:ghost', avatarHash: 'hg' },
        { nick: 'alice', avatar: 'blob:alice', avatarHash: 'ha' },
      ])

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.occupants.get('alice')?.avatar).toBe('blob:alice')
      expect(room?.occupants.has('ghost')).toBe(false)
    })

    it('does nothing for an unknown room', () => {
      let notifications = 0
      const unsub = roomStore.subscribe(() => { notifications++ })
      roomStore.getState().updateOccupantAvatars('missing@conference.example.com', [
        { nick: 'alice', avatar: 'blob:alice', avatarHash: 'ha' },
      ])
      unsub()
      expect(notifications).toBe(0)
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

    it('should find message by stanzaId when reaction references server-assigned ID', () => {
      const messages = [createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello')]
      messages[0].stanzaId = 'server-stanza-id-123'
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages }))

      // Reaction references the stanzaId (as other clients like Gajim may do)
      roomStore.getState().updateReactions('test@conference.example.com', 'server-stanza-id-123', 'bob', ['👍'])

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages[0].reactions).toEqual({ '👍': ['bob'] })
    })

    it('should find message by originId when a reaction references the sender id', () => {
      const messages = [createMessage('muc-rewritten-id', 'test@conference.example.com', 'alice', 'Hello')]
      messages[0].originId = 'sender-origin-uuid'
      messages[0].stanzaId = 'server-stanza-id-789'
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages }))

      // Reaction references the sender-assigned origin-id (e.g. a corrected message)
      roomStore.getState().updateReactions('test@conference.example.com', 'sender-origin-uuid', 'bob', ['👍'])

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages[0].reactions).toEqual({ '👍': ['bob'] })
    })

    it('should replace reactions when referenced by stanzaId', () => {
      const messages = [createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello')]
      messages[0].stanzaId = 'server-stanza-id-456'
      roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages }))

      // First reaction via stanzaId
      roomStore.getState().updateReactions('test@conference.example.com', 'server-stanza-id-456', 'bob', ['👍'])
      // Bob changes reaction (still via stanzaId)
      roomStore.getState().updateReactions('test@conference.example.com', 'server-stanza-id-456', 'bob', ['❤️'])

      const room = roomStore.getState().rooms.get('test@conference.example.com')
      expect(room?.messages[0].reactions).toEqual({ '❤️': ['bob'] })
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

    it('should load account-scoped drafts when switching account', () => {
      localStorageMock._store['fluux-room-drafts:alice@example.com'] = JSON.stringify([
        ['room1@conference.example.com', 'Alice draft'],
      ])

      roomStore.getState().switchAccount('alice@example.com')

      expect(roomStore.getState().getDraft('room1@conference.example.com')).toBe('Alice draft')
    })

    it('should clear room state when switching account', () => {
      roomStore.getState().addRoom(createRoom('room1@conference.example.com'))
      roomStore.getState().setDraft('room1@conference.example.com', 'Draft for Room 1')

      roomStore.getState().switchAccount('bob@example.com')

      expect(roomStore.getState().rooms.size).toBe(0)
      expect(roomStore.getState().drafts.size).toBe(0)
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
      // These tests exercise the foreground merge-into-RAM path (scroll-up /
      // active-room catch-up), so the room must be the active one. Background
      // catch-up of a NON-active room (IDB + preview, no RAM) is covered below.
      roomStore.setState({ activeRoomJid: roomJid })
    })

    it('background catch-up of a NON-active room persists to IndexedDB + preview but not RAM', () => {
      // roomJid is NOT the active room here (background catch-up of another room).
      roomStore.setState({ activeRoomJid: 'other@conference.example.com' })
      vi.mocked(messageCache.saveRoomMessages).mockClear()

      const mam: RoomMessage[] = [
        { type: 'groupchat', id: 'bg-1', roomJid, from: `${roomJid}/bob`, nick: 'bob', body: 'caught up 1', timestamp: new Date('2024-02-01T10:00:00Z'), isOutgoing: false },
        { type: 'groupchat', id: 'bg-2', roomJid, from: `${roomJid}/bob`, nick: 'bob', body: 'caught up 2', timestamp: new Date('2024-02-01T10:01:00Z'), isOutgoing: false },
      ]

      roomStore.getState().mergeRoomMAMMessages(roomJid, mam, {}, true, 'forward')

      // Persisted to IndexedDB (durable history)...
      expect(messageCache.saveRoomMessages).toHaveBeenCalled()
      // ...sidebar preview updated...
      expect(roomStore.getState().rooms.get(roomJid)?.lastMessage?.id).toBe('bg-2')
      // ...but the resident array is NOT populated (only the active room is in RAM).
      expect(roomStore.getState().rooms.get(roomJid)?.messages).toEqual([])
      expect(roomStore.getState().roomRuntime.get(roomJid)?.messages).toEqual([])
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

  describe('mergeRoomMAMMessages badge hydration', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))
      // Background catch-up hydration only applies to a NON-active room —
      // point activeRoomJid elsewhere unless a test explicitly marks roomJid active.
      roomStore.setState({ activeRoomJid: 'other@conference.example.com' })
    })

    it('forward merge into a non-active room recomputes unread and mention counts from the pointer', () => {
      roomStore.setState((state) => {
        const meta = new Map(state.roomMeta)
        meta.set(roomJid, { ...meta.get(roomJid)!, lastSeenMessageId: 'm1' })
        return { roomMeta: meta }
      })

      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'm1',
          roomJid,
          from: `${roomJid}/alice`,
          nick: 'alice',
          body: 'Already read',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
        {
          type: 'groupchat',
          id: 'm2',
          roomJid,
          from: `${roomJid}/bob`,
          nick: 'bob',
          body: '@me hi',
          timestamp: new Date('2024-01-15T10:01:00Z'),
          isOutgoing: false,
          isDelayed: true,
          isMention: true,
        },
        {
          type: 'groupchat',
          id: 'm3',
          roomJid,
          from: `${roomJid}/charlie`,
          nick: 'charlie',
          body: 'Also new',
          timestamp: new Date('2024-01-15T10:02:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, true, 'forward')

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.unreadCount).toBe(2)
      expect(meta?.mentionsCount).toBe(1)
      // Combined map mirrors meta.
      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.unreadCount).toBe(2)
      expect(room?.mentionsCount).toBe(1)
    })

    it('forward merge into a room with NO read state snaps the pointer (fresh-join guard)', () => {
      // No lastSeenMessageId/lastReadAt seeded — fresh room, never read.
      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'f1',
          roomJid,
          from: `${roomJid}/alice`,
          nick: 'alice',
          body: 'History 1',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
        {
          type: 'groupchat',
          id: 'f2',
          roomJid,
          from: `${roomJid}/bob`,
          nick: 'bob',
          body: 'History 2',
          timestamp: new Date('2024-01-15T10:01:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
        {
          type: 'groupchat',
          id: 'f3',
          roomJid,
          from: `${roomJid}/charlie`,
          nick: 'charlie',
          body: 'History 3',
          timestamp: new Date('2024-01-15T10:02:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, true, 'forward')

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.unreadCount).toBe(0)
      expect(meta?.mentionsCount).toBe(0)
      expect(meta?.lastSeenMessageId).toBe('f3')
    })

    it('backward merge does not touch counts', () => {
      roomStore.setState((state) => {
        const meta = new Map(state.roomMeta)
        meta.set(roomJid, { ...meta.get(roomJid)!, lastSeenMessageId: 'm1', unreadCount: 5, mentionsCount: 1 })
        return { roomMeta: meta }
      })

      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'older-1',
          roomJid,
          from: `${roomJid}/alice`,
          nick: 'alice',
          body: 'Older history',
          timestamp: new Date('2024-01-15T09:00:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, true, 'backward')

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.unreadCount).toBe(5)
      expect(meta?.mentionsCount).toBe(1)
    })

    it('forward merge into the ACTIVE room does not touch counts', () => {
      roomStore.setState({ activeRoomJid: roomJid })
      roomStore.setState((state) => {
        const meta = new Map(state.roomMeta)
        meta.set(roomJid, { ...meta.get(roomJid)!, lastSeenMessageId: 'm1', unreadCount: 0, mentionsCount: 0 })
        return { roomMeta: meta }
      })

      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'm2',
          roomJid,
          from: `${roomJid}/bob`,
          nick: 'bob',
          body: '@me hi',
          timestamp: new Date('2024-01-15T10:01:00Z'),
          isOutgoing: false,
          isDelayed: true,
          isMention: true,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, true, 'forward')

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.unreadCount).toBe(0)
      expect(meta?.mentionsCount).toBe(0)
    })
  })

  describe('mergeRoomMAMMessages gap tracking', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))
    })

    it('should set forwardGapTimestamp when forward catch-up is incomplete', () => {
      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'mam-1',
          roomJid,
          from: `${roomJid}/alice`,
          nick: 'alice',
          body: 'Message 1',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
        },
        {
          type: 'groupchat',
          id: 'mam-2',
          roomJid,
          from: `${roomJid}/bob`,
          nick: 'bob',
          body: 'Message 2',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: false,
        },
      ]

      // Forward, incomplete (complete=false)
      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, false, 'forward')

      const mamState = roomStore.getState().getRoomMAMQueryState(roomJid)
      expect(mamState.isCaughtUpToLive).toBe(false)
      expect(mamState.forwardGapTimestamp).toBe(new Date('2024-01-15T12:00:00Z').getTime())
    })

    it('should clear forwardGapTimestamp when forward catch-up completes', () => {
      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'mam-1',
          roomJid,
          from: `${roomJid}/alice`,
          nick: 'alice',
          body: 'Message',
          timestamp: new Date('2024-01-15T14:00:00Z'),
          isOutgoing: false,
        },
      ]

      // First: incomplete sets gap
      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, false, 'forward')
      expect(roomStore.getState().getRoomMAMQueryState(roomJid).forwardGapTimestamp).toBeDefined()

      // Second: complete clears gap
      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, true, 'forward')
      const mamState = roomStore.getState().getRoomMAMQueryState(roomJid)
      expect(mamState.isCaughtUpToLive).toBe(true)
      expect(mamState.forwardGapTimestamp).toBeUndefined()
    })

    it('should not set forwardGapTimestamp for empty MAM results', () => {
      // Forward, incomplete, but no messages — no gap timestamp to compute
      roomStore.getState().mergeRoomMAMMessages(roomJid, [], {}, false, 'forward')

      const mamState = roomStore.getState().getRoomMAMQueryState(roomJid)
      expect(mamState.isCaughtUpToLive).toBe(false)
      expect(mamState.forwardGapTimestamp).toBeUndefined()
    })

    it('should not set forwardGapTimestamp for backward queries', () => {
      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'mam-1',
          roomJid,
          from: `${roomJid}/alice`,
          nick: 'alice',
          body: 'Old message',
          timestamp: new Date('2024-01-10T10:00:00Z'),
          isOutgoing: false,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, { first: 'mam-1' }, false, 'backward')

      const mamState = roomStore.getState().getRoomMAMQueryState(roomJid)
      expect(mamState.forwardGapTimestamp).toBeUndefined()
    })

    it('should use the newest message timestamp for gap position', () => {
      const mamMessages: RoomMessage[] = [
        {
          type: 'groupchat',
          id: 'mam-1',
          roomJid,
          from: `${roomJid}/alice`,
          nick: 'alice',
          body: 'Earlier',
          timestamp: new Date('2024-01-15T08:00:00Z'),
          isOutgoing: false,
        },
        {
          type: 'groupchat',
          id: 'mam-2',
          roomJid,
          from: `${roomJid}/bob`,
          nick: 'bob',
          body: 'Latest',
          timestamp: new Date('2024-01-15T16:00:00Z'),
          isOutgoing: false,
        },
        {
          type: 'groupchat',
          id: 'mam-3',
          roomJid,
          from: `${roomJid}/carol`,
          nick: 'carol',
          body: 'Middle',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: false,
        },
      ]

      roomStore.getState().mergeRoomMAMMessages(roomJid, mamMessages, {}, false, 'forward')

      const mamState = roomStore.getState().getRoomMAMQueryState(roomJid)
      // Should pick the newest timestamp (16:00), not the last in array order
      expect(mamState.forwardGapTimestamp).toBe(new Date('2024-01-15T16:00:00Z').getTime())
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

  describe('loadPreviewFromCache', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().reset()
      vi.mocked(messageCache.getRoomMessages).mockReset()
      const room: Room = {
        jid: roomJid,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        isJoining: false,
        isBookmarked: false,
        supportsMAM: false, // Non-MAM room
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      }
      roomStore.getState().addRoom(room)
    })

    it('should load latest message from cache and set as lastMessage', async () => {
      const cachedMessage: RoomMessage = {
        type: 'groupchat',
        id: 'cached-1',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Cached message',
        timestamp: new Date('2024-01-15T10:00:00Z'),
        isOutgoing: false,
      }
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([cachedMessage])

      const result = await roomStore.getState().loadPreviewFromCache(roomJid)

      expect(result).toEqual(cachedMessage)
      expect(messageCache.getRoomMessages).toHaveBeenCalledWith(roomJid, {
        limit: 10,
        latest: true,
      })

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.lastMessage?.body).toBe('Cached message')
    })

    it('should return null when no cached messages exist', async () => {
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([])

      const result = await roomStore.getState().loadPreviewFromCache(roomJid)

      expect(result).toBeNull()

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.lastMessage).toBeUndefined()
    })

    it('should not overwrite newer lastMessage with older cached message', async () => {
      // Set a newer lastMessage first
      const newerMessage: RoomMessage = {
        type: 'groupchat',
        id: 'new-1',
        roomJid,
        from: `${roomJid}/bob`,
        nick: 'bob',
        body: 'Newer message',
        timestamp: new Date('2024-01-15T12:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().updateLastMessagePreview(roomJid, newerMessage)

      // Try to load older cached message
      const olderCachedMessage: RoomMessage = {
        type: 'groupchat',
        id: 'old-1',
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: 'Older cached',
        timestamp: new Date('2024-01-15T08:00:00Z'),
        isOutgoing: false,
      }
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([olderCachedMessage])

      await roomStore.getState().loadPreviewFromCache(roomJid)

      // Should still have the newer message
      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.lastMessage?.body).toBe('Newer message')
    })

    it('should return null for non-existent room', async () => {
      const result = await roomStore.getState().loadPreviewFromCache('nonexistent@conference.example.com')

      expect(result).toBeNull()
      expect(messageCache.getRoomMessages).not.toHaveBeenCalled()
    })
  })

  describe('hydratePreviewsFromCache', () => {
    const roomA = 'a@conference.example.com'
    const roomB = 'b@conference.example.com'

    function makeMsg(roomJid: string, iso: string, body: string): RoomMessage {
      return {
        type: 'groupchat',
        id: `${roomJid}-${iso}`,
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body,
        timestamp: new Date(iso),
        isOutgoing: false,
      }
    }

    function addBookmarkedRoom(jid: string): void {
      roomStore.getState().addRoom({
        jid,
        name: jid,
        nickname: 'me',
        joined: false,
        isJoining: false,
        isBookmarked: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
    }

    beforeEach(() => {
      roomStore.getState().reset()
      vi.mocked(messageCache.getRoomMessages).mockReset()
      vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(true)
    })

    // Restore the shared cache mocks so overrides here don't leak into later blocks.
    afterEach(() => {
      vi.mocked(messageCache.getRoomMessages).mockReset()
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([])
      vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(true)
    })

    it('orders the sidebar from cache at launch and only writes the store ONCE', async () => {
      // Added in A-then-B order with no lastMessage -> both would sort at epoch 0.
      addBookmarkedRoom(roomA)
      addBookmarkedRoom(roomB)
      expect(roomStore.getState().rooms.get(roomA)?.lastMessage).toBeUndefined()
      expect(roomStore.getState().rooms.get(roomB)?.lastMessage).toBeUndefined()

      // B's newest cached message is more recent than A's.
      vi.mocked(messageCache.getRoomMessages).mockImplementation((jid) =>
        Promise.resolve(
          jid === roomB
            ? [makeMsg(roomB, '2024-01-15T12:00:00Z', 'newer')]
            : [makeMsg(roomA, '2024-01-15T09:00:00Z', 'older')],
        ),
      )

      let writes = 0
      const unsub = roomStore.subscribe(() => { writes++ })
      await roomStore.getState().hydratePreviewsFromCache()
      unsub()

      // Both previews populated from cache...
      expect(roomStore.getState().rooms.get(roomA)?.lastMessage?.body).toBe('older')
      expect(roomStore.getState().rooms.get(roomB)?.lastMessage?.body).toBe('newer')
      // ...and B (most recent) now sorts above A, without ever opening a room.
      expect(roomStore.getState().allRooms().map((r) => r.jid)).toEqual([roomB, roomA])
      // Batched: a single store write regardless of room count (one sidebar re-sort).
      expect(writes).toBe(1)
    })

    it('never downgrades a fresher preview already set by join/catch-up', async () => {
      addBookmarkedRoom(roomA)
      const fresh = makeMsg(roomA, '2024-01-15T15:00:00Z', 'fresh from join')
      roomStore.getState().updateLastMessagePreview(roomA, fresh)

      // Cache only has an older message.
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([
        makeMsg(roomA, '2024-01-15T08:00:00Z', 'stale cache'),
      ])

      let writes = 0
      const unsub = roomStore.subscribe(() => { writes++ })
      await roomStore.getState().hydratePreviewsFromCache()
      unsub()

      expect(roomStore.getState().rooms.get(roomA)?.lastMessage?.body).toBe('fresh from join')
      // Nothing to update -> no store write at all.
      expect(writes).toBe(0)
    })

    it('is a no-op when the message cache is unavailable', async () => {
      addBookmarkedRoom(roomA)
      vi.mocked(messageCache.isMessageCacheAvailable).mockReturnValue(false)

      await roomStore.getState().hydratePreviewsFromCache()

      expect(messageCache.getRoomMessages).not.toHaveBeenCalled()
    })
  })

  describe('loadMessagesAroundFromCache', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().reset()
      vi.mocked(messageCache.getRoomMessagesAround).mockReset()
      vi.mocked(messageCache.getRoomMessagesAround).mockResolvedValue([])
      roomStore.getState().addRoom({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        isJoining: false,
        isBookmarked: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
    })

    function roomMsgAt(id: string, minute: number): RoomMessage {
      return {
        type: 'groupchat',
        id,
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: id,
        timestamp: new Date(`2024-03-01T10:0${minute}:00Z`),
        isOutgoing: false,
      }
    }

    it('hydrates the resident array with the cache slice that contains the anchor', async () => {
      const slice = [roomMsgAt('old-3', 3), roomMsgAt('anchor', 4), roomMsgAt('newer-5', 5)]
      vi.mocked(messageCache.getRoomMessagesAround).mockResolvedValue(slice)

      const returned = await roomStore.getState().loadMessagesAroundFromCache(roomJid, 'anchor')

      expect(messageCache.getRoomMessagesAround).toHaveBeenCalledWith(roomJid, 'anchor', expect.any(Object))
      const resident = roomStore.getState().rooms.get(roomJid)?.messages
      expect(resident?.map((m) => m.id)).toEqual(['old-3', 'anchor', 'newer-5'])
      expect(returned.map((m) => m.id)).toEqual(['old-3', 'anchor', 'newer-5'])
    })
  })

  describe('loadOlderMessagesFromCache (sliding window)', () => {
    const roomJid = 'room@conference.example.com'
    // Mirrors roomStore's RESIDENT_WINDOW_SIZE (formerly MAX_MESSAGES_PER_ROOM).
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      roomStore.getState().reset()
      vi.mocked(messageCache.getRoomMessages).mockReset()
      roomStore.getState().addRoom({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        isJoining: false,
        isBookmarked: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
    })

    function roomMsgAt(id: string, minuteOffset: number): RoomMessage {
      return {
        type: 'groupchat',
        id,
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: id,
        // minuteOffset is relative to a fixed epoch so older-batch ids sort before resident ids.
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    it('slides the window: keeps the just-loaded older batch and evicts the newest tail', async () => {
      // Seed the room at the resident cap - minutes 50..5049 so ids are 'resident-0'..'resident-4999'.
      const resident: RoomMessage[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(roomMsgAt(`resident-${i}`, 50 + i))
      }
      roomStore.setState((state) => {
        const newRooms = new Map(state.rooms)
        const existing = newRooms.get(roomJid)!
        newRooms.set(roomJid, { ...existing, messages: resident })
        return { rooms: newRooms }
      })

      // Cache returns 50 messages older than the current oldest resident message (minute 50).
      const olderBatch: RoomMessage[] = []
      for (let i = 0; i < 50; i++) {
        olderBatch.push(roomMsgAt(`older-${i}`, i))
      }
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(olderBatch)

      await roomStore.getState().loadOlderMessagesFromCache(roomJid, 50)

      const room = roomStore.getState().rooms.get(roomJid)
      // Window size is preserved...
      expect(room?.messages.length).toBe(RESIDENT_WINDOW_SIZE)
      // ...but the just-loaded older batch is now resident (oldest id is from the older batch)...
      expect(room?.messages[0].id).toBe('older-0')
      // ...which means the window slid: the newest 50 resident messages were evicted.
      expect(room?.messages.some((m) => m.id === 'resident-4999')).toBe(false)
      expect(room?.messages[room.messages.length - 1].id).toBe('resident-4949')
    })
  })

  describe('windowAtLiveEdge gating (sliding window)', () => {
    const roomJid = 'room@conference.example.com'
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      roomStore.getState().reset()
      vi.mocked(messageCache.getRoomMessages).mockReset()
      vi.mocked(messageCache.saveRoomMessage).mockClear()
      roomStore.getState().addRoom({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        isJoining: false,
        isBookmarked: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
    })

    function roomMsgAt(id: string, minuteOffset: number): RoomMessage {
      return {
        type: 'groupchat',
        id,
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: id,
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    // Seed the room at the resident cap and slide the window up so its newest tail is evicted.
    function seedSlidWindow() {
      const resident: RoomMessage[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(roomMsgAt(`resident-${i}`, 50 + i))
      }
      roomStore.setState((state) => {
        const newRooms = new Map(state.rooms)
        const existing = newRooms.get(roomJid)!
        newRooms.set(roomJid, { ...existing, messages: resident })
        const newRuntime = new Map(state.roomRuntime)
        const existingRuntime = newRuntime.get(roomJid)!
        newRuntime.set(roomJid, { ...existingRuntime, messages: resident })
        return { rooms: newRooms, roomRuntime: newRuntime }
      })

      const olderBatch: RoomMessage[] = []
      for (let i = 0; i < 50; i++) {
        olderBatch.push(roomMsgAt(`older-${i}`, i))
      }
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(olderBatch)
    }

    it('a fresh room seeded via addRoom is at the live edge', () => {
      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(true)
    })

    it('appends a live message when the window is at the live edge (default)', () => {
      const live = roomMsgAt('live-1', 10000)
      roomStore.getState().addMessage(roomJid, live)

      const room = roomStore.getState().getRoom(roomJid)!
      expect(room.messages.some((m) => m.id === 'live-1')).toBe(true)
      expect(room.lastMessage?.id).toBe('live-1')
    })

    it('sets windowAtLiveEdge false after a load-older that evicts the newest tail', async () => {
      seedSlidWindow()
      await roomStore.getState().loadOlderMessagesFromCache(roomJid, 50)
      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(false)
    })

    it('does not append a live message when the window has slid off the live edge, but still persists to cache and updates meta', async () => {
      seedSlidWindow()
      await roomStore.getState().loadOlderMessagesFromCache(roomJid, 50)
      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(false)

      vi.mocked(messageCache.saveRoomMessage).mockClear()
      const before = roomStore.getState().getRoom(roomJid)!.messages
      const live = roomMsgAt('live-1', 10000)
      roomStore.getState().addMessage(roomJid, live)

      const room = roomStore.getState().getRoom(roomJid)!
      // Resident array is unchanged (no false-adjacency gap appended)...
      expect(room.messages.some((m) => m.id === 'live-1')).toBe(false)
      expect(room.messages.length).toBe(before.length)
      expect(room.messages[room.messages.length - 1].id).toBe(before[before.length - 1].id)
      // ...but the message is still persisted to IndexedDB...
      expect(messageCache.saveRoomMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'live-1' }))
      // ...and meta (sidebar preview + unread badge) still update.
      expect(room.lastMessage?.id).toBe('live-1')
      expect(roomStore.getState().roomMeta.get(roomJid)?.lastMessage?.id).toBe('live-1')
      expect(room.unreadCount).toBe(1)
    })

    it('recenters to the live edge when the latest window is (re)loaded', async () => {
      seedSlidWindow()
      await roomStore.getState().loadOlderMessagesFromCache(roomJid, 50)
      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(false)

      // A latest-N load (activation path) makes the newest messages resident again.
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([roomMsgAt('latest-1', 9000)])
      await roomStore.getState().loadMessagesFromCache(roomJid, { limit: 100 })
      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(true)
    })

    it('mergeRoomMAMMessages flips windowAtLiveEdge true on a fetch-latest merge, but a plain backward merge does not', () => {
      roomStore.setState({ activeRoomJid: roomJid })
      // Seed the flag false, as if a prior scroll-up slid the window off the live edge.
      roomStore.setState((state) => {
        const newRuntime = new Map(state.roomRuntime)
        const existing = newRuntime.get(roomJid)!
        newRuntime.set(roomJid, { ...existing, windowAtLiveEdge: false })
        return { roomRuntime: newRuntime }
      })

      // A plain backward merge (isFetchLatest false) must not flip it back.
      const older = roomMsgAt('older-1', 1)
      roomStore.getState().mergeRoomMAMMessages(roomJid, [older], {}, false, 'backward')
      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(false)

      // A fetch-latest merge lands the window AT the live edge by construction.
      const fresh = roomMsgAt('fresh-1', 20000)
      roomStore.getState().mergeRoomMAMMessages(roomJid, [fresh], {}, false, 'backward', false, true)
      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(true)
    })
  })

  describe('loadNewerMessagesFromCache (sliding window)', () => {
    const roomJid = 'room@conference.example.com'
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      roomStore.getState().reset()
      vi.mocked(messageCache.getRoomMessages).mockReset()
      roomStore.getState().addRoom({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        isJoining: false,
        isBookmarked: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
    })

    function roomMsgAt(id: string, minuteOffset: number): RoomMessage {
      return {
        type: 'groupchat',
        id,
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: id,
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    // Seed the room at the resident cap with a slid-up window (oldest resident is 'resident-0').
    function seedResidentWindow() {
      const resident: RoomMessage[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(roomMsgAt(`resident-${i}`, i))
      }
      roomStore.setState((state) => {
        const newRooms = new Map(state.rooms)
        const existing = newRooms.get(roomJid)!
        newRooms.set(roomJid, { ...existing, messages: resident })
        const newRuntime = new Map(state.roomRuntime)
        const existingRuntime = newRuntime.get(roomJid)!
        newRuntime.set(roomJid, { ...existingRuntime, messages: resident, windowAtLiveEdge: false })
        return { rooms: newRooms, roomRuntime: newRuntime }
      })
    }

    it('appends the newer batch and evicts the oldest at the bound', async () => {
      seedResidentWindow()

      // Cache returns 50 messages newer than the current newest resident message (minute 4999).
      const newerBatch: RoomMessage[] = []
      for (let i = 0; i < 50; i++) {
        newerBatch.push(roomMsgAt(`newer-${i}`, RESIDENT_WINDOW_SIZE + i))
      }
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(newerBatch)

      await roomStore.getState().loadNewerMessagesFromCache(roomJid, 50)

      const room = roomStore.getState().rooms.get(roomJid)
      // Window size is preserved...
      expect(room?.messages.length).toBe(RESIDENT_WINDOW_SIZE)
      // ...the just-loaded newer batch is now resident (newest id is from the newer batch)...
      expect(room?.messages[room.messages.length - 1].id).toBe('newer-49')
      // ...which means the window slid down: the oldest 50 resident messages were evicted.
      expect(room?.messages.some((m) => m.id === 'resident-0')).toBe(false)
      expect(room?.messages[0].id).toBe('resident-50')
    })

    it('queries the cache with an after-cursor at the newest resident timestamp', async () => {
      seedResidentWindow()
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([])

      await roomStore.getState().loadNewerMessagesFromCache(roomJid, 50)

      const newestInMemory = roomMsgAt(`resident-${RESIDENT_WINDOW_SIZE - 1}`, RESIDENT_WINDOW_SIZE - 1)
      expect(messageCache.getRoomMessages).toHaveBeenCalledWith(roomJid, {
        after: newestInMemory.timestamp,
        limit: 50,
      })
    })

    it('sets windowAtLiveEdge true when the cache returns fewer than the limit (reached the tail)', async () => {
      seedResidentWindow()
      // Fewer than the requested limit ⇒ no more newer messages remain in the cache.
      const newerBatch = [roomMsgAt('newer-0', RESIDENT_WINDOW_SIZE)]
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(newerBatch)

      await roomStore.getState().loadNewerMessagesFromCache(roomJid, 50)

      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(true)
    })

    it('leaves windowAtLiveEdge slid (false) when a full batch returns (more newer remain)', async () => {
      seedResidentWindow()
      const newerBatch: RoomMessage[] = []
      for (let i = 0; i < 50; i++) {
        newerBatch.push(roomMsgAt(`newer-${i}`, RESIDENT_WINDOW_SIZE + i))
      }
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(newerBatch)

      await roomStore.getState().loadNewerMessagesFromCache(roomJid, 50)

      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(false)
    })

    it('returns an empty array and does nothing when the room has no resident messages', async () => {
      const returned = await roomStore.getState().loadNewerMessagesFromCache(roomJid, 50)
      expect(returned).toEqual([])
      expect(messageCache.getRoomMessages).not.toHaveBeenCalled()
    })
  })

  describe('recenterToLatest (sliding window)', () => {
    const roomJid = 'room@conference.example.com'
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      roomStore.getState().reset()
      vi.mocked(messageCache.getRoomMessages).mockReset()
      roomStore.getState().addRoom({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        isJoining: false,
        isBookmarked: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
    })

    function roomMsgAt(id: string, minuteOffset: number): RoomMessage {
      return {
        type: 'groupchat',
        id,
        roomJid,
        from: `${roomJid}/alice`,
        nick: 'alice',
        body: id,
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    it('reloads the newest window and sets windowAtLiveEdge true', async () => {
      // Seed a slid-up window (evicted the newest tail via load-older).
      const resident: RoomMessage[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(roomMsgAt(`resident-${i}`, 50 + i))
      }
      roomStore.setState((state) => {
        const newRooms = new Map(state.rooms)
        const existing = newRooms.get(roomJid)!
        newRooms.set(roomJid, { ...existing, messages: resident })
        const newRuntime = new Map(state.roomRuntime)
        const existingRuntime = newRuntime.get(roomJid)!
        newRuntime.set(roomJid, { ...existingRuntime, messages: resident, windowAtLiveEdge: false })
        return { rooms: newRooms, roomRuntime: newRuntime }
      })

      const latestBatch = [roomMsgAt('latest-1', 90000)]
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue(latestBatch)

      await roomStore.getState().recenterToLatest(roomJid)

      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(true)
      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.messages.some((m) => m.id === 'latest-1')).toBe(true)
    })

    it('sets windowAtLiveEdge true even when the cache has nothing newer (already-resident latest window)', async () => {
      vi.mocked(messageCache.getRoomMessages).mockResolvedValue([])

      await roomStore.getState().recenterToLatest(roomJid)

      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(true)
    })
  })

  describe('mergeRoomMembers', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))
    })

    it('stores affiliatedMembers on the room', () => {
      const members = [
        { jid: 'alice@example.com', nick: 'Alice', affiliation: 'owner' as const },
        { jid: 'bob@example.com', nick: 'Bob', affiliation: 'member' as const },
      ]

      roomStore.getState().mergeRoomMembers(roomJid, members)

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.affiliatedMembers).toEqual(members)
    })

    it('populates nickToJidCache from members with nicks', () => {
      const members = [
        { jid: 'alice@example.com', nick: 'Alice', affiliation: 'owner' as const },
        { jid: 'bob@example.com', nick: 'Bob', affiliation: 'member' as const },
      ]

      roomStore.getState().mergeRoomMembers(roomJid, members)

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.nickToJidCache?.get('Alice')).toBe('alice@example.com')
      expect(room?.nickToJidCache?.get('Bob')).toBe('bob@example.com')
    })

    it('skips members without nicks for cache population', () => {
      const members = [
        { jid: 'alice@example.com', nick: 'Alice', affiliation: 'owner' as const },
        { jid: 'bob@example.com', affiliation: 'member' as const },
      ]

      roomStore.getState().mergeRoomMembers(roomJid, members)

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.nickToJidCache?.get('Alice')).toBe('alice@example.com')
      expect(room?.nickToJidCache?.size).toBe(1)
    })

    it('does not override existing nickToJidCache entries (occupant precedence)', () => {
      // First, set up an existing cache entry from an online occupant
      roomStore.getState().addOccupant(roomJid, {
        nick: 'Alice',
        jid: 'alice@example.com/desktop',
        affiliation: 'owner',
        role: 'moderator',
      })

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.nickToJidCache?.get('Alice')).toBe('alice@example.com')

      // Now merge members — Alice's cache entry should NOT be overwritten
      const members = [
        { jid: 'alice@different.com', nick: 'Alice', affiliation: 'owner' as const },
      ]

      roomStore.getState().mergeRoomMembers(roomJid, members)

      const updatedRoom = roomStore.getState().rooms.get(roomJid)
      expect(updatedRoom?.nickToJidCache?.get('Alice')).toBe('alice@example.com')
      // But affiliatedMembers should still be stored
      expect(updatedRoom?.affiliatedMembers).toEqual(members)
    })

    it('populates nickToAvatarCache using contactAvatarLookup', () => {
      const members = [
        { jid: 'alice@example.com', nick: 'Alice', affiliation: 'owner' as const },
        { jid: 'bob@example.com', nick: 'Bob', affiliation: 'member' as const },
      ]

      const avatarLookup = (jid: string) => {
        if (jid === 'alice@example.com') return 'blob:alice-avatar'
        return null
      }

      roomStore.getState().mergeRoomMembers(roomJid, members, avatarLookup)

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.nickToAvatarCache?.get('Alice')).toBe('blob:alice-avatar')
      expect(room?.nickToAvatarCache?.has('Bob')).toBe(false)
    })

    it('does nothing for empty members array', () => {
      roomStore.getState().mergeRoomMembers(roomJid, [])

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.affiliatedMembers).toBeUndefined()
    })

    it('does nothing for non-existent room', () => {
      // Should not throw
      roomStore.getState().mergeRoomMembers('nonexistent@conference.example.com', [
        { jid: 'alice@example.com', nick: 'Alice', affiliation: 'owner' as const },
      ])
    })

    it('updates roomRuntime alongside rooms map', () => {
      const members = [
        { jid: 'alice@example.com', nick: 'Alice', affiliation: 'owner' as const },
      ]

      roomStore.getState().mergeRoomMembers(roomJid, members)

      const runtime = roomStore.getState().roomRuntime.get(roomJid)
      expect(runtime?.affiliatedMembers).toEqual(members)
      expect(runtime?.nickToJidCache?.get('Alice')).toBe('alice@example.com')
    })
  })

  describe('updateMemberAffiliation', () => {
    const roomJid = 'room@conference.example.com'

    beforeEach(() => {
      roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))
    })

    function seedMembers() {
      roomStore.getState().mergeRoomMembers(roomJid, [
        { jid: 'alice@example.com', nick: 'Alice', affiliation: 'owner' as const },
        { jid: 'bob@example.com', nick: 'Bob', affiliation: 'member' as const },
      ])
    }

    it("removes a member from affiliatedMembers when affiliation is set to 'none'", () => {
      seedMembers()

      roomStore.getState().updateMemberAffiliation(roomJid, 'bob@example.com', 'none')

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.affiliatedMembers?.map((m) => m.jid)).toEqual(['alice@example.com'])
    })

    it('removes the last affiliated member (empty-list edge case)', () => {
      roomStore.getState().mergeRoomMembers(roomJid, [
        { jid: 'bob@example.com', nick: 'Bob', affiliation: 'member' as const },
      ])

      roomStore.getState().updateMemberAffiliation(roomJid, 'bob@example.com', 'none')

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.affiliatedMembers).toEqual([])
    })

    it("removes a member when affiliation is set to 'outcast' (banned, not an offline member)", () => {
      seedMembers()

      roomStore.getState().updateMemberAffiliation(roomJid, 'alice@example.com', 'outcast')

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.affiliatedMembers?.map((m) => m.jid)).toEqual(['bob@example.com'])
    })

    it('updates an existing member affiliation in place (member → admin)', () => {
      seedMembers()

      roomStore.getState().updateMemberAffiliation(roomJid, 'bob@example.com', 'admin')

      const room = roomStore.getState().rooms.get(roomJid)
      const bob = room?.affiliatedMembers?.find((m) => m.jid === 'bob@example.com')
      expect(bob?.affiliation).toBe('admin')
      expect(room?.affiliatedMembers).toHaveLength(2)
    })

    it('adds an offline user promoted to an affiliation when not already in the list', () => {
      seedMembers()

      roomStore.getState().updateMemberAffiliation(roomJid, 'carol@example.com', 'member')

      const room = roomStore.getState().rooms.get(roomJid)
      const carol = room?.affiliatedMembers?.find((m) => m.jid === 'carol@example.com')
      expect(carol).toEqual({ jid: 'carol@example.com', affiliation: 'member' })
      expect(room?.affiliatedMembers).toHaveLength(3)
    })

    it("is a no-op when removing a user not in the list", () => {
      seedMembers()

      roomStore.getState().updateMemberAffiliation(roomJid, 'dave@example.com', 'none')

      const room = roomStore.getState().rooms.get(roomJid)
      expect(room?.affiliatedMembers?.map((m) => m.jid)).toEqual([
        'alice@example.com',
        'bob@example.com',
      ])
    })

    it('updates roomRuntime alongside the rooms map', () => {
      seedMembers()

      roomStore.getState().updateMemberAffiliation(roomJid, 'bob@example.com', 'none')

      const runtime = roomStore.getState().roomRuntime.get(roomJid)
      expect(runtime?.affiliatedMembers?.map((m) => m.jid)).toEqual(['alice@example.com'])
    })

    it('does nothing for a non-existent room', () => {
      // Should not throw
      roomStore
        .getState()
        .updateMemberAffiliation('nonexistent@conference.example.com', 'alice@example.com', 'none')
    })
  })

  describe('updateMessage', () => {
    it('should update message found by client id', () => {
      const roomJid = 'room@conference.example.com'
      const msg = createMessage('client-id-1', roomJid, 'alice', 'Hello')
      const room = createRoom(roomJid, { messages: [msg], joined: true })
      roomStore.getState().addRoom(room)

      roomStore.getState().updateMessage(roomJid, 'client-id-1', { isRetracted: true })

      const updated = roomStore.getState().rooms.get(roomJid)?.messages[0]
      expect(updated?.isRetracted).toBe(true)
    })

    it('should update message found by stanzaId when messageId is a stanza-id', () => {
      const roomJid = 'room@conference.example.com'
      const msg: RoomMessage = {
        ...createMessage('client-id-1', roomJid, 'alice', 'Hello'),
        stanzaId: 'server-stanza-id-123',
      }
      const room = createRoom(roomJid, { messages: [msg], joined: true })
      roomStore.getState().addRoom(room)

      // Retraction references the stanza-id, not the client id
      roomStore.getState().updateMessage(roomJid, 'server-stanza-id-123', { isRetracted: true })

      const updated = roomStore.getState().rooms.get(roomJid)?.messages[0]
      expect(updated?.isRetracted).toBe(true)
      // Verify IndexedDB update uses actual message id, not the stanza-id
      expect(messageCache.updateRoomMessage).toHaveBeenCalledWith('client-id-1', { isRetracted: true })
    })

    it('should update message found by originId when a correction references the origin-id', () => {
      const roomJid = 'room@conference.example.com'
      const msg: RoomMessage = {
        ...createMessage('muc-rewritten-id', roomJid, 'alice', 'Hello'),
        originId: 'sender-origin-uuid',
        stanzaId: 'server-stanza-id-123',
      }
      const room = createRoom(roomJid, { messages: [msg], joined: true })
      roomStore.getState().addRoom(room)

      // XEP-0308 corrections reference the sender-assigned origin-id. If a MUC
      // rewrote the message id, matching on id/stanzaId alone would miss it.
      roomStore.getState().updateMessage(roomJid, 'sender-origin-uuid', { isEdited: true, body: 'Hello (fixed)' })

      const updated = roomStore.getState().rooms.get(roomJid)?.messages[0]
      expect(updated?.isEdited).toBe(true)
      expect(updated?.body).toBe('Hello (fixed)')
      // IndexedDB update still keyed by the actual stored message id.
      expect(messageCache.updateRoomMessage).toHaveBeenCalledWith('muc-rewritten-id', { isEdited: true, body: 'Hello (fixed)' })
    })

    it('should not touch an origin-id carrier when another message owns the id (no over-match)', () => {
      const roomJid = 'room@conference.example.com'
      const carrier: RoomMessage = {
        ...createMessage('other-id', roomJid, 'alice', 'carrier body'),
        originId: 'shared-value',
      }
      const owner = createMessage('shared-value', roomJid, 'alice', 'owner body')
      const room = createRoom(roomJid, { messages: [carrier, owner], joined: true })
      roomStore.getState().addRoom(room)

      // Reference resolves to the message that OWNS it as id — not the carrier
      // that merely holds it as a (spoofable) origin-id.
      roomStore.getState().updateMessage(roomJid, 'shared-value', { isEdited: true, body: 'edited' })

      const msgs = roomStore.getState().rooms.get(roomJid)?.messages
      const updatedOwner = msgs?.find((m) => m.id === 'shared-value')
      const untouchedCarrier = msgs?.find((m) => m.id === 'other-id')
      expect(updatedOwner?.body).toBe('edited')
      expect(updatedOwner?.isEdited).toBe(true)
      expect(untouchedCarrier?.body).toBe('carrier body')
      expect(untouchedCarrier?.isEdited).toBeUndefined()
    })

    it('should update roomRuntime messages in sync', () => {
      const roomJid = 'room@conference.example.com'
      const msg: RoomMessage = {
        ...createMessage('client-id-1', roomJid, 'alice', 'Hello'),
        stanzaId: 'server-stanza-id-123',
      }
      const room = createRoom(roomJid, { messages: [msg], joined: true })
      roomStore.getState().addRoom(room)

      roomStore.getState().updateMessage(roomJid, 'server-stanza-id-123', { isRetracted: true })

      const runtime = roomStore.getState().roomRuntime.get(roomJid)
      expect(runtime?.messages[0]?.isRetracted).toBe(true)
    })
  })

  describe('setTargetMessageId', () => {
    it('should set targetMessageId', () => {
      roomStore.getState().setTargetMessageId('msg-456')
      expect(roomStore.getState().targetMessageId).toBe('msg-456')
    })

    it('should clear targetMessageId when set to null', () => {
      roomStore.getState().setTargetMessageId('msg-456')
      roomStore.getState().setTargetMessageId(null)
      expect(roomStore.getState().targetMessageId).toBeNull()
    })

    it('should start as null', () => {
      expect(roomStore.getState().targetMessageId).toBeNull()
    })

    it('should be reset when store is reset', () => {
      roomStore.getState().setTargetMessageId('msg-456')
      roomStore.getState().reset()
      expect(roomStore.getState().targetMessageId).toBeNull()
    })
  })

  describe('poll vote tracking', () => {
    beforeEach(() => {
      localStorageMock.clear()
      vi.clearAllMocks()
      roomStore.setState({ votedPollIds: new Map() })
    })

    it('should record a poll vote for a room', () => {
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')

      const ids = roomStore.getState().getVotedPollIds('room1@conf')
      expect(ids.has('poll-1')).toBe(true)
    })

    it('should return empty set for room without votes', () => {
      const ids = roomStore.getState().getVotedPollIds('nonexistent@conf')
      expect(ids.size).toBe(0)
    })

    it('should track multiple votes in the same room', () => {
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')
      roomStore.getState().recordPollVote('room1@conf', 'poll-2')

      const ids = roomStore.getState().getVotedPollIds('room1@conf')
      expect(ids.has('poll-1')).toBe(true)
      expect(ids.has('poll-2')).toBe(true)
      expect(ids.size).toBe(2)
    })

    it('should maintain separate votes for different rooms', () => {
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')
      roomStore.getState().recordPollVote('room2@conf', 'poll-2')

      expect(roomStore.getState().getVotedPollIds('room1@conf').has('poll-1')).toBe(true)
      expect(roomStore.getState().getVotedPollIds('room1@conf').has('poll-2')).toBe(false)
      expect(roomStore.getState().getVotedPollIds('room2@conf').has('poll-2')).toBe(true)
    })

    it('should be idempotent when recording the same vote twice', () => {
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')

      expect(roomStore.getState().getVotedPollIds('room1@conf').size).toBe(1)
    })

    it('should remove a poll vote', () => {
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')
      roomStore.getState().recordPollVote('room1@conf', 'poll-2')
      roomStore.getState().removePollVote('room1@conf', 'poll-1')

      const ids = roomStore.getState().getVotedPollIds('room1@conf')
      expect(ids.has('poll-1')).toBe(false)
      expect(ids.has('poll-2')).toBe(true)
    })

    it('should not throw when removing non-existent vote', () => {
      expect(() => {
        roomStore.getState().removePollVote('room1@conf', 'nonexistent')
      }).not.toThrow()
    })

    it('should clean up room entry when last vote is removed', () => {
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')
      roomStore.getState().removePollVote('room1@conf', 'poll-1')

      expect(roomStore.getState().votedPollIds.has('room1@conf')).toBe(false)
    })

    it('should clear all voted polls on reset', () => {
      roomStore.getState().recordPollVote('room1@conf', 'poll-1')
      roomStore.getState().recordPollVote('room2@conf', 'poll-2')
      vi.clearAllMocks()

      roomStore.getState().reset()

      expect(roomStore.getState().votedPollIds.size).toBe(0)
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('fluux-room-voted-polls')
    })

    describe('localStorage persistence', () => {
      it('should persist vote to localStorage when recording', () => {
        roomStore.getState().recordPollVote('room1@conf', 'poll-1')

        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'fluux-room-voted-polls',
          JSON.stringify([['room1@conf', ['poll-1']]])
        )
      })

      it('should update localStorage when removing a vote', () => {
        roomStore.getState().recordPollVote('room1@conf', 'poll-1')
        roomStore.getState().recordPollVote('room1@conf', 'poll-2')
        vi.clearAllMocks()

        roomStore.getState().removePollVote('room1@conf', 'poll-1')

        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'fluux-room-voted-polls',
          JSON.stringify([['room1@conf', ['poll-2']]])
        )
      })

      it('should load voted polls from localStorage on switchAccount', () => {
        localStorageMock._store['fluux-room-voted-polls:alice@example.com'] = JSON.stringify([
          ['room1@conf', ['poll-1', 'poll-2']],
        ])

        roomStore.getState().switchAccount('alice@example.com')

        const ids = roomStore.getState().getVotedPollIds('room1@conf')
        expect(ids.has('poll-1')).toBe(true)
        expect(ids.has('poll-2')).toBe(true)
      })
    })
  })

  describe('poll dismissal tracking', () => {
    beforeEach(() => {
      localStorageMock.clear()
      vi.clearAllMocks()
      roomStore.setState({ dismissedPollIds: new Map() })
    })

    it('should dismiss a poll for a room', () => {
      roomStore.getState().dismissPoll('room1@conf', 'poll-1')

      const ids = roomStore.getState().getDismissedPollIds('room1@conf')
      expect(ids.has('poll-1')).toBe(true)
    })

    it('should return empty set for room without dismissals', () => {
      const ids = roomStore.getState().getDismissedPollIds('nonexistent@conf')
      expect(ids.size).toBe(0)
    })

    it('should track multiple dismissals in the same room', () => {
      roomStore.getState().dismissPoll('room1@conf', 'poll-1')
      roomStore.getState().dismissPoll('room1@conf', 'poll-2')

      const ids = roomStore.getState().getDismissedPollIds('room1@conf')
      expect(ids.size).toBe(2)
    })

    it('should maintain separate dismissals for different rooms', () => {
      roomStore.getState().dismissPoll('room1@conf', 'poll-1')
      roomStore.getState().dismissPoll('room2@conf', 'poll-2')

      expect(roomStore.getState().getDismissedPollIds('room1@conf').has('poll-1')).toBe(true)
      expect(roomStore.getState().getDismissedPollIds('room1@conf').has('poll-2')).toBe(false)
    })

    it('should clear all dismissed polls on reset', () => {
      roomStore.getState().dismissPoll('room1@conf', 'poll-1')
      vi.clearAllMocks()

      roomStore.getState().reset()

      expect(roomStore.getState().dismissedPollIds.size).toBe(0)
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('fluux-room-dismissed-polls')
    })

    describe('localStorage persistence', () => {
      it('should persist dismissal to localStorage', () => {
        roomStore.getState().dismissPoll('room1@conf', 'poll-1')

        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'fluux-room-dismissed-polls',
          JSON.stringify([['room1@conf', ['poll-1']]])
        )
      })

      it('should load dismissed polls from localStorage on switchAccount', () => {
        localStorageMock._store['fluux-room-dismissed-polls:alice@example.com'] = JSON.stringify([
          ['room1@conf', ['poll-1']],
        ])

        roomStore.getState().switchAccount('alice@example.com')

        expect(roomStore.getState().getDismissedPollIds('room1@conf').has('poll-1')).toBe(true)
      })
    })
  })

  describe('updateLastMessagePreview (#524 MUC preview parity)', () => {
    const ROOM = 'room1@conference.example.com'

    it('never lets a bodiless (non-previewable) message become the room preview', () => {
      const realMessage: RoomMessage = {
        type: 'groupchat',
        id: 'real-1',
        roomJid: ROOM,
        from: `${ROOM}/alice`,
        nick: 'alice',
        body: 'a real message',
        timestamp: new Date('2026-06-14T10:00:00.000Z'),
        isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true, messages: [realMessage] }))

      // An encrypted reaction replayed from MAM before the key was available is
      // stored as an empty-body message. It is NEWER than the real message, so a
      // timestamp-only gate would wrongly promote it to a blank sidebar preview.
      const bodilessReaction: RoomMessage = {
        type: 'groupchat',
        id: 'react-1',
        roomJid: ROOM,
        from: `${ROOM}/bob`,
        nick: 'bob',
        body: '',
        timestamp: new Date('2026-06-14T11:00:00.000Z'),
        isOutgoing: false,
      }

      roomStore.getState().updateLastMessagePreview(ROOM, bodilessReaction)

      // The real message stays the preview; the bodiless reaction is rejected.
      expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage?.body).toBe('a real message')
      expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage?.id).toBe('real-1')
    })

    it('heals a stuck bodiless placeholder when a real (even older) message arrives', () => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      // Seed a stuck, non-previewable placeholder as the current preview.
      const bodilessPlaceholder: RoomMessage = {
        type: 'groupchat',
        id: 'stuck-1',
        roomJid: ROOM,
        from: `${ROOM}/bob`,
        nick: 'bob',
        body: '',
        timestamp: new Date('2026-06-14T12:00:00.000Z'),
        isOutgoing: false,
      }
      roomStore.setState((state) => {
        const meta = state.roomMeta.get(ROOM)!
        const roomMeta = new Map(state.roomMeta)
        roomMeta.set(ROOM, { ...meta, lastMessage: bodilessPlaceholder })
        return { roomMeta }
      })

      // A real message OLDER than the stuck placeholder must still replace it.
      const realMessage: RoomMessage = {
        type: 'groupchat',
        id: 'real-2',
        roomJid: ROOM,
        from: `${ROOM}/alice`,
        nick: 'alice',
        body: 'real content',
        timestamp: new Date('2026-06-14T11:00:00.000Z'),
        isOutgoing: false,
      }

      roomStore.getState().updateLastMessagePreview(ROOM, realMessage)

      expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage?.body).toBe('real content')
    })
  })
})

describe('setActiveRoom new-message marker — delayed history unified with chats', () => {
  // The marker (firstNewMessageId) drives scroll position on room open. Rooms now
  // treat delayed (MUC <history> replay or MAM-fetched archive) messages the same
  // way chats treat offline-delivered messages: as new relative to the read
  // pointer. roomStore calls onActivate WITH treatDelayedAsNew (parity with
  // chatStore). A fresh join (no prior read state) still derives no marker —
  // that's guarded by the fresh-entity path, not by treatDelayedAsNew.
  const ROOM = 'room@conference.example.com'

  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
    })
    vi.clearAllMocks()
  })

  function delayedMsg(id: string, nick: string, ts: string): RoomMessage {
    return {
      type: 'groupchat',
      id,
      roomJid: ROOM,
      from: `${ROOM}/${nick}`,
      nick,
      body: id,
      timestamp: new Date(ts),
      isOutgoing: false,
      isDelayed: true,
    }
  }

  function activateWith(messages: RoomMessage[], lastSeenMessageId: string, unreadCount: number) {
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true, messages, unreadCount }))
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      const existing = meta.get(ROOM)!
      meta.set(ROOM, { ...existing, lastSeenMessageId })
      return { roomMeta: meta }
    })
    roomStore.getState().setActiveRoom(ROOM)
    return roomStore.getState().firstNewMessageMarkers.get(ROOM)
  }

  it('places the divider on delayed history after lastSeen (unified with chats)', () => {
    // Reuse the existing test's setup verbatim, but expect a marker: rooms now
    // treat delayed (MAM/history-replay) messages as new, same as chats.
    const marker = activateWith(
      [
        createMessage('seen', ROOM, 'alice', 'seen message'),
        delayedMsg('h-1', 'bob', '2025-01-15T10:00:00Z'),
        delayedMsg('h-2', 'carol', '2025-01-15T10:30:00Z'),
      ],
      'seen',
      2
    )
    expect(marker).toBe('h-1')
  })

  it('fresh join (no read state) derives no marker from delayed history', () => {
    // Same setup WITHOUT seeding lastSeenMessageId/lastReadAt/unreadCount — the
    // fresh-entity path has nothing to resume from, so no marker is derived.
    roomStore.getState().addRoom(createRoom(ROOM, {
      joined: true,
      messages: [
        delayedMsg('h-1', 'bob', '2025-01-15T10:00:00Z'),
        delayedMsg('h-2', 'carol', '2025-01-15T10:30:00Z'),
      ],
    }))
    roomStore.getState().setActiveRoom(ROOM)
    const marker = roomStore.getState().firstNewMessageMarkers.get(ROOM)
    expect(marker).toBeUndefined()
  })

  it('still sets the marker on a genuinely new live (non-delayed) message', () => {
    const marker = activateWith(
      [
        createMessage('seen', ROOM, 'alice', 'seen message'),
        createMessage('live', ROOM, 'bob', 'live message'), // isDelayed defaults to false
      ],
      'seen',
      1
    )
    expect(marker).toBe('live')
  })
})

describe('acknowledged non-anonymous rooms', () => {
  const ROOM = 'irc_%23chan@irc.example.com'

  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    roomStore.setState({ acknowledgedNonAnonymousRooms: new Set() })
    vi.clearAllMocks()
  })

  it('reports a room as not acknowledged by default', () => {
    expect(roomStore.getState().isNonAnonymousRoomAcknowledged(ROOM)).toBe(false)
  })

  it('marks a room acknowledged and reports it', () => {
    roomStore.getState().acknowledgeNonAnonymousRoom(ROOM)
    expect(roomStore.getState().isNonAnonymousRoomAcknowledged(ROOM)).toBe(true)
  })

  it('does not affect other rooms', () => {
    roomStore.getState().acknowledgeNonAnonymousRoom(ROOM)
    expect(roomStore.getState().isNonAnonymousRoomAcknowledged('other@conference.example.com')).toBe(false)
  })

  it('persists the acknowledgement under the scoped storage key', () => {
    setStorageScopeJid('alice@example.com')
    try {
      roomStore.getState().acknowledgeNonAnonymousRoom(ROOM)
      expect(localStorageMock._store['fluux-room-nonanon-ack:alice@example.com']).toBeDefined()
      expect(localStorageMock._store['fluux-room-nonanon-ack']).toBeUndefined()
    } finally {
      _resetStorageScopeForTesting()
    }
  })
})

// Regression tests for chat/room parity drifts: each of these behaviors already
// exists in chatStore and had silently diverged in roomStore (or vice versa).
describe('roomStore parity drift regressions', () => {
  const roomJid = 'drift@conference.example.com'

  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      firstNewMessageMarkers: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
    })
    roomStore.getState().addRoom(createRoom(roomJid, { joined: true }))
  })

  afterEach(() => {
    setResidentWindowSize(5000)
  })

  function messageAt(id: string, nick: string, body: string, iso: string): RoomMessage {
    return {
      type: 'groupchat',
      id,
      roomJid,
      from: `${roomJid}/${nick}`,
      nick,
      body,
      timestamp: new Date(iso),
      isOutgoing: false,
    }
  }

  describe('addMessage archive-id backfill (parity with chatStore)', () => {
    it('backfills the server stanzaId from a dropped duplicate echo', () => {
      const original: RoomMessage = {
        ...messageAt('orig-1', 'testuser', 'hello', '2024-01-15T10:00:00Z'),
        isOutgoing: true,
        originId: 'origin-abc',
      }
      roomStore.getState().addMessage(roomJid, original)
      vi.mocked(messageCache.updateRoomMessage).mockClear()

      // The MAM/archive copy of the same message arrives with the server archive id.
      const archived: RoomMessage = { ...original, stanzaId: 'archive-123' }
      roomStore.getState().addMessage(roomJid, archived)

      const messages = roomStore.getState().rooms.get(roomJid)?.messages || []
      expect(messages).toHaveLength(1)
      expect(messages[0].stanzaId).toBe('archive-123')
      // The runtime mirror must receive the same patched array.
      expect(roomStore.getState().roomRuntime.get(roomJid)?.messages[0]?.stanzaId).toBe('archive-123')
      // The backfill must also persist so the cursor survives a reload.
      expect(messageCache.updateRoomMessage).toHaveBeenCalledWith(
        'orig-1',
        expect.objectContaining({ stanzaId: 'archive-123' })
      )
    })
  })

  describe('backward MAM merge preview guard (parity with chatStore)', () => {
    it('does not regress the sidebar preview when keep-oldest evicts the newest tail', () => {
      setResidentWindowSize(2)
      roomStore.setState({ activeRoomJid: roomJid })

      const newest = messageAt('new-1', 'alice', 'newest', '2024-01-15T12:00:00Z')
      roomStore.getState().addMessage(roomJid, newest)
      expect(roomStore.getState().rooms.get(roomJid)?.lastMessage?.id).toBe('new-1')

      // Scroll-up merge: two older messages + window of 2 → keep-oldest evicts 'new-1'.
      const older = [
        messageAt('old-1', 'bob', 'old 1', '2024-01-15T10:00:00Z'),
        messageAt('old-2', 'bob', 'old 2', '2024-01-15T10:30:00Z'),
      ]
      roomStore.getState().mergeRoomMAMMessages(roomJid, older, { first: 'cursor-1' }, false, 'backward')

      // The resident window slid, but the sidebar preview must stay on the newest message.
      expect(roomStore.getState().rooms.get(roomJid)?.messages.map((m) => m.id)).toEqual(['old-1', 'old-2'])
      expect(roomStore.getState().rooms.get(roomJid)?.lastMessage?.id).toBe('new-1')
      expect(roomStore.getState().roomMeta.get(roomJid)?.lastMessage?.id).toBe('new-1')
    })

    it('still heals a preview stuck on an encrypted fallback (isResolvedSamePreview)', () => {
      // A non-resident room whose preview holds the undecrypted fallback: the
      // resolved copy arriving via MAM has the SAME id and timestamp, so the
      // newer-only guard alone would refuse it — the heal path must let it through.
      const encrypted: RoomMessage = {
        ...messageAt('enc-1', 'alice', '[OpenPGP-encrypted message]', '2024-01-15T12:00:00Z'),
        encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">…</openpgp>',
      }
      roomStore.setState((state) => {
        const rooms = new Map(state.rooms)
        const room = rooms.get(roomJid)!
        rooms.set(roomJid, { ...room, messages: [], lastMessage: encrypted })
        const roomMeta = new Map(state.roomMeta)
        roomMeta.set(roomJid, { ...roomMeta.get(roomJid)!, lastMessage: encrypted })
        return { rooms, roomMeta }
      })

      const resolved: RoomMessage = { ...encrypted, body: 'decrypted at last', encryptedPayload: undefined }
      roomStore.getState().mergeRoomMAMMessages(roomJid, [resolved], {}, true, 'forward')

      expect(roomStore.getState().rooms.get(roomJid)?.lastMessage?.body).toBe('decrypted at last')
      expect(roomStore.getState().roomMeta.get(roomJid)?.lastMessage?.body).toBe('decrypted at last')
    })

    it('deep-history around-load does not regress the sidebar preview (parity with chatStore)', async () => {
      // A room whose resident array was evicted (non-active) but whose preview
      // tracks the newest message — the state a scroll-position restore finds.
      const newest = messageAt('new-1', 'alice', 'newest', '2024-01-15T12:00:00Z')
      roomStore.setState((state) => {
        const rooms = new Map(state.rooms)
        rooms.set(roomJid, { ...rooms.get(roomJid)!, messages: [], lastMessage: newest })
        const roomMeta = new Map(state.roomMeta)
        roomMeta.set(roomJid, { ...roomMeta.get(roomJid)!, lastMessage: newest })
        return { rooms, roomMeta }
      })

      // Scroll-position restore loads an OLD slice around an anchor.
      const oldSlice = [
        messageAt('old-1', 'bob', 'deep 1', '2024-01-15T09:00:00Z'),
        messageAt('old-2', 'bob', 'deep 2', '2024-01-15T09:30:00Z'),
      ]
      vi.mocked(messageCache.getRoomMessagesAround).mockResolvedValueOnce(oldSlice)
      await roomStore.getState().loadMessagesAroundFromCache(roomJid, 'old-1')

      // The old slice must not replace the newest preview.
      expect(roomStore.getState().rooms.get(roomJid)?.lastMessage?.id).toBe('new-1')
      expect(roomStore.getState().roomMeta.get(roomJid)?.lastMessage?.id).toBe('new-1')
    })

    it('updateRoom routes lastMessage to roomMeta (was dropped by the hard-coded field list)', () => {
      const preview = messageAt('prev-1', 'alice', 'preview', '2024-01-15T10:00:00Z')

      roomStore.getState().updateRoom(roomJid, { lastMessage: preview })

      expect(roomStore.getState().rooms.get(roomJid)?.lastMessage?.id).toBe('prev-1')
      expect(roomStore.getState().roomMeta.get(roomJid)?.lastMessage?.id).toBe('prev-1')
    })

    it('updateRoom preserves untouched meta fields (full rebuild wiped lastMessage/lastSeen)', () => {
      const preview = messageAt('prev-1', 'alice', 'preview', '2024-01-15T10:00:00Z')
      roomStore.setState((state) => {
        const roomMeta = new Map(state.roomMeta)
        roomMeta.set(roomJid, { ...roomMeta.get(roomJid)!, lastMessage: preview, lastSeenMessageId: 'seen-1' })
        return { roomMeta }
      })

      roomStore.getState().updateRoom(roomJid, { unreadCount: 5 })

      const meta = roomStore.getState().roomMeta.get(roomJid)
      expect(meta?.unreadCount).toBe(5)
      expect(meta?.lastMessage?.id).toBe('prev-1')
      expect(meta?.lastSeenMessageId).toBe('seen-1')
    })

    it('updateRoom never recenters the window: windowAtLiveEdge survives a runtime update', () => {
      roomStore.setState((state) => {
        const roomRuntime = new Map(state.roomRuntime)
        roomRuntime.set(roomJid, { ...roomRuntime.get(roomJid)!, windowAtLiveEdge: false })
        return { roomRuntime }
      })

      roomStore.getState().updateRoom(roomJid, { occupants: new Map() })

      expect(roomStore.getState().roomRuntime.get(roomJid)?.windowAtLiveEdge).toBe(false)
    })

    it('MAM merge backfills the archive stanzaId onto resident messages (parity with chatStore)', () => {
      roomStore.setState({ activeRoomJid: roomJid })
      const own: RoomMessage = {
        ...messageAt('own-1', 'testuser', 'mine', '2024-01-15T10:00:00Z'),
        isOutgoing: true,
        originId: 'origin-merge',
      }
      roomStore.getState().addMessage(roomJid, own)
      vi.mocked(messageCache.updateRoomMessage).mockClear()

      // The archive copy of the same message arrives via MAM with the server id.
      const archived: RoomMessage = { ...own, stanzaId: 'arch-merge' }
      roomStore.getState().mergeRoomMAMMessages(roomJid, [archived], {}, true, 'forward')

      const messages = roomStore.getState().rooms.get(roomJid)?.messages || []
      expect(messages).toHaveLength(1)
      expect(messages[0].stanzaId).toBe('arch-merge')
      expect(roomStore.getState().roomRuntime.get(roomJid)?.messages[0]?.stanzaId).toBe('arch-merge')
      expect(messageCache.updateRoomMessage).toHaveBeenCalledWith(
        'own-1',
        expect.objectContaining({ stanzaId: 'arch-merge' })
      )
    })
  })
})
