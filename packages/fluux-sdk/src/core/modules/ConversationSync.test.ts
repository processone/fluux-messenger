/**
 * ConversationSync PEP Tests
 *
 * Tests for conversation list sync via XEP-0223 (Private PubSub Storage):
 * - fetchConversations() - retrieve active and archived conversation lists
 * - publishConversations() - store conversation list in PEP with private access
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

describe('ConversationSync', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
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

  describe('fetchConversations', () => {
    beforeEach(async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should return active and archived conversations when PEP item exists', async () => {
      const response = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:conversations:0' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'conversations',
                      attrs: { xmlns: 'urn:xmpp:fluux:conversations:0' },
                      children: [
                        { name: 'conversation', attrs: { jid: 'alice@example.com' } },
                        { name: 'conversation', attrs: { jid: 'bob@example.com', archived: 'true' } },
                        { name: 'conversation', attrs: { jid: 'carol@example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const result = await xmppClient.conversationSync.fetchConversations()

      expect(result).toEqual([
        { jid: 'alice@example.com', archived: false },
        { jid: 'bob@example.com', archived: true },
        { jid: 'carol@example.com', archived: false },
      ])
    })

    it('should return empty array when PEP node does not exist', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('item-not-found')
      )

      const result = await xmppClient.conversationSync.fetchConversations()

      expect(result).toEqual([])
    })

    it('should return empty array when item has no conversations element', async () => {
      const emptyResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:conversations:0' },
              children: [],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResponse)

      const result = await xmppClient.conversationSync.fetchConversations()

      expect(result).toEqual([])
    })

    it('should skip conversation elements missing jid attribute', async () => {
      const response = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:conversations:0' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'conversations',
                      attrs: { xmlns: 'urn:xmpp:fluux:conversations:0' },
                      children: [
                        { name: 'conversation', attrs: { jid: 'alice@example.com' } },
                        { name: 'conversation', attrs: {} },
                        { name: 'conversation', attrs: { jid: 'bob@example.com', archived: 'true' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const result = await xmppClient.conversationSync.fetchConversations()

      expect(result).toEqual([
        { jid: 'alice@example.com', archived: false },
        { jid: 'bob@example.com', archived: true },
      ])
    })

    it('should return empty array when not connected', async () => {
      await xmppClient.disconnect()

      const result = await xmppClient.conversationSync.fetchConversations()

      expect(result).toEqual([])
    })
  })

  describe('publishConversations', () => {
    beforeEach(async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should publish conversations with XEP-0223 options', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.conversationSync.publishConversations([
        { jid: 'alice@example.com', archived: false },
        { jid: 'bob@example.com', archived: true },
      ])

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // Find the set call with pubsub publish
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

      // Find publish element with correct node
      const publish = pubsub.children.find((c: any) => c.name === 'publish')
      expect(publish).toBeDefined()
      expect(publish.attrs.node).toBe('urn:xmpp:fluux:conversations:0')

      // Find publish-options element (XEP-0223)
      const publishOptions = pubsub.children.find((c: any) => c.name === 'publish-options')
      expect(publishOptions).toBeDefined()
    })

    it('should include archived attribute only for archived conversations', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.conversationSync.publishConversations([
        { jid: 'alice@example.com', archived: false },
        { jid: 'bob@example.com', archived: true },
      ])

      // Check conversation element attributes via xml() mock calls
      const convCalls = mockXmlFn.mock.calls.filter((call: any) => call[0] === 'conversation')
      expect(convCalls.length).toBe(2)

      // Active conversation: no archived attribute
      const activeAttrs = convCalls[0][1] as Record<string, string>
      expect(activeAttrs.jid).toBe('alice@example.com')
      expect(activeAttrs.archived).toBeUndefined()

      // Archived conversation: archived="true"
      const archivedAttrs = convCalls[1][1] as Record<string, string>
      expect(archivedAttrs.jid).toBe('bob@example.com')
      expect(archivedAttrs.archived).toBe('true')
    })

    it('should publish empty list', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.conversationSync.publishConversations([])

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
    })

    it('should throw when not connected', async () => {
      await xmppClient.disconnect()

      await expect(
        xmppClient.conversationSync.publishConversations([
          { jid: 'alice@example.com', archived: false },
        ])
      ).rejects.toThrow('Not connected')
    })
  })
})
