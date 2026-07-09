/**
 * XMPPClient Core Tests
 *
 * Tests for core functionality: event emitter, state getters, console packet logging,
 * Stream Management resume detection, dead socket detection, and verifyConnection.
 *
 * Feature-specific tests are split into separate files:
 * - XMPPClient.connection.test.ts - connect, disconnect, reconnection
 * - XMPPClient.roster.test.ts - contact management, roster push
 * - XMPPClient.message.test.ts - message handling, carbons, chat states
 * - XMPPClient.presence.test.ts - presence handling, MUC presence
 * - XMPPClient.disco.test.ts - service discovery, server info
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from './XMPPClient'
import type { ConnectionStatus } from './types/connection'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  createMockRoom,
  type MockXmppClient,
  type MockStoreBindings,
} from './test-utils'
import { VERIFY_CONNECTION_TIMEOUT_MS } from './modules/connectionTimeouts'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { defaultStores, type SDKStores } from '../stores'
import { createDefaultStoreBindings } from './defaultStoreBindings'

let mockXmppClientInstance: MockXmppClient

// Use vi.hoisted to create the mock factory at hoist time
const { mockClientFactory, mockXmlFn } = vi.hoisted(() => {
  let clientInstance: MockXmppClient | null = null
  return {
    mockClientFactory: Object.assign(
      vi.fn(() => clientInstance),
      {
        _setInstance: (instance: MockXmppClient | any) => { clientInstance = instance },
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

describe('XMPPClient', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    _resetStorageScopeForTesting()
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('auto-initialization', () => {
    it('should initialize modules automatically without calling bindStores', () => {
      // Create a new client without calling bindStores
      const client = new XMPPClient({ debug: false })

      // Modules should be available immediately
      expect(client.connection).toBeDefined()
      expect(client.chat).toBeDefined()
      expect(client.roster).toBeDefined()
      expect(client.muc).toBeDefined()
      expect(client.admin).toBeDefined()
      expect(client.profile).toBeDefined()
      expect(client.discovery).toBeDefined()
      expect(client.mam).toBeDefined()
      expect(client.blocking).toBeDefined()
    })

    it('should work for headless bot usage without any setup', () => {
      // Simple bot-style usage - just create and use
      const client = new XMPPClient()

      // Should have all the necessary methods
      expect(typeof client.chat.sendMessage).toBe('function')
      expect(typeof client.muc.joinRoom).toBe('function')
      expect(typeof client.roster.addContact).toBe('function')
    })

    it('installs the crypto.randomUUID polyfill in the constructor (legacy webviews)', () => {
      // The polyfill must NOT rely on an import-time side effect (the package
      // is sideEffects:false, so bundlers may drop those) — constructing a
      // client must be enough, on any entry point.
      vi.stubGlobal('crypto', {
        getRandomValues: (arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) arr[i] = i
          return arr
        },
      })
      try {
        expect(typeof (globalThis.crypto as Crypto).randomUUID).toBe('undefined')
        new XMPPClient({ debug: false })
        expect(typeof (globalThis.crypto as Crypto).randomUUID).toBe('function')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('should allow bindStores to override default bindings (backwards compatibility)', () => {
      const client = new XMPPClient({ debug: false })

      // Override with custom mock stores
      client.bindStores(mockStores)

      // Modules should still work
      expect(client.connection).toBeDefined()
      expect(client.chat).toBeDefined()
    })

    it('should create presenceActor automatically', () => {
      const client = new XMPPClient({ debug: false })

      // Presence actor should be available immediately
      expect(client.presenceActor).toBeDefined()
      expect(client.presenceActor.getSnapshot).toBeDefined()
      expect(client.presenceActor.send).toBeDefined()
    })

    it('should have presenceActor in disconnected state initially', () => {
      const client = new XMPPClient({ debug: false })

      const state = client.presenceActor.getSnapshot()
      expect(state.value).toBe('disconnected')
    })

    it('should allow sending events to presenceActor', () => {
      const client = new XMPPClient({ debug: false })

      // Send CONNECT event
      client.presenceActor.send({ type: 'CONNECT' })

      // Should transition to connected.userOnline
      const state = client.presenceActor.getSnapshot()
      expect(state.value).toEqual({ connected: 'userOnline' })
    })

    it('should allow setting presence via presenceActor', () => {
      const client = new XMPPClient({ debug: false })

      // Connect first
      client.presenceActor.send({ type: 'CONNECT' })

      // Set presence to DND
      client.presenceActor.send({ type: 'SET_PRESENCE', show: 'dnd', status: 'Busy' })

      // Should be in DND state
      const state = client.presenceActor.getSnapshot()
      expect(state.value).toEqual({ connected: 'userDnd' })
      expect(state.context.statusMessage).toBe('Busy')
    })

    it('should set up connection handlers that send CONNECT/DISCONNECT events', () => {
      // Clear persisted presence to ensure fresh state
      sessionStorage.removeItem('fluux:presence-machine')
      const client = new XMPPClient({ debug: false })
      client.bindStores(mockStores)

      // Verify the connection module has the handlers set up
      const connectionModule = (client as any).connection

      // The onConnectionSuccess handler should exist
      expect(connectionModule.onConnectionSuccess).toBeDefined()

      // The onDisconnect handler should exist
      expect(connectionModule.onDisconnect).toBeDefined()

      // Verify presence actor starts in disconnected state
      expect(client.presenceActor.getSnapshot().value).toBe('disconnected')

      // Manually verify the onDisconnect handler sends DISCONNECT
      const sendSpy = vi.spyOn(client.presenceActor, 'send')

      // First connect the presence actor
      client.presenceActor.send({ type: 'CONNECT' })
      expect(client.presenceActor.getSnapshot().value).toEqual({ connected: 'userOnline' })
      sendSpy.mockClear()

      // Call the disconnect handler (simulating what Connection module does)
      connectionModule.onDisconnect()

      // Verify DISCONNECT was sent
      expect(sendSpy).toHaveBeenCalledWith({ type: 'DISCONNECT' })
      expect(client.presenceActor.getSnapshot().value).toBe('disconnected')
    })

    it('should preserve lastUserPreference across disconnect/connect cycle', () => {
      // Clear persisted presence to ensure fresh state
      sessionStorage.removeItem('fluux:presence-machine')
      const client = new XMPPClient({ debug: false })

      // Connect and set DND
      client.presenceActor.send({ type: 'CONNECT' })
      client.presenceActor.send({ type: 'SET_PRESENCE', show: 'dnd', status: 'Busy' })
      expect(client.presenceActor.getSnapshot().value).toEqual({ connected: 'userDnd' })
      expect(client.presenceActor.getSnapshot().context.lastUserPreference).toBe('dnd')

      // Disconnect
      client.presenceActor.send({ type: 'DISCONNECT' })
      expect(client.presenceActor.getSnapshot().value).toBe('disconnected')

      // lastUserPreference should be preserved
      expect(client.presenceActor.getSnapshot().context.lastUserPreference).toBe('dnd')

      // Reconnect - should restore to DND
      client.presenceActor.send({ type: 'CONNECT' })
      expect(client.presenceActor.getSnapshot().value).toEqual({ connected: 'userDnd' })
    })

    it('should set up store bindings automatically (Phase 3)', () => {
      const client = new XMPPClient({ debug: false })

      // Access internal sdkEventHandlers to verify bindings are set up
      const handlers = (client as any).sdkEventHandlers

      // Key SDK events should have handlers registered from auto-bindings
      // Note: connection:status is handled directly by Connection.ts (not via storeBindings)
      expect(handlers.has('roster:loaded')).toBe(true)
      expect(handlers.has('chat:message')).toBe(true)
      expect(handlers.has('room:added')).toBe(true)
    })

    it('should have working store bindings that update global stores', () => {
      const client = new XMPPClient({ debug: false })

      // Emit an SDK event - store bindings should respond
      // This tests that createStoreBindings was called in constructor
      let handlerCalled = false
      client.subscribe('chat:message', () => {
        handlerCalled = true
      })

      // Emit via the chat module (which has access to emitSDK)
      const chat = client.chat as any
      chat.deps.emitSDK('chat:message', {
        message: {
          id: 'test',
          from: 'user@example.com',
          body: 'Hello',
          timestamp: new Date(),
          isOutgoing: false,
          type: 'chat' as const,
        }
      })

      expect(handlerCalled).toBe(true)
    })
  })

  describe('destroy', () => {
    it('should clean up presence sync subscription', () => {
      const client = new XMPPClient({ debug: false })

      // Destroy should not throw
      expect(() => client.destroy()).not.toThrow()
    })

    it('should NOT stop the presence actor (kept for StrictMode compatibility)', () => {
      // In React StrictMode, destroy() is called between mount cycles but the
      // client ref persists. If we stopped the actor here, presence sync would
      // break on the second mount. The actor will be garbage collected with the client.
      const client = new XMPPClient({ debug: false })

      const stopSpy = vi.spyOn(client.presenceActor, 'stop')

      client.destroy()

      expect(stopSpy).not.toHaveBeenCalled()
    })

    it('re-establishes the state snapshot subscriber after destroy() + setupBindings()', async () => {
      // Regression: React StrictMode runs setup -> cleanup(destroy) -> setup again.
      // destroy() tears down the snapshot subscriber (and nulls the field);
      // setupBindings() must recreate it, otherwise SM-resumable persistence is
      // silently disabled for the rest of the client's lifetime.
      const setRoster = vi.fn(async () => {})
      const storageAdapter = {
        getSessionState: vi.fn(async () => null),
        setSessionState: vi.fn(async () => {}),
        clearSessionState: vi.fn(async () => {}),
        setRoster,
      }
      const client = new XMPPClient({ debug: false, storageAdapter })
      // The snapshot only writes when getJid() resolves — feed it a currentJid.
      ;(client as unknown as { currentJid: string }).currentJid = 'user@example.com/res'

      // Simulate the StrictMode mount/cleanup/remount cycle.
      client.destroy()
      client.setupBindings()

      // flushStateSnapshot is a no-op when the snapshot was not recreated.
      await client.flushStateSnapshot()

      expect(setRoster).toHaveBeenCalledWith('user@example.com', expect.any(Array))
    })
  })

  describe('clearPersistedPresence', () => {
    it('should not throw when sessionStorage is unavailable', () => {
      const client = new XMPPClient({ debug: false })

      // Should not throw even without sessionStorage
      expect(() => client.clearPersistedPresence()).not.toThrow()
    })
  })

  describe('notifySystemState', () => {
    it('should send WAKE_DETECTED to presence actor on awake', async () => {
      const sendSpy = vi.spyOn(xmppClient.presenceActor, 'send')

      // notifySystemState delegates to connection module which requires connected state.
      // We only verify the presence signaling here (connection behavior tested elsewhere).
      await xmppClient.notifySystemState('awake').catch(() => {})

      expect(sendSpy).toHaveBeenCalledWith({ type: 'WAKE_DETECTED' })
    })

    it('should send SLEEP_DETECTED to presence actor on sleeping', async () => {
      const sendSpy = vi.spyOn(xmppClient.presenceActor, 'send')

      await xmppClient.notifySystemState('sleeping').catch(() => {})

      expect(sendSpy).toHaveBeenCalledWith({ type: 'SLEEP_DETECTED' })
    })

    it('should NOT send presence events for visible/hidden states', async () => {
      const sendSpy = vi.spyOn(xmppClient.presenceActor, 'send')

      await xmppClient.notifySystemState('visible').catch(() => {})
      await xmppClient.notifySystemState('hidden').catch(() => {})

      expect(sendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'WAKE_DETECTED' })
      )
      expect(sendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SLEEP_DETECTED' })
      )
    })
  })

  describe('namespace modules', () => {
    it('should expose all namespace modules after bindStores', () => {
      expect(xmppClient.connection).toBeDefined()
      expect(xmppClient.chat).toBeDefined()
      expect(xmppClient.roster).toBeDefined()
      expect(xmppClient.muc).toBeDefined()
      expect(xmppClient.admin).toBeDefined()
      expect(xmppClient.profile).toBeDefined()
      expect(xmppClient.discovery).toBeDefined()
    })

    it('should have expected methods on chat module', () => {
      expect(typeof xmppClient.chat.sendMessage).toBe('function')
      expect(typeof xmppClient.chat.sendChatState).toBe('function')
      expect(typeof xmppClient.chat.sendReaction).toBe('function')
    })

    it('should have expected methods on roster module', () => {
      expect(typeof xmppClient.roster.addContact).toBe('function')
      expect(typeof xmppClient.roster.removeContact).toBe('function')
      expect(typeof xmppClient.roster.setPresence).toBe('function')
    })

    it('should have expected methods on muc module', () => {
      expect(typeof xmppClient.muc.joinRoom).toBe('function')
      expect(typeof xmppClient.muc.leaveRoom).toBe('function')
      expect(typeof xmppClient.muc.setBookmark).toBe('function')
    })
  })

  describe('event emitter', () => {
    it('should emit online event on connection', async () => {
      const onlineHandler = vi.fn()
      xmppClient.on('online', onlineHandler)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(onlineHandler).toHaveBeenCalled()
    })

    it('should allow unsubscribing from events', async () => {
      const onlineHandler = vi.fn()
      const unsubscribe = xmppClient.on('online', onlineHandler)

      unsubscribe()

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(onlineHandler).not.toHaveBeenCalled()
    })
  })

  describe('SDK event system', () => {
    it('should allow subscribing to SDK events', () => {
      const handler = vi.fn()
      const unsubscribe = xmppClient.subscribe('chat:message', handler)

      expect(typeof unsubscribe).toBe('function')
    })

    it('should call handler when SDK event is emitted', () => {
      const handler = vi.fn()
      xmppClient.subscribe('chat:message', handler)

      const mockMessage = {
        type: 'chat' as const,
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: new Date(),
        isOutgoing: false,
      }

      ;(xmppClient as any).emitSDK('chat:message', { message: mockMessage })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ message: mockMessage })
    })

    it('should allow multiple handlers for the same event', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      xmppClient.subscribe('chat:message', handler1)
      xmppClient.subscribe('chat:message', handler2)

      const mockMessage = {
        type: 'chat' as const,
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: new Date(),
        isOutgoing: false,
      }

      ;(xmppClient as any).emitSDK('chat:message', { message: mockMessage })

      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    it('should allow unsubscribing from SDK events', () => {
      const handler = vi.fn()
      const unsubscribe = xmppClient.subscribe('chat:message', handler)

      unsubscribe()

      const mockMessage = {
        type: 'chat' as const,
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: new Date(),
        isOutgoing: false,
      }

      ;(xmppClient as any).emitSDK('chat:message', { message: mockMessage })

      expect(handler).not.toHaveBeenCalled()
    })

    it('should not affect other handlers when one unsubscribes', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      const unsubscribe1 = xmppClient.subscribe('chat:message', handler1)
      xmppClient.subscribe('chat:message', handler2)

      unsubscribe1()

      const mockMessage = {
        type: 'chat' as const,
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: new Date(),
        isOutgoing: false,
      }

      ;(xmppClient as any).emitSDK('chat:message', { message: mockMessage })

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    it('should handle events with different types independently', () => {
      const chatHandler = vi.fn()
      const roomHandler = vi.fn()

      xmppClient.subscribe('chat:message', chatHandler)
      xmppClient.subscribe('room:message', roomHandler)

      const mockChatMessage = {
        type: 'chat' as const,
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: new Date(),
        isOutgoing: false,
      }

      ;(xmppClient as any).emitSDK('chat:message', { message: mockChatMessage })

      expect(chatHandler).toHaveBeenCalledTimes(1)
      expect(roomHandler).not.toHaveBeenCalled()
    })

    it('should handle connection events', () => {
      const handler = vi.fn()
      xmppClient.subscribe('connection:status', handler)

      ;(xmppClient as any).emitSDK('connection:status', { status: 'online' })

      expect(handler).toHaveBeenCalledWith({ status: 'online' })
    })

    it('should handle roster events', () => {
      const handler = vi.fn()
      xmppClient.subscribe('roster:contact', handler)

      const mockContact = {
        jid: 'alice@example.com',
        name: 'Alice',
        subscription: 'both' as const,
        status: 'online' as const,
      }

      ;(xmppClient as any).emitSDK('roster:contact', { contact: mockContact })

      expect(handler).toHaveBeenCalledWith({ contact: mockContact })
    })
  })

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      expect(xmppClient.isConnected()).toBe(false)
    })

    it('should return true when connected', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(xmppClient.isConnected()).toBe(true)
    })
  })

  describe('getJid', () => {
    it('should return null when not connected', () => {
      expect(xmppClient.getJid()).toBeNull()
    })

    it('should return JID when connected', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(xmppClient.getJid()).toBe('user@example.com')
    })
  })

  describe('console packet logging', () => {
    it('should log incoming packets via element event', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear previous calls
      vi.mocked(mockStores.console.addPacket).mockClear()

      // Simulate incoming element
      const mockElement = {
        name: 'message',
        attrs: { from: 'contact@example.com' },
        toString: () => '<message from="contact@example.com"/>',
      }
      mockXmppClientInstance._emit('element', mockElement)

      // Should have logged incoming packet
      expect(mockStores.console.addPacket).toHaveBeenCalledWith(
        'incoming',
        '<message from="contact@example.com"/>'
      )
    })

    it('should log outgoing packets via send event', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear previous calls
      vi.mocked(mockStores.console.addPacket).mockClear()

      // Simulate outgoing send event
      const mockElement = {
        name: 'presence',
        attrs: {},
        toString: () => '<presence/>',
      }
      mockXmppClientInstance._emit('send', mockElement)

      // Should have logged outgoing packet
      expect(mockStores.console.addPacket).toHaveBeenCalledWith(
        'outgoing',
        '<presence/>'
      )
    })
  })

  describe('Stream Management resume detection', () => {
    // Helper to create a mock client with SM support
    const createMockXmppClientWithSM = (smId: string | null = null) => {
      const handlers: Record<string, Function[]> = {}
      const smHandlers: Record<string, Function[]> = {}
      const iqCalleeHandlers: Map<string, Function> = new Map()
      const pendingLifecycleEvents: Record<string, unknown[][]> = {}
      const pendingSmEvents: Record<string, unknown[][]> = {}
      const queueableLifecycleEvents = new Set(['online', 'resumed', 'disconnect', 'error', 'nonza'])
      return {
        on: vi.fn((event: string, handler: Function) => {
          if (!handlers[event]) handlers[event] = []
          handlers[event].push(handler)
          const pending = pendingLifecycleEvents[event]
          if (pending?.length) {
            for (const args of pending) {
              handler(...args)
            }
            delete pendingLifecycleEvents[event]
          }
          return this
        }),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
        socket: { writable: true },
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
          _processIQ: function() { return true },
        },
        iqCaller: {
          request: vi.fn().mockImplementation(async (iq: any) => {
            const xmlns = iq.children?.[0]?.attrs?.xmlns
            // Return empty results for common IQ namespaces
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
            // Default empty result
            return createMockElement('iq', { type: 'result' }, [])
          }),
        },
        reconnect: {
          stop: vi.fn(),
          start: vi.fn(),
        },
        // Stream Management mock
        streamManagement: {
          id: smId,
          inbound: 0,
          on: vi.fn((event: string, handler: Function) => {
            if (!smHandlers[event]) smHandlers[event] = []
            smHandlers[event].push(handler)
            const pending = pendingSmEvents[event]
            if (pending?.length) {
              for (const args of pending) {
                handler(...args)
              }
              delete pendingSmEvents[event]
            }
          }),
        },
        // Helper to trigger events in tests
        _emit: (event: string, ...args: unknown[]) => {
          const eventHandlers = handlers[event]
          if (eventHandlers?.length) {
            eventHandlers.forEach(h => h(...args))
            return
          }
          if (queueableLifecycleEvents.has(event)) {
            if (!pendingLifecycleEvents[event]) pendingLifecycleEvents[event] = []
            pendingLifecycleEvents[event].push(args)
          }
        },
        _emitSM: (event: string, ...args: unknown[]) => {
          const eventHandlers = smHandlers[event]
          if (eventHandlers?.length) {
            eventHandlers.forEach(h => h(...args))
            return
          }
          if (!pendingSmEvents[event]) pendingSmEvents[event] = []
          pendingSmEvents[event].push(args)
        },
        _handlers: handlers,
        _smHandlers: smHandlers,
      }
    }

    it('should detect SM resume when resumed event fires', async () => {
      // Create a mock with SM support and existing SM ID
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-123')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-123', inbound: 5, outbound: 0 },
        skipDiscovery: true,
      })

      // SM resume succeeded - emit <resumed/> nonza (the nonza listener detects resume)
      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-123',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      // Connection should be established
      expect(stores.connection.setStatus).toHaveBeenCalledWith('online')
      expect(stores.connection.setJid).toHaveBeenCalledWith('user@example.com')
    })

    it('should NOT refresh or rejoin rooms on SM resumption', async () => {
      // SM resumption preserves MUC membership server-side. The client must not
      // send directed presence or re-join; any diff (occupant changes, messages)
      // is delivered via the SM replay queue.
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-rooms')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const joinRoomSpy = vi.spyOn(newXmppClient.muc, 'joinRoom').mockResolvedValue()
      const fetchBookmarksSpy = vi.spyOn(newXmppClient.muc, 'fetchBookmarks')
        .mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-rooms', inbound: 5, outbound: 0 },
        skipDiscovery: true,
        previouslyJoinedRooms: [
          { jid: 'room1@conference.example.com', nickname: 'testuser' },
          { jid: 'room2@conference.example.com', nickname: 'testuser' },
        ],
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-rooms',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      expect(joinRoomSpy).not.toHaveBeenCalled()
      // Room store must not be touched — live state is authoritative
      expect(stores.room.markAllRoomsNotJoined).not.toHaveBeenCalled()
      // Bookmarks fetched as a safety net (unknown disconnect duration)
      expect(fetchBookmarksSpy).toHaveBeenCalled()
    })

    it('should skip MAM catch-up but fetch bookmarks on SM resumption when disconnect duration is unknown', async () => {
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-catchup')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const catchUpSpy = vi.spyOn(newXmppClient.mam, 'catchUpAllRooms').mockResolvedValue()
      const bookmarksSpy = vi.spyOn(newXmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-catchup', inbound: 5, outbound: 0 },
        skipDiscovery: true,
        previouslyJoinedRooms: [
          { jid: 'room1@conference.example.com', nickname: 'testuser' },
        ],
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-catchup',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      // Unknown disconnect duration → SM replay covers messages, fetch bookmarks only
      expect(catchUpSpy).not.toHaveBeenCalled()
      expect(bookmarksSpy).toHaveBeenCalled()
    })

    it('should skip MAM catch-up on SM resumption for short disconnects', async () => {
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-short')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const catchUpSpy = vi.spyOn(newXmppClient.mam, 'catchUpAllRooms').mockResolvedValue()
      const bookmarksSpy = vi.spyOn(newXmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      // Simulate a reconnect with short disconnect: set the disconnectedAtTimestamp
      // on the connection module, then connect triggers handleConnectionSuccess
      // which computes the duration.
      // We test this by setting the internal timestamp 30s ago.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(newXmppClient.connection as any).disconnectedAtTimestamp = Date.now() - 30_000

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-short', inbound: 5, outbound: 0 },
        skipDiscovery: true,
        previouslyJoinedRooms: [
          { jid: 'room1@conference.example.com', nickname: 'testuser' },
        ],
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-short',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      // Short disconnect (30s < 120s threshold) → skip MAM catch-up and bookmarks
      expect(catchUpSpy).not.toHaveBeenCalled()
      expect(bookmarksSpy).not.toHaveBeenCalled()
    })

    it('should hydrate sidebar previews from the durable cache on SM resumption', async () => {
      // On a reload that resumes via SM, the room list is rebuilt from persisted
      // state whose non-active rooms had their messages evicted before save, so they
      // carry no lastMessage and would sort at epoch-0 until opened. The resume path
      // must repopulate previews from the cache, same as a fresh session does.
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-hydrate')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      // Short disconnect keeps the path minimal (no bookmark fetch / catch-up).
      // (In this node env localStorage.getItem throws, so the cache-marker check is
      // swallowed and execution continues down the real SM-resume path.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(newXmppClient.connection as any).disconnectedAtTimestamp = Date.now() - 30_000

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-hydrate', inbound: 5, outbound: 0 },
        skipDiscovery: true,
        previouslyJoinedRooms: [
          { jid: 'room1@conference.example.com', nickname: 'testuser' },
        ],
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-hydrate',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      expect(stores.room.hydratePreviewsFromCache).toHaveBeenCalled()
    })

    it('should skip MAM catch-up but fetch bookmarks on SM resumption for long disconnects', async () => {
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-long')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const catchUpSpy = vi.spyOn(newXmppClient.mam, 'catchUpAllRooms').mockResolvedValue()
      const bookmarksSpy = vi.spyOn(newXmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      // Simulate a reconnect with long disconnect (5 minutes ago)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(newXmppClient.connection as any).disconnectedAtTimestamp = Date.now() - 300_000

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-long', inbound: 5, outbound: 0 },
        skipDiscovery: true,
        previouslyJoinedRooms: [
          { jid: 'room1@conference.example.com', nickname: 'testuser' },
        ],
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-long',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      // Long disconnect (300s > 120s threshold) → SM replay covers messages, fetch bookmarks only
      expect(catchUpSpy).not.toHaveBeenCalled()
      expect(bookmarksSpy).toHaveBeenCalled()
    })

    it('should NOT refresh avatar blob URLs on SM resumption for short disconnects', async () => {
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-short-avatar')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      vi.spyOn(newXmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })
      const refreshAvatarsSpy = vi.spyOn(newXmppClient.profile, 'refreshAllAvatarBlobUrls').mockResolvedValue()

      // Short disconnect (30s): WebKit keeps the blob URLs alive, so refreshing
      // them would needlessly re-read every avatar from IndexedDB on each blip.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(newXmppClient.connection as any).disconnectedAtTimestamp = Date.now() - 30_000

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-short-avatar', inbound: 5, outbound: 0 },
        skipDiscovery: true,
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-short-avatar',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      expect(refreshAvatarsSpy).not.toHaveBeenCalled()
    })

    it('should refresh avatar blob URLs on SM resumption for long disconnects', async () => {
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-long-avatar')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      vi.spyOn(newXmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })
      const refreshAvatarsSpy = vi.spyOn(newXmppClient.profile, 'refreshAllAvatarBlobUrls').mockResolvedValue()

      // Long disconnect (5 min) covers the OS sleep-wake case where WebKit may
      // have reclaimed the blob URLs — they must be re-created.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(newXmppClient.connection as any).disconnectedAtTimestamp = Date.now() - 300_000

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-long-avatar', inbound: 5, outbound: 0 },
        skipDiscovery: true,
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-long-avatar',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      expect(refreshAvatarsSpy).toHaveBeenCalled()
    })

    it('should leave the live room store untouched on SM resumption', async () => {
      // Whether or not previouslyJoinedRooms is provided, the store already
      // reflects the session's room state (either from in-memory continuity on
      // mid-session reconnect, or from storage hydration on page reload). SM
      // resume trusts it.
      const mockClientWithSM = createMockXmppClientWithSM('sm-id-store')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const storeRooms = [
        createMockRoom('room1@conference.example.com', { nickname: 'testuser', joined: true }),
      ]
      stores.room.joinedRooms.mockReturnValue(storeRooms)

      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const joinRoomSpy = vi.spyOn(newXmppClient.muc, 'joinRoom').mockResolvedValue()
      vi.spyOn(newXmppClient.muc, 'fetchBookmarks')
        .mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-id-store', inbound: 5, outbound: 0 },
        skipDiscovery: true,
      })

      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-id-store',
        h: '5',
      })
      mockClientWithSM._emit('nonza', resumedNonza)

      await connectPromise

      expect(joinRoomSpy).not.toHaveBeenCalled()
      expect(stores.room.markAllRoomsNotJoined).not.toHaveBeenCalled()
    })

    it('should detect new session when SM resume fails (online event fires)', async () => {
      // SM resume failed - server emits 'online' instead of 'resumed'
      const mockClientWithSM = createMockXmppClientWithSM(null)
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'old-sm-id-456', inbound: 10, outbound: 0 }, // Previous SM state
        skipDiscovery: true,
      })

      // SM resume failed - 'online' event fires (not 'resumed')
      mockClientWithSM._emit('online')

      await connectPromise

      // New session should be established
      expect(stores.connection.setStatus).toHaveBeenCalledWith('online')
    })

    it('should detect new session when no previous SM state exists', async () => {
      const mockClientWithSM = createMockXmppClientWithSM('new-sm-id')
      mockClientFactory._setInstance(mockClientWithSM)

      const stores = createMockStores()
      const newXmppClient = new XMPPClient({ debug: false })
      newXmppClient.bindStores(stores)

      const connectPromise = newXmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
        // No smState - first connection
      })

      mockClientWithSM._emit('online')

      await connectPromise

      // No previous SM state means it's definitely a new session
      expect(stores.connection.setStatus).toHaveBeenCalledWith('online')
    })

    it('should distinguish SM resume (resumed event) from new session (online event)', async () => {
      // Test the core logic:
      // - 'resumed' event fires = SM resume succeeded (isResumption=true)
      // - 'online' event fires = new session (isResumption=false)

      // Case 1: SM resume success - 'resumed' event fires
      const mockClient1 = createMockXmppClientWithSM('same-sm-id')
      mockClientFactory._setInstance(mockClient1)

      const stores1 = createMockStores()
      const client1 = new XMPPClient({ debug: false })
      client1.bindStores(stores1)

      const promise1 = client1.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'same-sm-id', inbound: 5, outbound: 0 },
        skipDiscovery: true,
      })

      // SM resume succeeded - emit <resumed/> nonza (NOT 'online')
      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'same-sm-id',
        h: '5',
      })
      mockClient1._emit('nonza', resumedNonza)
      await promise1

      expect(stores1.connection.setStatus).toHaveBeenCalledWith('online')

      // Case 2: SM resume failed - 'online' event fires (NOT 'resumed')
      const mockClient2 = createMockXmppClientWithSM('new-sm-id')
      mockClientFactory._setInstance(mockClient2)

      const stores2 = createMockStores()
      const client2 = new XMPPClient({ debug: false })
      client2.bindStores(stores2)

      const promise2 = client2.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'old-sm-id', inbound: 5, outbound: 0 },
        skipDiscovery: true,
      })

      // SM resume failed - 'online' fires instead of 'resumed'
      mockClient2._emit('online')
      await promise2

      expect(stores2.connection.setStatus).toHaveBeenCalledWith('online')
    })
  })

  describe('dead socket detection', () => {
    it('should detect dead socket error patterns', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate dead socket error on send
      mockXmppClientInstance.send.mockRejectedValueOnce(
        new Error("null is not an object (evaluating 'this.socket.write')")
      )

      // Try to send a message - should trigger dead socket handling
      await expect(xmppClient.chat.sendMessage('alice@example.com', 'test')).rejects.toThrow()

      // Should have logged dead connection and scheduled reconnect
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Dead connection detected, will reconnect',
        'connection'
      )
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
    })

    it('should not trigger reconnect if already reconnecting', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Trigger disconnect to start reconnecting (xmpp.js emits 'disconnect' on socket close)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // Clear mocks
      mockStores.console.addEvent.mockClear()
      mockStores.connection.setStatus.mockClear()

      // Now simulate dead socket error - should not double-trigger
      mockXmppClientInstance.send.mockRejectedValueOnce(
        new Error("WebSocket is not open")
      )

      try {
        await xmppClient.chat.sendMessage('alice@example.com', 'test')
      } catch {
        // Expected to throw
      }

      // Should NOT have logged dead connection again (already reconnecting)
      expect(mockStores.console.addEvent).not.toHaveBeenCalledWith(
        'Dead connection detected, will reconnect',
        'connection'
      )
    })

    it('should not trigger reconnect after manual disconnect', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Disconnect manually
      await xmppClient.disconnect()
      mockStores.console.addEvent.mockClear()
      mockStores.connection.setStatus.mockClear()

      // Dead socket detection should not trigger reconnect
      // (client is already null after disconnect, so this tests the flag check)
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })
  })

  describe('sendIQ health checks', () => {
    it('should throw Not connected when xmpp client is null', async () => {
      // Don't connect — xmpp client is null
      // Try an IQ-based operation (e.g., blocking list fetch)
      await expect(xmppClient.blocking.fetchBlocklist()).rejects.toThrow('Not connected')
    })

    it('should reject IQ traffic before auth phase is complete', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance.iqCaller.request.mockClear()

      await expect(xmppClient.blocking.fetchBlocklist()).rejects.toThrow('Not connected')
      expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()

      mockXmppClientInstance._emit('online')
      await connectPromise

      const callsBeforeFetch = mockXmppClientInstance.iqCaller.request.mock.calls.length
      await xmppClient.blocking.fetchBlocklist()
      expect(mockXmppClientInstance.iqCaller.request.mock.calls.length).toBeGreaterThan(callsBeforeFetch)
    })

    it('should trigger dead socket recovery when client is null but status is online', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate dead socket: null out the xmpp reference in Connection while status remains 'online'
      mockStores.connection.getStatus.mockReturnValue('online' as ConnectionStatus)
      ;(xmppClient.connection as any).xmpp = null

      mockStores.console.addEvent.mockClear()

      await expect(xmppClient.blocking.fetchBlocklist()).rejects.toThrow('Not connected')

      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Client null but status online (IQ) - triggering reconnect',
        'error'
      )
    })

    it('should throw Socket not available when socket is null', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Null out the socket while keeping the client
      ;(mockXmppClientInstance as any).socket = null
      mockStores.connection.getStatus.mockReturnValue('online' as ConnectionStatus)
      mockStores.console.addEvent.mockClear()

      await expect(xmppClient.blocking.fetchBlocklist()).rejects.toThrow('Socket not available')

      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Socket null but status online (IQ) - triggering reconnect',
        'error'
      )
    })

    it('should detect dead socket errors on IQ response failure', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate dead socket error from iqCaller
      mockXmppClientInstance.iqCaller.request.mockRejectedValueOnce(
        new Error("null is not an object (evaluating 'this.socket.write')")
      )

      await expect(xmppClient.blocking.fetchBlocklist()).rejects.toThrow()

      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Dead connection detected, will reconnect',
        'connection'
      )
    })
  })

  describe('verifyConnection', () => {
    it('should return false when not connected', async () => {
      const result = await xmppClient.verifyConnection()
      expect(result).toBe(false)
    })

    it('should send SM request when SM is enabled', async () => {
      // Add SM to the existing mock client
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Give time for async operations
      await vi.advanceTimersByTimeAsync(100)
      mockXmppClientInstance.send.mockClear()

      // Simulate SM ack response when send() is called
      mockXmppClientInstance.send.mockImplementationOnce(() => {
        // Emit the <a/> nonza response shortly after
        setTimeout(() => {
          const ackNonza = createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' })
          mockXmppClientInstance._emit('nonza', ackNonza)
        }, 10)
        return Promise.resolve()
      })

      const resultPromise = xmppClient.verifyConnection()
      await vi.advanceTimersByTimeAsync(100)
      const result = await resultPromise

      expect(result).toBe(true)
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentElement = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sentElement.name).toBe('r')
      expect(sentElement.attrs.xmlns).toBe('urn:xmpp:sm:3')
    })

    it('should set status to verifying and restore to online on success', async () => {
      // Add SM to the existing mock client
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Track status changes - start as 'online', then simulate actual state tracking
      let currentStatus: ConnectionStatus = 'online'
      mockStores.connection.getStatus.mockImplementation(() => currentStatus)
      mockStores.connection.setStatus.mockImplementation((status: ConnectionStatus) => {
        currentStatus = status
      })
      mockStores.connection.setStatus.mockClear()

      // Simulate SM ack response when send() is called
      mockXmppClientInstance.send.mockImplementationOnce(() => {
        setTimeout(() => {
          const ackNonza = createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' })
          mockXmppClientInstance._emit('nonza', ackNonza)
        }, 10)
        return Promise.resolve()
      })

      const resultPromise = xmppClient.verifyConnection()
      await vi.advanceTimersByTimeAsync(100)
      await resultPromise

      // verifying maps to 'online' status but sets isVerifying flag
      expect(mockStores.connection.setIsVerifying).toHaveBeenCalledWith(true)
      expect(mockStores.connection.setIsVerifying).toHaveBeenCalledWith(false)
    })

    it('should return false and trigger reconnect on dead socket', async () => {
      // Add SM to the existing mock client
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate being online, then dead socket on verify
      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()
      mockXmppClientInstance.send.mockRejectedValueOnce(
        new Error("Cannot read properties of null")
      )

      const result = await xmppClient.verifyConnection()

      expect(result).toBe(false)
      // verifying maps to 'online' status with isVerifying flag, then reconnecting
      expect(mockStores.connection.setIsVerifying).toHaveBeenCalledWith(true)
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
    })

    it('should return false and trigger reconnect on SM ack timeout', async () => {
      // Add SM to the existing mock client
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate being online
      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()
      // Don't simulate any ack response - let it timeout

      const resultPromise = xmppClient.verifyConnection()

      // Advance just beyond the verification timeout. Using runAllTimersAsync()
      // would also drain reconnect backoff timers and can loop indefinitely.
      await vi.advanceTimersByTimeAsync(VERIFY_CONNECTION_TIMEOUT_MS + 50)

      const result = await resultPromise

      expect(result).toBe(false)
      // verifying maps to 'online' status with isVerifying flag, then reconnecting
      expect(mockStores.connection.setIsVerifying).toHaveBeenCalledWith(true)
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
    })
  })

  describe('verifyConnectionHealth', () => {
    it('should return false when not connected', async () => {
      const result = await xmppClient.verifyConnectionHealth()
      expect(result).toBe(false)
    })

    it('should return true on successful SM ack without changing status', async () => {
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      await vi.advanceTimersByTimeAsync(100)
      mockStores.connection.setStatus.mockClear()
      mockXmppClientInstance.send.mockClear()

      // Simulate SM ack response when send() is called
      mockXmppClientInstance.send.mockImplementationOnce(() => {
        setTimeout(() => {
          const ackNonza = createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' })
          mockXmppClientInstance._emit('nonza', ackNonza)
        }, 10)
        return Promise.resolve()
      })

      const resultPromise = xmppClient.verifyConnectionHealth()
      await vi.advanceTimersByTimeAsync(100)
      const result = await resultPromise

      expect(result).toBe(true)
      // Should NOT change status (no verifying → online transition)
      expect(mockStores.connection.setStatus).not.toHaveBeenCalled()
    })

    it('should return false and trigger reconnect on SM ack timeout', async () => {
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()

      const resultPromise = xmppClient.verifyConnectionHealth()

      await vi.advanceTimersByTimeAsync(VERIFY_CONNECTION_TIMEOUT_MS + 50)

      const result = await resultPromise

      expect(result).toBe(false)
      // Should trigger reconnect (via handleDeadSocket) but NOT go through verifying
      expect(mockStores.connection.setIsVerifying).not.toHaveBeenCalledWith(true)
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
    })

    it('should return false and trigger reconnect on dead socket error', async () => {
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()
      mockXmppClientInstance.send.mockRejectedValueOnce(
        new Error("Cannot read properties of null")
      )

      const result = await xmppClient.verifyConnectionHealth()

      expect(result).toBe(false)
      expect(mockStores.connection.setIsVerifying).not.toHaveBeenCalledWith(true)
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
    })
  })

  describe('stale client detection after reconnect', () => {
    it('verifyConnectionHealth should return true (not kill new connection) when client is replaced during await', async () => {
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()

      // Start health check — this will call waitForSmAck on the current client
      const resultPromise = xmppClient.verifyConnectionHealth()

      // Simulate reconnection: disconnect first, then reconnect with a new client.
      // This is what happens when the connection drops and auto-reconnect fires.
      await xmppClient.disconnect()

      const newClient = createMockXmppClient()
      newClient.streamManagement = {
        id: 'sm-456',
        inbound: 10,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }
      mockClientFactory._setInstance(newClient)

      const reconnectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })
      newClient._emit('online')
      await reconnectPromise

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()

      // Now advance past the timeout — the stale waitForSmAck should fire
      await vi.advanceTimersByTimeAsync(VERIFY_CONNECTION_TIMEOUT_MS + 50)

      const result = await resultPromise

      // Should return true (stale result ignored) and NOT trigger reconnect
      expect(result).toBe(true)
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })

    it('verifyConnection should return true when client is replaced during await', async () => {
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()

      const resultPromise = xmppClient.verifyConnection()

      // Simulate reconnection mid-verify: disconnect first, then reconnect
      await xmppClient.disconnect()

      const newClient = createMockXmppClient()
      newClient.streamManagement = {
        id: 'sm-456',
        inbound: 10,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }
      mockClientFactory._setInstance(newClient)

      const reconnectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })
      newClient._emit('online')
      await reconnectPromise

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()

      await vi.advanceTimersByTimeAsync(VERIFY_CONNECTION_TIMEOUT_MS + 50)

      const result = await resultPromise

      expect(result).toBe(true)
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })
  })

  describe('internal event wiring (regression tests)', () => {
    // These tests ensure internal events are properly connected to their handlers.
    // They prevent regressions where events are emitted but have no listeners.

    it('should wire avatarMetadataUpdate to profile.fetchAvatarData', async () => {
      // Spy on the profile module's fetchAvatarData method
      const fetchAvatarDataSpy = vi.spyOn(xmppClient.profile, 'fetchAvatarData').mockResolvedValue()

      // Emit avatarMetadataUpdate (simulating what PubSub.ts or Roster.ts would emit)
      ;(xmppClient as any).emit('avatarMetadataUpdate', 'contact@example.com', 'abc123hash')

      expect(fetchAvatarDataSpy).toHaveBeenCalledWith('contact@example.com', 'abc123hash')
    })

    it('should clear avatar when avatarMetadataUpdate emits null hash', async () => {
      // Emit avatarMetadataUpdate with null hash (avatar removed)
      ;(xmppClient as any).emit('avatarMetadataUpdate', 'contact@example.com', null)

      expect(mockStores.roster.updateAvatar).toHaveBeenCalledWith('contact@example.com', null)
    })

    it('should wire mucJoined to profile.fetchRoomAvatar for rooms without avatars', async () => {
      // Mock room without avatar
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          joined: true,
          avatar: undefined,
          avatarFromPresence: false,
        })
      )

      const fetchRoomAvatarSpy = vi.spyOn(xmppClient.profile, 'fetchRoomAvatar').mockResolvedValue()

      // Emit mucJoined
      ;(xmppClient as any).emit('mucJoined', 'room@conference.example.com', 'nickname')

      expect(fetchRoomAvatarSpy).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should wire roomAvatarUpdate to profile.fetchRoomAvatar with hash', async () => {
      const fetchRoomAvatarSpy = vi.spyOn(xmppClient.profile, 'fetchRoomAvatar').mockResolvedValue()

      // Emit roomAvatarUpdate
      ;(xmppClient as any).emit('roomAvatarUpdate', 'room@conference.example.com', 'newhash123')

      // Should pass the hash to fetchRoomAvatar for cache lookup
      expect(fetchRoomAvatarSpy).toHaveBeenCalledWith('room@conference.example.com', 'newhash123')
    })

    it('should NOT call fetchRoomAvatar on mucJoined if room already has avatar from presence', async () => {
      // Mock room with avatar from presence
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          joined: true,
          avatar: 'blob:existing',
          avatarFromPresence: true,
        })
      )

      const fetchRoomAvatarSpy = vi.spyOn(xmppClient.profile, 'fetchRoomAvatar').mockResolvedValue()

      // Emit mucJoined
      ;(xmppClient as any).emit('mucJoined', 'room@conference.example.com', 'nickname')

      expect(fetchRoomAvatarSpy).not.toHaveBeenCalled()
    })

    it('should wire occupantAvatarUpdate to profile.fetchOccupantAvatar', async () => {
      // Mock room without existing occupant avatar
      const occupants = new Map()
      occupants.set('TestUser', { nick: 'TestUser', affiliation: 'member', role: 'participant' })
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          joined: true,
          occupants,
        })
      )

      const fetchOccupantAvatarSpy = vi.spyOn(xmppClient.profile, 'fetchOccupantAvatar').mockResolvedValue()

      // Emit occupantAvatarUpdate (simulating what MUC.ts would emit)
      ;(xmppClient as any).emit('occupantAvatarUpdate', 'room@conference.example.com', 'TestUser', 'abc123hash', 'realuser@example.com')

      expect(fetchOccupantAvatarSpy).toHaveBeenCalledWith(
        'room@conference.example.com',
        'TestUser',
        'abc123hash',
        'realuser@example.com'
      )
    })

    it('should NOT call fetchOccupantAvatar if occupant already has same hash and avatar', async () => {
      // Mock room with occupant that already has the avatar
      const occupants = new Map()
      occupants.set('TestUser', {
        nick: 'TestUser',
        affiliation: 'member',
        role: 'participant',
        avatarHash: 'abc123hash',
        avatar: 'blob:existing-avatar',
      })
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          joined: true,
          occupants,
        })
      )

      const fetchOccupantAvatarSpy = vi.spyOn(xmppClient.profile, 'fetchOccupantAvatar').mockResolvedValue()

      // Emit occupantAvatarUpdate with same hash
      ;(xmppClient as any).emit('occupantAvatarUpdate', 'room@conference.example.com', 'TestUser', 'abc123hash', 'realuser@example.com')

      // Should skip fetch since hash matches and avatar exists
      expect(fetchOccupantAvatarSpy).not.toHaveBeenCalled()
    })

    it('should call fetchOccupantAvatar if occupant hash changed', async () => {
      // Mock room with occupant that has a different hash
      const occupants = new Map()
      occupants.set('TestUser', {
        nick: 'TestUser',
        affiliation: 'member',
        role: 'participant',
        avatarHash: 'oldhash',
        avatar: 'blob:old-avatar',
      })
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          joined: true,
          occupants,
        })
      )

      const fetchOccupantAvatarSpy = vi.spyOn(xmppClient.profile, 'fetchOccupantAvatar').mockResolvedValue()

      // Emit occupantAvatarUpdate with new hash
      ;(xmppClient as any).emit('occupantAvatarUpdate', 'room@conference.example.com', 'TestUser', 'newhash456', 'realuser@example.com')

      // Should fetch since hash changed
      expect(fetchOccupantAvatarSpy).toHaveBeenCalledWith(
        'room@conference.example.com',
        'TestUser',
        'newhash456',
        'realuser@example.com'
      )
    })
  })

  describe('fresh session discovery resilience', () => {
    // Regression test for issue #308: fire-and-forget discovery calls must run
    // even when earlier serial IQ calls (roster, bookmarks, etc.) fail or the
    // overall session setup timeout fires.

    it('should call discoverHttpUploadService even when fetchRoster throws', async () => {
      // Set up a JID so discovery has a domain to query
      ;(xmppClient as any).currentJid = 'user@example.com'

      const discoverSpy = vi.spyOn(xmppClient.discovery, 'discoverHttpUploadService').mockResolvedValue()
      const fetchServerInfoSpy = vi.spyOn(xmppClient.discovery, 'fetchServerInfo').mockResolvedValue()
      const fetchProfileSpy = vi.spyOn(xmppClient.profile, 'fetchOwnProfile').mockResolvedValue()

      // Make fetchRoster throw (simulating slow server + IQ timeout)
      vi.spyOn(xmppClient.roster, 'fetchRoster').mockRejectedValue(new Error('IQ timeout'))

      // Call runFreshSessionSetup directly (private method)
      try {
        await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(undefined, 1, 15000)
      } catch {
        // Expected: fetchRoster throws and propagates
      }

      // Discovery should have been called regardless of fetchRoster failure
      expect(discoverSpy).toHaveBeenCalled()
      expect(fetchServerInfoSpy).toHaveBeenCalled()
      expect(fetchProfileSpy).toHaveBeenCalled()
    })

    it('should call discoverHttpUploadService even when fetchBookmarks throws', async () => {
      ;(xmppClient as any).currentJid = 'user@example.com'

      const discoverSpy = vi.spyOn(xmppClient.discovery, 'discoverHttpUploadService').mockResolvedValue()

      // Let fetchRoster succeed but fetchBookmarks fail
      vi.spyOn(xmppClient.roster, 'fetchRoster').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'sendInitialPresence').mockResolvedValue()
      vi.spyOn(xmppClient.muc, 'fetchBookmarks').mockRejectedValue(new Error('IQ timeout'))
      vi.spyOn(xmppClient.discovery, 'fetchServerInfo').mockResolvedValue()
      vi.spyOn(xmppClient.profile, 'fetchOwnProfile').mockResolvedValue()

      try {
        await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(undefined, 1, 15000)
      } catch {
        // Expected
      }

      expect(discoverSpy).toHaveBeenCalled()
    })

    it('should NOT call markAllRoomsNotJoined until just before rejoinActiveRooms', async () => {
      // Regression: an aborted fresh-session setup (e.g. socket dies mid-flight
      // between fetchBookmarks and rejoinActiveRooms) must not leave the room
      // store stranded with every room marked joined:false. The skip-guard lift
      // is deferred so the previous session's state stays visible until the
      // rejoin actually happens.
      ;(xmppClient as any).currentJid = 'user@example.com'

      const stores = (xmppClient as any).stores
      const markAllSpy = stores.room.markAllRoomsNotJoined as ReturnType<typeof vi.fn>
      markAllSpy.mockClear()

      vi.spyOn(xmppClient.discovery, 'fetchServerInfo').mockResolvedValue()
      vi.spyOn(xmppClient.discovery, 'discoverHttpUploadService').mockResolvedValue()
      vi.spyOn(xmppClient.profile, 'fetchOwnProfile').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'fetchRoster').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'sendInitialPresence').mockResolvedValue()
      // Bookmarks fails — simulates the socket dying mid-setup
      vi.spyOn(xmppClient.muc, 'fetchBookmarks').mockRejectedValue(new Error('IQ timeout'))

      try {
        await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(
          [{ jid: 'r@conf.example.com', nickname: 'me' }],
          1,
          15000,
        )
      } catch { /* expected */ }

      // The room state must be untouched — any subsequent SM-resumed reconnect
      // needs to see the same joined rooms it had going in.
      expect(markAllSpy).not.toHaveBeenCalled()
    })

    it('should NOT call markAllRoomsNotJoined when a fresh session has no rooms to rejoin', async () => {
      // Edge case: first-ever connect (no previouslyJoinedRooms, no autojoin
      // bookmarks). There's nothing to rejoin, so lifting joinRoom()'s
      // skip-guard is unnecessary — and leaving the flag alone avoids a
      // spurious store update that would cascade through subscribers.
      ;(xmppClient as any).currentJid = 'user@example.com'
      ;(xmppClient as any).sessionLifecycle.sessionGeneration = 1

      const stores = (xmppClient as any).stores
      const markAllSpy = stores.room.markAllRoomsNotJoined as ReturnType<typeof vi.fn>
      markAllSpy.mockClear()

      vi.spyOn(xmppClient.discovery, 'fetchServerInfo').mockResolvedValue()
      vi.spyOn(xmppClient.discovery, 'discoverHttpUploadService').mockResolvedValue()
      vi.spyOn(xmppClient.profile, 'fetchOwnProfile').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'fetchRoster').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'sendInitialPresence').mockResolvedValue()
      vi.spyOn(xmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      const convSync = (xmppClient as any).conversationSync
      if (convSync) vi.spyOn(convSync, 'fetchConversations').mockResolvedValue([])

      // No previouslyJoinedRooms, no autojoin bookmarks
      await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(undefined, 1, 15000)

      expect(markAllSpy).not.toHaveBeenCalled()
    })

    it('should call markAllRoomsNotJoined exactly when rejoinActiveRooms runs', async () => {
      ;(xmppClient as any).currentJid = 'user@example.com'
      // Match the sessionGeneration so the guard doesn't abort mid-setup.
      ;(xmppClient as any).sessionLifecycle.sessionGeneration = 1

      const stores = (xmppClient as any).stores
      const markAllSpy = stores.room.markAllRoomsNotJoined as ReturnType<typeof vi.fn>
      markAllSpy.mockClear()

      const rejoinSpy = vi.spyOn(xmppClient.muc, 'rejoinActiveRooms').mockResolvedValue()

      vi.spyOn(xmppClient.discovery, 'fetchServerInfo').mockResolvedValue()
      vi.spyOn(xmppClient.discovery, 'discoverHttpUploadService').mockResolvedValue()
      vi.spyOn(xmppClient.profile, 'fetchOwnProfile').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'fetchRoster').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'sendInitialPresence').mockResolvedValue()
      vi.spyOn(xmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      const convSync = (xmppClient as any).conversationSync
      if (convSync) vi.spyOn(convSync, 'fetchConversations').mockResolvedValue([])

      await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(
        [{ jid: 'r@conf.example.com', nickname: 'me' }],
        1,
        15000,
      )

      expect(markAllSpy).toHaveBeenCalledTimes(1)
      expect(rejoinSpy).toHaveBeenCalledTimes(1)
      // Skip-guard is lifted before rejoin, not after
      const markAllCallOrder = markAllSpy.mock.invocationCallOrder[0]!
      const rejoinCallOrder = rejoinSpy.mock.invocationCallOrder[0]!
      expect(markAllCallOrder).toBeLessThan(rejoinCallOrder)
    })

    it('should call discoverHttpUploadService before any await in the setup chain', async () => {
      ;(xmppClient as any).currentJid = 'user@example.com'

      const callOrder: string[] = []

      vi.spyOn(xmppClient.discovery, 'discoverHttpUploadService').mockImplementation(async () => {
        callOrder.push('discoverHttpUploadService')
      })
      vi.spyOn(xmppClient.discovery, 'fetchServerInfo').mockImplementation(async () => {
        callOrder.push('fetchServerInfo')
      })
      vi.spyOn(xmppClient.profile, 'fetchOwnProfile').mockImplementation(async () => {
        callOrder.push('fetchOwnProfile')
      })
      vi.spyOn(xmppClient.roster, 'fetchRoster').mockImplementation(async () => {
        callOrder.push('fetchRoster')
      })
      vi.spyOn(xmppClient.roster, 'sendInitialPresence').mockResolvedValue()
      vi.spyOn(xmppClient.muc, 'fetchBookmarks').mockResolvedValue({ roomsToAutojoin: [], allRoomJids: [] })

      // Mock conversation sync
      const convSync = (xmppClient as any).conversationSync
      if (convSync) {
        vi.spyOn(convSync, 'fetchConversations').mockResolvedValue([])
      }

      await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(undefined, 1, 15000)

      // Discovery calls should be initiated before fetchRoster starts
      // (they're fire-and-forget so they start synchronously before the first await)
      const discoverIdx = callOrder.indexOf('discoverHttpUploadService')
      const rosterIdx = callOrder.indexOf('fetchRoster')
      expect(discoverIdx).not.toBe(-1)
      expect(rosterIdx).not.toBe(-1)
      expect(discoverIdx).toBeLessThan(rosterIdx)
    })

    // Issue #37: autojoin safety net — don't silently auto-join a room that exposes
    // the user's real JID unless they've acknowledged it.
    function setupAutojoinFreshSession() {
      ;(xmppClient as any).currentJid = 'user@example.com'
      ;(xmppClient as any).sessionLifecycle.sessionGeneration = 1
      vi.spyOn(xmppClient.discovery, 'fetchServerInfo').mockResolvedValue()
      vi.spyOn(xmppClient.discovery, 'discoverHttpUploadService').mockResolvedValue()
      vi.spyOn(xmppClient.profile, 'fetchOwnProfile').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'fetchRoster').mockResolvedValue()
      vi.spyOn(xmppClient.roster, 'sendInitialPresence').mockResolvedValue()
      vi.spyOn(xmppClient.muc, 'fetchBookmarks').mockResolvedValue({
        roomsToAutojoin: [{ jid: 'public@conf.example.com', nick: 'me' }],
        allRoomJids: ['public@conf.example.com'],
      })
      const convSync = (xmppClient as any).conversationSync
      if (convSync) vi.spyOn(convSync, 'fetchConversations').mockResolvedValue([])
      vi.spyOn(xmppClient.muc, 'queryRoomFeatures').mockResolvedValue({
        supportsMAM: false, supportsReactions: true, supportsHats: false,
        isNonAnonymous: true, isPrivate: false, isIrcGateway: false, supportsModeration: false, name: 'Public',
      })
      return vi.spyOn(xmppClient.muc, 'joinRoom').mockResolvedValue()
    }

    it('does not autojoin a non-anonymous public bookmark that is not acknowledged', async () => {
      const joinSpy = setupAutojoinFreshSession()
      const stores = (xmppClient as any).stores
      ;(stores.room.isNonAnonymousRoomAcknowledged as ReturnType<typeof vi.fn>).mockReturnValue(false)

      await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(undefined, 1, 15000)
      // The autojoin gate runs in a fire-and-forget async IIFE — flush its awaited
      // microtasks (fake timers are active, so advance them to drain the queue).
      await vi.advanceTimersByTimeAsync(1)

      expect(joinSpy).not.toHaveBeenCalled()
    })

    it('autojoins a non-anonymous public bookmark once it has been acknowledged', async () => {
      const joinSpy = setupAutojoinFreshSession()
      const stores = (xmppClient as any).stores
      ;(stores.room.isNonAnonymousRoomAcknowledged as ReturnType<typeof vi.fn>).mockReturnValue(true)

      await (xmppClient as any).sessionLifecycle.runFreshSessionSetup(undefined, 1, 15000)
      await vi.advanceTimersByTimeAsync(1)

      expect(joinSpy).toHaveBeenCalledWith(
        'public@conf.example.com',
        'me',
        expect.objectContaining({ knownFeatures: expect.objectContaining({ isNonAnonymous: true }) }),
      )
    })
  })

  describe('store injection', () => {
    // Wrap a store so getState() returns the real state with a specific method
    // replaced by a spy — lets the rest of the client run on real stores while
    // we observe that a chosen call routes through THIS instance.
    const withSpy = <S>(store: S, override: Record<string, unknown>): S => ({
      ...store,
      getState: () => ({ ...(store as { getState: () => object }).getState(), ...override }),
    }) as S

    it('createDefaultStoreBindings routes writes through the injected bundle', () => {
      const addMessage = vi.fn()
      const bundle: SDKStores = {
        ...defaultStores,
        chat: withSpy(defaultStores.chat, { addMessage }),
      }

      const bindings = createDefaultStoreBindings(bundle)
      bindings.chat.addMessage({ id: 'm1' } as never)

      expect(addMessage).toHaveBeenCalledWith({ id: 'm1' })
    })

    it('new XMPPClient({ stores }) routes connect account-switch through the injected bundle', () => {
      const chatSwitch = vi.fn()
      const roomSwitch = vi.fn()
      const ignoreRehydrate = vi.fn()
      const bundle: SDKStores = {
        ...defaultStores,
        chat: withSpy(defaultStores.chat, { switchAccount: chatSwitch }),
        room: withSpy(defaultStores.room, { switchAccount: roomSwitch }),
        ignore: withSpy(defaultStores.ignore, { rehydrate: ignoreRehydrate }),
      }

      const client = new XMPPClient({ debug: false, stores: bundle })
      // switchAccount / rehydrate run synchronously at the top of connect(),
      // before any await — so they fire before the socket work (which we let
      // reject harmlessly against the mocked transport).
      void client
        .connect({ jid: 'account@example.com', password: 'p', server: 'example.com', skipDiscovery: true })
        .catch(() => {})

      expect(chatSwitch).toHaveBeenCalledWith('account@example.com')
      expect(roomSwitch).toHaveBeenCalledWith('account@example.com')
      expect(ignoreRehydrate).toHaveBeenCalled()
    })
  })
})
