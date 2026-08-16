/**
 * XMPPClient Ping Tests
 *
 * Tests for XEP-0199 XMPP Ping response handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient, bindStoresForTesting } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
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

describe('XMPPClient Ping', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('iqCallee - ping (XEP-0199)', () => {
    it('should register iqCallee handler for ping queries', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Verify iqCallee.get was called with ping namespace
      expect(mockXmppClientInstance.iqCallee.get).toHaveBeenCalledWith(
        'urn:xmpp:ping',
        'ping',
        expect.any(Function)
      )
    })

    it('should return truthy from iqCallee handler (sends empty result)', async () => {
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
        'urn:xmpp:ping',
        'ping',
        { stanza: {} },
        'get'
      )

      // Should return truthy to indicate it was handled (iqCallee sends empty result)
      expect(result).toBeTruthy()
    })

    it('should skip ping in stanza handler when iqCallee is available', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      vi.clearAllMocks()

      const pingRequest = createMockElement('iq', {
        type: 'get',
        id: 'ping123',
        from: 'example.com',
      }, [
        {
          name: 'ping',
          attrs: { xmlns: 'urn:xmpp:ping' },
        },
      ])

      // Emit the ping query as a stanza
      mockXmppClientInstance._emit('stanza', pingRequest)

      // Should NOT call send directly (iqCallee handles it)
      // This verifies we're not double-processing
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should NOT send duplicate responses for ping (regression test)', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const pingRequest = createMockElement('iq', {
        type: 'get',
        id: 'ping789',
        from: 'process-one.net',
      }, [
        {
          name: 'ping',
          attrs: { xmlns: 'urn:xmpp:ping' },
        },
      ])

      // Simulate iqCallee processing the IQ (like real xmpp.js would)
      const sentResponses: any[] = []
      const mockSend = (stanza: any) => sentResponses.push(stanza)

      mockXmppClientInstance.iqCallee._processIQ(pingRequest, mockSend)

      // Should send exactly ONE response
      expect(sentResponses).toHaveLength(1)

      // Response should be a result
      const response = sentResponses[0]
      expect(response.attrs.type).toBe('result')
      expect(response.attrs.id).toBe('ping789')
    })

    it('should not respond to ping IQ result (only to get)', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      vi.clearAllMocks()

      // Create a ping IQ result (response to our own ping)
      const pingResult = createMockElement('iq', {
        type: 'result',
        id: 'ping123',
        from: 'example.com',
      }, [
        {
          name: 'ping',
          attrs: { xmlns: 'urn:xmpp:ping' },
        },
      ])

      mockXmppClientInstance._emit('stanza', pingResult)

      // Should not send any response
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })
  })

  describe('CLIENT_FEATURES', () => {
    it('should advertise ping support in disco#info', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Get the disco#info response
      const result = mockXmppClientInstance.iqCallee._call(
        'http://jabber.org/protocol/disco#info',
        'query',
        { stanza: {} },
        'get'
      )

      // Should include ping namespace in features
      const features = result.children.filter((c: any) => c.name === 'feature')
      const featureVars = features.map((f: any) => f.attrs.var)
      expect(featureVars).toContain('urn:xmpp:ping')
    })
  })
})
