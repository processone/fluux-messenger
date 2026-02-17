/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  saveSession,
  getSession,
  clearSession,
  saveViewState,
  getSavedViewState,
  saveRoster,
  getSavedRoster,
  saveRooms,
  getSavedRooms,
  saveServerInfo,
  getSavedServerInfo,
  saveOwnResources,
  getSavedOwnResources,
  type ViewStateData,
} from './useSessionPersistence'
import type { Contact, Room, RoomMessage, ServerInfo, HttpUploadService, ResourcePresence } from '@fluux/sdk'

const TEST_JID = 'user@example.com'
const OTHER_JID = 'other@example.com'
const TEST_SERVER = 'wss://example.com/ws'
const ACTIVE_SESSION_JID_KEY = 'xmpp-active-session-jid'
const SESSION_KEY = 'xmpp-session'
const ROSTER_KEY = 'xmpp-roster'
const ROOMS_KEY = 'xmpp-rooms'
const VIEW_STATE_KEY = 'xmpp-view-state'
const OWN_RESOURCES_KEY = 'xmpp-own-resources'

function scopedKey(baseKey: string, jid: string = TEST_JID): string {
  return `${baseKey}:${jid}`
}

// Mock sessionStorage
const mockStorage: Record<string, string> = {}
const mockSessionStorage = {
  get length() {
    return Object.keys(mockStorage).length
  },
  key: vi.fn((index: number) => Object.keys(mockStorage)[index] ?? null),
  getItem: vi.fn((key: string) => mockStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key]
  }),
  clear: vi.fn(() => {
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key])
  }),
}

Object.defineProperty(global, 'sessionStorage', {
  value: mockSessionStorage,
  writable: true,
})

describe('useSessionPersistence', () => {
  beforeEach(() => {
    // Clear mock storage before each test
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key])
    mockStorage[ACTIVE_SESSION_JID_KEY] = TEST_JID
    vi.clearAllMocks()
  })

  describe('Session credentials', () => {
    it('should save and retrieve session credentials', () => {
      saveSession(TEST_JID, 'password123', TEST_SERVER)

      const session = getSession()
      expect(session).toEqual({
        jid: TEST_JID,
        password: 'password123',
        server: TEST_SERVER,
      })
      expect(mockStorage[ACTIVE_SESSION_JID_KEY]).toBe(TEST_JID)
      expect(mockStorage[scopedKey(SESSION_KEY)]).toBeDefined()
      expect(mockStorage[SESSION_KEY]).toBeUndefined()
    })

    // Note: SM state tests removed - SM state is now managed by SDK's storage adapter

    it('should return null when no session exists', () => {
      expect(getSession()).toBeNull()
    })
  })

  describe('clearSession', () => {
    it('should remove all session-related keys', () => {
      // Set up all keys
      saveSession(TEST_JID, 'password', TEST_SERVER)
      saveViewState({
        sidebarView: 'messages',
        activeConversationId: null,
        activeRoomJid: null,
        selectedContactJid: null,
      }, TEST_JID)

      clearSession()

      expect(getSession()).toBeNull()
      expect(getSavedViewState(TEST_JID)).toBeNull()
      expect(getSavedRoster(TEST_JID)).toBeNull()
      expect(getSavedRooms(TEST_JID)).toBeNull()
      expect(getSavedServerInfo(TEST_JID)).toBeNull()
      expect(mockStorage[ACTIVE_SESSION_JID_KEY]).toBeUndefined()
      // Note: Presence is now managed by XState machine with key 'fluux:presence-machine'
    })

    it('should clear scoped data for all accounts', () => {
      saveSession(TEST_JID, 'password', TEST_SERVER)
      saveViewState({
        sidebarView: 'messages',
        activeConversationId: null,
        activeRoomJid: null,
        selectedContactJid: null,
      }, TEST_JID)

      saveSession(OTHER_JID, 'password', 'wss://other.example/ws')
      saveViewState({
        sidebarView: 'rooms',
        activeConversationId: null,
        activeRoomJid: 'room@conference.other.example',
        selectedContactJid: null,
      }, OTHER_JID)

      clearSession({ allAccounts: true })

      expect(mockStorage[scopedKey(SESSION_KEY, TEST_JID)]).toBeUndefined()
      expect(mockStorage[scopedKey(SESSION_KEY, OTHER_JID)]).toBeUndefined()
      expect(mockStorage[scopedKey(VIEW_STATE_KEY, TEST_JID)]).toBeUndefined()
      expect(mockStorage[scopedKey(VIEW_STATE_KEY, OTHER_JID)]).toBeUndefined()
      expect(mockStorage[ACTIVE_SESSION_JID_KEY]).toBeUndefined()
    })
  })

  // Note: Presence state is now managed by XState machine with its own persistence
  // in XMPPProvider (key: 'fluux:presence-machine')

  describe('View state', () => {
    it('should save and retrieve view state', () => {
      const viewState: ViewStateData = {
        sidebarView: 'rooms',
        activeConversationId: 'alice@example.com',
        activeRoomJid: 'room@conference.example.com',
        selectedContactJid: 'bob@example.com',
      }

      saveViewState(viewState, TEST_JID)

      const restored = getSavedViewState(TEST_JID)
      expect(restored).toEqual(viewState)
    })

    it('should handle all sidebar view types', () => {
      const views: ViewStateData['sidebarView'][] = [
        'messages',
        'rooms',
        'directory',
        'archive',
        'events',
        'admin',
        'settings',
      ]

      views.forEach((view) => {
        const viewState: ViewStateData = {
          sidebarView: view,
          activeConversationId: null,
          activeRoomJid: null,
          selectedContactJid: null,
        }

        saveViewState(viewState, TEST_JID)
        const restored = getSavedViewState(TEST_JID)
        expect(restored?.sidebarView).toBe(view)
      })
    })

    it('should persist showRoomOccupants state', () => {
      const viewState: ViewStateData = {
        sidebarView: 'rooms',
        activeConversationId: null,
        activeRoomJid: 'room@conference.example.com',
        selectedContactJid: null,
        showRoomOccupants: true,
      }

      saveViewState(viewState, TEST_JID)
      const restored = getSavedViewState(TEST_JID)
      expect(restored?.showRoomOccupants).toBe(true)

      // Also test with false
      viewState.showRoomOccupants = false
      saveViewState(viewState, TEST_JID)
      const restoredFalse = getSavedViewState(TEST_JID)
      expect(restoredFalse?.showRoomOccupants).toBe(false)
    })

    it('should isolate view state by jid', () => {
      const firstState: ViewStateData = {
        sidebarView: 'messages',
        activeConversationId: 'alice@example.com',
        activeRoomJid: null,
        selectedContactJid: null,
      }
      const secondState: ViewStateData = {
        sidebarView: 'rooms',
        activeConversationId: null,
        activeRoomJid: 'room@conference.other.example',
        selectedContactJid: null,
      }

      saveViewState(firstState, TEST_JID)
      saveViewState(secondState, OTHER_JID)

      expect(getSavedViewState(TEST_JID)).toEqual(firstState)
      expect(getSavedViewState(OTHER_JID)).toEqual(secondState)
    })

    it('should read legacy unscoped view state when no account scope is known', () => {
      const legacyState: ViewStateData = {
        sidebarView: 'archive',
        activeConversationId: null,
        activeRoomJid: null,
        selectedContactJid: null,
      }

      mockStorage[VIEW_STATE_KEY] = JSON.stringify(legacyState)
      delete mockStorage[ACTIVE_SESSION_JID_KEY]
      expect(getSavedViewState()).toEqual(legacyState)
    })

    it('should not read legacy unscoped view state when account scope is known', () => {
      const legacyState: ViewStateData = {
        sidebarView: 'archive',
        activeConversationId: 'alice@example.com',
        activeRoomJid: null,
        selectedContactJid: null,
      }

      mockStorage[VIEW_STATE_KEY] = JSON.stringify(legacyState)
      expect(getSavedViewState(TEST_JID)).toBeNull()
    })
  })

  describe('Roster serialization', () => {
    it('should convert Date objects to ISO strings and back', () => {
      const lastInteraction = new Date('2024-01-15T10:30:00Z')
      const lastSeen = new Date('2024-01-14T18:00:00Z')

      const contacts: Contact[] = [
        {
          jid: 'alice@example.com',
          name: 'Alice',
          presence: 'online',
          subscription: 'both',
          lastInteraction,
          lastSeen,
        },
      ]

      saveRoster(contacts, TEST_JID)
      const restored = getSavedRoster(TEST_JID)

      expect(restored).toHaveLength(1)
      expect(restored![0].lastInteraction).toBeInstanceOf(Date)
      expect(restored![0].lastInteraction?.getTime()).toBe(lastInteraction.getTime())
      expect(restored![0].lastSeen).toBeInstanceOf(Date)
      expect(restored![0].lastSeen?.getTime()).toBe(lastSeen.getTime())
    })

    it('should handle nested resource lastInteraction dates', () => {
      const resourceLastInteraction = new Date('2024-01-15T12:00:00Z')

      const contacts: Contact[] = [
        {
          jid: 'alice@example.com',
          name: 'Alice',
          presence: 'online',
          subscription: 'both',
          resources: new Map([
            [
              'mobile',
              {
                show: 'away',
                priority: 5,
                lastInteraction: resourceLastInteraction,
                client: 'Conversations',
              },
            ],
          ]),
        },
      ]

      saveRoster(contacts, TEST_JID)
      const restored = getSavedRoster(TEST_JID)

      expect(restored).toHaveLength(1)
      expect(restored![0].resources).toBeInstanceOf(Map)
      const resource = restored![0].resources?.get('mobile')
      expect(resource?.lastInteraction).toBeInstanceOf(Date)
      expect(resource?.lastInteraction?.getTime()).toBe(resourceLastInteraction.getTime())
    })

    it('should handle contacts without Date fields', () => {
      const contacts: Contact[] = [
        {
          jid: 'bob@example.com',
          name: 'Bob',
          presence: 'offline',
          subscription: 'both',
        },
      ]

      saveRoster(contacts, TEST_JID)
      const restored = getSavedRoster(TEST_JID)

      expect(restored).toHaveLength(1)
      expect(restored![0].lastInteraction).toBeUndefined()
      expect(restored![0].lastSeen).toBeUndefined()
    })

    it('should handle empty roster', () => {
      saveRoster([], TEST_JID)
      // Note: empty array is saved but getSavedRoster returns null for empty
      const stored = mockStorage[scopedKey(ROSTER_KEY)]
      expect(stored).toBe('[]')
    })
  })

  describe('Room serialization', () => {
    const createRoomMessage = (id: string, timestamp: Date, retractedAt?: Date): RoomMessage => ({
      type: 'groupchat',
      id,
      roomJid: 'room@conference.example.com',
      from: 'room@conference.example.com/user',
      nick: 'user',
      body: `Message ${id}`,
      timestamp,
      isOutgoing: false,
      retractedAt,
    })

    it('should convert message timestamps to Date objects', () => {
      const timestamp = new Date('2024-01-15T14:30:00Z')
      const rooms = new Map<string, Room>([
        [
          'room@conf.example.com',
          {
            jid: 'room@conf.example.com',
            name: 'Test Room',
            nickname: 'user',
            joined: true,
            occupants: new Map(),
            typingUsers: new Set(),
            messages: [createRoomMessage('msg1', timestamp)],
            unreadCount: 0,
            mentionsCount: 0,
            isBookmarked: true,
          },
        ],
      ])

      saveRooms(rooms, TEST_JID)
      const restored = getSavedRooms(TEST_JID)

      expect(restored).toHaveLength(1)
      expect(restored![0].messages).toHaveLength(1)
      expect(restored![0].messages[0].timestamp).toBeInstanceOf(Date)
      expect(restored![0].messages[0].timestamp.getTime()).toBe(timestamp.getTime())
    })

    it('should convert retractedAt to Date objects', () => {
      const timestamp = new Date('2024-01-15T14:30:00Z')
      const retractedAt = new Date('2024-01-15T14:35:00Z')

      const rooms = new Map<string, Room>([
        [
          'room@conf.example.com',
          {
            jid: 'room@conf.example.com',
            name: 'Test Room',
            nickname: 'user',
            joined: true,
            occupants: new Map(),
            typingUsers: new Set(),
            messages: [createRoomMessage('msg1', timestamp, retractedAt)],
            unreadCount: 0,
            mentionsCount: 0,
            isBookmarked: true,
          },
        ],
      ])

      saveRooms(rooms, TEST_JID)
      const restored = getSavedRooms(TEST_JID)

      expect(restored![0].messages[0].retractedAt).toBeInstanceOf(Date)
      expect(restored![0].messages[0].retractedAt?.getTime()).toBe(retractedAt.getTime())
    })

    it('should limit messages to last 50', () => {
      const messages: RoomMessage[] = []
      for (let i = 0; i < 100; i++) {
        messages.push(createRoomMessage(`msg${i}`, new Date(Date.now() + i * 1000)))
      }

      const rooms = new Map<string, Room>([
        [
          'room@conf.example.com',
          {
            jid: 'room@conf.example.com',
            name: 'Test Room',
            nickname: 'user',
            joined: true,
            occupants: new Map(),
            typingUsers: new Set(),
            messages,
            unreadCount: 0,
            mentionsCount: 0,
            isBookmarked: true,
          },
        ],
      ])

      saveRooms(rooms, TEST_JID)
      const restored = getSavedRooms(TEST_JID)

      expect(restored![0].messages).toHaveLength(50)
      // Should be the LAST 50 messages (msg50-msg99)
      expect(restored![0].messages[0].id).toBe('msg50')
      expect(restored![0].messages[49].id).toBe('msg99')
    })

    it('should convert lastReadAt to Date object', () => {
      const lastReadAt = new Date('2024-01-15T16:00:00Z')

      const rooms = new Map<string, Room>([
        [
          'room@conf.example.com',
          {
            jid: 'room@conf.example.com',
            name: 'Test Room',
            nickname: 'user',
            joined: true,
            occupants: new Map(),
            typingUsers: new Set(),
            messages: [],
            unreadCount: 0,
            mentionsCount: 0,
            isBookmarked: true,
            lastReadAt,
          },
        ],
      ])

      saveRooms(rooms, TEST_JID)
      const restored = getSavedRooms(TEST_JID)

      expect(restored![0].lastReadAt).toBeInstanceOf(Date)
      expect(restored![0].lastReadAt?.getTime()).toBe(lastReadAt.getTime())
    })

    it('should restore occupants as Map and typingUsers as Set', () => {
      const rooms = new Map<string, Room>([
        [
          'room@conf.example.com',
          {
            jid: 'room@conf.example.com',
            name: 'Test Room',
            nickname: 'user',
            joined: true,
            occupants: new Map([
              ['alice', { nick: 'alice', jid: 'alice@example.com', affiliation: 'member', role: 'participant' }],
            ]),
            typingUsers: new Set(['bob']),
            messages: [],
            unreadCount: 0,
            mentionsCount: 0,
            isBookmarked: true,
          },
        ],
      ])

      saveRooms(rooms, TEST_JID)
      const restored = getSavedRooms(TEST_JID)

      expect(restored![0].occupants).toBeInstanceOf(Map)
      expect(restored![0].occupants.get('alice')?.jid).toBe('alice@example.com')
      // typingUsers is always reset to empty Set on restore
      expect(restored![0].typingUsers).toBeInstanceOf(Set)
      expect(restored![0].typingUsers.size).toBe(0)
    })

    it('should handle rooms with no messages', () => {
      const rooms = new Map<string, Room>([
        [
          'room@conf.example.com',
          {
            jid: 'room@conf.example.com',
            name: 'Empty Room',
            nickname: 'user',
            joined: false,
            occupants: new Map(),
            typingUsers: new Set(),
            messages: [],
            unreadCount: 0,
            mentionsCount: 0,
            isBookmarked: true,
          },
        ],
      ])

      saveRooms(rooms, TEST_JID)
      const restored = getSavedRooms(TEST_JID)

      expect(restored![0].messages).toEqual([])
    })

    it('should preserve room metadata', () => {
      const rooms = new Map<string, Room>([
        [
          'room@conf.example.com',
          {
            jid: 'room@conf.example.com',
            name: 'Test Room',
            nickname: 'mynick',
            joined: true,
            subject: 'Room topic',
            avatarHash: 'abc123',
            occupants: new Map(),
            typingUsers: new Set(),
            messages: [],
            unreadCount: 5,
            mentionsCount: 2,
            isBookmarked: true,
            autojoin: true,
            password: 'secret',
            notifyAll: true,
            notifyAllPersistent: false,
            isQuickChat: true,
          },
        ],
      ])

      saveRooms(rooms, TEST_JID)
      const restored = getSavedRooms(TEST_JID)

      expect(restored![0].name).toBe('Test Room')
      expect(restored![0].nickname).toBe('mynick')
      expect(restored![0].subject).toBe('Room topic')
      expect(restored![0].avatarHash).toBe('abc123')
      expect(restored![0].unreadCount).toBe(5)
      expect(restored![0].mentionsCount).toBe(2)
      expect(restored![0].autojoin).toBe(true)
      expect(restored![0].password).toBe('secret')
      expect(restored![0].notifyAll).toBe(true)
      expect(restored![0].notifyAllPersistent).toBe(false)
      expect(restored![0].isQuickChat).toBe(true)
    })
  })

  describe('Server info serialization', () => {
    it('should save and retrieve server info', () => {
      const serverInfo: ServerInfo = {
        domain: 'example.com',
        features: ['http://jabber.org/protocol/disco#info', 'urn:xmpp:mam:2'],
        identities: [{ category: 'server', type: 'im', name: 'ejabberd' }],
      }
      const httpUploadService: HttpUploadService = {
        jid: 'upload.example.com',
        maxFileSize: 10485760,
      }

      saveServerInfo(serverInfo, httpUploadService, TEST_JID)
      const restored = getSavedServerInfo(TEST_JID)

      expect(restored?.serverInfo).toEqual(serverInfo)
      expect(restored?.httpUploadService).toEqual(httpUploadService)
    })

    it('should handle null values', () => {
      saveServerInfo(null, null, TEST_JID)
      const restored = getSavedServerInfo(TEST_JID)

      expect(restored?.serverInfo).toBeNull()
      expect(restored?.httpUploadService).toBeNull()
    })
  })

  describe('Own resources serialization', () => {
    it('should save and retrieve own resources', () => {
      const ownResources = new Map<string, ResourcePresence>([
        ['desktop', { show: 'away', priority: 5, client: 'Fluux Desktop' }],
        ['mobile', { show: null, priority: 10, status: 'On the go', client: 'Conversations' }],
      ])

      saveOwnResources(ownResources, TEST_JID)
      const restored = getSavedOwnResources(TEST_JID)

      expect(restored).toBeInstanceOf(Map)
      expect(restored?.size).toBe(2)
      expect(restored?.get('desktop')?.show).toBe('away')
      expect(restored?.get('desktop')?.client).toBe('Fluux Desktop')
      expect(restored?.get('mobile')?.priority).toBe(10)
      expect(restored?.get('mobile')?.status).toBe('On the go')
    })

    it('should convert lastInteraction Date to ISO string and back', () => {
      const lastInteraction = new Date('2024-01-15T10:30:00Z')
      const ownResources = new Map<string, ResourcePresence>([
        ['desktop', { show: 'away', priority: 5, lastInteraction, client: 'Fluux Desktop' }],
      ])

      saveOwnResources(ownResources, TEST_JID)
      const restored = getSavedOwnResources(TEST_JID)

      expect(restored?.get('desktop')?.lastInteraction).toBeInstanceOf(Date)
      expect(restored?.get('desktop')?.lastInteraction?.getTime()).toBe(lastInteraction.getTime())
    })

    it('should handle resources without lastInteraction', () => {
      const ownResources = new Map<string, ResourcePresence>([
        ['mobile', { show: 'dnd', priority: -1, client: 'Mobile Client' }],
      ])

      saveOwnResources(ownResources, TEST_JID)
      const restored = getSavedOwnResources(TEST_JID)

      expect(restored?.get('mobile')?.lastInteraction).toBeUndefined()
    })

    it('should handle empty Map', () => {
      const ownResources = new Map<string, ResourcePresence>()

      saveOwnResources(ownResources, TEST_JID)
      const stored = mockStorage[scopedKey(OWN_RESOURCES_KEY)]
      expect(stored).toBe('[]')
    })

    it('should return null when no own resources exist', () => {
      expect(getSavedOwnResources(TEST_JID)).toBeNull()
    })

    it('should be cleared by clearSession', () => {
      const ownResources = new Map<string, ResourcePresence>([
        ['desktop', { show: 'away', priority: 5, client: 'Fluux Desktop' }],
      ])
      saveOwnResources(ownResources, TEST_JID)

      clearSession()

      expect(getSavedOwnResources(TEST_JID)).toBeNull()
    })

    it('should return null for invalid JSON', () => {
      mockStorage[scopedKey(OWN_RESOURCES_KEY)] = 'invalid json{'
      expect(getSavedOwnResources(TEST_JID)).toBeNull()
    })
  })

  describe('Error handling', () => {
    it('should return null for invalid JSON in roster', () => {
      mockStorage[scopedKey(ROSTER_KEY)] = 'invalid json{'
      expect(getSavedRoster(TEST_JID)).toBeNull()
    })

    it('should return null for invalid JSON in rooms', () => {
      mockStorage[scopedKey(ROOMS_KEY)] = 'not valid json'
      expect(getSavedRooms(TEST_JID)).toBeNull()
    })

    it('should return null for invalid JSON in view state', () => {
      mockStorage[scopedKey(VIEW_STATE_KEY)] = '{ broken'
      expect(getSavedViewState(TEST_JID)).toBeNull()
    })

    it('should return null for invalid JSON in session', () => {
      mockStorage['xmpp-session'] = 'corrupted'
      expect(getSession()).toBeNull()
    })
  })
})

// ============================================================================
// Note: Hook behavior tests were removed as presence synchronization is now
// handled by XState's native persistence in XMPPProvider
