/**
 * XMPPClient Appearance Tests
 *
 * Tests for appearance settings storage via XEP-0223 (Private PubSub Storage):
 * - fetchAppearance() - retrieve mode settings from PEP (with legacy 'theme' fallback)
 * - setAppearance() - store mode settings in PEP with private access
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

describe('XMPPClient Appearance', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('fetchAppearance', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should return mode settings when PEP node exists', async () => {
      // Mock the IQ response with appearance data using new 'mode' element
      const appearanceResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:appearance:0' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'appearance',
                      attrs: { xmlns: 'urn:xmpp:fluux:appearance:0' },
                      children: [
                        { name: 'mode', text: 'light' }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(appearanceResponse)

      const result = await xmppClient.profile.fetchAppearance()

      expect(result).toEqual({ mode: 'light' })
    })

    it('should read legacy theme element for backwards compatibility', async () => {
      // Mock the IQ response with legacy 'theme' element (pre-1.0 format)
      const legacyResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:appearance:0' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'appearance',
                      attrs: { xmlns: 'urn:xmpp:fluux:appearance:0' },
                      children: [
                        { name: 'theme', text: 'dark' }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(legacyResponse)

      const result = await xmppClient.profile.fetchAppearance()

      // Should return as 'mode' even though stored as 'theme'
      expect(result).toEqual({ mode: 'dark' })
    })

    it('should return null when PEP node does not exist', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('item-not-found')
      )

      const result = await xmppClient.profile.fetchAppearance()

      expect(result).toBeNull()
    })

    it('should return null when appearance element is empty', async () => {
      const emptyResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:appearance:0' },
              children: []
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResponse)

      const result = await xmppClient.profile.fetchAppearance()

      expect(result).toBeNull()
    })

    it('should return null when not connected', async () => {
      await xmppClient.disconnect()

      const result = await xmppClient.profile.fetchAppearance()

      expect(result).toBeNull()
    })
  })

  describe('setAppearance', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should publish appearance settings with XEP-0223 options', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.setAppearance({ mode: 'dark' })

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // Find the setAppearance call (type='set' with pubsub publish)
      const calls = mockXmppClientInstance.iqCaller.request.mock.calls
      const setCall = calls.find((call: any) => {
        const arg = call[0]
        return arg.attrs?.type === 'set' &&
          arg.children?.some((c: any) => c.name === 'pubsub')
      })

      expect(setCall).toBeDefined()
      const callArg = setCall![0]
      expect(callArg.name).toBe('iq')
      expect(callArg.attrs.type).toBe('set')

      // Find pubsub element
      const pubsub = callArg.children.find((c: any) => c.name === 'pubsub')
      expect(pubsub).toBeDefined()

      // Find publish element
      const publish = pubsub.children.find((c: any) => c.name === 'publish')
      expect(publish).toBeDefined()
      expect(publish.attrs.node).toBe('urn:xmpp:fluux:appearance:0')

      // Find publish-options element (XEP-0223)
      const publishOptions = pubsub.children.find((c: any) => c.name === 'publish-options')
      expect(publishOptions).toBeDefined()
    })

    it('should throw when not connected', async () => {
      await xmppClient.disconnect()

      await expect(xmppClient.profile.setAppearance({ mode: 'light' }))
        .rejects.toThrow('Not connected')
    })

    it('should handle server errors gracefully', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('forbidden')
      )

      await expect(xmppClient.profile.setAppearance({ mode: 'system' }))
        .rejects.toThrow('forbidden')
    })
  })
})
