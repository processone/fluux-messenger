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
      // Mock single conversation
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
      ])

      const messageId = 'msg123'
      const archiveId = 'archive456'

      // Capture stanza handler for simulating MAM message response
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaHandler: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn((event: string, handler: Function) => {
        if (event === 'stanza') {
          stanzaHandler = handler as (stanza: any) => void
        }
        return originalOn.call(mockXmppClientInstance, event, handler)
      }) as any

      await connectClient()

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

  describe('refreshRoomPreviews', () => {
    it('should do nothing when there are no joined rooms', async () => {
      await connectClient()

      // Mock empty rooms
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([])

      await xmppClient.mam.refreshRoomPreviews()

      // Should not have logged anything about refreshing (early return)
      expect(emitSDKSpy).not.toHaveBeenCalledWith(
        'console:event',
        expect.objectContaining({
          message: expect.stringContaining('Refreshing previews for'),
        })
      )
    })

    it('should skip rooms without MAM support', async () => {
      await connectClient()

      // Mock rooms - one with MAM, one without
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', name: 'Room 1', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
        { jid: 'room2@conference.example.com', name: 'Room 2', supportsMAM: false, isQuickChat: false, joined: true, nickname: 'me' },
      ] as any)

      // Track MAM query targets
      const mamQueryTargets: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) {
          mamQueryTargets.push(iq.attrs.to)
        }
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      })

      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should only query the room with MAM support
      expect(mamQueryTargets).toContain('room1@conference.example.com')
      expect(mamQueryTargets).not.toContain('room2@conference.example.com')
    })

    it('should call loadPreviewFromCache for non-MAM rooms without lastMessage', async () => {
      await connectClient()

      // Mock rooms - one with MAM, one without (and no lastMessage)
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'mam-room@conference.example.com', name: 'MAM Room', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
        { jid: 'non-mam-room@conference.example.com', name: 'Non-MAM Room', supportsMAM: false, isQuickChat: false, joined: true, nickname: 'me', lastMessage: undefined },
      ] as any)

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      )

      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should call loadPreviewFromCache for the non-MAM room
      expect(mockStores.room.loadPreviewFromCache).toHaveBeenCalledWith('non-mam-room@conference.example.com')
    })

    it('should NOT call loadPreviewFromCache for non-MAM rooms that already have lastMessage', async () => {
      await connectClient()

      const existingMessage = {
        type: 'groupchat' as const,
        id: 'existing-msg',
        roomJid: 'non-mam-room@conference.example.com',
        from: 'non-mam-room@conference.example.com/alice',
        nick: 'alice',
        body: 'Existing message',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Mock room that already has lastMessage
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'non-mam-room@conference.example.com', name: 'Non-MAM Room', supportsMAM: false, isQuickChat: false, joined: true, nickname: 'me', lastMessage: existingMessage },
      ] as any)

      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should NOT call loadPreviewFromCache since room already has lastMessage
      expect(mockStores.room.loadPreviewFromCache).not.toHaveBeenCalled()
    })

    it('should skip Quick Chat rooms', async () => {
      await connectClient()

      // Mock rooms - one regular, one quick chat
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', name: 'Room 1', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
        { jid: 'quickchat@conference.example.com', name: 'Quick', supportsMAM: true, isQuickChat: true, joined: true, nickname: 'me' },
      ] as any)

      // Track MAM query targets
      const mamQueryTargets: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) {
          mamQueryTargets.push(iq.attrs.to)
        }
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      })

      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should only query the non-quick-chat room
      expect(mamQueryTargets).toContain('room1@conference.example.com')
      expect(mamQueryTargets).not.toContain('quickchat@conference.example.com')
    })

    it('should send MAM query for each eligible room', async () => {
      await connectClient()

      // Mock rooms
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', name: 'Room 1', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
        { jid: 'room2@conference.example.com', name: 'Room 2', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
      ] as any)

      // Track MAM query targets
      const mamQueryTargets: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) {
          mamQueryTargets.push(iq.attrs.to)
        }
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      })

      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should have queried both rooms
      expect(mamQueryTargets).toContain('room1@conference.example.com')
      expect(mamQueryTargets).toContain('room2@conference.example.com')
    })

    it('should update lastMessage preview when message is received', async () => {
      // Mock single room
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room@conference.example.com', name: 'Test Room', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'myNick' },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'myNick',
      } as any)

      const messageId = 'msg123'
      const archiveId = 'archive456'

      // Capture stanza handler for simulating MAM message response
      // IMPORTANT: Set up capture BEFORE connectClient() so we capture the listener
      let stanzaHandler: ((stanza: any) => void) | null = null
      const originalOn = mockXmppClientInstance.on
      mockXmppClientInstance.on = vi.fn((event: string, handler: Function) => {
        if (event === 'stanza') {
          stanzaHandler = handler as (stanza: any) => void
        }
        return originalOn.call(mockXmppClientInstance, event, handler)
      }) as any

      await connectClient()

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
                        attrs: { from: 'room@conference.example.com/sender', to: 'me@example.com', id: messageId, type: 'groupchat' },
                        children: [
                          { name: 'body', text: 'Hello from the room!' },
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
      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should have called updateLastMessagePreview
      expect(mockStores.room.updateLastMessagePreview).toHaveBeenCalled()
      const [roomJid, message] = mockStores.room.updateLastMessagePreview.mock.calls[0]
      expect(roomJid).toBe('room@conference.example.com')
      expect(message.body).toBe('Hello from the room!')
    })

    it('should not include with filter in room MAM query', async () => {
      await connectClient()

      // Mock single room
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room@conference.example.com', name: 'Test Room', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room@conference.example.com',
        nickname: 'me',
      } as any)

      // Track form fields
      let hasWithFilter = false
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          const form = query.children?.find((c: any) => c.name === 'x')
          const withField = form?.children?.find((c: any) => c.attrs?.var === 'with')
          if (withField) hasWithFilter = true
        }
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      })

      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Room MAM queries should NOT have a 'with' filter (they query the room's archive directly)
      expect(hasWithFilter).toBe(false)
    })

    it('should silently ignore errors for individual rooms', async () => {
      await connectClient()

      // Mock rooms
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', name: 'Room 1', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
        { jid: 'room2@conference.example.com', name: 'Room 2', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockImplementation((jid: string) => ({
        jid,
        nickname: 'me',
      } as any))

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
      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(30, 100)
      await expect(refreshPromise).resolves.not.toThrow()

      // Both rooms should have been attempted (callCount >= 2)
      expect(callCount).toBeGreaterThanOrEqual(2)
    })

    it('should log console event when starting refresh', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room@conference.example.com', name: 'Test', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me' },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room@conference.example.com',
        nickname: 'me',
      } as any)

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      )

      // Start the refresh
      const refreshPromise = xmppClient.mam.refreshRoomPreviews()
      await waitForAsyncOps(20, 100)
      await refreshPromise

      // Should have emitted the refresh event via SDK
      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: expect.stringContaining('Refreshing previews for 1 MAM room(s)'),
        category: 'sm',
      })
    })

    it('should respect concurrency limit', async () => {
      await connectClient()

      // Mock many rooms
      const rooms = Array.from({ length: 10 }, (_, i) => ({
        jid: `room${i}@conference.example.com`,
        name: `Room ${i}`,
        supportsMAM: true,
        isQuickChat: false,
        joined: true,
        nickname: 'me',
      }))
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue(rooms as any)

      vi.mocked(mockStores.room.getRoom).mockImplementation((jid: string) => ({
        jid,
        nickname: 'me',
      } as any))

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

      const refreshPromise = xmppClient.mam.refreshRoomPreviews({ concurrency: 3 })

      // Process all async operations with lots of timer advances
      await waitForAsyncOps(100, 100)

      await refreshPromise

      // With concurrency of 3, we should never have more than 3 concurrent MAM requests
      expect(maxConcurrent).toBeLessThanOrEqual(3)
    })
  })
})
