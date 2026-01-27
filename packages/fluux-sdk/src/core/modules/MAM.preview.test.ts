/**
 * MAM Preview Refresh Tests
 *
 * Tests for refreshConversationPreviews() which fetches the latest message
 * for each conversation to update sidebar previews after being offline.
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

describe('MAM Preview Refresh', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  // Helper to wait for async operations with timer advancement
  const waitForAsyncOps = async (iterations = 10, timePerIteration = 100) => {
    for (let i = 0; i < iterations; i++) {
      await vi.advanceTimersByTimeAsync(timePerIteration)
      await Promise.resolve() // Allow microtasks to run
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

  describe('refreshConversationPreviews', () => {
    it('should do nothing when there are no conversations', async () => {
      await connectClient()

      // Mock empty conversations
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([])

      await xmppClient.mam.refreshConversationPreviews()

      // Should not have logged anything about refreshing (early return)
      expect(mockStores.console.addEvent).not.toHaveBeenCalledWith(
        expect.stringContaining('Refreshing previews'),
        expect.anything()
      )
    })

    it('should send MAM query for each conversation', async () => {
      await connectClient()

      // Mock conversations
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
        { id: 'bob@example.com', messages: [] },
      ])

      // Track MAM query calls
      const mamQueryCalls: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          // Extract the 'with' field from the form
          const form = query.children?.find((c: any) => c.name === 'x')
          const withField = form?.children?.find((c: any) => c.attrs?.var === 'with')
          const withValue = withField?.children?.[0]?.children?.[0]
          if (withValue) mamQueryCalls.push(withValue)
        }
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      })

      // Start the refresh and advance timers
      const refreshPromise = xmppClient.mam.refreshConversationPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should have queried both conversations
      expect(mamQueryCalls).toContain('alice@example.com')
      expect(mamQueryCalls).toContain('bob@example.com')
    })

    it('should update lastMessage preview when message is received', async () => {
      await connectClient()

      // Mock single conversation
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
      ])

      const messageId = 'msg123'
      const archiveId = 'archive456'

      // Capture stanza handler for simulating MAM message response
      let stanzaHandler: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn((event: string, handler: Function) => {
        if (event === 'stanza') {
          stanzaHandler = handler as (stanza: any) => void
        }
        return originalOn.call(mockXmppClientInstance, event, handler)
      }) as any

      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          // Simulate receiving the MAM message stanza before returning fin
          if (stanzaHandler) {
            const mamMessage = createMockElement('message', {}, [
              {
                name: 'result',
                attrs: { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs?.queryid, id: archiveId },
                children: [
                  {
                    name: 'forwarded',
                    attrs: { xmlns: 'urn:xmpp:forward:0' },
                    children: [
                      {
                        name: 'delay',
                        attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:30:00Z' },
                      },
                      {
                        name: 'message',
                        attrs: { from: 'alice@example.com/resource', to: 'me@example.com', id: messageId, type: 'chat' },
                        children: [
                          { name: 'body', text: 'Hello from other device!' },
                        ],
                      },
                    ],
                  },
                ],
              },
            ])
            stanzaHandler(mamMessage)
          }
          return createMockElement('iq', { type: 'result' }, [
            {
              name: 'fin',
              attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
              children: [
                {
                  name: 'set',
                  attrs: { xmlns: 'http://jabber.org/protocol/rsm' },
                  children: [
                    { name: 'count', text: '1' },
                  ],
                },
              ],
            },
          ])
        }
        return createMockElement('iq', { type: 'result' }, [])
      })

      // Start the refresh and advance timers
      const refreshPromise = xmppClient.mam.refreshConversationPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should have called updateLastMessagePreview
      expect(mockStores.chat.updateLastMessagePreview).toHaveBeenCalled()
      const [conversationId, message] = mockStores.chat.updateLastMessagePreview.mock.calls[0]
      expect(conversationId).toBe('alice@example.com')
      expect(message.body).toBe('Hello from other device!')
    })

    it('should silently ignore errors for individual conversations', async () => {
      await connectClient()

      // Mock conversations
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
        { id: 'bob@example.com', messages: [] },
      ])

      let callCount = 0
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          callCount++
          if (callCount === 1) {
            // First MAM call fails
            throw new Error('Network error')
          }
        }
        // Other calls succeed
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      })

      // Start the refresh and advance timers - should not throw
      const refreshPromise = xmppClient.mam.refreshConversationPreviews()
      await waitForAsyncOps(30, 100)
      await expect(refreshPromise).resolves.not.toThrow()

      // Both conversations should have been attempted (callCount >= 2)
      expect(callCount).toBeGreaterThanOrEqual(2)
    })

    it('should log console event when starting refresh', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      )

      // Start the refresh
      const refreshPromise = xmppClient.mam.refreshConversationPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should have emitted the refresh event via SDK
      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: expect.stringContaining('Refreshing previews for 1 conversation'),
        category: 'sm',
      })
    })

    it('should respect concurrency limit', async () => {
      await connectClient()

      // Mock many conversations
      const conversations = Array.from({ length: 10 }, (_, i) => ({
        id: `user${i}@example.com`,
        messages: [],
      }))
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue(conversations)

      // Track concurrent requests
      let maxConcurrent = 0
      let currentConcurrent = 0

      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          currentConcurrent++
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent)

          // Simulate a small delay
          await new Promise(resolve => setTimeout(resolve, 10))

          currentConcurrent--
        }
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      })

      const refreshPromise = xmppClient.mam.refreshConversationPreviews({ concurrency: 3 })

      // Process all async operations with lots of timer advances
      await waitForAsyncOps(100, 100)

      await refreshPromise

      // With concurrency of 3, we should never have more than 3 concurrent MAM requests
      expect(maxConcurrent).toBeLessThanOrEqual(3)
    })
  })
})
