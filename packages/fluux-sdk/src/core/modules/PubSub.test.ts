/**
 * PubSub Module Tests
 *
 * Tests for XEP-0060 PubSub event handling.
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

describe('PubSub Module', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function connectClient() {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
  }

  describe('avatar metadata (XEP-0084)', () => {
    it('should emit avatarMetadataUpdate when receiving avatar metadata notification', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      const pubsubMessage = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
      }, [
        {
          name: 'event',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub#event' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      children: [
                        {
                          name: 'info',
                          attrs: { id: 'abc123hash' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', pubsubMessage)

      const avatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'avatarMetadataUpdate')
      expect(avatarCalls.length).toBe(1)
      expect(avatarCalls[0]).toEqual(['avatarMetadataUpdate', 'contact@example.com', 'abc123hash'])
    })

    it('should emit avatarMetadataUpdate with null when avatar is removed', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Avatar removed - item with no metadata child
      const pubsubMessage = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
      }, [
        {
          name: 'event',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub#event' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  children: [], // Empty item = avatar removed
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', pubsubMessage)

      const avatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'avatarMetadataUpdate')
      expect(avatarCalls.length).toBe(1)
      expect(avatarCalls[0]).toEqual(['avatarMetadataUpdate', 'contact@example.com', null])
    })
  })

  describe('nickname updates (XEP-0172)', () => {
    it('should update roster contact name when receiving nickname notification', async () => {
      await connectClient()

      const pubsubMessage = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
      }, [
        {
          name: 'event',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub#event' },
          children: [
            {
              name: 'items',
              attrs: { node: 'http://jabber.org/protocol/nick' },
              children: [
                {
                  name: 'item',
                  children: [
                    {
                      name: 'nick',
                      attrs: { xmlns: 'http://jabber.org/protocol/nick' },
                      text: 'New Nickname',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', pubsubMessage)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:contact-updated', { jid: 'contact@example.com', updates: { name: 'New Nickname' } })
    })
  })

  describe('bookmarks (XEP-0402 live sync)', () => {
    const bookmarkEvent = (from: string, itemsChildren: Array<Record<string, unknown>>) =>
      createMockElement('message', { from, to: 'user@example.com' }, [
        {
          name: 'event',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub#event' },
          children: [
            { name: 'items', attrs: { node: 'urn:xmpp:bookmarks:1' }, children: itemsChildren },
          ],
        },
      ])

    it('emits room:bookmark when our own account pushes a bookmark notification', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', bookmarkEvent('user@example.com', [
        {
          name: 'item',
          attrs: { id: 'room@conference.example.com' },
          children: [
            {
              name: 'conference',
              attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'My Room', autojoin: 'true' },
              children: [{ name: 'nick', text: 'mynick' }],
            },
          ],
        },
      ]))

      expect(emitSDKSpy).toHaveBeenCalledWith('room:bookmark', {
        roomJid: 'room@conference.example.com',
        bookmark: { name: 'My Room', nick: 'mynick', autojoin: true, password: undefined, notifyAll: false },
      })
    })

    it('emits room:bookmark-removed on an incoming bookmark retraction', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', bookmarkEvent('user@example.com', [
        { name: 'retract', attrs: { id: 'room@conference.example.com' } },
      ]))

      expect(emitSDKSpy).toHaveBeenCalledWith('room:bookmark-removed', { roomJid: 'room@conference.example.com' })
    })

    it('ignores a bookmark notification spoofed from another account', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', bookmarkEvent('attacker@evil.com', [
        {
          name: 'item',
          attrs: { id: 'evil@conference.example.com' },
          children: [{ name: 'conference', attrs: { xmlns: 'urn:xmpp:bookmarks:1', name: 'Evil' } }],
        },
      ]))

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:bookmark', expect.anything())
    })
  })

  describe('MDS incoming notify (XEP-0490)', () => {
    const mdsEvent = (from: string, itemsChildren: Array<Record<string, unknown>>) =>
      createMockElement('message', { from, to: 'user@example.com' }, [
        {
          name: 'event',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub#event' },
          children: [
            { name: 'items', attrs: { node: 'urn:xmpp:mds:displayed:0' }, children: itemsChildren },
          ],
        },
      ])

    it('emits read:displayed-synced for own MDS node notifications (XEP-0490 payload)', async () => {
      await connectClient()

      // Spec payload, as published by other compliant clients (Conversations,
      // Gajim, …): mds-namespaced <displayed/> wrapping a XEP-0359 stanza-id.
      mockXmppClientInstance._emit('stanza', mdsEvent('user@example.com', [
        {
          name: 'item',
          attrs: { id: 'juliet@capulet.example' },
          children: [
            {
              name: 'displayed',
              attrs: { xmlns: 'urn:xmpp:mds:displayed:0' },
              children: [
                {
                  name: 'stanza-id',
                  attrs: { xmlns: 'urn:xmpp:sid:0', id: 'stanza-99', by: 'user@example.com' },
                },
              ],
            },
          ],
        },
      ]))

      expect(emitSDKSpy).toHaveBeenCalledWith('read:displayed-synced', {
        conversationId: 'juliet@capulet.example',
        stanzaId: 'stanza-99',
      })
    })

    it('emits read:displayed-synced for legacy pre-0.18 Fluux payloads (migration read path)', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', mdsEvent('user@example.com', [
        {
          name: 'item',
          attrs: { id: 'juliet@capulet.example' },
          children: [
            {
              name: 'displayed',
              attrs: { xmlns: 'urn:xmpp:chat-markers:0', id: 'stanza-99' },
            },
          ],
        },
      ]))

      expect(emitSDKSpy).toHaveBeenCalledWith('read:displayed-synced', {
        conversationId: 'juliet@capulet.example',
        stanzaId: 'stanza-99',
      })
    })

    it('ignores MDS notifications that are not from our own bare JID', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', mdsEvent('attacker@evil.example', [
        {
          name: 'item',
          attrs: { id: 'juliet@capulet.example' },
          children: [
            {
              name: 'displayed',
              attrs: { xmlns: 'urn:xmpp:chat-markers:0', id: 'stanza-99' },
            },
          ],
        },
      ]))

      expect(emitSDKSpy).not.toHaveBeenCalledWith('read:displayed-synced', expect.anything())
    })

    it('returns true (handled) for MDS PubSub event messages', async () => {
      await connectClient()

      const result = xmppClient.pubsub.handle(mdsEvent('user@example.com', [
        {
          name: 'item',
          attrs: { id: 'juliet@capulet.example' },
          children: [
            {
              name: 'displayed',
              attrs: { xmlns: 'urn:xmpp:chat-markers:0', id: 'stanza-99' },
            },
          ],
        },
      ]))

      expect(result).toBe(true)
    })
  })

  describe('conversation list incoming notify (Fluux private PEP live sync)', () => {
    const convEvent = (from: string, convChildren: Array<Record<string, unknown>>) =>
      createMockElement('message', { from, to: 'user@example.com' }, [
        {
          name: 'event',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub#event' },
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
                      children: convChildren,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

    it('emits conversation:list-synced for own conversations node notifications', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', convEvent('user@example.com', [
        { name: 'conversation', attrs: { jid: 'alice@example.com' } },
        { name: 'conversation', attrs: { jid: 'bob@example.com', archived: 'true' } },
      ]))

      expect(emitSDKSpy).toHaveBeenCalledWith('conversation:list-synced', {
        conversations: [
          { jid: 'alice@example.com', archived: false },
          { jid: 'bob@example.com', archived: true },
        ],
      })
    })

    it('ignores conversations notifications that are not from our own bare JID', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', convEvent('attacker@evil.example', [
        { name: 'conversation', attrs: { jid: 'bob@example.com', archived: 'true' } },
      ]))

      expect(emitSDKSpy).not.toHaveBeenCalledWith('conversation:list-synced', expect.anything())
    })

    it('returns true (handled) for conversations PubSub event messages', async () => {
      await connectClient()

      const result = xmppClient.pubsub.handle(convEvent('user@example.com', [
        { name: 'conversation', attrs: { jid: 'alice@example.com' } },
      ]))

      expect(result).toBe(true)
    })

    it('applies an incoming archived conversation to the chat store live', async () => {
      await connectClient()

      mockXmppClientInstance._emit('stanza', convEvent('user@example.com', [
        { name: 'conversation', attrs: { jid: 'bob@example.com', archived: 'true' } },
      ]))

      // hasConversation() is mocked false → merge takes the "new conversation"
      // branch: add it, then archive it, matching the remote device's state.
      expect(mockStores.chat.addConversation).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bob@example.com' })
      )
      expect(mockStores.chat.archiveConversation).toHaveBeenCalledWith('bob@example.com')
    })
  })

  describe('stanza handling', () => {
    it('should return true (handled) for PubSub event messages', async () => {
      await connectClient()

      const pubsubMessage = createMockElement('message', {
        from: 'contact@example.com',
      }, [
        {
          name: 'event',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub#event' },
          children: [
            {
              name: 'items',
              attrs: { node: 'some:node' },
              children: [],
            },
          ],
        },
      ])

      const result = xmppClient.pubsub.handle(pubsubMessage)
      expect(result).toBe(true)
    })

    it('should return false for non-PubSub messages', async () => {
      await connectClient()

      const regularMessage = createMockElement('message', {
        from: 'contact@example.com',
      }, [
        { name: 'body', text: 'Hello' },
      ])

      const result = xmppClient.pubsub.handle(regularMessage)
      expect(result).toBe(false)
    })

    it('should return false for presence stanzas', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com',
      }, [])

      const result = xmppClient.pubsub.handle(presenceStanza)
      expect(result).toBe(false)
    })
  })
})
