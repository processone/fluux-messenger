/**
 * XMPPClient Disco Tests
 *
 * Tests for service discovery: disco#info handler, IQ handler validation,
 * and fetchServerInfo functionality.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  createIQHandlerTester,
  getDefaultIQResponse,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

let mockXmppClientInstance: MockXmppClient

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

// Import after mocking
import { client as xmppClientFactory } from '@xmpp/client'

describe('XMPPClient Disco', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('handleIQ - disco#info', () => {
    it('should register iqCallee handler for disco#info queries', async () => {
      // Don't use connectClient() here since it clears mocks
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Verify iqCallee.get was called with disco#info namespace
      expect(mockXmppClientInstance.iqCallee.get).toHaveBeenCalledWith(
        'http://jabber.org/protocol/disco#info',
        'query',
        expect.any(Function)
      )
    })

    it('should return query element with identity and features from iqCallee handler', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Call the iqCallee handler directly (simulates xmpp.js iq-callee behavior)
      const result = mockXmppClientInstance.iqCallee._call(
        'http://jabber.org/protocol/disco#info',
        'query',
        { stanza: {} },
        'get'
      )

      // Should return a query element (iqCallee wraps it in IQ result)
      expect(result).toBeDefined()
      expect(result.name).toBe('query')
      expect(result.attrs.xmlns).toBe('http://jabber.org/protocol/disco#info')

      // Should have identity
      const identity = result.children.find((c: any) => c.name === 'identity')
      expect(identity).toBeDefined()
      expect(identity.attrs.category).toBe('client')
      expect(identity.attrs.type).toBe('web')
      // In test environment (no Tauri), platform is 'web' -> 'Fluux Web'
      expect(identity.attrs.name).toBe('Fluux Web')

      // Should have features including avatar metadata notify
      const features = result.children.filter((c: any) => c.name === 'feature')
      const featureVars = features.map((f: any) => f.attrs.var)
      expect(featureVars).toContain('http://jabber.org/protocol/disco#info')
      expect(featureVars).toContain('urn:xmpp:avatar:metadata+notify')
      expect(featureVars).toContain('urn:xmpp:carbons:2')
    })

    it('should skip disco#info in stanza handler when iqCallee is available', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      vi.clearAllMocks()

      const discoQuery = createMockElement('iq', {
        type: 'get',
        id: 'disco123',
        from: 'contact@example.com/resource',
      }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
        },
      ])

      // Emit the disco#info query as a stanza
      mockXmppClientInstance._emit('stanza', discoQuery)

      // Should NOT call send directly (iqCallee handles it)
      // This verifies we're not double-processing
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should NOT send service-unavailable error for disco#info (regression test)', async () => {
      // This test simulates realistic iqCallee behavior to catch the bug
      // where missing handler registration caused service-unavailable errors
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const discoQuery = createMockElement('iq', {
        type: 'get',
        id: 'disco789',
        from: 'querier@example.com/resource',
      }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
        },
      ])

      // Simulate iqCallee processing the IQ (like real xmpp.js would)
      const sentResponses: any[] = []
      const mockSend = (stanza: any) => sentResponses.push(stanza)

      mockXmppClientInstance.iqCallee._processIQ(discoQuery, mockSend)

      // Should send exactly ONE response
      expect(sentResponses).toHaveLength(1)

      // Response should be a result, NOT an error
      const response = sentResponses[0]
      expect(response.attrs.type).toBe('result')
      expect(response.attrs.type).not.toBe('error')

      // Should NOT contain service-unavailable
      // Use toString() instead of JSON.stringify to avoid circular reference issues
      const responseStr = response.toString ? response.toString() : JSON.stringify(response)
      const hasServiceUnavailable = responseStr.includes('service-unavailable')
      expect(hasServiceUnavailable).toBe(false)

      // Should contain our features
      const query = response.children[0]
      expect(query.name).toBe('query')
    })

    it('should pass IQ handler validation using helper', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const tester = createIQHandlerTester(mockXmppClientInstance)

      // This will throw descriptive errors if any validation fails
      tester.assertHandlerValid(
        'http://jabber.org/protocol/disco#info',
        'query',
        'get'
      )
    })

    it('should NOT include node attribute in response when request has no node (XEP-0115)', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Call the iqCallee handler with a query that has NO node attribute
      const result = mockXmppClientInstance.iqCallee._call(
        'http://jabber.org/protocol/disco#info',
        'query',
        { stanza: {} },
        'get'
      )

      // Response should NOT have a node attribute
      expect(result).toBeDefined()
      expect(result.name).toBe('query')
      expect(result.attrs.node).toBeUndefined()
    })

    it('should include node attribute in response when request has node (XEP-0115 caps verification)', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const capsNode = 'https://fluux.io/desktop#ER9sxAmXPXeRwjX+S6ktVmyEV4k='

      // Call the iqCallee handler with a query that HAS a node attribute (caps verification)
      const result = mockXmppClientInstance.iqCallee._call(
        'http://jabber.org/protocol/disco#info',
        'query',
        {
          stanza: {},
          // The context includes the element with attrs
          element: { attrs: { node: capsNode } }
        },
        'get'
      )

      // Response MUST include the same node attribute for proper caching
      expect(result).toBeDefined()
      expect(result.name).toBe('query')
      expect(result.attrs.node).toBe(capsNode)
    })

    it('should echo back any node value for caps verification caching', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Test with a different caps node (from another client like Conversations)
      const conversationsNode = 'http://conversations.im#3a8mNPDpE4As3Z1IwGo6G7/9qwQ='

      const result = mockXmppClientInstance.iqCallee._call(
        'http://jabber.org/protocol/disco#info',
        'query',
        {
          stanza: {},
          element: { attrs: { node: conversationsNode } }
        },
        'get'
      )

      expect(result.attrs.node).toBe(conversationsNode)
    })
  })

  describe('IQ handler validation (all handlers)', () => {
    it('should have all IQ handlers properly registered without duplicates or errors', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const tester = createIQHandlerTester(mockXmppClientInstance)

      // Get all registered handlers
      const handlers = tester.getRegisteredHandlers()

      // Verify we have the expected handlers registered
      expect(handlers).toContainEqual({
        type: 'get',
        xmlns: 'http://jabber.org/protocol/disco#info',
        element: 'query'
      })
      expect(handlers).toContainEqual({
        type: 'set',
        xmlns: 'jabber:iq:roster',
        element: 'query'
      })

      // Validate each registered handler
      for (const handler of handlers) {
        const result = tester.testHandler(handler.xmlns, handler.element, handler.type)

        expect(result.isRegistered).toBe(true)
        expect(result.hasDuplicateResponses).toBe(false)
        expect(result.hasMixedResultAndError).toBe(false)
        // Note: roster push handler returns truthy which is valid
        expect(result.responseCount).toBeGreaterThanOrEqual(1)
      }
    })

    it('should produce exactly one response per IQ handler', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const tester = createIQHandlerTester(mockXmppClientInstance)

      // Test disco#info specifically - it had the duplicate response bug
      const discoResult = tester.testHandler(
        'http://jabber.org/protocol/disco#info',
        'query',
        'get'
      )

      expect(discoResult.responseCount).toBe(1)
      expect(discoResult.responses[0].type).toBe('result')
    })
  })

  describe('fetchServerInfo', () => {
    // Helper to wait for async operations (presence sending, fetchServerInfo, etc.)
    const waitForAsyncOps = async () => {
      const flushOnce = () => new Promise(resolve => process.nextTick(resolve))
      for (let i = 0; i < 5; i++) {
        await flushOnce()
        await vi.advanceTimersByTimeAsync(10)
      }
    }

    it('should query server disco#info and store server info', async () => {
      // Mock disco#info response
      const discoInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'server', type: 'im', name: 'ejabberd' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/disco#info' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:carbons:2' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoInfoResponse)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Verify connection:server-info was emitted with parsed data
      const serverInfoCall = emitSDKSpy.mock.calls.find(call => call[0] === 'connection:server-info')
      expect(serverInfoCall).toBeDefined()
      const serverInfo = (serverInfoCall![1] as { info: any }).info

      expect(serverInfo.domain).toBe('example.com')
      expect(serverInfo.identities).toHaveLength(1)
      expect(serverInfo.identities[0]).toEqual({
        category: 'server',
        type: 'im',
        name: 'ejabberd',
      })
      expect(serverInfo.features).toContain('http://jabber.org/protocol/disco#info')
      expect(serverInfo.features).toContain('urn:xmpp:carbons:2')
      expect(serverInfo.features).toContain('urn:xmpp:mam:2')
    })

    it('should sort features alphabetically', async () => {
      const discoInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'zzz:last' } },
            { name: 'feature', attrs: { var: 'aaa:first' } },
            { name: 'feature', attrs: { var: 'mmm:middle' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoInfoResponse)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      const serverInfoCall = emitSDKSpy.mock.calls.find(call => call[0] === 'connection:server-info')
      const serverInfo = (serverInfoCall![1] as { info: any }).info
      expect(serverInfo.features).toEqual(['aaa:first', 'mmm:middle', 'zzz:last'])
    })

    it('should handle multiple server identities', async () => {
      const discoInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'server', type: 'im', name: 'ejabberd' } },
            { name: 'identity', attrs: { category: 'pubsub', type: 'pep' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoInfoResponse)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      const serverInfoCall = emitSDKSpy.mock.calls.find(call => call[0] === 'connection:server-info')
      const serverInfo = (serverInfoCall![1] as { info: any }).info
      expect(serverInfo.identities).toHaveLength(2)
      expect(serverInfo.identities[0].category).toBe('server')
      expect(serverInfo.identities[1].category).toBe('pubsub')
    })

    it('should handle disco#info query failure gracefully', async () => {
      // Suppress expected warning logs
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})

      // Fail disco requests but allow other common IQ types (bookmarks, vcard, etc.)
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const xmlns = iq.children?.[0]?.attrs?.xmlns
        if (xmlns === 'http://jabber.org/protocol/disco#info' || xmlns === 'http://jabber.org/protocol/disco#items') {
          throw new Error('Service unavailable')
        }
        const defaultResponse = getDefaultIQResponse(iq)
        if (defaultResponse) return defaultResponse
        throw new Error('Service unavailable')
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Should not crash, and setServerInfo should not be called
      expect(mockStores.connection.setServerInfo).not.toHaveBeenCalled()
    })

    it('should log server feature count on success', async () => {
      const discoInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'feature1' } },
            { name: 'feature', attrs: { var: 'feature2' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoInfoResponse)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Check that an event was logged
      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: expect.stringContaining('2 features discovered'),
        category: 'connection'
      })
    })
  })
})
