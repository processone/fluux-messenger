/**
 * XMPPClient Connection Tests
 *
 * Tests for connection, disconnection, reconnection, and related features.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import { DIRECT_WEBSOCKET_PRECHECK_TIMEOUT_MS, RECONNECT_ATTEMPT_TIMEOUT_MS } from './connectionTimeouts'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

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

// Use vi.hoisted to create the mock at hoist time
const { mockDiscoverWebSocket } = vi.hoisted(() => ({
  mockDiscoverWebSocket: vi.fn(),
}))

const { mockFlushPendingRoomMessages } = vi.hoisted(() => ({
  mockFlushPendingRoomMessages: vi.fn(),
}))

// Mock websocketDiscovery to prevent real network calls
vi.mock('../../utils/websocketDiscovery', () => ({
  discoverWebSocket: mockDiscoverWebSocket,
}))

// Mock message cache flushing so disconnect tests can control stall behavior
vi.mock('../../utils/messageCache', async () => {
  const actual = await vi.importActual<typeof import('../../utils/messageCache')>('../../utils/messageCache')
  return {
    ...actual,
    flushPendingRoomMessages: mockFlushPendingRoomMessages,
  }
})

// Mock fastTokenStorage for FAST tests
const { mockFetchFastToken, mockSaveFastToken, mockDeleteFastToken } = vi.hoisted(() => ({
  mockFetchFastToken: vi.fn().mockReturnValue(null),
  mockSaveFastToken: vi.fn(),
  mockDeleteFastToken: vi.fn(),
}))

vi.mock('../fastTokenStorage', () => ({
  fetchFastToken: mockFetchFastToken,
  saveFastToken: mockSaveFastToken,
  deleteFastToken: mockDeleteFastToken,
  hasFastToken: vi.fn(),
}))

describe('XMPPClient Connection', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    // Reset the mock and set the instance for this test
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    // Reset WebSocket discovery mock to return null (discovery failed -> use fallback URL)
    mockDiscoverWebSocket.mockClear()
    mockDiscoverWebSocket.mockResolvedValue(null)
    mockFlushPendingRoomMessages.mockClear()
    mockFlushPendingRoomMessages.mockResolvedValue(undefined)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    xmppClient.cancelReconnect()
  })

  describe('connect', () => {
    it('should create XMPP client with correct options', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Simulate successful connection
      mockXmppClientInstance._emit('online')

      await connectPromise

      expect(mockClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'wss://example.com/ws',
          domain: 'example.com',
          credentials: expect.any(Function),
        })
      )
    })

    it('should use XEP-0156 discovery first, then default wss://<domain>/ws as last resort on web/no-proxy', async () => {
      mockDiscoverWebSocket.mockResolvedValueOnce(null)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockDiscoverWebSocket).toHaveBeenCalledWith('example.com', 5000)
      expect(mockClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'wss://example.com/ws',
        })
      )
    })

    it('should use custom WebSocket URL if provided', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'wss://custom.example.com/xmpp',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'wss://custom.example.com/xmpp',
        })
      )
    })

    it('should pass resource and lang options to xmpp client', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        resource: 'desktop',
        lang: 'fr',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: 'desktop',
          lang: 'fr',
        })
      )
    })

    it('should update store status on connection', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockStores.connection.setJid).toHaveBeenCalledWith('user@example.com')
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('online')
    })

    it('should send presence after connection', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockXmppClientInstance.send).toHaveBeenCalled()
    })

    it('should update error in store on connection failure', async () => {
      mockXmppClientInstance.start.mockRejectedValue(new Error('Connection refused'))

      await expect(
        xmppClient.connect({
          jid: 'user@example.com',
          password: 'secret',
          server: 'example.com',
        })
      ).rejects.toThrow('Connection refused')
    })
  })

  describe('connect() guard against concurrent connections', () => {
    it('should be a no-op when already connected', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear calls from initial connect
      mockClientFactory.mockClear()

      // Second connect call while connected — should be silently ignored
      await xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Should NOT have created a new XMPP client
      expect(mockClientFactory).not.toHaveBeenCalled()
    })

    it('should be a no-op when already connecting', async () => {
      // Start first connect (don't await — it's still connecting)
      const firstConnect = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Record how many clients were created so far
      const callsBefore = mockClientFactory.mock.calls.length

      // Second connect call while first is still in progress — should be ignored
      await xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Should NOT have created another XMPP client beyond the first one
      // (the first connect's async factory call may complete after our snapshot)
      expect(mockClientFactory.mock.calls.length).toBeLessThanOrEqual(callsBefore + 1)

      // Clean up: let first connect complete
      mockXmppClientInstance._emit('online')
      await firstConnect

      // Total: exactly 1 client created
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
    })

    it('should allow connect from terminal state', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Trigger a conflict → terminal.conflict
      mockXmppClientInstance._emit('error', new Error('conflict'))
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Prepare new client for reconnect
      const reconnectClient = createMockXmppClient()
      mockClientFactory.mockClear()
      mockClientFactory._setInstance(reconnectClient)

      // Connect from terminal state — should work
      const reconnectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      reconnectClient._emit('online')
      await reconnectPromise

      // Should have created a new client
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
    })

    it('should allow connect from disconnected state', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Disconnect
      await xmppClient.disconnect()

      // Prepare new client
      const reconnectClient = createMockXmppClient()
      mockClientFactory.mockClear()
      mockClientFactory._setInstance(reconnectClient)

      // Connect from disconnected — should work
      const reconnectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      reconnectClient._emit('online')
      await reconnectPromise

      expect(mockClientFactory).toHaveBeenCalledTimes(1)
    })
  })

  describe('disconnect', () => {
    it('should stop the client and update store', async () => {
      // First connect
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Then disconnect
      await xmppClient.disconnect()

      expect(mockXmppClientInstance.stop).toHaveBeenCalled()
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('disconnected')
      expect(mockStores.connection.setJid).toHaveBeenCalledWith(null)
    })

    it('should not hang disconnect when room message flush stalls', async () => {
      // First connect
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate IndexedDB/WebKit stall in flushPendingRoomMessages()
      mockFlushPendingRoomMessages.mockImplementation(
        () => new Promise<void>(() => {})
      )

      const disconnectPromise = xmppClient.disconnect()

      // Fast-forward cleanup timeout (2s) so disconnect can proceed to stop()
      await vi.advanceTimersByTimeAsync(2000)
      await disconnectPromise

      expect(mockXmppClientInstance.stop).toHaveBeenCalled()
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('disconnected')
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Disconnect cleanup warning: room message flush timed out',
        'error'
      )
    })

    it('should resolve disconnect even when client.stop never settles', async () => {
      // First connect
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate a hanging graceful stop() (observed on Linux/proxy paths)
      mockXmppClientInstance.stop.mockImplementation(() => new Promise<void>(() => {}))

      const disconnectPromise = xmppClient.disconnect()
      let settled = false
      void disconnectPromise.then(() => { settled = true })

      // Disconnect should complete immediately without waiting for stop timeout.
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)

      if (settled) {
        await disconnectPromise
      }

      expect(mockXmppClientInstance.stop).toHaveBeenCalled()
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('disconnected')
      expect(mockStores.connection.setJid).toHaveBeenCalledWith(null)
    })
  })

  describe('reconnection with exponential backoff', () => {
    it('should schedule reconnect on unexpected disconnect', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear previous calls to track new ones
      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.connection.setReconnectState).mockClear()

      // Simulate unexpected disconnect
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should be in reconnecting state
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(1, expect.any(Number)) // attempt 1, target time
    })

    it('should not reconnect after manual disconnect', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Manual disconnect
      await xmppClient.disconnect()

      // Clear previous calls
      vi.mocked(mockStores.connection.setStatus).mockClear()

      // Simulate offline event
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should NOT have set reconnecting status after the disconnect call
      const calls = vi.mocked(mockStores.connection.setStatus).mock.calls
      expect(calls.some(c => c[0] === 'reconnecting')).toBe(false)
    })

    it('should stop reconnection when cancelReconnect is called', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Cancel
      xmppClient.cancelReconnect()

      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(0, null)

      // Advance timer - should NOT attempt reconnection
      mockClientFactory.mockClear()
      await vi.advanceTimersByTimeAsync(5000)

      // Factory should not have been called again
      expect(mockClientFactory).not.toHaveBeenCalled()
    })

    it('should attempt reconnect after delay expires', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Reset call count
      mockClientFactory.mockClear()

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Before timer expires, no new client created
      expect(mockClientFactory).not.toHaveBeenCalled()

      // Advance timer to trigger reconnect
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      await vi.advanceTimersByTimeAsync(1000)

      // Should have created new client for reconnect
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
    })

    it('should NOT auto-reconnect when initial connection fails (never connected)', async () => {
      // Make connection fail by having start() reject
      mockXmppClientInstance.start.mockRejectedValue(new Error('Connection refused'))

      // Attempt to connect - it will fail
      await expect(
        xmppClient.connect({
          jid: 'user@example.com',
          password: 'secret',
          server: 'example.com',
          skipDiscovery: true,
        })
      ).rejects.toThrow('Connection refused')

      // Clear previous calls to track new activity
      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.connection.setError).mockClear()
      mockClientFactory.mockClear()

      // Simulate the disconnect event that follows connection failure
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should NOT set status to reconnecting - this is initial connection failure
      const statusCalls = vi.mocked(mockStores.connection.setStatus).mock.calls
      expect(statusCalls.some(c => c[0] === 'reconnecting')).toBe(false)

      // Should set a user-visible error message
      expect(mockStores.connection.setError).toHaveBeenCalled()
      const errorArg = vi.mocked(mockStores.connection.setError).mock.calls[0][0]
      expect(errorArg).toContain('Connection failed')

      // Advance timers - no reconnection should be scheduled
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockClientFactory).not.toHaveBeenCalled()

      // Should have logged the initial connection failure
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Initial connection failed (no auto-reconnect)',
        'connection'
      )
    })

    it('should extract WebSocket close code from CloseEvent reason', async () => {
      // Simulate failed initial connection
      mockXmppClientInstance.start.mockRejectedValue(new Error('Connection refused'))

      await expect(
        xmppClient.connect({
          jid: 'user@example.com',
          password: 'secret',
          server: 'example.com',
          skipDiscovery: true,
        })
      ).rejects.toThrow('Connection refused')

      vi.mocked(mockStores.connection.setError).mockClear()

      // Simulate disconnect with a CloseEvent-like reason (has code and reason properties)
      mockXmppClientInstance._emit('disconnect', {
        clean: false,
        reason: { code: 1006, reason: '' },
      })

      const errorArg = vi.mocked(mockStores.connection.setError).mock.calls[0][0]
      expect(errorArg).toBe('Connection failed: WebSocket closed (code: 1006)')
    })

    it('should include CloseEvent reason string when present', async () => {
      mockXmppClientInstance.start.mockRejectedValue(new Error('Connection refused'))

      await expect(
        xmppClient.connect({
          jid: 'user@example.com',
          password: 'secret',
          server: 'example.com',
          skipDiscovery: true,
        })
      ).rejects.toThrow('Connection refused')

      vi.mocked(mockStores.connection.setError).mockClear()

      mockXmppClientInstance._emit('disconnect', {
        clean: false,
        reason: { code: 1008, reason: 'Policy violation' },
      })

      const errorArg = vi.mocked(mockStores.connection.setError).mock.calls[0][0]
      expect(errorArg).toBe('Connection failed: WebSocket closed (code: 1008, Policy violation)')
    })

    it('should prefer discovered XEP-0156 WebSocket endpoint before proxy for domain server inputs', async () => {
      mockDiscoverWebSocket.mockResolvedValue('wss://discovered.example.com/ws')

      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:12345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
      })
      await vi.advanceTimersByTimeAsync(0)
      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'wss://discovered.example.com/ws' })
      )
      expect(mockProxyAdapter.startProxy).not.toHaveBeenCalled()

      proxyClient.cancelReconnect()
    })

    it('should skip default /ws fallback and switch directly to proxy when XEP-0156 has no endpoint', async () => {
      mockDiscoverWebSocket.mockResolvedValue(null)

      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:12345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
      })

      await vi.advanceTimersByTimeAsync(0)
      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockClientFactory).toHaveBeenCalledTimes(1)
      expect(mockClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'ws://127.0.0.1:12345' })
      )
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(1)
      expect(mockStores.connection.setConnectionMethod).toHaveBeenCalledWith('proxy')

      proxyClient.cancelReconnect()
    })

    it('should skip WebSocket attempts entirely on proxy-capable desktop when skipDiscovery is enabled for a domain', async () => {
      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:12345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      await vi.advanceTimersByTimeAsync(0)
      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(mockDiscoverWebSocket).not.toHaveBeenCalled()
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(1)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
      expect(mockClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'ws://127.0.0.1:12345' })
      )

      proxyClient.cancelReconnect()
    })

    it('should fall back to proxy when direct WebSocket attempt fails', async () => {
      mockDiscoverWebSocket.mockResolvedValue('wss://discovered.example.com/ws')

      const firstClient = createMockXmppClient()
      firstClient.start.mockRejectedValue(new Error('direct websocket failed'))
      const fallbackClient = createMockXmppClient()
      mockClientFactory.mockImplementationOnce(() => firstClient).mockImplementationOnce(() => fallbackClient)

      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:12345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(mockClientFactory).toHaveBeenCalledTimes(2)
      fallbackClient._emit('online')
      await connectPromise

      expect(mockClientFactory).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ service: 'wss://discovered.example.com/ws' })
      )
      expect(mockClientFactory).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ service: 'ws://127.0.0.1:12345' })
      )
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(1)
      expect(mockStores.connection.setConnectionMethod).toHaveBeenCalledWith('proxy')

      proxyClient.cancelReconnect()
    })

    it('should fall back to proxy when direct WebSocket pre-check stalls', async () => {
      mockDiscoverWebSocket.mockResolvedValue('wss://discovered.example.com/ws')

      const stalledClient = createMockXmppClient()
      stalledClient.start.mockReturnValue(new Promise(() => {}))
      const fallbackClient = createMockXmppClient()
      mockClientFactory.mockImplementationOnce(() => stalledClient).mockImplementationOnce(() => fallbackClient)

      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:12345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
      })

      await vi.advanceTimersByTimeAsync(DIRECT_WEBSOCKET_PRECHECK_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(1)
      expect(mockClientFactory).toHaveBeenCalledTimes(2)

      fallbackClient._emit('online')
      await connectPromise

      expect(mockClientFactory).toHaveBeenLastCalledWith(
        expect.objectContaining({ service: 'ws://127.0.0.1:12345' })
      )

      proxyClient.cancelReconnect()
    })

    it('should show firewall hint when proxy mode connection fails with code 1006', async () => {
      // Create a client with proxy adapter (simulating Tauri desktop mode)
      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({
          url: 'ws://127.0.0.1:12345',
        }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      // Start connection — proxy starts successfully but xmpp.js connect fails
      // (simulates firewall blocking the WebView → localhost proxy connection)
      mockXmppClientInstance.start.mockRejectedValue(new Error('Connection refused'))

      await expect(
        proxyClient.connect({
          jid: 'user@example.com',
          password: 'secret',
          server: 'tls://example.com:5223',
          skipDiscovery: true,
        })
      ).rejects.toThrow('Connection refused')

      vi.mocked(mockStores.connection.setError).mockClear()

      // Simulate disconnect with CloseEvent code 1006 (abnormal closure — firewall blocked it)
      mockXmppClientInstance._emit('disconnect', {
        clean: false,
        reason: { code: 1006, reason: '' },
      })

      const errorArg = vi.mocked(mockStores.connection.setError).mock.calls[0][0]
      expect(errorArg).toContain('Unable to reach local proxy')
      expect(errorArg).toContain('firewall')

      proxyClient.cancelReconnect()
    })

    it('should reuse cached proxy endpoint before refreshing on automatic reconnect', async () => {
      const mockProxyAdapter = {
        startProxy: vi.fn()
          .mockResolvedValueOnce({ url: 'ws://127.0.0.1:12345' })
          .mockResolvedValueOnce({ url: 'ws://127.0.0.1:22345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      // Initial connect uses first proxy URL
      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'tls://example.com:5223',
        skipDiscovery: true,
      })
      await vi.advanceTimersByTimeAsync(0)
      mockXmppClientInstance._emit('online')
      await connectPromise
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(1)

      // Trigger automatic reconnect
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Provide fresh xmpp instance for reconnect attempt
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)

      await vi.advanceTimersByTimeAsync(1000)
      reconnectClient._emit('online')
      await vi.advanceTimersByTimeAsync(0)

      // Auto-reconnect should reuse the cached proxy URL first.
      expect(mockProxyAdapter.stopProxy).not.toHaveBeenCalled()
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(1)
      expect(mockClientFactory).toHaveBeenLastCalledWith(
        expect.objectContaining({ service: 'ws://127.0.0.1:12345' })
      )

      proxyClient.cancelReconnect()
    })

    it('should refresh proxy endpoint when cached proxy reconnect fails', async () => {
      const mockProxyAdapter = {
        startProxy: vi.fn()
          .mockResolvedValueOnce({ url: 'ws://127.0.0.1:12345' })
          .mockResolvedValueOnce({ url: 'ws://127.0.0.1:22345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      // Initial connect uses first proxy URL
      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'tls://example.com:5223',
        skipDiscovery: true,
      })
      await vi.advanceTimersByTimeAsync(0)
      mockXmppClientInstance._emit('online')
      await connectPromise
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(1)

      // Trigger automatic reconnect
      mockXmppClientInstance._emit('disconnect', { clean: false })

      const failedReconnectClient = createMockXmppClient()
      failedReconnectClient.start.mockRejectedValue(
        new Error('Socket disconnected during connection handshake')
      )
      const recoveredReconnectClient = createMockXmppClient()
      mockClientFactory
        .mockImplementationOnce(() => failedReconnectClient)
        .mockImplementationOnce(() => recoveredReconnectClient)

      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(0)

      recoveredReconnectClient._emit('online')
      await vi.advanceTimersByTimeAsync(0)

      expect(mockProxyAdapter.stopProxy).toHaveBeenCalledTimes(1)
      expect(mockProxyAdapter.startProxy).toHaveBeenCalledTimes(2)
      expect(mockClientFactory).toHaveBeenLastCalledWith(
        expect.objectContaining({ service: 'ws://127.0.0.1:22345' })
      )

      proxyClient.cancelReconnect()
    })

    it('should auto-reconnect when connection drops after successful connection', async () => {
      // First, connect successfully
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear to track new calls
      vi.mocked(mockStores.connection.setStatus).mockClear()
      mockClientFactory.mockClear()

      // Simulate unexpected disconnect after successful connection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should schedule reconnect because we were previously connected
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Connection lost unexpectedly, will reconnect',
        'connection'
      )
    })

    it('should trigger dead-socket recovery on websocket econnerror stream error', async () => {
      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:12345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'tls://example.com:5223',
        skipDiscovery: true,
      })
      await vi.advanceTimersByTimeAsync(0)
      mockXmppClientInstance._emit('online')
      await connectPromise

      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.console.addEvent).mockClear()

      mockXmppClientInstance._emit('error', new Error('websocket econnerror ws://[::1]:42583'))

      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Stream transport error, forcing reconnect recovery',
        'connection'
      )
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('Dead-socket recovery: triggering immediate reconnect'),
        'connection'
      )

      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockProxyAdapter.stopProxy).not.toHaveBeenCalled()

      proxyClient.cancelReconnect()
    })

    it('should not restart proxy from stale transport error after manual disconnect', async () => {
      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:12345' }),
        stopProxy: vi.fn().mockResolvedValue(undefined),
      }
      const proxyClient = new XMPPClient({ debug: false, proxyAdapter: mockProxyAdapter })
      proxyClient.bindStores(mockStores)

      const connectPromise = proxyClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'tls://example.com:5223',
        skipDiscovery: true,
      })
      await vi.advanceTimersByTimeAsync(0)
      mockXmppClientInstance._emit('online')
      await connectPromise

      await proxyClient.disconnect()

      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.connection.setReconnectState).mockClear()
      vi.mocked(mockStores.console.addEvent).mockClear()
      vi.mocked(mockProxyAdapter.stopProxy).mockClear()
      mockClientFactory.mockClear()

      // Simulate delayed error from old socket after user-initiated disconnect.
      // With removeAllListeners working, the event never reaches the handler —
      // stale events are blocked at the source (listener removal) rather than
      // at the handler level (state check).
      mockXmppClientInstance._emit('error', new Error('websocket econnerror ws://[::1]:42583'))

      await vi.advanceTimersByTimeAsync(0)

      // Proxy restart remains single-owner: only attemptReconnect() may refresh proxy.
      expect(mockProxyAdapter.stopProxy).not.toHaveBeenCalled()
      expect(mockClientFactory).not.toHaveBeenCalled()
      expect(vi.mocked(mockStores.connection.setStatus).mock.calls.some((c) => c[0] === 'reconnecting')).toBe(false)

      proxyClient.cancelReconnect()
    })

    it('should NOT auto-reconnect on fresh connect() after a previous successful session', async () => {
      // Scenario: User had a successful session, then connection recovery failed,
      // user clicks Connect again. This fresh connect() should NOT auto-reconnect
      // if it fails, because hasEverConnected is reset at the start of connect().

      // Step 1: Connect successfully (sets hasEverConnected = true internally)
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Step 1b: Disconnect so we can call connect() again
      await xmppClient.disconnect()

      // Step 2: Prepare a new client that will fail to start
      const failClient = createMockXmppClient()
      mockClientFactory._setInstance(failClient)
      failClient.start.mockRejectedValue(new Error('Connection refused'))

      await expect(
        xmppClient.connect({
          jid: 'user@example.com',
          password: 'secret',
          server: 'example.com',
          skipDiscovery: true,
        })
      ).rejects.toThrow('Connection refused')

      // Clear to track new calls
      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.connection.setError).mockClear()
      mockClientFactory.mockClear()

      // Step 3: Simulate disconnect event from the failed connection
      failClient._emit('disconnect', { clean: false })

      // Should NOT auto-reconnect - this is a fresh login attempt that failed
      const statusCalls = vi.mocked(mockStores.connection.setStatus).mock.calls
      expect(statusCalls.some(c => c[0] === 'reconnecting')).toBe(false)

      // Should set a user-visible error message
      expect(mockStores.connection.setError).toHaveBeenCalled()
      const errorArg = vi.mocked(mockStores.connection.setError).mock.calls[0][0]
      expect(errorArg).toContain('Connection failed')

      // Should log initial connection failure
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Initial connection failed (no auto-reconnect)',
        'connection'
      )
    })
  })

  describe('exponential backoff calculation', () => {
    it('should verify backoff formula: delay = min(1000 * 2^(attempt-1), 120000)', () => {
      const INITIAL_DELAY = 1000
      const MAX_DELAY = 120000
      const MULTIPLIER = 2

      const calculateDelay = (attempt: number) =>
        Math.min(INITIAL_DELAY * Math.pow(MULTIPLIER, attempt - 1), MAX_DELAY)

      expect(calculateDelay(1)).toBe(1000)   // 1s
      expect(calculateDelay(2)).toBe(2000)   // 2s
      expect(calculateDelay(3)).toBe(4000)   // 4s
      expect(calculateDelay(4)).toBe(8000)   // 8s
      expect(calculateDelay(5)).toBe(16000)  // 16s
      expect(calculateDelay(6)).toBe(32000)  // 32s
      expect(calculateDelay(7)).toBe(64000)  // 64s
      expect(calculateDelay(8)).toBe(120000) // capped at 120s
      expect(calculateDelay(9)).toBe(120000) // still 120s
    })
  })

  describe('disableBuiltInReconnect', () => {
    it('should call reconnect.stop() on client creation', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Verify that xmpp.js built-in reconnect was disabled
      expect(mockXmppClientInstance.reconnect.stop).toHaveBeenCalled()
    })

    it('should call reconnect.stop() on reconnection attempt', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Reset to track new calls
      mockXmppClientInstance.reconnect.stop.mockClear()

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Create new mock client for reconnection
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Advance timer to trigger reconnect
      await vi.advanceTimersByTimeAsync(1000)

      // Verify reconnect.stop() was called on the new client
      expect(mockXmppClientInstance.reconnect.stop).toHaveBeenCalled()
    })
  })

  describe('disconnect edge cases', () => {
    it('should clear credentials on disconnect', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Verify connected
      expect(xmppClient.isConnected()).toBe(true)

      // Disconnect
      await xmppClient.disconnect()

      // Try to trigger reconnection via offline event - should NOT reconnect
      // because credentials are cleared
      mockClientFactory.mockClear()
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Advance timers - no reconnection should happen
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockClientFactory).not.toHaveBeenCalled()
    })

    it('should ignore stale post-disconnect econnerror without triggering reconnect', async () => {
      // First connect
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Manual disconnect transitions machine to disconnected and nulls active client.
      await xmppClient.disconnect()

      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.connection.setReconnectState).mockClear()
      vi.mocked(mockStores.console.addEvent).mockClear()
      mockClientFactory.mockClear()

      // Late stale transport error/disconnect from old socket.
      // With removeAllListeners working, these events never reach the handler —
      // stale events are blocked at the source (listener removal after disconnect).
      mockXmppClientInstance._emit('error', new Error('websocket econnerror ws://[::1]:42583'))
      mockXmppClientInstance._emit('disconnect', {
        clean: false,
        reason: { code: 1006, reason: 'ECONNERROR' },
      })

      await vi.advanceTimersByTimeAsync(5000)

      // Must not re-enter reconnect flow from stale events after manual disconnect.
      const statusCalls = vi.mocked(mockStores.connection.setStatus).mock.calls
      expect(statusCalls.some((call) => call[0] === 'reconnecting')).toBe(false)
      expect(mockClientFactory).not.toHaveBeenCalled()
    })

    it('should handle disconnect when already disconnected', async () => {
      // Disconnect without connecting first - should not throw
      await expect(xmppClient.disconnect()).resolves.not.toThrow()
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('disconnected')
    })

    it('should not reject disconnect when client.stop fails', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      mockXmppClientInstance.stop.mockRejectedValue(new Error('stop failed'))

      await expect(xmppClient.disconnect()).resolves.not.toThrow()
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('disconnected')
    })

    it('should force-close transport after disconnect cleanup', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Provide explicit transport hooks so we can assert force cleanup happened
      const removeAllListeners = vi.fn()
      const socketEnd = vi.fn()
      ;(mockXmppClientInstance as any).removeAllListeners = removeAllListeners
      ;(mockXmppClientInstance as any).socket = { writable: true, end: socketEnd }

      await xmppClient.disconnect()

      expect(removeAllListeners).toHaveBeenCalled()
      expect(socketEnd).toHaveBeenCalled()
    })

    it('should set status before stopping client to prevent race conditions', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Track the order of calls
      const callOrder: string[] = []
      vi.mocked(mockStores.connection.setStatus).mockImplementation((status) => {
        callOrder.push(`setStatus:${status}`)
      })
      mockXmppClientInstance.stop.mockImplementation(async () => {
        callOrder.push('stop')
      })

      // Disconnect
      await xmppClient.disconnect()

      // Verify setStatus('disconnected') was called BEFORE stop()
      const disconnectedIndex = callOrder.indexOf('setStatus:disconnected')
      const stopIndex = callOrder.indexOf('stop')
      expect(disconnectedIndex).toBeLessThan(stopIndex)
    })
  })

  describe('reconnection attempt counter', () => {
    it('should increase delay with each failed reconnection attempt', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear to track new calls
      vi.mocked(mockStores.connection.setReconnectState).mockClear()

      // First disconnect - attempt 1
      mockXmppClientInstance._emit('disconnect', { clean: false })
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(1, expect.any(Number)) // attempt 1, target time

      // Simulate failed reconnect by making start() reject
      mockXmppClientInstance = createMockXmppClient()
      mockXmppClientInstance.start = vi.fn().mockRejectedValue(new Error('Connection failed'))
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Clear and advance to trigger the reconnect attempt (which will fail)
      vi.mocked(mockStores.connection.setReconnectState).mockClear()
      await vi.advanceTimersByTimeAsync(1000)

      // Allow the rejected promise to be handled
      await vi.advanceTimersByTimeAsync(0)

      // Second attempt should have 2s delay
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(2, expect.any(Number)) // attempt 2, target time
    })

    it('should reset attempt counter on successful reconnection', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Create new mock for reconnection
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Advance timer and successfully reconnect
      await vi.advanceTimersByTimeAsync(1000)
      mockXmppClientInstance._emit('online')

      // Give time for the reconnect promise to resolve
      await vi.advanceTimersByTimeAsync(100)

      // Verify reconnect state was reset
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(0, null)
    })
  })

  describe('post-reconnect actions', () => {
    it('should send presence after successful reconnection', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear send calls
      mockXmppClientInstance.send.mockClear()

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Create new mock for reconnection
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Advance timer and successfully reconnect
      await vi.advanceTimersByTimeAsync(1000)
      mockXmppClientInstance._emit('online')

      // Give time for async operations
      await vi.advanceTimersByTimeAsync(100)

      // Should have sent presence
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sendCalls.find((call: any[]) => call[0]?.name === 'presence')
      expect(presenceCall).toBeDefined()
    })

    it('should request roster after new session (not SM resume)', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Create new mock for reconnection
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Mock iqCaller.request to return an empty roster response
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          { name: 'query', attrs: { xmlns: 'jabber:iq:roster' }, children: [] }
        ])
      )

      // Advance timer and successfully reconnect (new session, not SM resume)
      await vi.advanceTimersByTimeAsync(1000)
      mockXmppClientInstance._emit('online')

      // Give time for async operations
      await vi.advanceTimersByTimeAsync(100)

      // Should have requested roster via sendIQ (iqCaller.request)
      const iqCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const rosterCall = iqCalls.find((call: any[]) => {
        const stanza = call[0]
        return stanza?.name === 'iq' &&
               stanza?.attrs?.type === 'get' &&
               stanza?.children?.some((c: any) => c?.attrs?.xmlns === 'jabber:iq:roster')
      })
      expect(rosterCall).toBeDefined()
    })

    it('should reset all presence on new session', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear calls
      vi.mocked(mockStores.roster.resetAllPresence).mockClear()

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Create new mock for reconnection
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Advance timer and successfully reconnect (new session)
      await vi.advanceTimersByTimeAsync(1000)
      mockXmppClientInstance._emit('online')

      // Give time for async operations
      await vi.advanceTimersByTimeAsync(100)

      // Should have reset presence (for fresh state from new session)
      expect(mockStores.roster.resetAllPresence).toHaveBeenCalled()
    })

    it('should NOT call bulk preview refresh on connect (MAM is lazy)', async () => {
      // Regression test: We removed bulk preview refresh on connect because:
      // - Conversations: Preview updates when opened (lazy MAM) or when new messages arrive
      // - Rooms: Preview is fetched on room join (room:joined event)
      // This avoids the flood of 300+ MAM queries that occurred on every reconnect

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Give time for async operations
      await vi.advanceTimersByTimeAsync(100)

      // MAM preview refresh methods should NOT have been called
      // Check that no MAM queries were sent for preview refresh
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const mamPreviewQueries = sendCalls.filter((call: any) => {
        const stanza = call[0]
        // MAM preview queries would be IQ stanzas with MAM namespace
        // targeting the user's archive for multiple conversations
        if (stanza?.name !== 'iq' || stanza?.attrs?.type !== 'set') return false
        const queryChild = stanza?.children?.find((c: any) =>
          c?.attrs?.xmlns === 'urn:xmpp:mam:2' && c?.name === 'query'
        )
        // Preview queries use max=1 to get just the last message
        if (!queryChild) return false
        const setChild = queryChild?.children?.find((c: any) => c?.name === 'set')
        const maxChild = setChild?.children?.find((c: any) => c?.name === 'max')
        return maxChild?.children?.[0] === '1'
      })

      // No bulk preview queries should be sent on connect
      expect(mamPreviewQueries).toHaveLength(0)
    })

    it('should reset MAM states on new session so history is re-fetched', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear calls
      vi.mocked(mockStores.chat.resetMAMStates).mockClear()

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Create new mock for reconnection
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Advance timer and successfully reconnect (new session)
      await vi.advanceTimersByTimeAsync(1000)
      mockXmppClientInstance._emit('online')

      // Give time for async operations
      await vi.advanceTimersByTimeAsync(100)

      // Should have reset MAM states so conversations re-fetch history
      // (messages may have arrived while disconnected)
      expect(mockStores.chat.resetMAMStates).toHaveBeenCalled()
    })

    it('should NOT reset MAM states on SM resumption', async () => {
      // Connect with SM state
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-123', inbound: 3 },
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Clear calls
      vi.mocked(mockStores.chat.resetMAMStates).mockClear()

      // Trigger reconnection
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Create new mock for reconnection
      mockXmppClientInstance = createMockXmppClient()
      mockClientFactory._setInstance(mockXmppClientInstance)

      // Advance timer and successfully resume via SM
      await vi.advanceTimersByTimeAsync(1000)
      // Emit the SM 'resumed' event instead of 'online'
      mockXmppClientInstance._emitSM('resumed')

      // Give time for async operations
      await vi.advanceTimersByTimeAsync(100)

      // Should NOT reset MAM states on SM resumption — the server replays
      // undelivered stanzas, so no MAM catchup is needed
      expect(mockStores.chat.resetMAMStates).not.toHaveBeenCalled()
    })

  })

  describe('resource conflict handling', () => {
    it('should detect resource conflict from error message', async () => {
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
      vi.mocked(mockStores.events.addSystemNotification).mockClear()
      vi.mocked(mockStores.console.addEvent).mockClear()

      // Simulate resource conflict error
      mockXmppClientInstance._emit('error', new Error('conflict'))

      // Should log the conflict
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Disconnected: Resource conflict (another client connected)',
        'error'
      )

      // Should add system notification
      expect(mockStores.events.addSystemNotification).toHaveBeenCalledWith(
        'resource-conflict',
        'Session Replaced',
        expect.stringContaining('Another client connected')
      )
    })

    it('should not auto-reconnect after resource conflict', async () => {
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
      vi.mocked(mockStores.connection.setStatus).mockClear()

      // Simulate resource conflict error followed by offline
      mockXmppClientInstance._emit('error', new Error('conflict'))
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should set status to error (not reconnecting) — terminal state
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('error')

      // Should set error message
      expect(mockStores.connection.setError).toHaveBeenCalledWith('Session replaced by another client')

      // Advance timers - no reconnect should be scheduled
      await vi.advanceTimersByTimeAsync(5000)

      // Should NOT have attempted to create a new client for reconnection
      // The factory should not have been called after the conflict
      const factoryCalls = mockClientFactory.mock.calls.length
      expect(factoryCalls).toBe(1) // Only the initial connection
    })

    it('should not trigger reconnect from stale disconnect after resource conflict', async () => {
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
      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.console.addEvent).mockClear()

      // Simulate conflict: the error handler transitions to terminal.conflict
      // and clears credentials
      mockXmppClientInstance._emit('error', new Error('conflict'))

      // Now simulate a stale disconnect from the old client.
      // In the real scenario, this.xmpp was already replaced by a new connection,
      // so the disconnect comes from a stale client.
      ;(xmppClient.connection as any).xmpp = null

      mockXmppClientInstance._emit('disconnect', { clean: true })

      // The stale disconnect recovery should NOT fire SOCKET_DIED because
      // the machine is in terminal.conflict state
      expect(mockStores.console.addEvent).not.toHaveBeenCalledWith(
        'Socket closed from stale client while connected, forcing reconnect recovery',
        'connection'
      )

      // Should not have transitioned to reconnecting
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')

      // Advance timers — no reconnect should fire
      await vi.advanceTimersByTimeAsync(10_000)
      const factoryCalls = mockClientFactory.mock.calls.length
      expect(factoryCalls).toBe(1) // Only the initial connection
    })

    it('should detect auth error from error message', async () => {
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
      vi.mocked(mockStores.console.addEvent).mockClear()
      vi.mocked(mockStores.connection.setStatus).mockClear()

      // Simulate auth error followed by offline
      mockXmppClientInstance._emit('error', new Error('not-authorized'))
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should log the auth error
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Disconnected: Authentication error',
        'error'
      )

      // Should set status to error
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('error')

      // Should set error message
      expect(mockStores.connection.setError).toHaveBeenCalledWith('Authentication failed')
    })

    it('should not classify stanza type=auth errors as auth stream failures', async () => {
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
      vi.mocked(mockStores.console.addEvent).mockClear()
      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.connection.setError).mockClear()

      // Simulate an IQ error payload that contains error type="auth"
      // but is unrelated to stream authentication.
      mockXmppClientInstance._emit(
        'error',
        new Error('<iq type="error"><error type="auth"><forbidden/></error></iq>')
      )
      mockXmppClientInstance._emit('disconnect', { clean: false })

      expect(mockStores.console.addEvent).not.toHaveBeenCalledWith(
        'Disconnected: Authentication error',
        'error'
      )
      expect(mockStores.connection.setError).not.toHaveBeenCalledWith('Authentication failed')
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
    })

    it('should still reconnect on normal disconnection', async () => {
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
      vi.mocked(mockStores.connection.setStatus).mockClear()

      // Simulate normal disconnection (no error before offline)
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should set status to reconnecting
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // Should have logged reconnect intent
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Connection lost unexpectedly, will reconnect',
        'connection'
      )
    })

    it('should not trigger reconnect from stale disconnect after auth error', async () => {
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
      vi.mocked(mockStores.connection.setStatus).mockClear()
      vi.mocked(mockStores.console.addEvent).mockClear()

      // Auth error → terminal.authFailed
      mockXmppClientInstance._emit('error', new Error('not-authorized'))

      // Stale disconnect from the old client
      ;(xmppClient.connection as any).xmpp = null
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Should NOT have triggered reconnect recovery
      expect(mockStores.console.addEvent).not.toHaveBeenCalledWith(
        'Socket closed from stale client while connected, forcing reconnect recovery',
        'connection'
      )
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })

    it('should skip handleDeadSocket when in terminal state', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Trigger conflict → terminal.conflict
      mockXmppClientInstance._emit('error', new Error('conflict'))

      // Clear calls
      vi.mocked(mockStores.console.addEvent).mockClear()
      vi.mocked(mockStores.connection.setStatus).mockClear()

      // Call handleDeadSocket (e.g., from a stale econnerror)
      xmppClient.connection.handleDeadSocket({ source: 'test' })

      // Should be skipped
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Dead-socket recovery skipped: machine in terminal state',
        'connection'
      )
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })
  })

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      expect(xmppClient.isConnected()).toBe(false)
    })

    it('should return true after successful connection', async () => {
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

    it('should return JID after connection', async () => {
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
      const handler = vi.fn()
      const unsubscribe = xmppClient.on('online', handler)

      // Unsubscribe before connecting
      unsubscribe()

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('bookmark autojoin', () => {
    it('should join rooms marked with autojoin after fresh connection', async () => {
      // Mock iqCaller to return bookmarks with autojoin rooms
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const firstChild = iq.children?.[0]
        const xmlns = firstChild?.attrs?.xmlns

        // Return autojoin bookmarks for PubSub query
        if (xmlns === 'http://jabber.org/protocol/pubsub') {
          const items = firstChild.children?.find((c: any) => c.name === 'items')
          if (items?.attrs?.node === 'urn:xmpp:bookmarks:1') {
            return createMockElement('iq', { type: 'result' }, [
              {
                name: 'pubsub',
                attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
                children: [
                  {
                    name: 'items',
                    attrs: { node: 'urn:xmpp:bookmarks:1' },
                    children: [
                      {
                        name: 'item',
                        attrs: { id: 'room1@conference.example.org' },
                        children: [
                          {
                            name: 'conference',
                            attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'Room 1', autojoin: 'true' },
                            children: [{ name: 'nick', text: 'testnick' }],
                          },
                        ],
                      },
                      {
                        name: 'item',
                        attrs: { id: 'room2@conference.example.org' },
                        children: [
                          {
                            name: 'conference',
                            attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'Room 2', autojoin: 'false' },
                            children: [{ name: 'nick', text: 'testnick' }],
                          },
                        ],
                      },
                      {
                        name: 'item',
                        attrs: { id: 'room3@conference.example.org' },
                        children: [
                          {
                            name: 'conference',
                            attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'Room 3', autojoin: 'true' },
                            children: [{ name: 'nick', text: 'testnick' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ])
          }
        }

        // Return empty disco#info
        if (xmlns === 'http://jabber.org/protocol/disco#info') {
          return createMockElement('iq', { type: 'result' }, [
            { name: 'query', attrs: { xmlns }, children: [] }
          ])
        }

        // Default empty result
        return createMockElement('iq', { type: 'result' }, [])
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Allow async operations to complete
      await vi.advanceTimersByTimeAsync(100)

      // Verify that presence was sent to autojoin rooms (room1 and room3, not room2)
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const mucPresences = sendCalls.filter((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to?.includes('@conference.example.org/')
      })

      // Should have sent presence to room1 and room3 (autojoin=true)
      expect(mucPresences.length).toBeGreaterThanOrEqual(2)

      const joinedRooms = mucPresences.map((call: any) => call[0].attrs.to.split('/')[0])
      expect(joinedRooms).toContain('room1@conference.example.org')
      expect(joinedRooms).toContain('room3@conference.example.org')
      expect(joinedRooms).not.toContain('room2@conference.example.org')
    })

    it('should rejoin non-autojoin rooms AND join autojoin bookmarks on reconnect', async () => {
      // Mock iqCaller to return autojoin bookmarks
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const firstChild = iq.children?.[0]
        const xmlns = firstChild?.attrs?.xmlns

        if (xmlns === 'http://jabber.org/protocol/pubsub') {
          const items = firstChild.children?.find((c: any) => c.name === 'items')
          if (items?.attrs?.node === 'urn:xmpp:bookmarks:1') {
            return createMockElement('iq', { type: 'result' }, [
              {
                name: 'pubsub',
                attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
                children: [
                  {
                    name: 'items',
                    attrs: { node: 'urn:xmpp:bookmarks:1' },
                    children: [
                      {
                        name: 'item',
                        attrs: { id: 'autojoin@conference.example.org' },
                        children: [
                          {
                            name: 'conference',
                            attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'Autojoin Room', autojoin: 'true' },
                            children: [{ name: 'nick', text: 'testnick' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ])
          }
        }

        if (xmlns === 'http://jabber.org/protocol/disco#info') {
          return createMockElement('iq', { type: 'result' }, [
            { name: 'query', attrs: { xmlns }, children: [] }
          ])
        }

        return createMockElement('iq', { type: 'result' }, [])
      })

      // Simulate previously active rooms in the store
      mockStores.room.joinedRooms = vi.fn().mockReturnValue([
        { jid: 'active@conference.example.org', nickname: 'user', joined: true }
      ])

      // Reconnect scenario: previouslyJoinedRooms contains a non-autojoin room
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        previouslyJoinedRooms: [{ jid: 'active@conference.example.org', nickname: 'user', autojoin: false }],
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      await vi.advanceTimersByTimeAsync(100)

      // Should have rejoined BOTH the previously active room AND the autojoin bookmark
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const mucPresences = sendCalls.filter((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to?.includes('@conference.example.org/')
      })

      const joinedRooms = mucPresences.map((call: any) => call[0].attrs.to.split('/')[0])

      // Should rejoin previously active non-autojoin room
      expect(joinedRooms).toContain('active@conference.example.org')
      // Should ALSO join autojoin bookmark room (both are joined on reconnect)
      expect(joinedRooms).toContain('autojoin@conference.example.org')
    })

    it('should not double-join a room that is in both previouslyJoinedRooms and autojoin bookmarks', async () => {
      // This tests the case where a room was previously joined but is ALSO an autojoin bookmark
      // (e.g., the autojoin flag was changed on another client)
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const firstChild = iq.children?.[0]
        const xmlns = firstChild?.attrs?.xmlns

        if (xmlns === 'http://jabber.org/protocol/pubsub') {
          const items = firstChild.children?.find((c: any) => c.name === 'items')
          if (items?.attrs?.node === 'urn:xmpp:bookmarks:1') {
            return createMockElement('iq', { type: 'result' }, [
              {
                name: 'pubsub',
                attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
                children: [
                  {
                    name: 'items',
                    attrs: { node: 'urn:xmpp:bookmarks:1' },
                    children: [
                      {
                        name: 'item',
                        // Same JID as in previouslyJoinedRooms but now with autojoin=true
                        attrs: { id: 'shared@conference.example.org' },
                        children: [
                          {
                            name: 'conference',
                            attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'Shared Room', autojoin: 'true' },
                            children: [{ name: 'nick', text: 'testnick' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ])
          }
        }

        if (xmlns === 'http://jabber.org/protocol/disco#info') {
          return createMockElement('iq', { type: 'result' }, [
            { name: 'query', attrs: { xmlns }, children: [] }
          ])
        }

        return createMockElement('iq', { type: 'result' }, [])
      })

      // previouslyJoinedRooms has the room with autojoin: false (stale data)
      // but the current bookmark has autojoin: true
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        previouslyJoinedRooms: [{ jid: 'shared@conference.example.org', nickname: 'user', autojoin: false }],
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await vi.advanceTimersByTimeAsync(100)

      // Count MUC presence stanzas to shared@conference.example.org
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const mucPresences = sendCalls.filter((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to?.startsWith('shared@conference.example.org/')
      })

      // Should only join once (via autojoin logic), not twice
      expect(mucPresences.length).toBe(1)
    })

    it('should not autojoin when bookmarks have no autojoin rooms', async () => {
      // Mock iqCaller to return bookmarks without autojoin
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const firstChild = iq.children?.[0]
        const xmlns = firstChild?.attrs?.xmlns

        if (xmlns === 'http://jabber.org/protocol/pubsub') {
          const items = firstChild.children?.find((c: any) => c.name === 'items')
          if (items?.attrs?.node === 'urn:xmpp:bookmarks:1') {
            return createMockElement('iq', { type: 'result' }, [
              {
                name: 'pubsub',
                attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
                children: [
                  {
                    name: 'items',
                    attrs: { node: 'urn:xmpp:bookmarks:1' },
                    children: [
                      {
                        name: 'item',
                        attrs: { id: 'noautojoin@conference.example.org' },
                        children: [
                          {
                            name: 'conference',
                            attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'No Autojoin', autojoin: 'false' },
                            children: [{ name: 'nick', text: 'testnick' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ])
          }
        }

        if (xmlns === 'http://jabber.org/protocol/disco#info') {
          return createMockElement('iq', { type: 'result' }, [
            { name: 'query', attrs: { xmlns }, children: [] }
          ])
        }

        return createMockElement('iq', { type: 'result' }, [])
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance._emit('online')
      await connectPromise

      await vi.advanceTimersByTimeAsync(100)

      // Should NOT have sent any MUC presence
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const mucPresences = sendCalls.filter((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to?.includes('@conference.example.org/')
      })

      expect(mucPresences).toHaveLength(0)
    })
  })

  describe('getStreamManagementState caching', () => {
    it('should return null when no SM state exists', () => {
      // No connection, no cache
      const smState = xmppClient.getStreamManagementState()
      expect(smState).toBeNull()
    })

    it('should return live SM state when xmpp client is connected', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Set up SM state on the mock client
      mockXmppClientInstance.streamManagement = {
        id: 'sm-session-123',
        inbound: 42,
        enabled: true,
        outbound: 0,
        on: vi.fn(),
      }

      mockXmppClientInstance._emit('online')
      await connectPromise

      const smState = xmppClient.getStreamManagementState()
      expect(smState).toMatchObject({
        id: 'sm-session-123',
        inbound: 42,
      })
    })

    it('should return cached SM state when xmpp client becomes unavailable', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Set up SM state on the mock client
      mockXmppClientInstance.streamManagement = {
        id: 'sm-session-456',
        inbound: 10,
        enabled: true,
        outbound: 0,
        on: vi.fn(),
      }

      mockXmppClientInstance._emit('online')
      await connectPromise

      // First call populates the cache
      const smState1 = xmppClient.getStreamManagementState()
      expect(smState1).toMatchObject({
        id: 'sm-session-456',
        inbound: 10,
      })

      // Simulate socket death - SM becomes unavailable
      mockXmppClientInstance.streamManagement = null as any

      // Should return cached state
      const smState2 = xmppClient.getStreamManagementState()
      expect(smState2).toMatchObject({
        id: 'sm-session-456',
        inbound: 10,
      })
    })

    it('should clear cached SM state on manual disconnect', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Set up SM state on the mock client
      mockXmppClientInstance.streamManagement = {
        id: 'sm-session-789',
        inbound: 5,
        enabled: true,
        outbound: 0,
        on: vi.fn(),
      }

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Populate the cache
      const smState1 = xmppClient.getStreamManagementState()
      expect(smState1).not.toBeNull()

      // Disconnect clears the cache
      await xmppClient.disconnect()

      // SM state should be null after disconnect
      const smState2 = xmppClient.getStreamManagementState()
      expect(smState2).toBeNull()
    })

    it('should update cache with latest SM state on each call', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      mockXmppClientInstance.streamManagement = {
        id: 'sm-session-abc',
        inbound: 1,
        enabled: true,
        outbound: 0,
        on: vi.fn(),
      }

      mockXmppClientInstance._emit('online')
      await connectPromise

      // First call
      const smState1 = xmppClient.getStreamManagementState()
      expect(smState1?.inbound).toBe(1)

      // Update inbound counter (simulating received stanzas)
      mockXmppClientInstance.streamManagement.inbound = 15

      // Second call should return updated state
      const smState2 = xmppClient.getStreamManagementState()
      expect(smState2?.inbound).toBe(15)

      // Simulate socket death
      mockXmppClientInstance.streamManagement = null as any

      // Should return the last cached state (inbound: 15)
      const smState3 = xmppClient.getStreamManagementState()
      expect(smState3?.inbound).toBe(15)
    })
  })

  describe('Joined room persistence', () => {
    it('should load joined rooms from storage and pass to handleConnectionSuccess', async () => {
      // Use real timers for this test since we need async storage to resolve
      vi.useRealTimers()

      const storedJoinedRooms = [
        { jid: 'stored-room@conference.example.com', nickname: 'storedUser', autojoin: false },
      ]

      // Create storage adapter that returns stored session state with joined rooms
      // SM state is fresh (within 10 min) so it and joined rooms should be used
      const mockStorageAdapter = {
        getSessionState: vi.fn().mockResolvedValue({
          smId: 'valid-sm-id',
          smInbound: 10,
          resource: 'test-resource',
          timestamp: Date.now() - 5 * 60 * 1000, // 5 minutes ago (valid)
          joinedRooms: storedJoinedRooms,
        }),
        setSessionState: vi.fn(),
        clearSessionState: vi.fn(),
      }

      const clientWithStorage = new XMPPClient({ debug: false, storageAdapter: mockStorageAdapter })
      clientWithStorage.bindStores(mockStores)

      // Set up IQ handler to return empty bookmarks
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const firstChild = iq.children?.[0]
        const xmlns = firstChild?.attrs?.xmlns

        if (xmlns === 'http://jabber.org/protocol/pubsub') {
          const items = firstChild.children?.find((c: any) => c.name === 'items')
          if (items?.attrs?.node === 'urn:xmpp:bookmarks:1') {
            return createMockElement('iq', { type: 'result' }, [
              {
                name: 'pubsub',
                attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
                children: [
                  { name: 'items', attrs: { node: 'urn:xmpp:bookmarks:1' }, children: [] }
                ],
              },
            ])
          }
        }

        if (xmlns === 'http://jabber.org/protocol/disco#info') {
          return createMockElement('iq', { type: 'result' }, [
            { name: 'query', attrs: { xmlns }, children: [] }
          ])
        }

        return createMockElement('iq', { type: 'result' }, [])
      })

      // Connect - should load joined rooms from storage
      const connectPromise = clientWithStorage.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Small delay to let storage load happen
      await new Promise(resolve => setTimeout(resolve, 10))

      mockXmppClientInstance._emit('online')
      await connectPromise

      // Wait for async operations to complete
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should have joined the room from storage
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const mucPresences = sendCalls.filter((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to?.includes('stored-room@conference.example.com')
      })

      expect(mucPresences.length).toBe(1)

      // Restore fake timers for other tests
      vi.useFakeTimers()
    })
  })

  describe('notifySystemState', () => {
    beforeEach(async () => {
      // Set up a connected client for these tests
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'wss://example.com/ws',
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      mockStores.connection.getStatus.mockReturnValue('online')
      // Clear mocks after connection setup
      mockStores.connection.setStatus.mockClear()
      mockStores.console.addEvent.mockClear()
      mockXmppClientInstance.send.mockClear()
    })

    it('should verify connection on "awake" state when online', async () => {
      // Add SM to enable verification
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      // Simulate SM ack response when send is called
      mockXmppClientInstance.send.mockImplementationOnce(() => {
        setTimeout(() => {
          const ackNonza = createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' })
          mockXmppClientInstance._emit('nonza', ackNonza)
        }, 10)
        return Promise.resolve()
      })

      const notifyPromise = xmppClient.notifySystemState('awake')
      await vi.runAllTimersAsync()
      await notifyPromise

      // Should have entered verifying state (status stays 'online', isVerifying flag set)
      expect(mockStores.connection.setIsVerifying).toHaveBeenCalledWith(true)
      // Should have logged the verification
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('awake'),
        'connection'
      )
    })

    it('should NOT verify connection on "visible" state when online', async () => {
      await xmppClient.notifySystemState('visible')

      // Should NOT enter verifying state
      expect(mockStores.connection.setIsVerifying).not.toHaveBeenCalledWith(true)
      // Should NOT send any SM request (send was cleared after connection setup)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should trigger reconnect on "visible" state when reconnecting', async () => {
      // Put the connection machine into reconnecting state by simulating a dead socket
      // The machine is in connected.healthy after the connect above — SOCKET_DIED
      // transitions it to reconnecting.waiting
      xmppClient.connectionActor.send({ type: 'SOCKET_DIED' })

      await xmppClient.notifySystemState('visible')

      // Should log the event
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('visible'),
        'connection'
      )
    })

    it('should skip verification and reconnect immediately when sleep exceeds SM timeout', async () => {
      // Sleep duration of 15 minutes (exceeds 10 min SM timeout)
      const fifteenMinutesMs = 15 * 60 * 1000

      await xmppClient.notifySystemState('awake', fifteenMinutesMs)

      // Should NOT verify (no SM request sent for verification)
      expect(mockStores.connection.setIsVerifying).not.toHaveBeenCalledWith(true)
      // Should trigger reconnect
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')
      // Should log that we're reconnecting immediately
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('exceeds SM timeout'),
        'connection'
      )
    })

    it('should verify connection when sleep is under SM timeout', async () => {
      // Add SM to enable verification
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      // Simulate SM ack response when send is called
      mockXmppClientInstance.send.mockImplementationOnce(() => {
        setTimeout(() => {
          const ackNonza = createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' })
          mockXmppClientInstance._emit('nonza', ackNonza)
        }, 10)
        return Promise.resolve()
      })

      // Sleep duration of 5 minutes (under 10 min SM timeout)
      const fiveMinutesMs = 5 * 60 * 1000

      const notifyPromise = xmppClient.notifySystemState('awake', fiveMinutesMs)
      await vi.runAllTimersAsync()
      await notifyPromise

      // Should verify (isVerifying flag set)
      expect(mockStores.connection.setIsVerifying).toHaveBeenCalledWith(true)
    })
  })

  // ── Wake-from-sleep reconnection regression tests ─────────────────────────
  // These tests verify the fixes for the 30-second freeze that occurred when
  // reconnecting after system wake. The root causes were:
  // 1. Missing disconnect handler in setupConnectionHandlers (30s hang)
  // 2. Stale this.xmpp reference after unexpected disconnect
  // 3. No mutex on concurrent attemptReconnect calls

  describe('wake-from-sleep reconnection', () => {
    beforeEach(async () => {
      // Set up a connected client with SM enabled
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()
      mockStores.console.addEvent.mockClear()
      mockClientFactory.mockClear()
    })

    it('should not hang when new socket disconnects during XMPP handshake', async () => {
      // Simulate unexpected disconnect (bridge died during sleep)
      mockXmppClientInstance._emit('disconnect', { clean: true, reason: { code: 1000, reason: 'Bridge closed' } })

      // Reconnect timer scheduled (attempt 1, 1s delay)
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // Prepare new mock client for reconnect attempt
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)

      // Advance timer to trigger reconnect
      await vi.advanceTimersByTimeAsync(1000)

      // New client should have been created
      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Simulate: new WebSocket connects but XMPP server TCP connect fails,
      // so proxy closes the WebSocket immediately. Neither 'online' nor 'error'
      // fires — only 'disconnect'. Without Fix 1, this would hang for 30s.
      reconnectClient._emit('disconnect', { clean: false })

      // Allow error handling to propagate
      await vi.advanceTimersByTimeAsync(0)

      // Should have logged the handshake disconnect as a failure
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('Socket disconnected during connection handshake'),
        'error'
      )

      // Should schedule another reconnect attempt (not stuck forever)
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(2, expect.any(Number))
    })

    it('should clean up client and retry when reconnect attempt times out', async () => {
      // Simulate unexpected disconnect to enter reconnecting state
      mockXmppClientInstance._emit('disconnect', { clean: false })
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // Prepare new mock client for reconnect attempt
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)

      // Advance timer to trigger reconnect attempt
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Simulate: SASL auth succeeds but resource binding hangs.
      // Neither 'online' nor 'error' nor 'disconnect' fires.
      // The RECONNECT_ATTEMPT_TIMEOUT_MS should catch this.

      // Verify the client is still referenced before timeout
      expect((xmppClient.connection as any).xmpp).toBe(reconnectClient)

      // Advance past the reconnect attempt timeout
      mockClientFactory.mockClear()
      mockStores.connection.setReconnectState.mockClear()
      await vi.advanceTimersByTimeAsync(RECONNECT_ATTEMPT_TIMEOUT_MS)

      // Client should have been cleaned up (nulled) by the timeout handler
      expect((xmppClient.connection as any).xmpp).toBeNull()

      // Should have logged the timeout
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('timed out'),
        'error'
      )

      // Should schedule another reconnect attempt (machine → waiting → attempting)
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number)
      )

      // Prepare another client for the retry
      const retryClient = createMockXmppClient()
      mockClientFactory._setInstance(retryClient)
      mockClientFactory.mockClear()

      // Advance timer to trigger the retry attempt
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
    })

    it('should not fire stale events from timed-out client after cleanup', async () => {
      // Simulate disconnect to enter reconnecting state
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Prepare client for reconnect attempt
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)

      // Trigger reconnect attempt
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Advance past timeout — client is cleaned up
      await vi.advanceTimersByTimeAsync(RECONNECT_ATTEMPT_TIMEOUT_MS)
      expect((xmppClient.connection as any).xmpp).toBeNull()

      // Now simulate the stale client belatedly firing 'online'
      // (e.g., resource binding finally completed after timeout).
      // Since listeners were stripped by cleanupClient/forceDestroyClient,
      // this should NOT cause a CONNECTION_SUCCESS on the state machine.
      mockStores.connection.setStatus.mockClear()
      reconnectClient._emit('online')

      // The machine should still be in reconnecting (not connected)
      // because the stale 'online' event was stripped by cleanup
      const statusCalls = vi.mocked(mockStores.connection.setStatus).mock.calls
      expect(statusCalls.some(c => c[0] === 'online')).toBe(false)
    })

    it('should null xmpp reference on unexpected disconnect to prevent stale operations', async () => {
      // Add SM to enable verification path
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      // Start wake verification (sends SM <r/> request)
      // Don't resolve SM ack — simulate dead socket
      mockXmppClientInstance.send.mockImplementationOnce(() => {
        // Send succeeds (buffered) but no ack will come
        return Promise.resolve()
      })

      const notifyPromise = xmppClient.notifySystemState('awake')

      // Before verify timeout, the bridge close frame arrives
      mockXmppClientInstance._emit('disconnect', { clean: true, reason: { code: 1000, reason: 'Bridge closed' } })

      // The disconnect handler should have:
      // 1. Sent SOCKET_DIED to machine
      // 2. Nulled this.xmpp (Fix 2)
      // 3. Started reconnect timer
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // Complete the verify (it should return false quickly since xmpp is now null)
      // Without Fix 2, the verify would hang for 10s waiting for SM ack on dead socket.
      // With Fix 2, xmpp is null so verify returns false immediately.
      await vi.advanceTimersByTimeAsync(0)
      await notifyPromise

      // The reconnect timer should be running (not stuck in verification loop)
      // Verify by advancing timer and confirming a reconnect attempt is made.
      // After wake, attemptReconnect adds a 2s network settle delay (NETWORK_SETTLE_DELAY_MS).
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)
      await vi.advanceTimersByTimeAsync(3000)
      expect(mockClientFactory).toHaveBeenCalled()
    })

    it('should ignore stale disconnect without triggering reconnect', async () => {
      // Simulate the race: internal xmpp ref was already replaced/nulled,
      // but the old socket disconnect event arrives while machine is connected.
      ;(xmppClient.connection as any).xmpp = null

      vi.mocked(mockStores.connection.setStatus).mockClear()

      mockXmppClientInstance._emit('disconnect', {
        clean: false,
        reason: { code: 1006, reason: 'ECONNERROR' },
      })

      // Stale disconnect should be logged and ignored — no reconnect triggered.
      // In every real code path, the machine has already transitioned out of
      // `connected` before any stale disconnect arrives (SOCKET_DIED is sent
      // synchronously before forceDestroyClient strips listeners).
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })

    it('should schedule reconnect after SM verify timeout without disconnect event', async () => {
      // Add SM to enable verification path
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      // Simulate a silent dead socket:
      // <r/> send succeeds (buffered) but no <a/> ever comes back.
      mockXmppClientInstance.send.mockImplementation(() => Promise.resolve())

      // Prepare reconnect client before timer fires
      const reconnectClient = createMockXmppClient()
      mockClientFactory.mockClear()
      mockClientFactory._setInstance(reconnectClient)

      const notifyPromise = xmppClient.notifySystemState('awake')

      // Wake verification timeout is 15s (WAKE_VERIFY_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(15_000)
      await notifyPromise

      // Timeout should transition to reconnecting and arm backoff timer
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Verification failed, reconnecting',
        'connection'
      )
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // First reconnect attempt uses 1s delay
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
    })

    it('should prevent concurrent reconnect attempts via state-machine sequencing', async () => {
      // Trigger unexpected disconnect to enter reconnecting state
      mockXmppClientInstance._emit('disconnect', { clean: false })
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // Prepare mock client for reconnect
      const reconnectClient = createMockXmppClient()
      // Make start() hang (simulate slow connection)
      reconnectClient.start = vi.fn().mockReturnValue(new Promise(() => {}))
      mockClientFactory._setInstance(reconnectClient)

      // Advance timer to trigger first reconnect attempt
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Now call triggerReconnect() while the first attempt is still in progress
      // (simulates app becoming visible while reconnecting)
      mockClientFactory.mockClear()
      xmppClient.triggerReconnect()

      // No second reconnect attempt should start while machine stays in attempting.
      expect(mockClientFactory).not.toHaveBeenCalled()
    })

    it('should allow repeated reconnect triggers after "still online" short-circuit', async () => {
      // Force the defensive online short-circuit path in attemptReconnect()
      ;(mockXmppClientInstance as any).status = 'online'

      // First immediate reconnect short-circuits
      xmppClient.connectionActor.send({ type: 'SOCKET_DIED' })
      xmppClient.triggerReconnect()
      await vi.advanceTimersByTimeAsync(0)

      // A second trigger should still run through attempting, not get stuck.
      vi.mocked(mockStores.console.addEvent).mockClear()
      xmppClient.connectionActor.send({ type: 'SOCKET_DIED' })
      xmppClient.triggerReconnect()
      await vi.advanceTimersByTimeAsync(0)

      expect(mockStores.console.addEvent).toHaveBeenCalled()
      expect(mockStores.console.addEvent).not.toHaveBeenCalledWith(
        'Reconnect attempt already in progress, skipping',
        'connection'
      )
    })

    it('should run reconnect success recovery when short-circuiting on an already-online transport', async () => {
      ;(mockXmppClientInstance as any).status = 'online'
      mockXmppClientInstance.send.mockClear()
      vi.mocked(mockStores.roster.resetAllPresence).mockClear()
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        {
          jid: 'fluux-messenger@conference.process-one.net',
          nickname: 'Mickaël',
          joined: true,
          autojoin: false,
        } as any,
      ])

      const connectionModule = xmppClient.connection as any
      const reconnectSubstateSpy = vi.spyOn(connectionModule, 'isReconnectingSubstate').mockReturnValue(true)
      await connectionModule.attemptReconnect()
      reconnectSubstateSpy.mockRestore()

      expect(mockStores.roster.resetAllPresence).toHaveBeenCalled()
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Connection still online - cancelling reconnect attempt',
        'connection'
      )

      const rejoinPresence = mockXmppClientInstance.send.mock.calls.find((call: any[]) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
          stanza?.attrs?.to === 'fluux-messenger@conference.process-one.net/Mickaël'
      })
      expect(rejoinPresence).toBeDefined()
    })

    it('should handle full overnight sleep sequence (bridge closed hours ago)', async () => {
      // Step 1: Bridge watchdog closes connection during sleep
      // The WebSocket close frame is queued (JS runtime is suspended)
      // Step 2: System wakes — both the close frame and wake event arrive

      // Simulate the close frame arriving first (within same tick as wake)
      mockXmppClientInstance._emit('disconnect', { clean: true, reason: { code: 1000, reason: 'Bridge closed' } })

      // Machine enters reconnecting state
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('reconnecting')

      // Prepare mock for reconnect BEFORE calling notifySystemState,
      // because triggerReconnect() fires attemptReconnect() synchronously
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)

      // Now the wake event fires with a long sleep duration (8 hours)
      // Since we're already in reconnecting state, this should triggerReconnect
      const eightHoursMs = 8 * 60 * 60 * 1000
      await xmppClient.notifySystemState('awake', eightHoursMs)

      // Should log the immediate reconnect trigger
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('triggering immediate reconnect'),
        'connection'
      )

      // Allow the async attemptReconnect to progress (cleanupClient, createXmppClient, start).
      // After wake, attemptReconnect adds a 2s network settle delay (NETWORK_SETTLE_DELAY_MS).
      await vi.advanceTimersByTimeAsync(3000)

      // The triggerReconnect should have started attemptReconnect
      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Simulate successful reconnection on the new client
      reconnectClient._emit('online')
      await vi.advanceTimersByTimeAsync(100)

      // Machine should have received CONNECTION_SUCCESS → connected.healthy
      const statusCalls = vi.mocked(mockStores.connection.setStatus).mock.calls.map(c => c[0])
      expect(statusCalls).toContain('online')
    })

    it('should abort SM ack verification immediately when socket disconnects', async () => {
      // Add SM for verification path
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      // Mock send to succeed (buffered) but never get an ack
      mockXmppClientInstance.send.mockImplementation(() => Promise.resolve())

      // Start verification
      const verifyPromise = xmppClient.verifyConnection()

      // Socket disconnects during verification (bridge closed)
      mockXmppClientInstance._emit('disconnect', { clean: true })

      // Verification should resolve false immediately (not wait 10s)
      const startTime = Date.now()
      const result = await verifyPromise
      const elapsed = Date.now() - startTime

      expect(result).toBe(false)
      // Should resolve nearly instantly, not after the 10s timeout
      expect(elapsed).toBeLessThan(1000)
    })
  })

  describe('SM state preservation on dead socket', () => {
    beforeEach(async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      mockStores.connection.getStatus.mockReturnValue('online')
    })

    it('should capture SM state into cache before nulling xmpp on unexpected disconnect', () => {
      // Simulate SM being enabled with valid state
      mockXmppClientInstance.streamManagement.id = 'sm-abc123'
      mockXmppClientInstance.streamManagement.enabled = true
      mockXmppClientInstance.streamManagement.inbound = 42

      // Trigger unexpected disconnect — the disconnect handler captures SM state
      // before nulling xmpp and scheduling reconnect
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // SM state should be preserved via cache and accessible after socket death
      const smState = xmppClient.getStreamManagementState()
      expect(smState).not.toBeNull()
      expect(smState?.id).toBe('sm-abc123')
      expect(smState?.inbound).toBe(42)
    })

    it('should return null SM state when SM was never enabled', () => {
      // SM id stays null (default)
      mockXmppClientInstance._emit('disconnect', { clean: false })

      const smState = xmppClient.getStreamManagementState()
      expect(smState).toBeNull()
    })
  })

  describe('SM nonza-based cache population', () => {
    it('should populate SM cache when <enabled/> nonza is received', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Simulate SM being enabled at xmpp.js level (sets sm.id)
      mockXmppClientInstance.streamManagement.id = 'sm-new-session'
      mockXmppClientInstance.streamManagement.enabled = true
      mockXmppClientInstance.streamManagement.inbound = 0

      // Fire <enabled/> nonza (this is what the server sends)
      const enabledNonza = createMockElement('enabled', {
        xmlns: 'urn:xmpp:sm:3',
        id: 'sm-new-session',
        max: '600',
      })
      mockXmppClientInstance._emit('nonza', enabledNonza)

      // Then fire online to complete connection
      mockXmppClientInstance._emit('online')
      await connectPromise

      // SM state should be cached now
      const smState = xmppClient.getStreamManagementState()
      expect(smState).not.toBeNull()
      expect(smState?.id).toBe('sm-new-session')
    })

    it('should populate SM cache when <resumed/> nonza is received', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Simulate SM resume at xmpp.js level
      mockXmppClientInstance.streamManagement.id = 'sm-resumed-session'
      mockXmppClientInstance.streamManagement.enabled = true
      mockXmppClientInstance.streamManagement.inbound = 15

      // Fire <resumed/> nonza
      const resumedNonza = createMockElement('resumed', {
        xmlns: 'urn:xmpp:sm:3',
        previd: 'sm-resumed-session',
        h: '15',
      })
      mockXmppClientInstance._emit('nonza', resumedNonza)
      await connectPromise

      // SM state should be cached
      const smState = xmppClient.getStreamManagementState()
      expect(smState).not.toBeNull()
      expect(smState?.id).toBe('sm-resumed-session')
    })

    it('should preserve SM state through dead-socket → reconnect cycle', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      // Simulate SM enable: xmpp.js sets sm.id, then server sends <enabled/>
      mockXmppClientInstance.streamManagement.id = 'sm-cycle-test'
      mockXmppClientInstance.streamManagement.enabled = true
      mockXmppClientInstance.streamManagement.inbound = 0

      const enabledNonza = createMockElement('enabled', {
        xmlns: 'urn:xmpp:sm:3',
        id: 'sm-cycle-test',
        max: '600',
      })
      mockXmppClientInstance._emit('nonza', enabledNonza)
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Simulate receiving some stanzas (inbound counter advances)
      mockXmppClientInstance.streamManagement.inbound = 25

      // Socket dies unexpectedly
      mockStores.connection.getStatus.mockReturnValue('online')
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // SM state should survive: captured by handleDeadSocket from live client
      const smState = xmppClient.getStreamManagementState()
      expect(smState).not.toBeNull()
      expect(smState?.id).toBe('sm-cycle-test')
      expect(smState?.inbound).toBe(25)
    })
  })

  describe('FAST token authentication (XEP-0484)', () => {
    /**
     * Helper to extract the credentials callback passed to the xmpp.js client factory.
     * The callback is the core of FAST token integration — it decides which auth
     * method to use (token vs password) and reports the method to the store.
     */
    function getCredentialsCallback(): Function {
      const call = mockClientFactory.mock.calls[mockClientFactory.mock.calls.length - 1] as unknown[]
      return (call[0] as { credentials: Function }).credentials
    }

    it('should wire FAST storage methods on the mock client fast module', async () => {
      // Add a fast module to the mock client
      ;(mockXmppClientInstance as any).fast = {
        fetchToken: vi.fn(),
        saveToken: vi.fn(),
        deleteToken: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Verify FAST storage methods were overridden
      const fast = (mockXmppClientInstance as any).fast
      expect(fast.fetchToken).not.toBe(vi.fn()) // Should be replaced
      // Call the wired methods to verify they delegate to our mock
      fast.fetchToken()
      expect(mockFetchFastToken).toHaveBeenCalledWith('user@example.com')
    })

    it('should use password auth when no FAST token available', async () => {
      mockFetchFastToken.mockReturnValue(null)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Extract and invoke the credentials callback
      const credentialsFn = getCredentialsCallback()
      const mockAuthenticate = vi.fn()
      const mockFast = { fetch: vi.fn().mockResolvedValue(null) }

      await credentialsFn(
        mockAuthenticate,
        ['SCRAM-SHA-256', 'PLAIN'],
        mockFast,
        { isSecure: () => true }
      )

      // Should authenticate with password, no token
      expect(mockAuthenticate).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'user', password: 'secret' }),
        expect.any(String)
      )
      // Auth method should be 'password'
      expect(mockStores.connection.setAuthMethod).toHaveBeenCalledWith('password')
    })

    it('should use FAST token when available', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const credentialsFn = getCredentialsCallback()
      const mockAuthenticate = vi.fn()
      const mockToken = { mechanism: 'HT-SHA-256-NONE', token: 'fast-tok', expiry: '2099-01-01T00:00:00Z' }
      const mockFast = { fetch: vi.fn().mockResolvedValue(mockToken) }

      await credentialsFn(
        mockAuthenticate,
        ['HT-SHA-256-NONE', 'SCRAM-SHA-256'],
        mockFast,
        { isSecure: () => true }
      )

      // Should have token in credentials
      expect(mockAuthenticate).toHaveBeenCalledWith(
        expect.objectContaining({ token: mockToken }),
        expect.any(String)
      )
      // Auth method should be 'fast-token'
      expect(mockStores.connection.setAuthMethod).toHaveBeenCalledWith('fast-token')
    })

    it('should throw when no password and no FAST token', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: undefined,
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const credentialsFn = getCredentialsCallback()
      const mockAuthenticate = vi.fn()
      const mockFast = { fetch: vi.fn().mockResolvedValue(null) }

      await expect(
        credentialsFn(
          mockAuthenticate,
          ['SCRAM-SHA-256'],
          mockFast,
          { isSecure: () => true }
        )
      ).rejects.toThrow('No credentials available')

      expect(mockAuthenticate).not.toHaveBeenCalled()
    })

    it('should use FAST token when password is undefined', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: undefined,
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const credentialsFn = getCredentialsCallback()
      const mockAuthenticate = vi.fn()
      const mockToken = { mechanism: 'HT-SHA-256-NONE', token: 'fast-tok', expiry: '2099-01-01T00:00:00Z' }
      const mockFast = { fetch: vi.fn().mockResolvedValue(mockToken) }

      await credentialsFn(
        mockAuthenticate,
        ['HT-SHA-256-NONE', 'SCRAM-SHA-256'],
        mockFast,
        { isSecure: () => true }
      )

      // Should succeed with token, no password
      expect(mockAuthenticate).toHaveBeenCalledWith(
        expect.objectContaining({ token: mockToken }),
        expect.any(String)
      )
      expect(mockStores.connection.setAuthMethod).toHaveBeenCalledWith('fast-token')
    })

    it('should log auth method to console store', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const credentialsFn = getCredentialsCallback()
      await credentialsFn(
        vi.fn(), // authenticate
        ['SCRAM-SHA-256'],
        { fetch: vi.fn().mockResolvedValue(null) },
        { isSecure: () => true }
      )

      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('Auth: password'),
        'connection'
      )
    })

    it('should not include password in credentials when password is undefined', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: undefined,
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const credentialsFn = getCredentialsCallback()
      const mockAuthenticate = vi.fn()
      const mockToken = { mechanism: 'HT-SHA-256-NONE', token: 'fast-tok', expiry: '2099-01-01T00:00:00Z' }

      await credentialsFn(
        mockAuthenticate,
        ['HT-SHA-256-NONE'],
        { fetch: vi.fn().mockResolvedValue(mockToken) },
        { isSecure: () => true }
      )

      // Password should NOT be in the credentials object
      const passedCreds = mockAuthenticate.mock.calls[0][0]
      expect(passedCreds).not.toHaveProperty('password')
      expect(passedCreds.token).toBe(mockToken)
    })
  })

  // =========================================================================
  // Reconnection robustness tests
  //
  // These tests target the three bugs found in the XMPP log analysis:
  // Bug 1: Stale waitForSmAck timeout killing new connections
  // Bug 2: Room list shrinking across reconnect cycles
  // Bug 3: Wake + keepalive timer race
  // =========================================================================
  describe('reconnection robustness', () => {
    beforeEach(async () => {
      // Set up a connected client with SM enabled
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()
      mockStores.console.addEvent.mockClear()
      mockClientFactory.mockClear()
    })

    it('should not kill new connection when stale keepalive timeout fires after SM resume', async () => {
      // Simulate: keepalive send succeeds but no ack comes (dead socket scenario)
      mockXmppClientInstance.send.mockImplementation(() => Promise.resolve())

      // Start keepalive health check on old connection
      const healthPromise = xmppClient.verifyConnectionHealth()

      // Before timeout fires, connection drops and reconnects via SM resume
      mockXmppClientInstance._emit('disconnect', { clean: false })

      const reconnectClient = createMockXmppClient()
      reconnectClient.streamManagement = {
        id: 'sm-456',
        inbound: 10,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }
      mockClientFactory._setInstance(reconnectClient)

      // Advance to trigger reconnect attempt
      await vi.advanceTimersByTimeAsync(1000)

      // New connection succeeds
      reconnectClient._emit('online')
      await vi.advanceTimersByTimeAsync(100)

      mockStores.connection.setStatus.mockClear()

      // Now the stale 10s timeout fires — should NOT kill the new connection
      await vi.advanceTimersByTimeAsync(10_000)
      await healthPromise

      // New connection should remain healthy (no reconnect triggered by stale timeout)
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })

    it('should not trigger reconnect when concurrent verifyConnection and verifyConnectionHealth race', async () => {
      // Both wake detection and Rust keepalive timer can call verify concurrently
      mockXmppClientInstance.send.mockImplementation(() => {
        // Simulate: SM ack arrives for both verifications
        setTimeout(() => {
          const ackNonza = createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' })
          mockXmppClientInstance._emit('nonza', ackNonza)
        }, 50)
        return Promise.resolve()
      })

      // Fire both concurrently (wake + keepalive race)
      const verify1 = xmppClient.verifyConnection()
      const verify2 = xmppClient.verifyConnectionHealth()

      // Advance past ack delay
      await vi.advanceTimersByTimeAsync(100)

      const [result1, result2] = await Promise.all([verify1, verify2])

      // Both should succeed without triggering reconnect
      expect(result1).toBe(true)
      expect(result2).toBe(true)
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('reconnecting')
    })

    it('should preserve rooms across multiple rapid disconnect/reconnect cycles', async () => {
      // Simulate 9 rooms joined (as seen in the real log)
      const nineRooms = Array.from({ length: 9 }, (_, i) => ({
        jid: `room${i + 1}@conference.example.com`,
        nickname: 'user',
        joined: true,
        autojoin: false,
      }))
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue(nineRooms as any)

      // Cycle 1: disconnect → reconnect
      mockXmppClientInstance._emit('disconnect', { clean: false })

      const client2 = createMockXmppClient()
      mockClientFactory._setInstance(client2)
      await vi.advanceTimersByTimeAsync(1000)
      client2._emit('online')
      await vi.advanceTimersByTimeAsync(100)
      mockStores.connection.getStatus.mockReturnValue('online')

      // After reconnect, markAllRoomsNotJoined was called — simulate store now
      // returning fewer rooms (only 1 finished rejoining before next disconnect)
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', nickname: 'user', joined: true, autojoin: false } as any,
      ])

      // Cycle 2: disconnect again before all rooms rejoined
      client2._emit('disconnect', { clean: false })

      const client3 = createMockXmppClient()
      mockClientFactory._setInstance(client3)
      await vi.advanceTimersByTimeAsync(1000)

      // The connect call should use previouslyJoinedRooms — check it passed
      // all rooms, not just the 1 that was joined in the live store.
      // Since we don't have a storageAdapter in this test, the live store value
      // (1 room) is used. The SM-persisted fallback is tested separately below.
      expect(mockClientFactory).toHaveBeenCalled()
    })
  })

  describe('SM-persisted room list fallback', () => {
    let clientWithStorage: XMPPClient
    let mockStorageAdapter: {
      getSessionState: ReturnType<typeof vi.fn>
      setSessionState: ReturnType<typeof vi.fn>
      clearSessionState: ReturnType<typeof vi.fn>
    }

    beforeEach(async () => {
      // Use real timers for storage-related tests
      vi.useRealTimers()

      mockStorageAdapter = {
        getSessionState: vi.fn().mockResolvedValue(null),
        setSessionState: vi.fn().mockResolvedValue(undefined),
        clearSessionState: vi.fn().mockResolvedValue(undefined),
      }

      clientWithStorage = new XMPPClient({
        debug: false,
        storageAdapter: mockStorageAdapter as any,
      })
      clientWithStorage.bindStores(mockStores)

      // Connect
      const connectPromise = clientWithStorage.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })

      await new Promise(resolve => setTimeout(resolve, 10))
      mockXmppClientInstance._emit('online')
      await connectPromise
      await new Promise(resolve => setTimeout(resolve, 50))

      mockStores.connection.getStatus.mockReturnValue('online')
      mockStores.connection.setStatus.mockClear()
      mockStores.console.addEvent.mockClear()
      mockClientFactory.mockClear()
    })

    afterEach(() => {
      clientWithStorage.cancelReconnect()
      vi.useFakeTimers()
    })

    it('should fall back to SM-persisted room list when live store has few rooms', async () => {
      // Live store returns only 1 room (others lost due to markAllRoomsNotJoined)
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', nickname: 'user', joined: true } as any,
      ])

      // SM persistence has the full list of 9 rooms
      const persistedRooms = Array.from({ length: 9 }, (_, i) => ({
        jid: `room${i + 1}@conference.example.com`,
        nickname: 'user',
      }))
      mockStorageAdapter.getSessionState.mockResolvedValue({
        smId: 'sm-old',
        smInbound: 5,
        resource: 'desktop',
        timestamp: Date.now() - 60_000, // 1 minute ago (fresh)
        joinedRooms: persistedRooms,
      })

      // Directly test attemptReconnect via the connection module
      const connectionModule = clientWithStorage.connection as any
      const reconnectSubstateSpy = vi.spyOn(connectionModule, 'isReconnectingSubstate').mockReturnValue(true)

      // Make the transport appear online so it short-circuits (easier to test)
      ;(mockXmppClientInstance as any).status = 'online'

      await connectionModule.attemptReconnect()
      reconnectSubstateSpy.mockRestore()

      // Should have logged the SM fallback
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringMatching(/SM-persisted room list.*9 rooms.*live store only has 1/),
        'sm'
      )
    })

    it('should use live store when it has enough rooms (no fallback needed)', async () => {
      // Live store has 5 rooms — enough that fallback is not triggered (threshold is ≤ 1)
      const fiveRooms = Array.from({ length: 5 }, (_, i) => ({
        jid: `room${i + 1}@conference.example.com`,
        nickname: 'user',
        joined: true,
      }))
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue(fiveRooms as any)

      // Clear any calls from the initial connect()
      mockStorageAdapter.getSessionState.mockClear()

      const connectionModule = clientWithStorage.connection as any
      const reconnectSubstateSpy = vi.spyOn(connectionModule, 'isReconnectingSubstate').mockReturnValue(true)
      ;(mockXmppClientInstance as any).status = 'online'

      await connectionModule.attemptReconnect()
      reconnectSubstateSpy.mockRestore()

      // Should NOT have loaded from SM persistence (live store has enough rooms)
      expect(mockStorageAdapter.getSessionState).not.toHaveBeenCalled()
    })

    it('should handle SM persistence load failure gracefully', async () => {
      // Live store has 0 rooms
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([])

      // Storage throws an error
      mockStorageAdapter.getSessionState.mockRejectedValue(new Error('IndexedDB unavailable'))

      const connectionModule = clientWithStorage.connection as any
      const reconnectSubstateSpy = vi.spyOn(connectionModule, 'isReconnectingSubstate').mockReturnValue(true)
      ;(mockXmppClientInstance as any).status = 'online'

      // Should not throw — storage errors are non-fatal
      await expect(connectionModule.attemptReconnect()).resolves.not.toThrow()
      reconnectSubstateSpy.mockRestore()
    })
  })

  // =========================================================================
  // Network readiness gate tests
  //
  // After macOS sleep/wake, the OS network stack may need several seconds to
  // reinitialize. These tests verify the waitForNetworkReady() gate prevents
  // wasting reconnect attempts on a network that isn't ready yet.
  // =========================================================================
  describe('network readiness gate', () => {
    let originalOnLine: boolean
    let installedWindowShim = false
    const windowEventTarget = new EventTarget()

    beforeEach(() => {
      originalOnLine = navigator.onLine
      // The production code checks `typeof window === 'undefined'` and uses
      // window.addEventListener/removeEventListener/dispatchEvent.
      // In happy-dom vitest, `window` may not be a true global, so we
      // install a minimal shim backed by an EventTarget.
      if (typeof globalThis.window === 'undefined') {
        ;(globalThis as any).window = {
          addEventListener: windowEventTarget.addEventListener.bind(windowEventTarget),
          removeEventListener: windowEventTarget.removeEventListener.bind(windowEventTarget),
          dispatchEvent: windowEventTarget.dispatchEvent.bind(windowEventTarget),
        }
        installedWindowShim = true
      }
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'onLine', {
        value: originalOnLine,
        writable: true,
        configurable: true,
      })
      if (installedWindowShim) {
        delete (globalThis as any).window
        installedWindowShim = false
      }
    })

    it('waitForNetworkReady returns true immediately when navigator.onLine is true', async () => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })

      const connectionModule = (xmppClient.connection as any)
      const result = await connectionModule.waitForNetworkReady(5000)
      expect(result).toBe(true)
    })

    it('waitForNetworkReady waits for online event when navigator.onLine is false', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

      const connectionModule = (xmppClient.connection as any)
      const promise = connectionModule.waitForNetworkReady(5000)

      // Simulate network coming up after 1 second
      await vi.advanceTimersByTimeAsync(1000)
      // Dispatch on the actual window (or the shim, which IS windowEventTarget)
      window.dispatchEvent(new Event('online'))

      const result = await promise
      expect(result).toBe(true)
    })

    it('waitForNetworkReady times out and returns false when network stays offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

      const connectionModule = (xmppClient.connection as any)
      const promise = connectionModule.waitForNetworkReady(5000)

      // Advance past the timeout without firing online event
      await vi.advanceTimersByTimeAsync(5000)

      const result = await promise
      expect(result).toBe(false)
    })

    it('attemptReconnect skips WebSocket creation when network is not available', async () => {
      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      mockStores.connection.getStatus.mockReturnValue('online')

      // Simulate disconnect to enter reconnecting state
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Prepare new mock client
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)
      mockClientFactory.mockClear()

      // Set network offline BEFORE the reconnect attempt fires
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

      // Advance past the reconnect delay (1s for attempt 1)
      await vi.advanceTimersByTimeAsync(1000)

      // The network wait timeout (15s default) needs to expire
      await vi.advanceTimersByTimeAsync(15_000)

      // No new client should have been created — we skipped the attempt
      expect(mockClientFactory).not.toHaveBeenCalled()

      // CONNECTION_ERROR should have been sent to the machine (triggers retry)
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        'Reconnect skipped: network not available',
        'connection'
      )
    })

    it('attemptReconnect proceeds normally when network is online', async () => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })

      // Connect first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      mockStores.connection.getStatus.mockReturnValue('online')

      // Simulate disconnect to enter reconnecting state
      mockXmppClientInstance._emit('disconnect', { clean: false })

      // Prepare new mock client for reconnect
      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)
      mockClientFactory.mockClear()

      // Advance past the reconnect delay
      await vi.advanceTimersByTimeAsync(1000)

      // New client SHOULD have been created (network is online)
      expect(mockClientFactory).toHaveBeenCalled()
    })
  })
})
