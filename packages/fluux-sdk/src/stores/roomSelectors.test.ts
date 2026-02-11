import { describe, it, expect } from 'vitest'
import { roomSelectors } from './roomSelectors'
import type { RoomState } from './roomStore'
import type { Room, RoomEntity, RoomMetadata, RoomRuntime, RoomOccupant, RoomMessage, MAMQueryState } from '../core/types'

/**
 * Create a minimal RoomState mock for testing selectors.
 */
function createMockState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    rooms: new Map(),
    roomEntities: new Map(),
    roomMeta: new Map(),
    roomRuntime: new Map(),
    activeRoomJid: null,
    activeAnimation: null,
    drafts: new Map(),
    mamQueryStates: new Map(),
    // Actions are not needed for selector tests
    addRoom: () => {},
    updateRoom: () => {},
    removeRoom: () => {},
    setRoomJoined: () => {},
    addOccupant: () => {},
    batchAddOccupants: () => {},
    removeOccupant: () => {},
    setSelfOccupant: () => {},
    getRoom: () => undefined,
    reset: () => {},
    addMessage: () => {},
    updateReactions: () => {},
    updateMessage: () => {},
    getMessage: () => undefined,
    markAsRead: () => {},
    setActiveRoom: () => {},
    getActiveRoomJid: () => null,
    clearFirstNewMessageId: () => {},
    setTyping: () => {},
    setBookmark: () => {},
    removeBookmark: () => {},
    setNotifyAll: () => {},
    triggerAnimation: () => {},
    clearAnimation: () => {},
    setDraft: () => {},
    getDraft: () => '',
    clearDraft: () => {},
    loadMessagesFromCache: async () => [],
    loadOlderMessagesFromCache: async () => [],
    setRoomMAMLoading: () => {},
    setRoomMAMError: () => {},
    mergeRoomMAMMessages: () => {},
    getRoomMAMQueryState: () => ({ isLoading: false, hasQueried: false, error: null, isHistoryComplete: false, isCaughtUpToLive: false }),
    resetRoomMAMStates: () => {},
    joinedRooms: () => [],
    bookmarkedRooms: () => [],
    allRooms: () => [],
    quickChatRooms: () => [],
    activeRoom: () => undefined,
    activeMessages: () => [],
    totalMentionsCount: () => 0,
    totalUnreadCount: () => 0,
    totalNotifiableUnreadCount: () => 0,
    roomsWithUnreadCount: () => 0,
    updateOccupantAvatar: () => {},
    ...overrides,
  } as RoomState
}

function createMockRoom(jid: string, overrides: Partial<Room> = {}): Room {
  return {
    jid,
    name: `Room ${jid}`,
    nickname: 'me',
    joined: false,
    isBookmarked: false,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set<string>(),
    ...overrides,
  }
}

function createMockRoomMessage(id: string, roomJid: string, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    type: 'groupchat',
    id,
    roomJid,
    from: `${roomJid}/sender`,
    nick: 'sender',
    body: `Message ${id}`,
    timestamp: new Date(),
    isOutgoing: false,
    ...overrides,
  }
}

function createMockOccupant(nick: string, overrides: Partial<RoomOccupant> = {}): RoomOccupant {
  return {
    nick,
    affiliation: 'member',
    role: 'participant',
    ...overrides,
  }
}

describe('roomSelectors', () => {
  describe('roomJids', () => {
    it('should return empty array when no rooms', () => {
      const state = createMockState()
      const result = roomSelectors.roomJids(state)
      expect(result).toEqual([])
    })

    it('should return all room JIDs', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com')],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com')],
      ])
      const state = createMockState({ rooms })
      const result = roomSelectors.roomJids(state)
      expect(result).toContain('room1@conference.example.com')
      expect(result).toContain('room2@conference.example.com')
    })
  })

  describe('bookmarkedRoomJids', () => {
    it('should return only bookmarked room JIDs sorted by name', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { name: 'Zebra Room', isBookmarked: true })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { isBookmarked: false })],
        ['room3@conference.example.com', createMockRoom('room3@conference.example.com', { name: 'Alpha Room', isBookmarked: true })],
      ])
      const state = createMockState({ rooms })
      const result = roomSelectors.bookmarkedRoomJids(state)
      expect(result).toEqual(['room3@conference.example.com', 'room1@conference.example.com'])
    })
  })

  describe('joinedRoomJids', () => {
    it('should return only joined room JIDs', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { joined: true })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { joined: false })],
      ])
      const state = createMockState({ rooms })
      const result = roomSelectors.joinedRoomJids(state)
      expect(result).toEqual(['room1@conference.example.com'])
    })
  })

  describe('roomById', () => {
    it('should return room for given JID', () => {
      const room = createMockRoom('room@conference.example.com')
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      const result = roomSelectors.roomById('room@conference.example.com')(state)
      expect(result).toBe(room)
    })

    it('should return undefined for unknown JID', () => {
      const state = createMockState()
      const result = roomSelectors.roomById('unknown@conference.example.com')(state)
      expect(result).toBeUndefined()
    })
  })

  describe('messagesForRoom', () => {
    it('should return messages for given room', () => {
      const messages = [createMockRoomMessage('1', 'room@conference.example.com')]
      const room = createMockRoom('room@conference.example.com', { messages })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      const result = roomSelectors.messagesForRoom('room@conference.example.com')(state)
      expect(result).toBe(messages)
    })

    it('should return empty array for unknown room', () => {
      const state = createMockState()
      const result = roomSelectors.messagesForRoom('unknown@conference.example.com')(state)
      expect(result).toEqual([])
    })
  })

  describe('activeRoomJid', () => {
    it('should return null when no active room', () => {
      const state = createMockState()
      expect(roomSelectors.activeRoomJid(state)).toBeNull()
    })

    it('should return active room JID', () => {
      const state = createMockState({ activeRoomJid: 'room@conference.example.com' })
      expect(roomSelectors.activeRoomJid(state)).toBe('room@conference.example.com')
    })
  })

  describe('occupantsFor', () => {
    it('should return occupants for room', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1', createMockOccupant('user1')],
        ['user2', createMockOccupant('user2')],
      ])
      const room = createMockRoom('room@conference.example.com', { occupants })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      const result = roomSelectors.occupantsFor('room@conference.example.com')(state)
      expect(result).toBe(occupants)
    })
  })

  describe('occupantCountFor', () => {
    it('should return occupant count for room', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1', createMockOccupant('user1')],
        ['user2', createMockOccupant('user2')],
      ])
      const room = createMockRoom('room@conference.example.com', { occupants })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      expect(roomSelectors.occupantCountFor('room@conference.example.com')(state)).toBe(2)
    })
  })

  describe('typingFor', () => {
    it('should return typing users for room', () => {
      const typingUsers = new Set(['user1', 'user2'])
      const room = createMockRoom('room@conference.example.com', { typingUsers })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      const result = roomSelectors.typingFor('room@conference.example.com')(state)
      expect(result).toBe(typingUsers)
    })
  })

  describe('draftFor', () => {
    it('should return draft for room', () => {
      const drafts = new Map([['room@conference.example.com', 'Hello draft']])
      const state = createMockState({ drafts })
      expect(roomSelectors.draftFor('room@conference.example.com')(state)).toBe('Hello draft')
    })

    it('should return empty string for no draft', () => {
      const state = createMockState()
      expect(roomSelectors.draftFor('room@conference.example.com')(state)).toBe('')
    })
  })

  describe('hasDraft', () => {
    it('should return true when draft exists', () => {
      const drafts = new Map([['room@conference.example.com', 'Hello']])
      const state = createMockState({ drafts })
      expect(roomSelectors.hasDraft('room@conference.example.com')(state)).toBe(true)
    })

    it('should return false when no draft', () => {
      const state = createMockState()
      expect(roomSelectors.hasDraft('room@conference.example.com')(state)).toBe(false)
    })
  })

  describe('totalMentionsCount', () => {
    it('should sum mentions across joined rooms', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { joined: true, mentionsCount: 3 })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { joined: true, mentionsCount: 5 })],
        ['room3@conference.example.com', createMockRoom('room3@conference.example.com', { joined: false, mentionsCount: 10 })],
      ])
      const state = createMockState({ rooms })
      expect(roomSelectors.totalMentionsCount(state)).toBe(8)
    })
  })

  describe('totalUnreadCount', () => {
    it('should sum unread counts across joined rooms', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { joined: true, unreadCount: 3 })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { joined: true, unreadCount: 7 })],
      ])
      const state = createMockState({ rooms })
      expect(roomSelectors.totalUnreadCount(state)).toBe(10)
    })
  })

  describe('totalNotifiableUnreadCount', () => {
    it('should sum unread in rooms with notifyAll', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { joined: true, unreadCount: 3, notifyAll: true })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { joined: true, unreadCount: 7, notifyAll: false })],
        ['room3@conference.example.com', createMockRoom('room3@conference.example.com', { joined: true, unreadCount: 5, notifyAllPersistent: true })],
      ])
      const state = createMockState({ rooms })
      expect(roomSelectors.totalNotifiableUnreadCount(state)).toBe(8)
    })
  })

  describe('roomsWithUnreadCount', () => {
    it('should count rooms with mentions or notifyAll unread', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { joined: true, mentionsCount: 1 })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { joined: true, unreadCount: 5, notifyAll: true })],
        ['room3@conference.example.com', createMockRoom('room3@conference.example.com', { joined: true, unreadCount: 10 })],
      ])
      const state = createMockState({ rooms })
      expect(roomSelectors.roomsWithUnreadCount(state)).toBe(2)
    })
  })

  describe('isJoined', () => {
    it('should return true for joined room', () => {
      const room = createMockRoom('room@conference.example.com', { joined: true })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      expect(roomSelectors.isJoined('room@conference.example.com')(state)).toBe(true)
    })

    it('should return false for non-joined room', () => {
      const room = createMockRoom('room@conference.example.com', { joined: false })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      expect(roomSelectors.isJoined('room@conference.example.com')(state)).toBe(false)
    })
  })

  describe('isBookmarked', () => {
    it('should return true for bookmarked room', () => {
      const room = createMockRoom('room@conference.example.com', { isBookmarked: true })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      expect(roomSelectors.isBookmarked('room@conference.example.com')(state)).toBe(true)
    })
  })

  describe('hasRoom', () => {
    it('should return true for existing room', () => {
      const rooms = new Map([['room@conference.example.com', createMockRoom('room@conference.example.com')]])
      const state = createMockState({ rooms })
      expect(roomSelectors.hasRoom('room@conference.example.com')(state)).toBe(true)
    })

    it('should return false for non-existing room', () => {
      const state = createMockState()
      expect(roomSelectors.hasRoom('room@conference.example.com')(state)).toBe(false)
    })
  })

  describe('mamStateFor', () => {
    it('should return MAM state for room', () => {
      const mamState: MAMQueryState = {
        isLoading: true,
        hasQueried: false,
        error: null,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      }
      const mamQueryStates = new Map([['room@conference.example.com', mamState]])
      const state = createMockState({ mamQueryStates })
      expect(roomSelectors.mamStateFor('room@conference.example.com')(state)).toBe(mamState)
    })
  })

  describe('isMAMLoading', () => {
    it('should return true when loading', () => {
      const mamQueryStates = new Map<string, MAMQueryState>([['room@conference.example.com', {
        isLoading: true,
        hasQueried: false,
        error: null,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      }]])
      const state = createMockState({ mamQueryStates })
      expect(roomSelectors.isMAMLoading('room@conference.example.com')(state)).toBe(true)
    })
  })

  describe('selfOccupantFor', () => {
    it('should return self occupant for room', () => {
      const selfOccupant = createMockOccupant('myNick', { affiliation: 'owner' })
      const room = createMockRoom('room@conference.example.com', { selfOccupant })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      expect(roomSelectors.selfOccupantFor('room@conference.example.com')(state)).toBe(selfOccupant)
    })
  })

  describe('notifyAllFor', () => {
    it('should return true when notifyAll is enabled', () => {
      const room = createMockRoom('room@conference.example.com', { notifyAll: true })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      expect(roomSelectors.notifyAllFor('room@conference.example.com')(state)).toBe(true)
    })

    it('should return true when notifyAllPersistent is enabled', () => {
      const room = createMockRoom('room@conference.example.com', { notifyAllPersistent: true })
      const rooms = new Map([['room@conference.example.com', room]])
      const state = createMockState({ rooms })
      expect(roomSelectors.notifyAllFor('room@conference.example.com')(state)).toBe(true)
    })
  })

  describe('roomCount', () => {
    it('should return total room count', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com')],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com')],
      ])
      const state = createMockState({ rooms })
      expect(roomSelectors.roomCount(state)).toBe(2)
    })
  })

  describe('bookmarkedRoomCount', () => {
    it('should return bookmarked room count', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { isBookmarked: true })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { isBookmarked: false })],
      ])
      const state = createMockState({ rooms })
      expect(roomSelectors.bookmarkedRoomCount(state)).toBe(1)
    })
  })

  describe('joinedRoomCount', () => {
    it('should return joined room count', () => {
      const rooms = new Map<string, Room>([
        ['room1@conference.example.com', createMockRoom('room1@conference.example.com', { joined: true })],
        ['room2@conference.example.com', createMockRoom('room2@conference.example.com', { joined: false })],
      ])
      const state = createMockState({ rooms })
      expect(roomSelectors.joinedRoomCount(state)).toBe(1)
    })
  })

  // ============================================================
  // METADATA SELECTORS TESTS (Phase 6)
  // ============================================================

  describe('entityById', () => {
    it('should return entity for existing room', () => {
      const entity: RoomEntity = {
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'user',
        joined: true,
        isBookmarked: true,
      }
      const roomEntities = new Map([['room@conference.example.com', entity]])
      const state = createMockState({ roomEntities })
      expect(roomSelectors.entityById('room@conference.example.com')(state)).toEqual(entity)
    })

    it('should return undefined for non-existing room', () => {
      const state = createMockState()
      expect(roomSelectors.entityById('nonexistent@conference.example.com')(state)).toBeUndefined()
    })
  })

  describe('metadataById', () => {
    it('should return metadata for existing room', () => {
      const meta: RoomMetadata = {
        unreadCount: 5,
        mentionsCount: 2,
        typingUsers: new Set(['alice', 'bob']),
      }
      const roomMeta = new Map([['room@conference.example.com', meta]])
      const state = createMockState({ roomMeta })
      expect(roomSelectors.metadataById('room@conference.example.com')(state)).toEqual(meta)
    })

    it('should return undefined for non-existing room', () => {
      const state = createMockState()
      expect(roomSelectors.metadataById('nonexistent@conference.example.com')(state)).toBeUndefined()
    })
  })

  describe('runtimeById', () => {
    it('should return runtime for existing room', () => {
      const runtime: RoomRuntime = {
        occupants: new Map([['alice', { nick: 'alice', affiliation: 'member', role: 'participant' }]]),
        messages: [],
      }
      const roomRuntime = new Map([['room@conference.example.com', runtime]])
      const state = createMockState({ roomRuntime })
      expect(roomSelectors.runtimeById('room@conference.example.com')(state)).toEqual(runtime)
    })
  })

  describe('allMetadata', () => {
    it('should return all room metadata', () => {
      const meta1: RoomMetadata = { unreadCount: 3, mentionsCount: 1, typingUsers: new Set() }
      const meta2: RoomMetadata = { unreadCount: 7, mentionsCount: 0, typingUsers: new Set() }
      const roomMeta = new Map([
        ['room1@conference.example.com', meta1],
        ['room2@conference.example.com', meta2],
      ])
      const state = createMockState({ roomMeta })
      const result = roomSelectors.allMetadata(state)
      expect(result.size).toBe(2)
      expect(result.get('room1@conference.example.com')).toEqual(meta1)
    })
  })

  describe('sidebarListItems', () => {
    it('should combine entity and metadata for sidebar display', () => {
      const entity: RoomEntity = {
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'user',
        joined: true,
        isBookmarked: true,
        avatar: 'https://example.com/avatar.png',
      }
      const meta: RoomMetadata = {
        unreadCount: 3,
        mentionsCount: 1,
        typingUsers: new Set(),
        notifyAll: true,
      }
      const roomEntities = new Map([['room@conference.example.com', entity]])
      const roomMeta = new Map([['room@conference.example.com', meta]])
      const state = createMockState({ roomEntities, roomMeta })

      const result = roomSelectors.sidebarListItems(state)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'user',
        joined: true,
        isBookmarked: true,
        isJoining: undefined,
        isQuickChat: undefined,
        autojoin: undefined,
        avatar: 'https://example.com/avatar.png',
        avatarHash: undefined,
        unreadCount: 3,
        mentionsCount: 1,
        notifyAll: true,
        draft: undefined,
        occupantCount: 0,
        lastMessage: undefined,
      })
    })

    it('should sort by room name', () => {
      const entity1: RoomEntity = {
        jid: 'zebra@conference.example.com',
        name: 'Zebra Room',
        nickname: 'user',
        joined: true,
        isBookmarked: true,
      }
      const entity2: RoomEntity = {
        jid: 'alpha@conference.example.com',
        name: 'Alpha Room',
        nickname: 'user',
        joined: true,
        isBookmarked: true,
      }
      const meta: RoomMetadata = { unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
      const roomEntities = new Map([
        ['zebra@conference.example.com', entity1],
        ['alpha@conference.example.com', entity2],
      ])
      const roomMeta = new Map([
        ['zebra@conference.example.com', meta],
        ['alpha@conference.example.com', meta],
      ])
      const state = createMockState({ roomEntities, roomMeta })

      const result = roomSelectors.sidebarListItems(state)
      expect(result[0].name).toBe('Alpha Room')
      expect(result[1].name).toBe('Zebra Room')
    })

    it('should include draft text', () => {
      const entity: RoomEntity = {
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'user',
        joined: true,
        isBookmarked: true,
      }
      const meta: RoomMetadata = { unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
      const roomEntities = new Map([['room@conference.example.com', entity]])
      const roomMeta = new Map([['room@conference.example.com', meta]])
      const drafts = new Map([['room@conference.example.com', 'Draft message']])
      const state = createMockState({ roomEntities, roomMeta, drafts })

      const result = roomSelectors.sidebarListItems(state)
      expect(result[0].draft).toBe('Draft message')
    })
  })

  describe('bookmarkedSidebarListItems', () => {
    it('should only include bookmarked rooms', () => {
      const entity1: RoomEntity = {
        jid: 'room1@conference.example.com',
        name: 'Bookmarked Room',
        nickname: 'user',
        joined: true,
        isBookmarked: true,
      }
      const entity2: RoomEntity = {
        jid: 'room2@conference.example.com',
        name: 'Non-Bookmarked Room',
        nickname: 'user',
        joined: true,
        isBookmarked: false,
      }
      const meta: RoomMetadata = { unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
      const roomEntities = new Map([
        ['room1@conference.example.com', entity1],
        ['room2@conference.example.com', entity2],
      ])
      const roomMeta = new Map([
        ['room1@conference.example.com', meta],
        ['room2@conference.example.com', meta],
      ])
      const state = createMockState({ roomEntities, roomMeta })

      const result = roomSelectors.bookmarkedSidebarListItems(state)
      expect(result).toHaveLength(1)
      expect(result[0].jid).toBe('room1@conference.example.com')
    })
  })

  describe('runtimeMessagesFor', () => {
    it('should return messages from runtime', () => {
      const msg = createMockRoomMessage('1', 'room@conference.example.com')
      const runtime: RoomRuntime = {
        occupants: new Map(),
        messages: [msg],
      }
      const roomRuntime = new Map([['room@conference.example.com', runtime]])
      const state = createMockState({ roomRuntime })

      const result = roomSelectors.runtimeMessagesFor('room@conference.example.com')(state)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(msg)
    })

    it('should return empty array for non-existing room', () => {
      const state = createMockState()
      const result = roomSelectors.runtimeMessagesFor('nonexistent@conference.example.com')(state)
      expect(result).toEqual([])
    })
  })

  describe('runtimeOccupantsFor', () => {
    it('should return occupants from runtime', () => {
      const occupant: RoomOccupant = { nick: 'alice', affiliation: 'member', role: 'participant' }
      const runtime: RoomRuntime = {
        occupants: new Map([['alice', occupant]]),
        messages: [],
      }
      const roomRuntime = new Map([['room@conference.example.com', runtime]])
      const state = createMockState({ roomRuntime })

      const result = roomSelectors.runtimeOccupantsFor('room@conference.example.com')(state)
      expect(result.size).toBe(1)
      expect(result.get('alice')).toEqual(occupant)
    })
  })
})
