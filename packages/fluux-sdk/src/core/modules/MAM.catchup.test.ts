/**
 * MAM Background Catch-Up Tests
 *
 * Tests for catchUpAllConversations(), catchUpAllRooms(), and
 * discoverNewConversationsFromRoster() which populate full message
 * history in the background after connecting.
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

describe('MAM Background Catch-Up', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  // Helper to wait for async operations with timer advancement
  const waitForAsyncOps = async (iterations = 10, timePerIteration = 100) => {
    for (let i = 0; i < iterations; i++) {
      await vi.advanceTimersByTimeAsync(timePerIteration)
      await Promise.resolve()
    }
  }

  // Helper to establish a mock connection
  const connectClient = async () => {
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

    // Mock connection status as online (needed by batch operation guards)
    vi.mocked(mockStores.connection.getStatus).mockReturnValue('online')

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

  // Helper to build a MAM fin response
  const createFinResponse = (complete = true) =>
    createMockElement('iq', { type: 'result' }, [
      { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: complete ? 'true' : 'false' }, children: [] },
    ])

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

  describe('catchUpAllConversations', () => {
    it('should do nothing when there are no conversations', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([])
      mockXmppClientInstance.iqCaller.request.mockClear()

      await xmppClient.mam.catchUpAllConversations()

      // Should not have emitted any console event
      expect(emitSDKSpy).not.toHaveBeenCalledWith(
        'console:event',
        expect.objectContaining({
          message: expect.stringContaining('Background catch-up'),
        })
      )
    })

    it('should query with forward start filter for conversations with cached messages', async () => {
      await connectClient()

      const cachedTimestamp = new Date('2026-01-20T10:00:00.000Z')
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        {
          id: 'alice@example.com',
          messages: [{
            type: 'chat' as const,
            id: 'msg-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Hello',
            timestamp: cachedTimestamp,
            isOutgoing: false,
            isDelayed: false,
          }],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllConversations()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      // Verify MAM query was made
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // The emitted mam-messages event should have direction='forward' (start filter used)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', expect.objectContaining({
        conversationId: 'alice@example.com',
        direction: 'forward',
      }))
    })

    it('should query with before="" for conversations without cached messages', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllConversations()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      // Verify MAM query was made
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // The emitted mam-messages event should have direction='backward' (no start filter = before="" query)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', expect.objectContaining({
        conversationId: 'alice@example.com',
        direction: 'backward',
      }))
    })

    it('should query multiple conversations', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
        { id: 'bob@example.com', messages: [] },
        { id: 'charlie@example.com', messages: [] },
      ])

      const queriedConversations: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          const form = query.children?.find((c: any) => c.name === 'x')
          const withField = form?.children?.find((c: any) => c.attrs?.var === 'with')
          const withValue = withField?.children?.[0]?.children?.[0]
          if (withValue) queriedConversations.push(withValue)
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations()
      await waitForAsyncOps(30, 100)
      await catchUpPromise

      expect(queriedConversations).toContain('alice@example.com')
      expect(queriedConversations).toContain('bob@example.com')
      expect(queriedConversations).toContain('charlie@example.com')
    })

    it('should respect concurrency limit', async () => {
      await connectClient()

      const conversations = Array.from({ length: 8 }, (_, i) => ({
        id: `user${i}@example.com`,
        messages: [],
      }))
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue(conversations)

      let maxConcurrent = 0
      let currentConcurrent = 0

      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          currentConcurrent++
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
          await new Promise(resolve => setTimeout(resolve, 10))
          currentConcurrent--
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ concurrency: 2 })
      await waitForAsyncOps(100, 100)
      await catchUpPromise

      // With concurrency of 2, should never exceed 2 concurrent MAM requests
      expect(maxConcurrent).toBeLessThanOrEqual(2)
    })

    it('should handle individual conversation errors gracefully', async () => {
      await connectClient()

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
            throw new Error('Network error')
          }
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations()
      await waitForAsyncOps(30, 100)
      await expect(catchUpPromise).resolves.not.toThrow()

      // Both conversations should have been attempted
      expect(callCount).toBeGreaterThanOrEqual(2)
    })

    it('should emit console event on start', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllConversations()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Background catch-up for 1 conversation(s)',
        category: 'sm',
      })
    })

    it('should skip excluded conversation', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
        { id: 'bob@example.com', messages: [] },
        { id: 'charlie@example.com', messages: [] },
      ])

      const queriedConversations: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const query = iq?.children?.[0]
        if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
          const form = query.children?.find((c: any) => c.name === 'x')
          const withField = form?.children?.find((c: any) => c.attrs?.var === 'with')
          const withValue = withField?.children?.[0]?.children?.[0]
          if (withValue) queriedConversations.push(withValue)
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ exclude: 'bob@example.com' })
      await waitForAsyncOps(30, 100)
      await catchUpPromise

      expect(queriedConversations).toContain('alice@example.com')
      expect(queriedConversations).not.toContain('bob@example.com')
      expect(queriedConversations).toContain('charlie@example.com')
    })

    it('should handle null exclude gracefully', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        { id: 'alice@example.com', messages: [] },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ exclude: null })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Background catch-up for 1 conversation(s)',
        category: 'sm',
      })
    })
  })

  describe('catchUpAllRooms', () => {
    it('should do nothing when there are no joined rooms', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([])
      mockXmppClientInstance.iqCaller.request.mockClear()

      await xmppClient.mam.catchUpAllRooms()

      expect(emitSDKSpy).not.toHaveBeenCalledWith(
        'console:event',
        expect.objectContaining({
          message: expect.stringContaining('Background catch-up for'),
        })
      )
    })

    it('should skip rooms without MAM support', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'room2@conference.example.com', supportsMAM: false, isQuickChat: false, joined: true, messages: [] },
      ] as any)

      const queriedRooms: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) {
          queriedRooms.push(iq.attrs.to)
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(queriedRooms).toContain('room1@conference.example.com')
      expect(queriedRooms).not.toContain('room2@conference.example.com')
    })

    it('should skip Quick Chat rooms', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'quickchat@conference.example.com', supportsMAM: true, isQuickChat: true, joined: true, messages: [] },
      ] as any)

      const queriedRooms: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) {
          queriedRooms.push(iq.attrs.to)
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(queriedRooms).toContain('room1@conference.example.com')
      expect(queriedRooms).not.toContain('quickchat@conference.example.com')
    })

    it('should query with forward start filter for rooms with cached messages', async () => {
      await connectClient()

      const cachedTimestamp = new Date('2026-01-20T10:00:00.000Z')
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        {
          jid: 'room1@conference.example.com',
          supportsMAM: true,
          isQuickChat: false,
          joined: true,
          nickname: 'me',
          messages: [{
            type: 'groupchat' as const,
            id: 'msg-1',
            roomJid: 'room1@conference.example.com',
            from: 'room1@conference.example.com/sender',
            body: 'Hello',
            timestamp: cachedTimestamp,
            isOutgoing: false,
            isDelayed: false,
          }],
        },
      ] as any)

      // getRoom is needed by queryRoomArchive for nickname
      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room1@conference.example.com',
        nickname: 'me',
      } as any)

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      // Verify MAM query was made
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // The emitted room:mam-messages event should have direction='forward' (start filter used)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-messages', expect.objectContaining({
        roomJid: 'room1@conference.example.com',
        direction: 'forward',
      }))
    })

    it('should query with before="" for rooms without cached messages', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me', messages: [] },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room1@conference.example.com',
        nickname: 'me',
      } as any)

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      // Verify MAM query was made
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // The emitted room:mam-messages event should have direction='backward' (no start = before="" query)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-messages', expect.objectContaining({
        roomJid: 'room1@conference.example.com',
        direction: 'backward',
      }))
    })

    it('should respect concurrency limit', async () => {
      await connectClient()

      const rooms = Array.from({ length: 8 }, (_, i) => ({
        jid: `room${i}@conference.example.com`,
        supportsMAM: true,
        isQuickChat: false,
        joined: true,
        messages: [],
      }))
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue(rooms as any)

      let maxConcurrent = 0
      let currentConcurrent = 0

      mockXmppClientInstance.iqCaller.request.mockImplementation(async () => {
        currentConcurrent++
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
        await new Promise(resolve => setTimeout(resolve, 10))
        currentConcurrent--
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllRooms({ concurrency: 2 })
      await waitForAsyncOps(100, 100)
      await catchUpPromise

      expect(maxConcurrent).toBeLessThanOrEqual(2)
    })

    it('should handle individual room errors gracefully', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'room2@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)

      let callCount = 0
      mockXmppClientInstance.iqCaller.request.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('Network error')
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(30, 100)
      await expect(catchUpPromise).resolves.not.toThrow()

      expect(callCount).toBeGreaterThanOrEqual(2)
    })

    it('should emit console event on start', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Background catch-up for 1 room(s)',
        category: 'sm',
      })
    })

    it('should skip excluded room', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'room2@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'room3@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)

      const queriedRooms: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) {
          queriedRooms.push(iq.attrs.to)
        }
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.catchUpAllRooms({ exclude: 'room2@conference.example.com' })
      await waitForAsyncOps(30, 100)
      await catchUpPromise

      expect(queriedRooms).toContain('room1@conference.example.com')
      expect(queriedRooms).not.toContain('room2@conference.example.com')
      expect(queriedRooms).toContain('room3@conference.example.com')
    })
  })

  describe('discoverNewConversationsFromRoster', () => {
    it('should do nothing when roster is empty', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([])
      mockXmppClientInstance.iqCaller.request.mockClear()

      await xmppClient.mam.discoverNewConversationsFromRoster()

      expect(emitSDKSpy).not.toHaveBeenCalledWith(
        'console:event',
        expect.objectContaining({ message: expect.stringContaining('Discovering') })
      )
    })

    it('should skip contacts that already have a conversation', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([
        { jid: 'alice@example.com', name: 'Alice', presence: 'online', subscription: 'both' },
        { jid: 'bob@example.com', name: 'Bob', presence: 'offline', subscription: 'both' },
      ] as any)

      // Both contacts already have conversations
      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(true)
      mockXmppClientInstance.iqCaller.request.mockClear()

      await xmppClient.mam.discoverNewConversationsFromRoster()

      // No MAM queries should have been made
      expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()
    })

    it('should query MAM for contacts without existing conversations', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([
        { jid: 'alice@example.com', name: 'Alice', presence: 'online', subscription: 'both' },
        { jid: 'bob@example.com', name: 'Bob', presence: 'offline', subscription: 'both' },
      ] as any)

      // Alice has a conversation, Bob doesn't
      vi.mocked(mockStores.chat.hasConversation).mockImplementation(
        (jid: string) => jid === 'alice@example.com'
      )

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const discoverPromise = xmppClient.mam.discoverNewConversationsFromRoster()
      await waitForAsyncOps(20, 100)
      await discoverPromise

      // Should have emitted a console event for 1 contact (Bob)
      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Discovering conversations for 1 roster contact(s)',
        category: 'sm',
      })

      // Should have made a MAM query (only for Bob)
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
    })

    it('should use backward query (before="") for discovery', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([
        { jid: 'bob@example.com', name: 'Bob', presence: 'offline', subscription: 'both' },
      ] as any)

      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(false)
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const discoverPromise = xmppClient.mam.discoverNewConversationsFromRoster()
      await waitForAsyncOps(20, 100)
      await discoverPromise

      // The emitted event should have direction='backward' (before="" query)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', expect.objectContaining({
        conversationId: 'bob@example.com',
        direction: 'backward',
      }))
    })

    it('should silently ignore individual errors', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([
        { jid: 'alice@example.com', name: 'Alice', presence: 'online', subscription: 'both' },
        { jid: 'bob@example.com', name: 'Bob', presence: 'offline', subscription: 'both' },
      ] as any)

      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(false)

      // First query fails, second succeeds
      mockXmppClientInstance.iqCaller.request
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValue(createFinResponse())

      // Should not throw
      const discoverPromise = xmppClient.mam.discoverNewConversationsFromRoster()
      await waitForAsyncOps(20, 100)
      await discoverPromise
    })
  })
})
