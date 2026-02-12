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

// Mock sessionStorage
const mockStorage: Record<string, string> = {}
const mockSessionStorage = {
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
    vi.clearAllMocks()
  })

  describe('Session credentials', () => {
    it('should save and retrieve session credentials', () => {
      saveSession('user@example.com', 'password123', 'wss://example.com/ws')

      const session = getSession()
      expect(session).toEqual({
        jid: 'user@example.com',
        password: 'password123',
        server: 'wss://example.com/ws',
      })
    })

    // Note: SM state tests removed - SM state is now managed by SDK's storage adapter

    it('should return null when no session exists', () => {
      expect(getSession()).toBeNull()
    })
  })

  describe('clearSession', () => {
    it('should remove all session-related keys', () => {
      // Set up all keys
      saveSession('user@example.com', 'password', 'wss://example.com/ws')
      saveViewState({
        sidebarView: 'messages',
        activeConversationId: null,
        activeRoomJid: null,
        selectedContactJid: null,
      })

      clearSession()

      expect(getSession()).toBeNull()
      expect(getSavedViewState()).toBeNull()
      expect(getSavedRoster()).toBeNull()
      expect(getSavedRooms()).toBeNull()
      expect(getSavedServerInfo()).toBeNull()
      // Note: Presence is now managed by XState machine with key 'fluux:presence-machine'
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

      saveViewState(viewState)

      const restored = getSavedViewState()
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

        saveViewState(viewState)
        const restored = getSavedViewState()
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

      saveViewState(viewState)
      const restored = getSavedViewState()
      expect(restored?.showRoomOccupants).toBe(true)

      // Also test with false
      viewState.showRoomOccupants = false
      saveViewState(viewState)
      const restoredFalse = getSavedViewState()
      expect(restoredFalse?.showRoomOccupants).toBe(false)
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

      saveRoster(contacts)
      const restored = getSavedRoster()

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

      saveRoster(contacts)
      const restored = getSavedRoster()

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

      saveRoster(contacts)
      const restored = getSavedRoster()

      expect(restored).toHaveLength(1)
      expect(restored![0].lastInteraction).toBeUndefined()
      expect(restored![0].lastSeen).toBeUndefined()
    })

    it('should handle empty roster', () => {
      saveRoster([])
      // Note: empty array is saved but getSavedRoster returns null for empty
      const stored = mockStorage['xmpp-roster']
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

      saveRooms(rooms)
      const restored = getSavedRooms()

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

      saveRooms(rooms)
      const restored = getSavedRooms()

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

      saveRooms(rooms)
      const restored = getSavedRooms()

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

      saveRooms(rooms)
      const restored = getSavedRooms()

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

      saveRooms(rooms)
      const restored = getSavedRooms()

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

      saveRooms(rooms)
      const restored = getSavedRooms()

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

      saveRooms(rooms)
      const restored = getSavedRooms()

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

      saveServerInfo(serverInfo, httpUploadService)
      const restored = getSavedServerInfo()

      expect(restored?.serverInfo).toEqual(serverInfo)
      expect(restored?.httpUploadService).toEqual(httpUploadService)
    })

    it('should handle null values', () => {
      saveServerInfo(null, null)
      const restored = getSavedServerInfo()

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

      saveOwnResources(ownResources)
      const restored = getSavedOwnResources()

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

      saveOwnResources(ownResources)
      const restored = getSavedOwnResources()

      expect(restored?.get('desktop')?.lastInteraction).toBeInstanceOf(Date)
      expect(restored?.get('desktop')?.lastInteraction?.getTime()).toBe(lastInteraction.getTime())
    })

    it('should handle resources without lastInteraction', () => {
      const ownResources = new Map<string, ResourcePresence>([
        ['mobile', { show: 'dnd', priority: -1, client: 'Mobile Client' }],
      ])

      saveOwnResources(ownResources)
      const restored = getSavedOwnResources()

      expect(restored?.get('mobile')?.lastInteraction).toBeUndefined()
    })

    it('should handle empty Map', () => {
      const ownResources = new Map<string, ResourcePresence>()

      saveOwnResources(ownResources)
      const stored = mockStorage['xmpp-own-resources']
      expect(stored).toBe('[]')
    })

    it('should return null when no own resources exist', () => {
      expect(getSavedOwnResources()).toBeNull()
    })

    it('should be cleared by clearSession', () => {
      const ownResources = new Map<string, ResourcePresence>([
        ['desktop', { show: 'away', priority: 5, client: 'Fluux Desktop' }],
      ])
      saveOwnResources(ownResources)

      clearSession()

      expect(getSavedOwnResources()).toBeNull()
    })

    it('should return null for invalid JSON', () => {
      mockStorage['xmpp-own-resources'] = 'invalid json{'
      expect(getSavedOwnResources()).toBeNull()
    })
  })

  describe('Error handling', () => {
    it('should return null for invalid JSON in roster', () => {
      mockStorage['xmpp-roster'] = 'invalid json{'
      expect(getSavedRoster()).toBeNull()
    })

    it('should return null for invalid JSON in rooms', () => {
      mockStorage['xmpp-rooms'] = 'not valid json'
      expect(getSavedRooms()).toBeNull()
    })

    it('should return null for invalid JSON in view state', () => {
      mockStorage['xmpp-view-state'] = '{ broken'
      expect(getSavedViewState()).toBeNull()
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
