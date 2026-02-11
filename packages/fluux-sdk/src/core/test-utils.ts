/**
 * Shared test utilities for XMPPClient tests
 */
import { vi, type Mock } from 'vitest'
import type { Element } from '@xmpp/client'
import type { Room, StoreBindings, SDKEvents, SDKEventPayload } from './types'
import type { StoreRefs } from '../bindings/storeBindings'

// Type utility to convert all function properties to Vitest Mock functions
type MockifyFunctions<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : T[K]
}

// Type for mock store bindings - all functions are Vitest Mocks
export type MockStoreBindings = {
  [K in keyof StoreBindings]: MockifyFunctions<StoreBindings[K]>
}

/**
 * Create a mock Room object with default values.
 * All required properties are provided with sensible defaults.
 * Pass partial overrides to customize specific properties.
 */
export const createMockRoom = (jid: string, overrides: Partial<Room> = {}): Room => ({
  jid,
  name: overrides.name ?? jid.split('@')[0],
  nickname: overrides.nickname ?? 'testuser',
  joined: overrides.joined ?? false,
  isJoining: overrides.isJoining,
  subject: overrides.subject,
  avatar: overrides.avatar,
  avatarHash: overrides.avatarHash,
  avatarFromPresence: overrides.avatarFromPresence,
  occupants: overrides.occupants ?? new Map(),
  selfOccupant: overrides.selfOccupant,
  messages: overrides.messages ?? [],
  unreadCount: overrides.unreadCount ?? 0,
  mentionsCount: overrides.mentionsCount ?? 0,
  typingUsers: overrides.typingUsers ?? new Set(),
  isBookmarked: overrides.isBookmarked ?? false,
  autojoin: overrides.autojoin,
  password: overrides.password,
  notifyAll: overrides.notifyAll,
  notifyAllPersistent: overrides.notifyAllPersistent,
})

// Mock EventEmitter behavior for the XMPP client
export const createMockXmppClient = () => {
  const handlers: Record<string, Function[]> = {}
  const smHandlers: Record<string, Function[]> = {}
  const iqCalleeHandlers: Map<string, Function> = new Map()
  return {
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(handler)
      return this
    }),
    removeListener: vi.fn((event: string, handler: Function) => {
      if (handlers[event]) {
        const idx = handlers[event].indexOf(handler)
        if (idx > -1) handlers[event].splice(idx, 1)
      }
      return this
    }),
    off: vi.fn((event: string, handler: Function) => {
      if (handlers[event]) {
        const idx = handlers[event].indexOf(handler)
        if (idx > -1) handlers[event].splice(idx, 1)
      }
      return this
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    // Mock socket property (required by sendStanza health check)
    socket: { writable: true },
    // Mock iq-callee for roster push handling and disco#info
    // Simulates real xmpp.js iqCallee behavior:
    // - If handler registered and returns Element/truthy: sends IQ result
    // - If no handler registered: sends service-unavailable error
    iqCallee: {
      set: vi.fn((xmlns: string, element: string, handler: Function) => {
        iqCalleeHandlers.set(`set:${xmlns}:${element}`, handler)
      }),
      get: vi.fn((xmlns: string, element: string, handler: Function) => {
        iqCalleeHandlers.set(`get:${xmlns}:${element}`, handler)
      }),
      _handlers: iqCalleeHandlers,
      _call: (xmlns: string, element: string, context: unknown, type: 'set' | 'get' = 'set') => {
        const handler = iqCalleeHandlers.get(`${type}:${xmlns}:${element}`)
        if (handler) return handler(context)
        return undefined
      },
      // Simulate iqCallee processing an IQ stanza (like real xmpp.js does)
      // Returns true if handled, false if no handler (would send service-unavailable)
      _processIQ: function(stanza: any, sendFn: Function): boolean {
        const type = stanza.attrs?.type
        if (type !== 'get' && type !== 'set') return false

        const child = stanza.children?.[0]
        if (!child) return false

        const xmlns = child.attrs?.xmlns
        const element = child.name
        const key = `${type}:${xmlns}:${element}`
        const handler = iqCalleeHandlers.get(key)

        if (!handler) {
          // Real iqCallee sends service-unavailable when no handler
          sendFn({
            name: 'iq',
            attrs: { type: 'error', to: stanza.attrs?.from, id: stanza.attrs?.id },
            children: [
              child,
              { name: 'error', attrs: { type: 'cancel' }, children: [
                { name: 'service-unavailable', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } }
              ]}
            ]
          })
          return true // Handled (with error)
        }

        const result = handler({ stanza, element: child })
        if (result && typeof result === 'object' && result.name) {
          // Handler returned Element - wrap in IQ result
          sendFn({
            name: 'iq',
            attrs: { type: 'result', to: stanza.attrs?.from, id: stanza.attrs?.id },
            children: [result]
          })
        } else if (result) {
          // Handler returned truthy - send empty result
          sendFn({
            name: 'iq',
            attrs: { type: 'result', to: stanza.attrs?.from, id: stanza.attrs?.id },
            children: []
          })
        }
        return true
      },
    },
    // Mock for @xmpp/reconnect module
    reconnect: {
      stop: vi.fn(),
      start: vi.fn(),
    },
    // Mock for iq-caller module (used for disco#info queries, bookmarks, etc.)
    // Return sensible defaults instead of rejecting to avoid stderr noise
    iqCaller: {
      request: vi.fn().mockImplementation(async (iq: any) => {
        const firstChild = iq.children?.[0]
        const xmlns = firstChild?.attrs?.xmlns

        // Bookmarks query via PubSub (XEP-0402)
        if (xmlns === 'http://jabber.org/protocol/pubsub') {
          const items = firstChild.children?.find((c: any) => c.name === 'items')
          if (items?.attrs?.node === 'urn:xmpp:bookmarks:1') {
            // Return empty bookmarks
            return createMockElement('iq', { type: 'result' }, [
              {
                name: 'pubsub',
                attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
                children: [
                  {
                    name: 'items',
                    attrs: { node: 'urn:xmpp:bookmarks:1' },
                    children: [] // No bookmarked rooms
                  }
                ]
              }
            ])
          }
        }

        // Disco#items query
        if (xmlns === 'http://jabber.org/protocol/disco#items') {
          // Return empty items list (no services)
          return createMockElement('iq', { type: 'result' }, [
            { name: 'query', attrs: { xmlns }, children: [] }
          ])
        }

        // Disco#info query
        if (xmlns === 'http://jabber.org/protocol/disco#info') {
          // Return minimal disco info (no features)
          return createMockElement('iq', { type: 'result' }, [
            { name: 'query', attrs: { xmlns }, children: [] }
          ])
        }

        // VCard query (vcard-temp)
        if (xmlns === 'vcard-temp') {
          // Return empty vCard (no avatar)
          return createMockElement('iq', { type: 'result' }, [
            { name: 'vCard', attrs: { xmlns }, children: [] }
          ])
        }

        // PubSub query (for bookmarks, etc.)
        if (xmlns === 'http://jabber.org/protocol/pubsub') {
          // Return empty pubsub result (no bookmarks)
          return createMockElement('iq', { type: 'result' }, [
            { name: 'pubsub', attrs: { xmlns }, children: [] }
          ])
        }

        // Default: return empty result to avoid "Not mocked" errors
        // This ensures all IQ queries have a response, even if empty
        return {
          name: 'iq',
          attrs: { type: 'result' },
          children: [],
          getChild: (_name: string) => undefined,
          getChildren: () => [],
        }
      }),
    },
    // Mock Stream Management plugin
    streamManagement: {
      id: null as string | null,
      enabled: false,
      inbound: 0,
      outbound: 0,
      on: vi.fn((event: string, handler: Function) => {
        if (!smHandlers[event]) smHandlers[event] = []
        smHandlers[event].push(handler)
      }),
    },
    // Helper to trigger events in tests
    _emit: (event: string, ...args: unknown[]) => {
      handlers[event]?.forEach(h => h(...args))
    },
    // Helper to trigger SM events in tests
    _emitSM: (event: string, ...args: unknown[]) => {
      smHandlers[event]?.forEach(h => h(...args))
    },
    _handlers: handlers,
    _smHandlers: smHandlers,
  }
}

export type MockXmppClient = ReturnType<typeof createMockXmppClient>

// Type for mock element children - supports nested elements with optional methods
type MockChildInput = {
  name: string
  attrs?: Record<string, string>
  text?: string
  children?: unknown[]
  getChildren?: (name: string) => unknown[]
  getChild?: (name: string, xmlns?: string) => unknown
}

/**
 * Mock Element type that matches the interface of @xmpp/client Element
 * but with implementation suitable for testing.
 */
export interface MockElement {
  name: string
  attrs: Record<string, string>
  children: (string | MockElement)[]
  _text?: string
  is: (tagName: string) => boolean
  getChild: (childName: string, xmlns?: string) => MockElement | undefined
  getChildText: (childName: string) => string | null
  getChildren: (childName: string) => MockElement[]
  getText: () => string | null
  text: () => string
  toString: () => string
}

// Helper to create mock XMPP Element for testing stanza handlers
// Returns Element type for compatibility with production code
export const createMockElement = (
  name: string,
  attrs: Record<string, string> = {},
  children: Array<MockChildInput> = []
): Element => {
  const childElements: MockElement[] = []

  for (const child of children) {
    const childEl = createMockElement(
      child.name,
      child.attrs || {},
      (child.children || []) as Array<MockChildInput>
    ) as unknown as MockElement
    if (child.text !== undefined) {
      childEl._text = child.text
    }
    childElements.push(childEl)
  }

  const element: MockElement = {
    name,
    attrs,
    children: childElements,
    _text: undefined,
    is: (tagName: string) => name === tagName,
    getChild: (childName: string, xmlns?: string) => {
      return childElements.find((c) => {
        if (c.name !== childName) return false
        if (xmlns && c.attrs?.xmlns !== xmlns) return false
        return true
      })
    },
    getChildText: (childName: string) => {
      const child = childElements.find((c) => c.name === childName)
      return child?._text || null
    },
    getChildren: (childName: string) => {
      return childElements.filter((c) => c.name === childName)
    },
    getText: function() {
      return this._text || null
    },
    // Alias for compatibility with xmpp.js Element.text()
    text: function() {
      return this._text || ''
    },
    toString: () => `<${name}/>`,
  }

  // Cast to Element for compatibility with production code
  return element as unknown as Element
}

/**
 * Default IQ response handler for tests.
 * Returns empty results for common IQ namespaces to avoid "Not mocked" errors.
 * Use this as a fallback in custom mock implementations.
 */
export const getDefaultIQResponse = (iq: Element): Element | null => {
  const firstChild = iq.children?.[0]
  const xmlns = typeof firstChild === 'object' && firstChild !== null ? firstChild.attrs?.xmlns : undefined

  if (xmlns === 'http://jabber.org/protocol/disco#info') {
    return createMockElement('iq', { type: 'result' }, [
      { name: 'query', attrs: { xmlns }, children: [] }
    ])
  }
  if (xmlns === 'http://jabber.org/protocol/disco#items') {
    return createMockElement('iq', { type: 'result' }, [
      { name: 'query', attrs: { xmlns }, children: [] }
    ])
  }
  if (xmlns === 'vcard-temp') {
    return createMockElement('iq', { type: 'result' }, [
      { name: 'vCard', attrs: { xmlns }, children: [] }
    ])
  }
  if (xmlns === 'http://jabber.org/protocol/pubsub') {
    return createMockElement('iq', { type: 'result' }, [
      { name: 'pubsub', attrs: { xmlns }, children: [] }
    ])
  }
  if (xmlns === 'jabber:iq:roster') {
    return createMockElement('iq', { type: 'result' }, [
      { name: 'query', attrs: { xmlns }, children: [] }
    ])
  }

  return null // No default handler - caller should handle or throw
}

/**
 * IQ Handler Test Helper
 *
 * Validates that IQ handlers are properly registered and don't produce
 * duplicate responses, errors, or mixed result+error responses.
 */
export interface IQHandlerTestResult {
  isRegistered: boolean
  registrationType: 'get' | 'set' | null
  responses: Array<{
    type: 'result' | 'error'
    stanza: any
  }>
  // Validation results
  hasDuplicateResponses: boolean
  hasUnexpectedError: boolean
  hasMixedResultAndError: boolean
  responseCount: number
}

export const createIQHandlerTester = (mockClient: ReturnType<typeof createMockXmppClient>) => {
  return {
    /**
     * Test an IQ handler by simulating an incoming IQ stanza
     *
     * @param xmlns - The namespace of the IQ child element
     * @param element - The element name (e.g., 'query')
     * @param type - 'get' or 'set'
     * @param stanzaAttrs - Optional attributes for the IQ stanza (from, id, etc.)
     * @returns Test results with validation
     */
    testHandler(
      xmlns: string,
      element: string,
      type: 'get' | 'set',
      stanzaAttrs: Record<string, string> = {}
    ): IQHandlerTestResult {
      const responses: IQHandlerTestResult['responses'] = []

      // Check registration
      const handlerKey = `${type}:${xmlns}:${element}`
      const isRegistered = mockClient.iqCallee._handlers.has(handlerKey)

      // Determine registration type
      let registrationType: 'get' | 'set' | null = null
      if (mockClient.iqCallee._handlers.has(`get:${xmlns}:${element}`)) {
        registrationType = 'get'
      } else if (mockClient.iqCallee._handlers.has(`set:${xmlns}:${element}`)) {
        registrationType = 'set'
      }

      // Create test IQ stanza
      const testStanza = createMockElement('iq', {
        type,
        id: stanzaAttrs.id || `test_${Date.now()}`,
        from: stanzaAttrs.from || 'tester@example.com/resource',
        to: stanzaAttrs.to || 'user@example.com/web',
      }, [
        { name: element, attrs: { xmlns } }
      ])

      // Collect responses from iqCallee
      const collectResponse = (stanza: any) => {
        responses.push({
          type: stanza.attrs?.type === 'error' ? 'error' : 'result',
          stanza
        })
      }

      // Process through iqCallee simulation
      mockClient.iqCallee._processIQ(testStanza, collectResponse)

      // Also check if our stanza handler would send additional responses
      // by tracking send() calls
      const sendCallsBefore = mockClient.send.mock.calls.length
      mockClient._emit('stanza', testStanza)
      const sendCallsAfter = mockClient.send.mock.calls.length

      // Add any direct send() calls as responses
      for (let i = sendCallsBefore; i < sendCallsAfter; i++) {
        const sentStanza = mockClient.send.mock.calls[i][0]
        if (sentStanza?.name === 'iq') {
          responses.push({
            type: sentStanza.attrs?.type === 'error' ? 'error' : 'result',
            stanza: sentStanza
          })
        }
      }

      // Analyze responses
      const resultCount = responses.filter(r => r.type === 'result').length
      const errorCount = responses.filter(r => r.type === 'error').length

      return {
        isRegistered,
        registrationType,
        responses,
        hasDuplicateResponses: responses.length > 1,
        hasUnexpectedError: errorCount > 0 && isRegistered,
        hasMixedResultAndError: resultCount > 0 && errorCount > 0,
        responseCount: responses.length,
      }
    },

    /**
     * Assert that an IQ handler is correctly configured
     * Throws descriptive errors if any validation fails
     */
    assertHandlerValid(
      xmlns: string,
      element: string,
      type: 'get' | 'set',
      stanzaAttrs: Record<string, string> = {}
    ): void {
      const result = this.testHandler(xmlns, element, type, stanzaAttrs)

      if (!result.isRegistered) {
        throw new Error(
          `IQ handler not registered for ${type}:${xmlns}:${element}. ` +
          `This will cause service-unavailable errors in production.`
        )
      }

      if (result.registrationType !== type) {
        throw new Error(
          `IQ handler registered with wrong type. ` +
          `Expected '${type}' but found '${result.registrationType}'.`
        )
      }

      if (result.hasDuplicateResponses) {
        throw new Error(
          `IQ handler produces ${result.responseCount} responses (expected 1). ` +
          `Types: ${result.responses.map(r => r.type).join(', ')}. ` +
          `This causes duplicate stanzas in production.`
        )
      }

      if (result.hasMixedResultAndError) {
        throw new Error(
          `IQ handler produces both result and error responses. ` +
          `This is invalid XMPP behavior.`
        )
      }

      if (result.hasUnexpectedError) {
        throw new Error(
          `IQ handler is registered but produces an error response. ` +
          `Check that the handler returns a valid Element or truthy value.`
        )
      }

      if (result.responseCount === 0) {
        throw new Error(
          `IQ handler produces no response. ` +
          `All IQ get/set stanzas must receive a response.`
        )
      }
    },

    /**
     * Get a summary of all registered IQ handlers
     */
    getRegisteredHandlers(): Array<{ type: 'get' | 'set'; xmlns: string; element: string }> {
      const handlers: Array<{ type: 'get' | 'set'; xmlns: string; element: string }> = []

      for (const key of mockClient.iqCallee._handlers.keys()) {
        // Key format is "type:xmlns:element" but xmlns may contain colons
        // e.g., "get:http://jabber.org/protocol/disco#info:query"
        const firstColon = key.indexOf(':')
        const lastColon = key.lastIndexOf(':')
        const type = key.substring(0, firstColon)
        const xmlns = key.substring(firstColon + 1, lastColon)
        const element = key.substring(lastColon + 1)

        handlers.push({
          type: type as 'get' | 'set',
          xmlns,
          element
        })
      }

      return handlers
    }
  }
}

// Create mock store bindings with proper mock types
export const createMockStores = (): MockStoreBindings => ({
  connection: {
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue('disconnected'),
    setJid: vi.fn(),
    setError: vi.fn(),
    setReconnectState: vi.fn(),
    setPresenceState: vi.fn(),
    setAutoAway: vi.fn(),
    setServerInfo: vi.fn(),
    setConnectionMethod: vi.fn(),
    getPresenceShow: vi.fn().mockReturnValue('online'),
    getStatusMessage: vi.fn().mockReturnValue(null),
    getIsAutoAway: vi.fn().mockReturnValue(false),
    getPreAutoAwayState: vi.fn().mockReturnValue(null),
    getPreAutoAwayStatusMessage: vi.fn().mockReturnValue(null),
    clearPreAutoAwayState: vi.fn(),
    setOwnAvatar: vi.fn(),
    setOwnNickname: vi.fn(),
    getOwnNickname: vi.fn().mockReturnValue(null),
    updateOwnResource: vi.fn(),
    removeOwnResource: vi.fn(),
    clearOwnResources: vi.fn(),
    getJid: vi.fn().mockReturnValue(null),
    setHttpUploadService: vi.fn(),
    getHttpUploadService: vi.fn().mockReturnValue(null),
    getServerInfo: vi.fn().mockReturnValue(null),
  },
  chat: {
    addMessage: vi.fn(),
    addConversation: vi.fn(),
    updateConversationName: vi.fn(),
    hasConversation: vi.fn().mockReturnValue(false),
    setTyping: vi.fn(),
    updateReactions: vi.fn(),
    updateMessage: vi.fn(),
    getMessage: vi.fn().mockReturnValue(undefined),
    triggerAnimation: vi.fn(),
    // XEP-0313: MAM support
    setMAMLoading: vi.fn(),
    setMAMError: vi.fn(),
    mergeMAMMessages: vi.fn(),
    getMAMQueryState: vi.fn().mockReturnValue({ isLoading: false, error: null, hasQueried: false, isHistoryComplete: false }),
    resetMAMStates: vi.fn(),
    markAllNeedsCatchUp: vi.fn(),
    clearNeedsCatchUp: vi.fn(),
    updateLastMessagePreview: vi.fn(),
    getAllConversations: vi.fn().mockReturnValue([]),
    getArchivedConversations: vi.fn().mockReturnValue([]),
    unarchiveConversation: vi.fn(),
    getLastMessage: vi.fn().mockReturnValue(undefined),
  },
  roster: {
    setContacts: vi.fn(),
    addOrUpdateContact: vi.fn(),
    updateContact: vi.fn(),
    updatePresence: vi.fn(),
    removePresence: vi.fn(),
    setPresenceError: vi.fn(),
    updateAvatar: vi.fn(),
    removeContact: vi.fn(),
    hasContact: vi.fn().mockReturnValue(true), // Default to true so messages are processed normally
    getContact: vi.fn().mockReturnValue(undefined),
    getOfflineContacts: vi.fn().mockReturnValue([]),
    sortedContacts: vi.fn().mockReturnValue([]),
    resetAllPresence: vi.fn(),
  },
  console: {
    addPacket: vi.fn(),
    addEvent: vi.fn(),
  },
  events: {
    addSubscriptionRequest: vi.fn(),
    removeSubscriptionRequest: vi.fn(),
    addStrangerMessage: vi.fn(),
    removeStrangerMessages: vi.fn(),
    addMucInvitation: vi.fn(),
    removeMucInvitation: vi.fn(),
    addSystemNotification: vi.fn(),
    clearSystemNotifications: vi.fn(),
  },
  room: {
    addRoom: vi.fn(),
    updateRoom: vi.fn(),
    removeRoom: vi.fn(),
    setRoomJoined: vi.fn(),
    addOccupant: vi.fn(),
    batchAddOccupants: vi.fn(),
    removeOccupant: vi.fn(),
    setSelfOccupant: vi.fn(),
    getRoom: vi.fn().mockReturnValue(undefined),
    addMessage: vi.fn(),
    updateReactions: vi.fn(),
    updateMessage: vi.fn(),
    getMessage: vi.fn().mockReturnValue(undefined),
    markAsRead: vi.fn(),
    getActiveRoomJid: vi.fn().mockReturnValue(null),
    setTyping: vi.fn(),
    setBookmark: vi.fn(),
    removeBookmark: vi.fn(),
    setNotifyAll: vi.fn(),
    joinedRooms: vi.fn().mockReturnValue([]),
    triggerAnimation: vi.fn(),
    // XEP-0313: MAM support for MUC rooms
    setRoomMAMLoading: vi.fn(),
    setRoomMAMError: vi.fn(),
    mergeRoomMAMMessages: vi.fn(),
    getRoomMAMQueryState: vi.fn().mockReturnValue({ isLoading: false, error: null, hasQueried: false, isHistoryComplete: false }),
    resetRoomMAMStates: vi.fn(),
    markAllRoomsNeedsCatchUp: vi.fn(),
    clearRoomNeedsCatchUp: vi.fn(),
    updateLastMessagePreview: vi.fn(),
    loadPreviewFromCache: vi.fn().mockResolvedValue(null),
  },
  admin: {
    setIsAdmin: vi.fn(),
    setCommands: vi.fn(),
    getCommands: vi.fn(() => []),
    setCurrentSession: vi.fn(),
    setIsDiscovering: vi.fn(),
    setIsExecuting: vi.fn(),
    getCurrentSession: vi.fn().mockReturnValue(null),
    setEntityCounts: vi.fn(),
    setMucServiceJid: vi.fn(),
    getMucServiceJid: vi.fn().mockReturnValue(null),
    setMucServiceSupportsMAM: vi.fn(),
    getMucServiceSupportsMAM: vi.fn().mockReturnValue(null),
    setVhosts: vi.fn(),
    setSelectedVhost: vi.fn(),
    selectedVhost: null,
    reset: vi.fn(),
  },
  blocking: {
    setBlocklist: vi.fn(),
    addBlockedJids: vi.fn(),
    removeBlockedJids: vi.fn(),
    clearBlocklist: vi.fn(),
    isBlocked: vi.fn().mockReturnValue(false),
    getBlockedJids: vi.fn().mockReturnValue([]),
  },
})

/**
 * Create a mock XMPPClient instance with namespace structure for hook tests.
 * This provides the same API structure as the real XMPPClient class.
 */
export const createMockXMPPClientForHooks = () => ({
  // Core methods (on XMPPClient directly)
  connect: vi.fn(),
  disconnect: vi.fn(),
  cancelReconnect: vi.fn(),
  getStreamManagementState: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
  getJid: vi.fn().mockReturnValue('user@example.com/resource'),
  on: vi.fn(),
  off: vi.fn(),
  onStanza: vi.fn(),
  sendRawXml: vi.fn(),

  // Namespace modules
  roster: {
    addContact: vi.fn(),
    removeContact: vi.fn(),
    renameContact: vi.fn(),
    acceptSubscription: vi.fn(),
    rejectSubscription: vi.fn(),
    setPresence: vi.fn(),
    fetchRoster: vi.fn(),
  },
  profile: {
    fetchContactNickname: vi.fn(),
    fetchOwnNickname: vi.fn(),
    publishOwnNickname: vi.fn(),
    clearOwnNickname: vi.fn(),
    publishOwnAvatar: vi.fn(),
    clearOwnAvatar: vi.fn(),
    fetchAppearance: vi.fn(),
    setAppearance: vi.fn(),
    fetchOwnProfile: vi.fn(),
    restoreContactAvatarFromCache: vi.fn(),
    restoreOwnAvatarFromCache: vi.fn(),
    restoreRoomAvatarFromCache: vi.fn(),
    setRoomAvatar: vi.fn(),
    clearRoomAvatar: vi.fn(),
    changePassword: vi.fn(),
  },
  chat: {
    sendMessage: vi.fn(),
    sendChatState: vi.fn(),
    sendReaction: vi.fn(),
    sendCorrection: vi.fn(),
    sendRetraction: vi.fn(),
    sendEasterEgg: vi.fn(),
    sendLinkPreview: vi.fn(),
    queryMAM: vi.fn(),
    queryRoomMAM: vi.fn(),
  },
  muc: {
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    setBookmark: vi.fn(),
    removeBookmark: vi.fn(),
    setRoomNotifyAll: vi.fn(),
    createQuickChat: vi.fn(),
    sendMediatedInvitation: vi.fn(),
    sendMediatedInvitations: vi.fn(),
  },
  admin: {
    executeAdminCommand: vi.fn(),
    cancelAdminCommand: vi.fn(),
    fetchEntityCounts: vi.fn(),
    fetchVhosts: vi.fn(),
    fetchUserList: vi.fn(),
    discoverMucService: vi.fn(),
    fetchRoomList: vi.fn(),
    fetchRoomOptions: vi.fn(),
  },
  discovery: {
    requestUploadSlot: vi.fn(),
  },
})

export type MockXMPPClientForHooks = ReturnType<typeof createMockXMPPClientForHooks>

/**
 * Setup mock for @xmpp/client module
 * Must be called before importing XMPPClient
 */
export const setupXmppClientMock = (mockInstance: MockXmppClient) => {
  vi.mock('@xmpp/client', () => ({
    client: vi.fn(() => mockInstance),
    xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
      name,
      attrs: attrs || {},
      children,
      toString: () => `<${name}/>`,
    })),
  }))

  vi.mock('@xmpp/debug', () => ({
    default: vi.fn(),
  }))
}

// ============================================================================
// SDK Event Testing Utilities
// ============================================================================

/**
 * Mock XMPPClient with type-safe SDK event subscription and emission.
 * Used for testing store bindings and event-based integrations.
 */
export interface MockSDKClient {
  /** Subscribe to an SDK event. Returns unsubscribe function. */
  subscribe: Mock<(event: string, handler: (payload: unknown) => void) => () => void>
  /**
   * Type-safe event emitter for tests.
   * @param event - SDK event name (e.g., 'connection:status', 'chat:message')
   * @param payload - Event payload matching the event type
   */
  emit: <E extends keyof SDKEvents>(event: E, payload: SDKEventPayload<E>) => void
  /** Internal handler storage (for debugging) */
  _handlers: Map<string, Set<(payload: unknown) => void>>
}

/**
 * Create a mock XMPPClient with SDK event subscription/emission capabilities.
 * This provides type-safe event emission for testing store bindings.
 *
 * @example
 * ```typescript
 * const mockClient = createMockClientWithSDKEvents()
 * const stores = createMockStoreRefs()
 *
 * createStoreBindings(mockClient as unknown as XMPPClient, () => stores)
 *
 * // Type-safe event emission
 * mockClient.emit('connection:status', { status: 'connecting' })
 * expect(stores.connection.setStatus).toHaveBeenCalledWith('connecting')
 *
 * mockClient.emit('chat:message', { message: { id: '1', body: 'Hello' } })
 * expect(stores.chat.addMessage).toHaveBeenCalled()
 * ```
 */
export const createMockClientWithSDKEvents = (): MockSDKClient => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()

  return {
    subscribe: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (!handlers.has(event)) {
        handlers.set(event, new Set())
      }
      handlers.get(event)!.add(handler)
      return () => {
        handlers.get(event)?.delete(handler)
      }
    }),
    emit: <E extends keyof SDKEvents>(event: E, payload: SDKEventPayload<E>) => {
      handlers.get(event)?.forEach(h => h(payload))
    },
    _handlers: handlers,
  }
}

// Type utility for mock StoreRefs - all methods are Vitest Mocks
type MockifyMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : T[K]
}

export type MockStoreRefs = {
  [K in keyof StoreRefs]: MockifyMethods<StoreRefs[K]>
}

/**
 * Create mock StoreRefs for testing store bindings.
 * All methods are Vitest mocks that can be inspected and asserted against.
 *
 * @example
 * ```typescript
 * const stores = createMockStoreRefs()
 *
 * // Use with createStoreBindings
 * createStoreBindings(mockClient as unknown as XMPPClient, () => stores)
 *
 * // Assert store methods were called
 * mockClient.emit('connection:status', { status: 'online' })
 * expect(stores.connection.setStatus).toHaveBeenCalledWith('online')
 * ```
 */
export const createMockStoreRefs = (): MockStoreRefs => ({
  connection: {
    setStatus: vi.fn(),
    setJid: vi.fn(),
    setError: vi.fn(),
    setServerInfo: vi.fn(),
    setHttpUploadService: vi.fn(),
    setOwnAvatar: vi.fn(),
    setOwnNickname: vi.fn(),
    updateOwnResource: vi.fn(),
    removeOwnResource: vi.fn(),
  } as unknown as MockStoreRefs['connection'],
  chat: {
    addMessage: vi.fn(),
    addConversation: vi.fn(),
    updateConversationName: vi.fn(),
    setTyping: vi.fn(),
    updateReactions: vi.fn(),
    updateMessage: vi.fn(),
    triggerAnimation: vi.fn(),
  } as unknown as MockStoreRefs['chat'],
  roster: {
    setContacts: vi.fn(),
    addOrUpdateContact: vi.fn(),
    removeContact: vi.fn(),
    updatePresence: vi.fn(),
    removePresence: vi.fn(),
    setPresenceError: vi.fn(),
    updateAvatar: vi.fn(),
  } as unknown as MockStoreRefs['roster'],
  room: {
    addRoom: vi.fn(),
    updateRoom: vi.fn(),
    removeRoom: vi.fn(),
    setRoomJoined: vi.fn(),
    addOccupant: vi.fn(),
    batchAddOccupants: vi.fn(),
    removeOccupant: vi.fn(),
    setSelfOccupant: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    updateReactions: vi.fn(),
    setTyping: vi.fn(),
    setBookmark: vi.fn(),
    removeBookmark: vi.fn(),
    triggerAnimation: vi.fn(),
  } as unknown as MockStoreRefs['room'],
  events: {
    addSubscriptionRequest: vi.fn(),
    removeSubscriptionRequest: vi.fn(),
    addStrangerMessage: vi.fn(),
    removeStrangerMessages: vi.fn(),
    addMucInvitation: vi.fn(),
    removeMucInvitation: vi.fn(),
    addSystemNotification: vi.fn(),
  } as unknown as MockStoreRefs['events'],
  admin: {
    setIsAdmin: vi.fn(),
    setCommands: vi.fn(),
    setCurrentSession: vi.fn(),
    setIsDiscovering: vi.fn(),
    setIsExecuting: vi.fn(),
  } as unknown as MockStoreRefs['admin'],
  blocking: {
    setBlocklist: vi.fn(),
    addBlockedJids: vi.fn(),
    removeBlockedJids: vi.fn(),
    clearBlocklist: vi.fn(),
  } as unknown as MockStoreRefs['blocking'],
  console: {
    addEvent: vi.fn(),
    addPacket: vi.fn(),
  } as unknown as MockStoreRefs['console'],
})
