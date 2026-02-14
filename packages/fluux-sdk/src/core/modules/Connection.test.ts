/**
 * XMPPClient Connection Tests
 *
 * Tests for connection, disconnection, reconnection, and related features.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
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

// Mock websocketDiscovery to prevent real network calls
vi.mock('../../utils/websocketDiscovery', () => ({
  discoverWebSocket: mockDiscoverWebSocket,
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

      expect(mockClientFactory).toHaveBeenCalledWith({
        service: 'wss://example.com/ws',
        domain: 'example.com',
        username: 'user',
        password: 'secret',
      })
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
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(1, 1) // attempt 1, 1 second
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

    it('should show firewall hint when proxy mode connection fails with code 1006', async () => {
      // Create a client with proxy adapter (simulating Tauri desktop mode)
      const mockProxyAdapter = {
        startProxy: vi.fn().mockResolvedValue({
          url: 'ws://127.0.0.1:12345',
          connectionMethod: 'starttls',
          resolvedEndpoint: 'tcp://xmpp.example.com:5222',
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
          server: 'example.com',
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

    it('should NOT auto-reconnect on fresh connect() after a previous successful session', async () => {
      // Scenario: User had a successful session, reconnect exhausted max retries,
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

      // Step 2: Start a fresh connect() that will fail
      // This simulates the user clicking Connect again after an error screen
      mockXmppClientInstance.start.mockRejectedValue(new Error('Connection refused'))

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
      mockXmppClientInstance._emit('disconnect', { clean: false })

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

    it('should handle disconnect when already disconnected', async () => {
      // Disconnect without connecting first - should not throw
      await expect(xmppClient.disconnect()).resolves.not.toThrow()
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('disconnected')
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
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(1, 1) // 1s delay

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
      expect(mockStores.connection.setReconnectState).toHaveBeenCalledWith(2, 2)
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

      // Should have requested roster via send() (roster response handled by stanza routing)
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const rosterCall = sendCalls.find((call: any[]) => {
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
      expect(smState).toEqual({
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
      expect(smState1).toEqual({
        id: 'sm-session-456',
        inbound: 10,
      })

      // Simulate socket death - SM becomes unavailable
      mockXmppClientInstance.streamManagement = null as any

      // Should return cached state
      const smState2 = xmppClient.getStreamManagementState()
      expect(smState2).toEqual({
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

      // Should have set status to verifying
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('verifying')
      // Should have logged the verification
      expect(mockStores.console.addEvent).toHaveBeenCalledWith(
        expect.stringContaining('awake'),
        'connection'
      )
    })

    it('should NOT verify connection on "visible" state when online', async () => {
      await xmppClient.notifySystemState('visible')

      // Should NOT set status to verifying
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('verifying')
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
      expect(mockStores.connection.setStatus).not.toHaveBeenCalledWith('verifying')
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

      // Should verify (status set to verifying)
      expect(mockStores.connection.setStatus).toHaveBeenCalledWith('verifying')
    })
  })
})
