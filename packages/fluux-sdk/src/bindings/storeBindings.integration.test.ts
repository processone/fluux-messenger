/**
 * Integration test to verify SDK event bindings work correctly.
 *
 * This test simulates the real app flow:
 * 1. XMPPClient created
 * 2. bindStores() called with mock stores
 * 3. createStoreBindings() called to wire SDK events
 * 4. Verify that when modules emit SDK events, bindings fire and call store methods
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../core/XMPPClient'
import { createStoreBindings, StoreRefs } from './storeBindings'
import {
  createMockStores,
  createMockXmppClient,
  type MockXmppClient,
  type MockStoreBindings,
} from '../core/test-utils'

let mockXmppClientInstance: MockXmppClient

// Use vi.hoisted to create the mock factory at hoist time
const { mockClientFactory, mockXmlFn } = vi.hoisted(() => {
  let clientInstance: MockXmppClient | null = null
  return {
    mockClientFactory: Object.assign(
      vi.fn(() => clientInstance),
      {
        _setInstance: (instance: MockXmppClient) => { clientInstance = instance },
      }
    ),
    mockXmlFn: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
      name,
      attrs: attrs || {},
      children,
      toString: () => `<${name}/>`,
    })),
  }
})

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: mockClientFactory,
  xml: mockXmlFn,
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

describe('SDK Event Bindings Integration', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let storeRefs: StoreRefs
  let unsubscribe: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    // Create real XMPPClient
    xmppClient = new XMPPClient({ debug: false })

    // Create mock stores for both bindStores and createStoreBindings
    mockStores = createMockStores()

    // Bind stores to client (creates modules with emitSDK capability)
    xmppClient.bindStores(mockStores)

    // Create StoreRefs for createStoreBindings (simulating XMPPProvider setup)
    storeRefs = {
      connection: {
        setStatus: mockStores.connection.setStatus,
        setJid: mockStores.connection.setJid,
        setError: mockStores.connection.setError,
        setServerInfo: mockStores.connection.setServerInfo,
        setHttpUploadService: mockStores.connection.setHttpUploadService,
        setOwnAvatar: mockStores.connection.setOwnAvatar,
        setOwnNickname: mockStores.connection.setOwnNickname,
        updateOwnResource: mockStores.connection.updateOwnResource,
        removeOwnResource: mockStores.connection.removeOwnResource,
      } as unknown as StoreRefs['connection'],
      chat: {
        addMessage: mockStores.chat.addMessage,
        addConversation: mockStores.chat.addConversation,
        updateConversationName: mockStores.chat.updateConversationName,
        setTyping: mockStores.chat.setTyping,
        updateReactions: mockStores.chat.updateReactions,
        updateMessage: mockStores.chat.updateMessage,
        triggerAnimation: mockStores.chat.triggerAnimation,
      } as unknown as StoreRefs['chat'],
      roster: {
        setContacts: mockStores.roster.setContacts,
        addOrUpdateContact: mockStores.roster.addOrUpdateContact,
        removeContact: mockStores.roster.removeContact,
        updatePresence: mockStores.roster.updatePresence,
        removePresence: mockStores.roster.removePresence,
        setPresenceError: mockStores.roster.setPresenceError,
        updateAvatar: mockStores.roster.updateAvatar,
      } as unknown as StoreRefs['roster'],
      room: {
        addRoom: mockStores.room.addRoom,
        updateRoom: mockStores.room.updateRoom,
        removeRoom: mockStores.room.removeRoom,
        setRoomJoined: mockStores.room.setRoomJoined,
        addOccupant: mockStores.room.addOccupant,
        batchAddOccupants: mockStores.room.batchAddOccupants,
        removeOccupant: mockStores.room.removeOccupant,
        setSelfOccupant: mockStores.room.setSelfOccupant,
        addMessage: mockStores.room.addMessage,
        updateMessage: mockStores.room.updateMessage,
        updateReactions: mockStores.room.updateReactions,
        setBookmark: mockStores.room.setBookmark,
        removeBookmark: mockStores.room.removeBookmark,
        triggerAnimation: mockStores.room.triggerAnimation,
      } as unknown as StoreRefs['room'],
      events: {
        addSubscriptionRequest: mockStores.events.addSubscriptionRequest,
        removeSubscriptionRequest: mockStores.events.removeSubscriptionRequest,
        addStrangerMessage: mockStores.events.addStrangerMessage,
        removeStrangerMessages: mockStores.events.removeStrangerMessages,
        addMucInvitation: mockStores.events.addMucInvitation,
        removeMucInvitation: mockStores.events.removeMucInvitation,
        addSystemNotification: mockStores.events.addSystemNotification,
      } as unknown as StoreRefs['events'],
      admin: {
        setIsAdmin: mockStores.admin.setIsAdmin,
        setCommands: mockStores.admin.setCommands,
        setCurrentSession: mockStores.admin.setCurrentSession,
        setIsDiscovering: mockStores.admin.setIsDiscovering,
        setIsExecuting: mockStores.admin.setIsExecuting,
      } as unknown as StoreRefs['admin'],
      blocking: {
        setBlocklist: mockStores.blocking.setBlocklist,
        addBlockedJids: mockStores.blocking.addBlockedJids,
        removeBlockedJids: mockStores.blocking.removeBlockedJids,
        clearBlocklist: mockStores.blocking.clearBlocklist,
      } as unknown as StoreRefs['blocking'],
      console: {
        addEvent: mockStores.console.addEvent,
        addPacket: mockStores.console.addPacket,
      } as unknown as StoreRefs['console'],
    }

    // Set up store bindings (simulating what XMPPProvider does)
    unsubscribe = createStoreBindings(xmppClient, () => storeRefs)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    unsubscribe()
  })

  describe('SDK event → store method flow', () => {
    it('should call store.roster.setContacts when emitSDK(roster:loaded) is called', () => {
      // Arrange
      const contacts = [{ jid: 'alice@example.com', name: 'Alice', presence: 'online' }]

      // Act - directly call emitSDK to verify the binding works
      xmppClient['emitSDK']('roster:loaded', { contacts } as any)

      // Assert
      expect(mockStores.roster.setContacts).toHaveBeenCalledWith(contacts)
    })

    it('should call store.room.addRoom when emitSDK(room:added) is called', () => {
      // Arrange
      const room = { jid: 'room@conference.example.com', name: 'Test Room' }

      // Act
      xmppClient['emitSDK']('room:added', { room } as any)

      // Assert
      expect(mockStores.room.addRoom).toHaveBeenCalledWith(room)
    })

    it('should call store.connection.setStatus when emitSDK(connection:status) is called', () => {
      // Act
      xmppClient['emitSDK']('connection:status', { status: 'connecting' })

      // Assert
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('connecting')
    })

    it('should call store.chat.addMessage when emitSDK(chat:message) is called', () => {
      // Arrange
      const message = { id: 'msg1', from: 'bob@example.com', body: 'Hello', type: 'chat' }

      // Act
      xmppClient['emitSDK']('chat:message', { message } as any)

      // Assert
      expect(mockStores.chat.addMessage).toHaveBeenCalledWith(message)
    })

    it('should call store.room.setRoomJoined when emitSDK(room:joined) is called', () => {
      // Act
      xmppClient['emitSDK']('room:joined', { roomJid: 'room@conference.example.com', joined: true })

      // Assert
      expect(mockStores.room.setRoomJoined).toHaveBeenCalledWith('room@conference.example.com', true)
    })
  })

  describe('Verify emitSDK is properly bound in modules', () => {
    it('should have emitSDK available on roster module deps', () => {
      // Verify the module has emitSDK in its deps
      const roster = xmppClient.roster as any
      expect(roster.deps.emitSDK).toBeDefined()
      expect(typeof roster.deps.emitSDK).toBe('function')
    })

    it('should have emitSDK available on muc module deps', () => {
      const muc = xmppClient.muc as any
      expect(muc.deps.emitSDK).toBeDefined()
      expect(typeof muc.deps.emitSDK).toBe('function')
    })

    it('should have emitSDK available on chat module deps', () => {
      const chat = xmppClient.chat as any
      expect(chat.deps.emitSDK).toBeDefined()
      expect(typeof chat.deps.emitSDK).toBe('function')
    })
  })

  describe('Full flow: module emits → binding receives → store updates', () => {
    it('should update roster store when roster module emitSDK is called directly', () => {
      // Simulate what a module would do
      const roster = xmppClient.roster as any
      const contacts = [{ jid: 'test@example.com', name: 'Test' }]

      // Call emitSDK like the module would
      roster.deps.emitSDK('roster:loaded', { contacts })

      // Verify the store method was called via the binding
      expect(mockStores.roster.setContacts).toHaveBeenCalledWith(contacts)
    })

    it('should update room store when muc module emitSDK is called directly', () => {
      const muc = xmppClient.muc as any
      const room = { jid: 'room@conference.example.com', name: 'Test Room' }

      muc.deps.emitSDK('room:added', { room })

      expect(mockStores.room.addRoom).toHaveBeenCalledWith(room)
    })
  })

  describe('Unsubscribe cleans up handlers', () => {
    it('should not call store methods after unsubscribe', () => {
      // Unsubscribe all bindings
      unsubscribe()

      // Clear any previous calls
      vi.clearAllMocks()

      // Try to emit an event
      xmppClient['emitSDK']('roster:loaded', { contacts: [] })

      // Should not have been called
      expect(mockStores.roster.setContacts).not.toHaveBeenCalled()
    })
  })

  describe('Event-only pattern (no direct store calls)', () => {
    it('should update store when only SDK event is emitted (simulating removal of direct call)', () => {
      // This simulates what happens when we remove direct store calls from modules
      // and rely only on SDK events + bindings

      // Clear any previous calls
      vi.clearAllMocks()

      // Simulate a module only emitting SDK event (no direct store call)
      const contacts = [
        { jid: 'alice@example.com', name: 'Alice', presence: 'online' },
        { jid: 'bob@example.com', name: 'Bob', presence: 'offline' }
      ]

      // Use the module's deps.emitSDK like a real module would
      const roster = xmppClient.roster as any
      roster.deps.emitSDK('roster:loaded', { contacts })

      // Verify the binding caught the event and called the store
      expect(mockStores.roster.setContacts).toHaveBeenCalledTimes(1)
      expect(mockStores.roster.setContacts).toHaveBeenCalledWith(contacts)
    })

    it('should update room store when only room:added event is emitted', () => {
      vi.clearAllMocks()

      const room = {
        jid: 'room@conference.example.com',
        name: 'Test Room',
        joined: false,
        isBookmarked: true,
        autojoin: true,
        nickname: 'Me',
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      }

      const muc = xmppClient.muc as any
      muc.deps.emitSDK('room:added', { room })

      expect(mockStores.room.addRoom).toHaveBeenCalledTimes(1)
      expect(mockStores.room.addRoom).toHaveBeenCalledWith(room)
    })

    it('should count SDK event handler subscriptions', () => {
      // Verify that bindings are actually registered
      const client = xmppClient as any

      // Check that we have handlers registered for key events
      expect(client.sdkEventHandlers.has('roster:loaded')).toBe(true)
      expect(client.sdkEventHandlers.has('room:added')).toBe(true)
      expect(client.sdkEventHandlers.has('chat:message')).toBe(true)
      expect(client.sdkEventHandlers.has('connection:status')).toBe(true)

      // Check handler counts - we have 2 handlers per event:
      // 1. Auto-bindings created in XMPPClient constructor (to global Zustand stores)
      // 2. Test bindings created in beforeEach (to mock stores)
      expect(client.sdkEventHandlers.get('roster:loaded')?.size).toBe(2)
      expect(client.sdkEventHandlers.get('room:added')?.size).toBe(2)
    })
  })
})
