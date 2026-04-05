/**
 * XMPPClient MAM Tests
 *
 * Tests for XEP-0313 Message Archive Management: queryMAM, parseMAMMessage,
 * and supportsMAM feature detection.
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
import { generateStableMessageId } from '../../utils/uuid'

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

describe('XMPPClient MAM', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  // Helper to wait for async operations
  const waitForAsyncOps = async () => {
    const flushOnce = () => new Promise(resolve => process.nextTick(resolve))
    for (let i = 0; i < 5; i++) {
      await flushOnce()
      await vi.advanceTimersByTimeAsync(10)
    }
  }

  // Helper to establish a mock connection
  const connectClient = async () => {
    // Mock minimal disco responses for connect
    mockXmppClientInstance.iqCaller.request.mockResolvedValue(
      createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
          ],
        },
      ])
    )

    const connectPromise = xmppClient.connect({
      jid: 'me@example.com',
      password: 'password',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    await waitForAsyncOps()
  }

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

  describe('supportsMAM', () => {
    it('should return false when serverInfo is null', () => {
      vi.mocked(mockStores.connection.getServerInfo!).mockReturnValue(null)
      expect(xmppClient.supportsMAM()).toBe(false)
    })

    it('should return false when serverInfo has no features', () => {
      vi.mocked(mockStores.connection.getServerInfo!).mockReturnValue({
        domain: 'example.com',
        identities: [],
        features: [],
      })
      expect(xmppClient.supportsMAM()).toBe(false)
    })

    it('should return false when MAM feature is not present', () => {
      vi.mocked(mockStores.connection.getServerInfo!).mockReturnValue({
        domain: 'example.com',
        identities: [],
        features: ['http://jabber.org/protocol/disco#info', 'urn:xmpp:carbons:2'],
      })
      expect(xmppClient.supportsMAM()).toBe(false)
    })

    it('should return true when MAM feature is present', () => {
      vi.mocked(mockStores.connection.getServerInfo!).mockReturnValue({
        domain: 'example.com',
        identities: [],
        features: ['http://jabber.org/protocol/disco#info', 'urn:xmpp:mam:2', 'urn:xmpp:carbons:2'],
      })
      expect(xmppClient.supportsMAM()).toBe(true)
    })
  })

  describe('queryMAM', () => {
    it('should send correct MAM query IQ with data form filter', async () => {
      await connectClient()

      // Mock IQ response with empty result
      const mamResponse = createMockElement('iq', { type: 'result', id: 'mam_test' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'count', text: '0' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      // Execute query
      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Verify IQ was sent with correct structure
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(1)
      const iqCall = vi.mocked(mockXmppClientInstance.iqCaller.request).mock.calls[0][0]

      // Verify IQ structure
      expect(iqCall.attrs.type).toBe('set')

      // Verify result
      expect(result.messages).toEqual([])
      expect(result.complete).toBe(true)
    })

    it('should collect forwarded messages from stanza events', async () => {
      const queryId = 'mam_query_123'

      // Mock IQ response
      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'first', attrs: { index: '0' }, text: 'id1' },
                { name: 'last', text: 'id2' },
                { name: 'count', text: '2' },
              ],
            },
          ],
        },
      ])

      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') {
          stanzaListener = listener as (stanza: any) => void
        }
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on

      await connectClient()

      // Mock request to emit messages before resolving
      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        // Extract queryid from the IQ
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const actualQueryId = queryChild?.attrs?.queryid || queryId

        // Emit MAM message stanzas
        if (stanzaListener) {
          // First message
          const msg1 = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: actualQueryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'msg-1' },
                      children: [
                        { name: 'body', text: 'Hello from the past!' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'stanza-id-1', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msg1)

          // Second message
          const msg2 = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: actualQueryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'me@example.com/resource', to: 'alice@example.com', type: 'chat', id: 'msg-2' },
                      children: [
                        { name: 'body', text: 'Hi Alice!' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'stanza-id-2', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msg2)
        }

        return mamResponse
      })

      // Set own JID for outgoing detection
      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      // Execute query
      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Verify messages were collected
      expect(result.messages.length).toBe(2)
      expect(result.complete).toBe(true)

      // Verify first message (incoming)
      expect(result.messages[0].body).toBe('Hello from the past!')
      // from stores the bare JID (without resource) for consistency
      expect(result.messages[0].from).toBe('alice@example.com')
      expect(result.messages[0].isOutgoing).toBe(false)
      expect(result.messages[0].isDelayed).toBe(true)
      expect(result.messages[0].stanzaId).toBe('stanza-id-1')

      // Verify second message (outgoing)
      expect(result.messages[1].body).toBe('Hi Alice!')
      expect(result.messages[1].isOutgoing).toBe(true)
    })

    it('should set MAM loading state during query', async () => {
      await connectClient()
      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Verify loading state was set
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-loading', { conversationId: 'alice@example.com', isLoading: true })
      // Verify loading state was cleared
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-loading', { conversationId: 'alice@example.com', isLoading: false })
    })

    it('should merge messages into store on success', async () => {
      await connectClient()
      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'count', text: '0' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Verify chat:mam-messages was emitted with direction='backward' (no start filter)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', {
        conversationId: 'alice@example.com',
        messages: expect.any(Array),
        rsm: expect.any(Object),
        complete: true,
        direction: 'backward'
      })
    })

    it('should set error state on query failure', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request = vi.fn().mockRejectedValue(new Error('Network error'))

      await expect(xmppClient.chat.queryMAM({ with: 'alice@example.com' })).rejects.toThrow('Network error')

      // Verify error state was set
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-error', { conversationId: 'alice@example.com', error: 'Network error' })
      // Verify loading was cleared
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-loading', { conversationId: 'alice@example.com', isLoading: false })
    })

    it('should parse complete=false correctly', async () => {
      await connectClient()
      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'false' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result.complete).toBe(false)
    })

    it('should handle messages with reply info', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          const msgWithReply = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'reply-msg' },
                      children: [
                        { name: 'body', text: 'This is a reply' },
                        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', to: 'me@example.com', id: 'original-msg-id' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msgWithReply)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result.messages.length).toBe(1)
      expect(result.messages[0].replyTo).toEqual({
        id: 'original-msg-id',
        to: 'me@example.com',
      })
    })

    it('should handle messages with attachments (OOB)', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          const msgWithOob = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'file-msg' },
                      children: [
                        { name: 'body', text: 'https://upload.example.com/file.jpg' },
                        {
                          name: 'x',
                          attrs: { xmlns: 'jabber:x:oob' },
                          children: [
                            { name: 'url', text: 'https://upload.example.com/file.jpg' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msgWithOob)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result.messages.length).toBe(1)
      expect(result.messages[0].attachment).toBeDefined()
      expect(result.messages[0].attachment?.url).toBe('https://upload.example.com/file.jpg')
    })

    it('should handle file-only messages with OOB but no body text', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Message with ONLY OOB attachment, no body text
          const fileOnlyMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'file-only-msg' },
                      children: [
                        // NO body element - file-only transfer
                        {
                          name: 'x',
                          attrs: { xmlns: 'jabber:x:oob' },
                          children: [
                            { name: 'url', text: 'https://upload.example.com/image.png' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(fileOnlyMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should still parse the message even without body text
      expect(result.messages.length).toBe(1)
      expect(result.messages[0].id).toBe('file-only-msg')
      expect(result.messages[0].body).toBe('') // Empty body
      expect(result.messages[0].attachment).toBeDefined()
      expect(result.messages[0].attachment?.url).toBe('https://upload.example.com/image.png')
    })

    it('should apply link previews from fastening messages', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // First: the original message with a URL
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'msg-with-url' },
                      children: [
                        { name: 'body', text: 'Check out https://example.com/article' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Second: the fastening message with link preview
          const fasteningMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:01Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'fastening-msg' },
                      children: [
                        {
                          name: 'apply-to',
                          attrs: { xmlns: 'urn:xmpp:fasten:0', id: 'msg-with-url' },
                          children: [
                            {
                              name: 'external',
                              attrs: { xmlns: 'urn:xmpp:fasten:0', name: 'ogp' },
                              children: [
                                { name: 'meta', attrs: { xmlns: 'http://ogp.me/ns#', property: 'og:title', content: 'Example Article' } },
                                { name: 'meta', attrs: { xmlns: 'http://ogp.me/ns#', property: 'og:description', content: 'This is an example article' } },
                                { name: 'meta', attrs: { xmlns: 'http://ogp.me/ns#', property: 'og:url', content: 'https://example.com/article' } },
                              ],
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
          stanzaListener(fasteningMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should have only 1 message (fastening is applied, not a separate message)
      expect(result.messages.length).toBe(1)
      expect(result.messages[0].id).toBe('msg-with-url')
      expect(result.messages[0].linkPreview).toBeDefined()
      expect(result.messages[0].linkPreview?.title).toBe('Example Article')
      expect(result.messages[0].linkPreview?.description).toBe('This is an example article')
      expect(result.messages[0].linkPreview?.url).toBe('https://example.com/article')
    })

    it('should use RSM with before="" for latest messages by default', async () => {
      await connectClient()
      let capturedIq: any = null

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        capturedIq = iq
        return mamResponse
      })

      await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Verify RSM element was included
      expect(capturedIq).toBeDefined()
      const queryEl = capturedIq.children?.find((c: any) => c.name === 'query')
      expect(queryEl).toBeDefined()

      const setEl = queryEl?.children?.find((c: any) => c.name === 'set')
      expect(setEl).toBeDefined()
      expect(setEl.attrs.xmlns).toBe('http://jabber.org/protocol/rsm')

      // Verify max and before are present
      const maxEl = setEl?.children?.find((c: any) => c.name === 'max')
      expect(maxEl).toBeDefined()

      const beforeEl = setEl?.children?.find((c: any) => c.name === 'before')
      expect(beforeEl).toBeDefined()
    })

    it('should respect custom max parameter', async () => {
      await connectClient()
      let capturedIq: any = null

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        capturedIq = iq
        return mamResponse
      })

      await xmppClient.chat.queryMAM({ with: 'alice@example.com', max: 25 })

      const queryEl = capturedIq.children?.find((c: any) => c.name === 'query')
      const setEl = queryEl?.children?.find((c: any) => c.name === 'set')
      const maxEl = setEl?.children?.find((c: any) => c.name === 'max')

      // The max element should have a child with text '25'
      expect(maxEl?.children?.[0]).toBe('25')
    })

    it('should include specific before ID for pagination', async () => {
      await connectClient()
      let capturedIq: any = null

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        capturedIq = iq
        return mamResponse
      })

      // Pass a specific stanza-id to get messages before that ID
      await xmppClient.chat.queryMAM({ with: 'alice@example.com', before: 'stanza-id-12345' })

      const queryEl = capturedIq.children?.find((c: any) => c.name === 'query')
      const setEl = queryEl?.children?.find((c: any) => c.name === 'set')
      const beforeEl = setEl?.children?.find((c: any) => c.name === 'before')

      // The before element should have the stanza-id as its child
      expect(beforeEl).toBeDefined()
      expect(beforeEl?.children?.[0]).toBe('stanza-id-12345')
    })

    it('should have empty before element to get latest messages', async () => {
      await connectClient()
      let capturedIq: any = null

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        capturedIq = iq
        return mamResponse
      })

      // Default before='' should create empty <before/> for latest messages
      await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      const queryEl = capturedIq.children?.find((c: any) => c.name === 'query')
      const setEl = queryEl?.children?.find((c: any) => c.name === 'set')
      const beforeEl = setEl?.children?.find((c: any) => c.name === 'before')

      // The before element should exist but have no children (empty)
      expect(beforeEl).toBeDefined()
      expect(beforeEl?.children?.length || 0).toBe(0)
    })

    it('should skip messages without body', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Message without body (e.g., chat state notification)
          const msgNoBody = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'chat-state-msg' },
                      children: [
                        { name: 'composing', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msgNoBody)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Message without body should be skipped
      expect(result.messages.length).toBe(0)
    })

    it('should handle message retractions (XEP-0424) from MAM', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'msg-to-retract' },
                      children: [
                        { name: 'body', text: 'I will retract this message' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'stanza-id-1', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Retraction stanza (from the same sender, targeting the original message)
          const retractionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'retraction-stanza' },
                      children: [
                        { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'msg-to-retract' } },
                        { name: 'fallback', attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:message-retract:1' } },
                        { name: 'body', text: 'This person attempted to retract a previous message, but it\'s unsupported by your client.' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(retractionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message, not the retraction stanza
      expect(result.messages.length).toBe(1)

      // The original message should be marked as retracted with timestamp
      expect(result.messages[0].id).toBe('msg-to-retract')
      expect(result.messages[0].isRetracted).toBe(true)
      expect(result.messages[0].retractedAt).toBeInstanceOf(Date)
    })

    it('should handle retraction targeting stanzaId', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message with stanza-id
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'client-msg-id' },
                      children: [
                        { name: 'body', text: 'Message with stanza-id' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'server-stanza-id', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Retraction targeting the stanza-id (not the client message id)
          const retractionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'retraction-id' },
                      children: [
                        { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'server-stanza-id' } },
                        { name: 'body', text: 'Retraction fallback' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(retractionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message
      expect(result.messages.length).toBe(1)

      // The original message should be marked as retracted (matched by stanzaId)
      expect(result.messages[0].stanzaId).toBe('server-stanza-id')
      expect(result.messages[0].isRetracted).toBe(true)
    })

    it('should handle message corrections (XEP-0308) from MAM', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'msg-to-correct' },
                      children: [
                        { name: 'body', text: 'Original message with typo' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'stanza-id-1', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Correction stanza (from the same sender, targeting the original message)
          const correctionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'correction-stanza' },
                      children: [
                        { name: 'body', text: 'Corrected message without typo' },
                        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'msg-to-correct' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(correctionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message, not the correction stanza
      expect(result.messages.length).toBe(1)

      // The original message should be updated with the corrected body
      expect(result.messages[0].id).toBe('msg-to-correct')
      expect(result.messages[0].body).toBe('Corrected message without typo')
      expect(result.messages[0].isEdited).toBe(true)
    })

    it('should handle correction with XEP-0428 fallback text', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'msg-to-correct' },
                      children: [
                        { name: 'body', text: 'Original message' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Correction with XEP-0428 fallback text
          const correctionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'correction-stanza' },
                      children: [
                        // Body with fallback prefix that should be stripped
                        { name: 'body', text: '[Corrected] Actual corrected text' },
                        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'msg-to-correct' } },
                        {
                          name: 'fallback',
                          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:message-correct:0' },
                          children: [
                            // Note: xmlns is required for mock to work (xmpp.js inherits namespace automatically)
                            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '12' } }, // '[Corrected] ' is 12 chars
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(correctionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message
      expect(result.messages.length).toBe(1)

      // The message should have the corrected body with fallback stripped
      expect(result.messages[0].body).toBe('Actual corrected text')
      expect(result.messages[0].isEdited).toBe(true)
    })

    it('should handle correction targeting stanzaId', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message with stanza-id
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'client-msg-id' },
                      children: [
                        { name: 'body', text: 'Original text' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'server-stanza-id', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Correction targeting the stanza-id (not the client message id)
          const correctionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'correction-id' },
                      children: [
                        { name: 'body', text: 'Corrected text' },
                        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'server-stanza-id' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(correctionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message
      expect(result.messages.length).toBe(1)

      // The original message should be updated (matched by stanzaId)
      expect(result.messages[0].stanzaId).toBe('server-stanza-id')
      expect(result.messages[0].body).toBe('Corrected text')
      expect(result.messages[0].isEdited).toBe(true)
    })

    it('should reject correction from different sender (security check)', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message from alice
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'alice-msg' },
                      children: [
                        { name: 'body', text: 'Alice original message' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Malicious correction from eve trying to modify alice's message
          const maliciousCorrectionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'eve@example.com', type: 'chat', id: 'evil-correction' },
                      children: [
                        { name: 'body', text: 'Eve trying to modify alice message' },
                        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'alice-msg' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(maliciousCorrectionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message (malicious correction discarded)
      expect(result.messages.length).toBe(1)

      // The message should NOT be modified
      expect(result.messages[0].body).toBe('Alice original message')
      expect(result.messages[0].isEdited).toBeUndefined()
    })

    it('should handle message reactions (XEP-0444) from MAM', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'msg-to-react' },
                      children: [
                        { name: 'body', text: 'This is a great message!' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'stanza-id-1', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Reaction stanza from bob
          const reactionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com/resource', to: 'me@example.com', type: 'chat', id: 'reaction-stanza' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'msg-to-react' },
                          children: [
                            { name: 'reaction', text: '👍' },
                            { name: 'reaction', text: '❤️' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(reactionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message, not the reaction stanza
      expect(result.messages.length).toBe(1)

      // The original message should have reactions applied
      expect(result.messages[0].id).toBe('msg-to-react')
      expect(result.messages[0].reactions).toBeDefined()
      expect(result.messages[0].reactions!['👍']).toEqual(['bob@example.com'])
      expect(result.messages[0].reactions!['❤️']).toEqual(['bob@example.com'])
    })

    it('should handle reaction targeting stanzaId', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message with stanza-id
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'client-msg-id' },
                      children: [
                        { name: 'body', text: 'Message with stanza-id' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'server-stanza-id', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Reaction targeting the stanza-id (not the client message id)
          const reactionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:05:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com', type: 'chat', id: 'reaction-id' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'server-stanza-id' },
                          children: [
                            { name: 'reaction', text: '🎉' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(reactionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message
      expect(result.messages.length).toBe(1)

      // The original message should have reactions (matched by stanzaId)
      expect(result.messages[0].stanzaId).toBe('server-stanza-id')
      expect(result.messages[0].reactions).toBeDefined()
      expect(result.messages[0].reactions!['🎉']).toEqual(['bob@example.com'])
    })

    it('should handle multiple reactions from different users', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'popular-msg' },
                      children: [
                        { name: 'body', text: 'A popular message!' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // Reaction from bob
          const bobReaction = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:01:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com', type: 'chat', id: 'bob-reaction' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'popular-msg' },
                          children: [
                            { name: 'reaction', text: '👍' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(bobReaction)

          // Reaction from charlie (same emoji)
          const charlieReaction = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-3' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:02:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'charlie@example.com', type: 'chat', id: 'charlie-reaction' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'popular-msg' },
                          children: [
                            { name: 'reaction', text: '👍' },
                            { name: 'reaction', text: '❤️' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(charlieReaction)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // Should only have the original message
      expect(result.messages.length).toBe(1)

      // Both bob and charlie reacted with 👍
      expect(result.messages[0].reactions!['👍']).toContain('bob@example.com')
      expect(result.messages[0].reactions!['👍']).toContain('charlie@example.com')
      expect(result.messages[0].reactions!['👍'].length).toBe(2)

      // Only charlie reacted with ❤️
      expect(result.messages[0].reactions!['❤️']).toEqual(['charlie@example.com'])
    })

    it('should replace user reactions when they send new ones', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'msg-1' },
                      children: [
                        { name: 'body', text: 'A message' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // First reaction from bob: 👍
          const bobReaction1 = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:01:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com', type: 'chat', id: 'bob-reaction-1' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'msg-1' },
                          children: [
                            { name: 'reaction', text: '👍' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(bobReaction1)

          // Second reaction from bob: changes to ❤️ (replaces 👍)
          const bobReaction2 = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-3' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:02:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com', type: 'chat', id: 'bob-reaction-2' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'msg-1' },
                          children: [
                            { name: 'reaction', text: '❤️' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(bobReaction2)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result.messages.length).toBe(1)

      // Bob's 👍 should be replaced by ❤️
      expect(result.messages[0].reactions!['👍']).toBeUndefined()
      expect(result.messages[0].reactions!['❤️']).toEqual(['bob@example.com'])
    })

    it('should handle empty reactions (remove all reactions)', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Original message
          const originalMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com', type: 'chat', id: 'msg-1' },
                      children: [
                        { name: 'body', text: 'A message' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(originalMsg)

          // First: bob adds a reaction
          const bobReaction = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-2' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:01:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com', type: 'chat', id: 'bob-reaction-1' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'msg-1' },
                          children: [
                            { name: 'reaction', text: '👍' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(bobReaction)

          // Second: bob removes all reactions (empty reactions element)
          const bobRemove = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-id-3' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:02:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com', type: 'chat', id: 'bob-remove' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'msg-1' },
                          children: [], // Empty - removes all reactions
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(bobRemove)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result.messages.length).toBe(1)

      // Reactions should be undefined (cleaned up empty object)
      expect(result.messages[0].reactions).toBeUndefined()
    })

    it('should emit unresolved reactions as events for messages already in store', async () => {
      // Scenario: catch-up query returns a reaction targeting a message from a prior query/cache.
      // The reaction's target is NOT in the current MAM page, so it should be emitted as a
      // chat:reactions event for the store to apply to the cached message.
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Only a reaction stanza — no original message in this page
          // (the target message 'old-msg-1' is already in the store from a prior query)
          const reactionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-reaction' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T12:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com/resource', to: 'me@example.com', type: 'chat', id: 'reaction-stanza' },
                      children: [
                        {
                          name: 'reactions',
                          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'old-msg-1' },
                          children: [
                            { name: 'reaction', text: '🎉' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(reactionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // No displayable messages in this batch
      expect(result.messages.length).toBe(0)

      // The unresolved reaction should have been emitted as a chat:reactions event
      const reactionEvents = emitSDKSpy.mock.calls.filter(
        ([event]: [string, ...unknown[]]) => event === 'chat:reactions'
      )
      expect(reactionEvents.length).toBe(1)
      expect(reactionEvents[0][1]).toEqual({
        conversationId: 'alice@example.com',
        messageId: 'old-msg-1',
        reactorJid: 'bob@example.com',
        emojis: ['🎉'],
        timestamp: new Date('2024-01-15T12:00:00Z'),
      })
    })

    it('should emit unresolved corrections as events for messages already in store', async () => {
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Only a correction stanza — target message not in this page
          const correctionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-correction' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T12:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'correction-stanza' },
                      children: [
                        { name: 'body', text: 'Corrected text' },
                        {
                          name: 'replace',
                          attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'old-msg-2' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(correctionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result.messages.length).toBe(0)

      // The unresolved correction should have been emitted as a chat:message-updated event
      const updateEvents = emitSDKSpy.mock.calls.filter(
        ([event]: [string, ...unknown[]]) => event === 'chat:message-updated'
      )
      expect(updateEvents.length).toBe(1)
      expect(updateEvents[0][1]).toMatchObject({
        conversationId: 'alice@example.com',
        messageId: 'old-msg-2',
        updates: {
          body: 'Corrected text',
          isEdited: true,
        },
      })
    })

    it('should preserve originalBody from cached message when emitting unresolved corrections', async () => {
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      // Mock the store to return a cached message with the original body
      vi.mocked(mockStores.chat.getMessage).mockReturnValue({
        type: 'chat',
        id: 'old-msg-with-body',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'https://example.com/original-link',
        timestamp: new Date('2024-01-15T11:00:00Z'),
        isOutgoing: false,
      })

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Correction stanza targeting a message already in the store
          const correctionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-correction' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T12:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'correction-stanza' },
                      children: [
                        { name: 'body', text: 'Edited message without link' },
                        {
                          name: 'replace',
                          attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'old-msg-with-body' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(correctionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      // The unresolved correction should include originalBody from the cached message
      const updateEvents = emitSDKSpy.mock.calls.filter(
        ([event]: [string, ...unknown[]]) => event === 'chat:message-updated'
      )
      expect(updateEvents.length).toBe(1)
      expect(updateEvents[0][1]).toMatchObject({
        conversationId: 'alice@example.com',
        messageId: 'old-msg-with-body',
        updates: {
          body: 'Edited message without link',
          isEdited: true,
          originalBody: 'https://example.com/original-link',
        },
      })
    })

    it('should emit unresolved retractions as events for messages already in store', async () => {
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Only a retraction stanza — target message not in this page
          const retractionMsg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: 'archive-retraction' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T12:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat', id: 'retraction-stanza' },
                      children: [
                        {
                          name: 'retract',
                          attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'old-msg-3' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(retractionMsg)
        }

        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result.messages.length).toBe(0)

      // The unresolved retraction should have been emitted as a chat:message-updated event
      const updateEvents = emitSDKSpy.mock.calls.filter(
        ([event]: [string, ...unknown[]]) => event === 'chat:message-updated'
      )
      expect(updateEvents.length).toBe(1)
      expect(updateEvents[0][1]).toMatchObject({
        conversationId: 'alice@example.com',
        messageId: 'old-msg-3',
        updates: {
          isRetracted: true,
        },
      })
    })

    it('should NOT mark as complete when using start filter (forward query)', async () => {
      // Regression test: When fetching missed messages with a 'start' filter,
      // the server may return complete=true meaning "no more FUTURE messages".
      // This must NOT set isComplete=true in the store, as that would
      // incorrectly block scroll-up loading of older history.
      await connectClient()

      // Server returns complete=true for forward query (no more messages after start time)
      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'count', text: '0' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      // Query with start filter (forward direction, like fetching missed messages)
      await xmppClient.chat.queryMAM({ with: 'alice@example.com', start: '2026-01-21T19:00:00Z' })

      // Direction should be 'forward' for queries with start filter
      // The store will set isCaughtUpToLive=true but NOT isHistoryComplete
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', {
        conversationId: 'alice@example.com',
        messages: expect.any(Array),
        rsm: expect.any(Object),
        complete: true, // complete from server
        direction: 'forward' // direction - store will only set isCaughtUpToLive, not isHistoryComplete
      })
    })

    it('should mark as complete when using backward query (no start filter)', async () => {
      // Verify that backward queries (without start filter) DO mark as complete
      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'count', text: '0' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      // Query WITHOUT start filter (backward direction)
      await xmppClient.chat.queryMAM({ with: 'alice@example.com', before: '' })

      // Direction should be 'backward' for queries without start filter
      // The store will set isHistoryComplete=true
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', {
        conversationId: 'alice@example.com',
        messages: expect.any(Array),
        rsm: expect.any(Object),
        complete: true, // complete from server
        direction: 'backward' // direction - store will set isHistoryComplete
      })
    })
  })

  describe('queryRoomMAM', () => {
    const roomJid = 'room@conference.example.com'

    it('should send correct room MAM query IQ to room JID', async () => {
      await connectClient()
      let capturedIq: any = null

      // Setup room in store
      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        capturedIq = iq
        return mamResponse
      })

      await xmppClient.chat.queryRoomMAM({ roomJid })

      // Verify IQ was sent TO the room JID
      expect(capturedIq).toBeDefined()
      expect(capturedIq.attrs.to).toBe(roomJid)
      expect(capturedIq.attrs.type).toBe('set')
    })

    it('should NOT include "with" filter in room MAM query', async () => {
      await connectClient()
      let capturedIq: any = null

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        capturedIq = iq
        return mamResponse
      })

      await xmppClient.chat.queryRoomMAM({ roomJid })

      // Verify query has FORM_TYPE but NO 'with' filter
      const queryEl = capturedIq.children?.find((c: any) => c.name === 'query')
      const formEl = queryEl?.children?.find((c: any) => c.name === 'x')
      const fieldEls = formEl?.children?.filter((c: any) => c.name === 'field') || []

      // Should have FORM_TYPE field
      const formTypeField = fieldEls.find((f: any) => f.attrs?.var === 'FORM_TYPE')
      expect(formTypeField).toBeDefined()

      // Should NOT have 'with' field
      const withField = fieldEls.find((f: any) => f.attrs?.var === 'with')
      expect(withField).toBeUndefined()
    })

    it('should collect room messages and detect outgoing by nickname', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') stanzaListener = listener as (stanza: any) => void
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const queryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Message from another user
          const otherUserMsg = createMockElement('message', { from: roomJid }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: `${roomJid}/OtherUser`, type: 'groupchat', id: 'msg-1' },
                      children: [
                        { name: 'body', text: 'Hello from other user' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(otherUserMsg)

          // Message from self (by nickname)
          const selfMsg = createMockElement('message', { from: roomJid }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: queryId },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:01:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: `${roomJid}/MyNick`, type: 'groupchat', id: 'msg-2' },
                      children: [
                        { name: 'body', text: 'Hello from me' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(selfMsg)
        }

        return mamResponse
      })

      const result = await xmppClient.chat.queryRoomMAM({ roomJid })

      expect(result.messages.length).toBe(2)

      // First message is from other user - not outgoing
      expect(result.messages[0].nick).toBe('OtherUser')
      expect(result.messages[0].isOutgoing).toBe(false)
      expect(result.messages[0].roomJid).toBe(roomJid)

      // Second message is from self (MyNick) - outgoing
      expect(result.messages[1].nick).toBe('MyNick')
      expect(result.messages[1].isOutgoing).toBe(true)
    })

    it('should set room MAM loading state during query', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      await xmppClient.chat.queryRoomMAM({ roomJid })

      // Verify loading state was set and cleared
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-loading', { roomJid, isLoading: true })
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-loading', { roomJid, isLoading: false })
    })

    it('should merge room messages into store on success', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'first', text: 'first-id' },
                { name: 'last', text: 'last-id' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      await xmppClient.chat.queryRoomMAM({ roomJid })

      // Verify room:mam-messages was emitted with direction='backward' (no start filter)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-messages', {
        roomJid,
        messages: expect.any(Array),
        rsm: expect.objectContaining({ first: 'first-id', last: 'last-id' }),
        complete: true,
        direction: 'backward'
      })
    })

    it('should set error state on room MAM query failure', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      mockXmppClientInstance.iqCaller.request = vi.fn().mockRejectedValue(new Error('Room MAM not supported'))

      await expect(xmppClient.chat.queryRoomMAM({ roomJid })).rejects.toThrow('Room MAM not supported')

      // Verify error state was set
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-error', { roomJid, error: 'Room MAM not supported' })
      // Verify loading was cleared
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-loading', { roomJid, isLoading: false })
    })

    it('should use RSM before parameter for pagination', async () => {
      await connectClient()
      let capturedIq: any = null

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        capturedIq = iq
        return mamResponse
      })

      await xmppClient.chat.queryRoomMAM({ roomJid, before: 'stanza-id-12345' })

      const queryEl = capturedIq.children?.find((c: any) => c.name === 'query')
      const setEl = queryEl?.children?.find((c: any) => c.name === 'set')
      const beforeEl = setEl?.children?.find((c: any) => c.name === 'before')

      expect(beforeEl).toBeDefined()
      expect(beforeEl?.children?.[0]).toBe('stanza-id-12345')
    })

    it('should NOT mark as complete when using start filter (forward query)', async () => {
      // Regression test: When fetching missed messages with a 'start' filter,
      // the server may return complete=true meaning "no more FUTURE messages".
      // This must NOT set isComplete=true in the store, as that would
      // incorrectly block scroll-up loading of older history.
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      // Server returns complete=true for forward query (no more messages after start time)
      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'count', text: '0' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      // Query with start filter (forward direction)
      await xmppClient.chat.queryRoomMAM({ roomJid, start: '2026-01-21T19:00:00Z' })

      // Direction should be 'forward' for queries with start filter
      // The store will set isCaughtUpToLive=true but NOT isHistoryComplete
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-messages', {
        roomJid,
        messages: expect.any(Array),
        rsm: expect.any(Object),
        complete: true, // complete from server
        direction: 'forward' // direction - store will only set isCaughtUpToLive, not isHistoryComplete
      })
    })

    it('should mark as complete when using before filter (backward query)', async () => {
      // Verify backward pagination correctly marks as complete
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: roomJid,
        name: 'Test Room',
        nickname: 'MyNick',
        joined: true,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      // Server returns complete=true for backward query (reached beginning of archive)
      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'first', text: 'oldest-msg' },
                { name: 'last', text: 'newest-msg' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockResolvedValue(mamResponse)

      // Query with before filter (backward direction, for scroll-up loading)
      await xmppClient.chat.queryRoomMAM({ roomJid, before: 'some-stanza-id' })

      // Direction should be 'backward' for queries with before filter
      // The store will set isHistoryComplete=true
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-messages', {
        roomJid,
        messages: expect.any(Array),
        rsm: expect.any(Object),
        complete: true, // complete from server
        direction: 'backward' // direction - store will set isHistoryComplete
      })
    })
  })

  describe('stable message ID for messages without id attribute (issue #117)', () => {
    it('should generate stable IDs for chat MAM messages without id attribute', async () => {
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') {
          stanzaListener = listener as (stanza: any) => void
        }
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on

      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'first', attrs: { index: '0' }, text: 'archive-no-id-1' },
                { name: 'last', text: 'archive-no-id-1' },
                { name: 'count', text: '1' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const actualQueryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Message WITHOUT id attribute (like from IRC bridges via Biboumi)
          const msg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: actualQueryId, id: 'archive-no-id-1' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:00:00Z' },
                    },
                    {
                      // No 'id' attribute on this message — typical for IRC-bridged messages
                      name: 'message',
                      attrs: { from: 'alice@example.com/resource', to: 'me@example.com', type: 'chat' },
                      children: [
                        { name: 'body', text: 'Hello from IRC!' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msg)
        }
        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      // Query MAM twice — same message should get the same stable ID
      const result1 = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })
      const result2 = await xmppClient.chat.queryMAM({ with: 'alice@example.com' })

      expect(result1.messages.length).toBe(1)
      expect(result2.messages.length).toBe(1)

      // The ID should be deterministic (stable), not random
      const expectedId = generateStableMessageId(
        'alice@example.com/resource',
        '2024-01-15T10:00:00.000Z',
        'Hello from IRC!'
      )
      expect(result1.messages[0].id).toBe(expectedId)
      expect(result1.messages[0].id).toMatch(/^stable-/)

      // Same message queried again should produce the exact same ID (deduplication)
      expect(result1.messages[0].id).toBe(result2.messages[0].id)
    })

    it('should use MAM archive ID as stanzaId fallback when message has no stanza-id element', async () => {
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') {
          stanzaListener = listener as (stanza: any) => void
        }
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on

      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [
            {
              name: 'set',
              attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
              children: [
                { name: 'first', attrs: { index: '0' }, text: 'mam-archive-uuid-123' },
                { name: 'last', text: 'mam-archive-uuid-123' },
                { name: 'count', text: '1' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const actualQueryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          // Message without stanza-id element — the MAM result id should be used as stanzaId
          const msg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: actualQueryId, id: 'mam-archive-uuid-123' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T11:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'bob@example.com/resource', to: 'me@example.com', type: 'chat' },
                      children: [
                        { name: 'body', text: 'Message without stanza-id' },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msg)
        }
        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'bob@example.com' })

      expect(result.messages.length).toBe(1)
      // stanzaId should fall back to the MAM archive result id
      expect(result.messages[0].stanzaId).toBe('mam-archive-uuid-123')
    })

    it('should prefer stanza-id over MAM archive ID when both are present', async () => {
      let stanzaListener: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn().mockImplementation((event: string, listener: Function) => {
        if (event === 'stanza') {
          stanzaListener = listener as (stanza: any) => void
        }
        return originalOn.call(mockXmppClientInstance, event, listener)
      }) as typeof mockXmppClientInstance.on

      await connectClient()

      const mamResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'fin',
          attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async (iq) => {
        const queryChild = iq.children?.find((c: any) => c.name === 'query')
        const actualQueryId = queryChild?.attrs?.queryid || 'test'

        if (stanzaListener) {
          const msg = createMockElement('message', { from: 'example.com' }, [
            {
              name: 'result',
              attrs: { xmlns: 'urn:xmpp:mam:2', queryid: actualQueryId, id: 'archive-id-fallback' },
              children: [
                {
                  name: 'forwarded',
                  attrs: { xmlns: 'urn:xmpp:forward:0' },
                  children: [
                    {
                      name: 'delay',
                      attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T12:00:00Z' },
                    },
                    {
                      name: 'message',
                      attrs: { from: 'carol@example.com/resource', to: 'me@example.com', type: 'chat', id: 'msg-with-stanza-id' },
                      children: [
                        { name: 'body', text: 'Message with stanza-id' },
                        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'preferred-stanza-id', by: 'example.com' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ])
          stanzaListener(msg)
        }
        return mamResponse
      })

      vi.mocked(mockStores.connection.getJid).mockReturnValue('me@example.com/myresource')

      const result = await xmppClient.chat.queryMAM({ with: 'carol@example.com' })

      expect(result.messages.length).toBe(1)
      // stanza-id from the message element should take priority over archive id
      expect(result.messages[0].stanzaId).toBe('preferred-stanza-id')
      // message id should be the explicit one
      expect(result.messages[0].id).toBe('msg-with-stanza-id')
    })
  })
})
