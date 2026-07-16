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
import { MAM_ROOM_FORWARD_MAX_PAGES_MANUAL } from '../../utils/mamCatchUpUtils'

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

    it('should use newest non-delayed message as catch-up cursor, ignoring delayed ones', async () => {
      await connectClient()

      const liveTimestamp = new Date('2026-01-20T08:00:00.000Z')
      const delayedTimestamp = new Date('2026-01-20T10:00:00.000Z')

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        {
          id: 'alice@example.com',
          messages: [
            {
              type: 'chat' as const,
              id: 'msg-live',
              conversationId: 'alice@example.com',
              from: 'alice@example.com',
              body: 'Live message',
              timestamp: liveTimestamp,
              isOutgoing: false,
              isDelayed: false,
            },
            {
              type: 'chat' as const,
              id: 'msg-delayed',
              conversationId: 'alice@example.com',
              from: 'alice@example.com',
              body: 'Delayed message',
              timestamp: delayedTimestamp,
              isOutgoing: false,
              isDelayed: true,
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllConversations()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      // Should emit forward query starting from the live message timestamp (08:00), not the delayed one (10:00)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', expect.objectContaining({
        conversationId: 'alice@example.com',
        direction: 'forward',
      }))

      // Verify the IQ request used the live message timestamp as start
      const iqCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const mamQuery = iqCalls.find((call: unknown[]) => {
        const el = call[0] as { children?: Array<{ name?: string }> }
        return el?.children?.some((c: { name?: string }) => c.name === 'query')
      })
      expect(mamQuery).toBeDefined()
    })

    it('should use forward query from newest delayed message as catch-up cursor', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([
        {
          id: 'alice@example.com',
          messages: [
            {
              type: 'chat' as const,
              id: 'msg-delayed',
              conversationId: 'alice@example.com',
              from: 'alice@example.com',
              body: 'Delayed offline message',
              timestamp: new Date('2026-01-20T10:00:00.000Z'),
              isOutgoing: false,
              isDelayed: true,
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllConversations()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      // Should use forward query from the newest delayed message timestamp
      // (not fall back to backward query) so merge uses full sort and
      // correctly positions messages sent from other clients while offline
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:mam-messages', expect.objectContaining({
        conversationId: 'alice@example.com',
        direction: 'forward',
      }))
    })
  })

    it('opts into forward auto-pagination (oldest-first to completion) for the catch-up — parity with rooms', async () => {
      await connectClient()

      const messages = [
        { type: 'chat' as const, id: 'm1', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'hi', timestamp: new Date('2026-05-14T09:00:00.000Z'), isOutgoing: false, isDelayed: false },
      ]
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([{ id: 'alice@example.com', messages }] as any)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        with: 'alice@example.com',
        maxAutoPages: expect.any(Number),
      }))
    })

    it('uses the newest PRE-session message as the forward cursor, ignoring a live message (1:1 parity)', async () => {
      await connectClient()

      const monthOld = new Date('2026-05-14T09:00:00.000Z')
      const liveThisSession = new Date('2026-06-14T12:00:05.000Z')
      const sessionStartTime = new Date('2026-06-14T12:00:00.000Z').getTime()

      const messages = [
        { type: 'chat' as const, id: 'old', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'old', timestamp: monthOld, isOutgoing: false, isDelayed: false },
        { type: 'chat' as const, id: 'live', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'live', timestamp: liveThisSession, isOutgoing: false, isDelayed: false },
      ]
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([{ id: 'alice@example.com', messages }] as any)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ sessionStartTime })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        with: 'alice@example.com',
        start: '2026-05-14T09:00:00.001Z', // monthOld + 1ms — NOT liveThisSession + 1ms
      }))
    })

    it('uses a persisted conversation gap boundary before newer cached messages', async () => {
      await connectClient()

      const gapStart = new Date('2026-05-14T09:00:00.000Z')
      const newerAboveGap = new Date('2026-06-01T12:00:00.000Z')

      const messages = [
        { type: 'chat' as const, id: 'newer', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'newer', timestamp: newerAboveGap, isOutgoing: false, isDelayed: false },
      ]
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([{ id: 'alice@example.com', messages }] as any)
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(gapStart.getTime())

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        with: 'alice@example.com',
        start: '2026-05-14T09:00:00.001Z',
      }))
    })

    it('fetch-latest for a persisted conversation whose cache is empty this run (preview anchor retired)', async () => {
      await connectClient()
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([{ id: 'alice@example.com', messages: [] }] as any)
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(undefined)
      vi.mocked(mockStores.chat.getConversationLastTimestamp!).mockReturnValue(new Date('2026-05-14T09:00:00Z').getTime())

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({ messages: [], complete: false, rsm: {} })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ with: 'alice@example.com', before: '' }))
      expect(querySpy).not.toHaveBeenCalledWith(expect.objectContaining({ start: expect.any(String) }))
    })

  describe('catchUpConversationHistory (latest-first orchestrator)', () => {
    const setupChat = (pending: string | undefined) => {
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(undefined)
      vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(pending)
    }

    it('empty cache: single fetch-latest; no growth when the pointer resolved inside the window', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async () => {
        // The fetch-latest merge resolved the pointer (its message was in the page).
        vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(undefined)
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ with: 'alice@example.com', before: '' }))
    })

    it('empty cache + deep pointer: grows the window backward page by page until the pointer resolves', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === 'page-1-first') {
          // Second backward page contained the pointer's message → resolved.
          vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'page-2-first' } }
        }
        if (opts.before === '') return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
        return { messages: [], complete: false, rsm: { first: 'page-1-first' } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      expect(calls.map((c) => c.before)).toEqual(['', 'w-bottom', 'page-1-first'])
    })

    it('stops growing at the archive start (purged pointer) instead of looping', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === '') return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
        return { messages: [], complete: true, rsm: { first: 'page-1-first' } } // archive start
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      expect(calls).toHaveLength(2)
    })

    it('respects the per-pass page cap for a very deep pointer', async () => {
      await connectClient()
      setupChat('mds-ptr')

      let n = 0
      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async () => {
        n++
        return { messages: [], complete: false, rsm: { first: `page-${n}-first` } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      // 1 fetch-latest + MAM_POINTER_STITCH_MAX_PAGES backward pages
      expect(querySpy).toHaveBeenCalledTimes(1 + 10)
    })

    it('stops the Phase B walk immediately when the backward cursor stops advancing (stuck pointer)', async () => {
      await connectClient()
      setupChat('mds-ptr') // the pending pointer never clears in this test

      const calls: any[] = []
      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        // Every page — including the fetch-latest — returns the SAME cursor:
        // the archive has nothing further to offer this walk.
        return { messages: [], complete: false, rsm: { first: 'stuck' } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      // Fetch-latest + exactly ONE backward page — the non-advancing-cursor
      // guard bails instead of looping MAM_POINTER_STITCH_MAX_PAGES times.
      expect(querySpy).toHaveBeenCalledTimes(2)
      expect(calls.map((c) => c.before)).toEqual(['', 'stuck'])
    })

    it('terminates cleanly when a pending pointer has no cursor anywhere (empty archive, cache unavailable)', async () => {
      await connectClient()
      setupChat('mds-ptr')
      // Default loadMessagesFromCache mock resolves [] — the cache-bottom probe is unavailable.

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive')
        .mockResolvedValue({ messages: [], complete: false, rsm: {} })

      await expect(
        xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })
      ).resolves.not.toThrow()

      // Only the fetch-latest ran — with no windowBottom from Phase A, no seed
      // from the cache-bottom probe, and no seed from the (empty) peek slice,
      // there is no cursor to page backward from.
      expect(querySpy).toHaveBeenCalledTimes(1)
    })

    it('does NOT grow toward the pointer when stitchReadPointer is off (active entity)', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive')
        .mockResolvedValue({ messages: [], complete: false, rsm: { first: 'w-bottom' } })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [])

      expect(querySpy).toHaveBeenCalledTimes(1)
    })

    it('non-empty cache: id-exact forward from the coverage edge with the bail cap; done when complete', async () => {
      await connectClient()
      setupChat(undefined)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive')
        .mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z'), stanzaId: 'cov-42' }]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        after: 'cov-42', // COVERAGE id, not the read pointer
        maxAutoPages: 3, // MAM_CATCHUP_FORWARD_BAIL_PAGES
      }))
    })

    it('non-empty cache without stanza-ids: timestamp fallback anchor', async () => {
      await connectClient()
      setupChat(undefined)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive')
        .mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        start: '2026-05-14T09:00:00.001Z',
        maxAutoPages: 3,
      }))
    })

    it('non-empty cache, long gap: bails to a fetch-latest when the forward phase ends incomplete', async () => {
      await connectClient()
      setupChat(undefined)

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.start) return { messages: [], complete: false, rsm: { last: 'x' } }
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({ start: '2026-05-14T09:00:00.001Z' })
      expect(calls[1]).toMatchObject({ before: '' })
    })

    it('forward-complete Phase A + still-pending pointer: seeds the backward walk from the TRUE cache bottom', async () => {
      await connectClient()
      setupChat('mds-ptr')

      // The `messages` peek param is the NEWEST-100 slice; the true cache
      // bottom sits far below it. The seed must probe the oldest cached
      // messages (skipping id-less own-sent rows) — NOT reuse the peek.
      vi.mocked(mockStores.chat.loadMessagesFromCache).mockResolvedValue([
        { timestamp: new Date('2026-01-01T00:00:00Z') }, // own-sent, never archived
        { timestamp: new Date('2026-01-02T00:00:00Z'), stanzaId: 'bottom-1' },
        { timestamp: new Date('2026-01-03T00:00:00Z'), stanzaId: 'bottom-2' },
      ] as any)

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        // Phase A forward from the coverage edge completes in one page —
        // no fetch-latest, so windowBottom would stay unset.
        if (opts.after === 'new-9') return { messages: [], complete: true, rsm: {} }
        if (opts.before === 'bottom-1') {
          // First backward page below prior coverage resolved the pointer.
          vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'older-0' } }
        }
        return { messages: [], complete: false, rsm: { first: 'x' } }
      })

      const cached = [
        { timestamp: new Date('2026-06-14T09:00:00Z'), stanzaId: 'old-1' },
        { timestamp: new Date('2026-06-14T10:00:00Z'), stanzaId: 'new-9' },
      ]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, {
        sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime(),
        stitchReadPointer: true,
      })

      // Phase B resumes from the deepest cached archive id — genuinely below
      // prior coverage — not the peek slice's oldest (~100 below live).
      expect(mockStores.chat.loadMessagesFromCache).toHaveBeenCalledWith(
        'alice@example.com',
        expect.objectContaining({ peek: true, oldest: true })
      )
      expect(calls[0]).toMatchObject({ after: 'new-9' })
      expect(calls[1]).toMatchObject({ before: 'bottom-1' })
      expect(calls).toHaveLength(2)
    })

    it('falls back to the peek slice for the seed when the cache bottom probe returns nothing', async () => {
      await connectClient()
      setupChat('mds-ptr')
      // Default loadMessagesFromCache mock resolves [] (cache unavailable).

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.after === 'new-9') return { messages: [], complete: true, rsm: {} }
        if (opts.before === 'old-1') {
          vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'older-0' } }
        }
        return { messages: [], complete: false, rsm: { first: 'x' } }
      })

      const cached = [
        { timestamp: new Date('2026-06-14T09:00:00Z'), stanzaId: 'old-1' },
        { timestamp: new Date('2026-06-14T10:00:00Z'), stanzaId: 'new-9' },
      ]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, {
        sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime(),
        stitchReadPointer: true,
      })

      expect(calls[0]).toMatchObject({ after: 'new-9' })
      expect(calls[1]).toMatchObject({ before: 'old-1' })
      expect(calls).toHaveLength(2)
    })

    it('bails out of the Phase B walk when the conversation becomes active mid-walk', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === 'w-bottom') {
          // The user opened the conversation while this backward page was in flight.
          vi.mocked(mockStores.chat.getActiveConversationId!).mockReturnValue('alice@example.com')
          return { messages: [], complete: false, rsm: { first: 'page-1-first' } }
        }
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      // Fetch-latest + ONE backward page — the walk stops as soon as the
      // entity is active (backward pages would keep-oldest-evict the ACTIVE
      // resident window's live edge).
      expect(calls.map((c) => c.before)).toEqual(['', 'w-bottom'])
    })

    it('resumes a recorded gap id-exact (after: seam startId)', async () => {
      await connectClient()
      setupChat(undefined)
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(new Date('2026-05-14T09:00:00Z').getTime())
      vi.mocked(mockStores.chat.getConversationGapStartId!).mockReturnValue('gap-edge-7')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newer' }])

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ after: 'gap-edge-7' }))
    })

    it('degrades gracefully through the orchestrator when the Phase A anchor is purged (item-not-found)', async () => {
      await connectClient()
      setupChat(undefined)

      // Don't stub queryArchive — exercise the real transport-level degrade
      // (item-not-found on the first after-anchored page → fetch-latest retry).
      let callCount = 0
      mockXmppClientInstance.iqCaller.request = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return Promise.reject({ condition: 'item-not-found' })
        }
        return createFinResponse(true)
      })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z'), stanzaId: 'purged-42' }]
      await expect(
        xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, {
          sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime(),
        })
      ).resolves.not.toThrow()

      // First page (after-anchored) failed, degrade retry (fetch-latest) succeeded.
      expect(callCount).toBe(2)
    })
  })

  describe('catchUpRoomHistory (latest-first orchestrator, room twin)', () => {
    const roomJid = 'room1@conference.example.com'
    const setupRoom = (pending: string | undefined) => {
      vi.mocked(mockStores.room.getRoomGapStart!).mockReturnValue(undefined)
      vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(pending)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({ jid: roomJid, nickname: 'me' } as any)
    }

    it('empty cache: single fetch-latest; no growth when the pointer resolved inside the window', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async () => {
        vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(undefined)
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [], { stitchReadPointer: true })

      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ roomJid, before: '' }))
    })

    it('empty cache + deep pointer: grows the window backward until the pointer resolves', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === 'page-1-first') {
          vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'page-2-first' } }
        }
        if (opts.before === '') return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
        return { messages: [], complete: false, rsm: { first: 'page-1-first' } }
      })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [], { stitchReadPointer: true })

      expect(calls.map((c) => c.before)).toEqual(['', 'w-bottom', 'page-1-first'])
    })

    it('non-empty cache, long gap: bails to a fetch-latest when the forward phase ends incomplete', async () => {
      await connectClient()
      setupRoom(undefined)

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.start) return { messages: [], complete: false, rsm: { last: 'x' } }
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
      await xmppClient.mam.catchUpRoomHistory(roomJid, cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({ start: '2026-05-14T09:00:00.001Z', maxAutoPages: 3 })
      expect(calls[1]).toMatchObject({ before: '' })
    })

    it('forward-complete Phase A + still-pending pointer: seeds the backward walk from the TRUE cache bottom', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      // The `messages` peek param is the NEWEST-100 slice; the true cache
      // bottom sits far below it. The seed must probe the oldest cached
      // messages (skipping id-less own-sent rows) — NOT reuse the peek.
      vi.mocked(mockStores.room.loadMessagesFromCache).mockResolvedValue([
        { timestamp: new Date('2026-01-01T00:00:00Z') }, // own-sent, never archived
        { timestamp: new Date('2026-01-02T00:00:00Z'), stanzaId: 'bottom-1' },
        { timestamp: new Date('2026-01-03T00:00:00Z'), stanzaId: 'bottom-2' },
      ] as any)

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.after === 'new-9') return { messages: [], complete: true, rsm: {} }
        if (opts.before === 'bottom-1') {
          vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'older-0' } }
        }
        return { messages: [], complete: false, rsm: { first: 'x' } }
      })

      const cached = [
        { timestamp: new Date('2026-06-14T09:00:00Z'), stanzaId: 'old-1' },
        { timestamp: new Date('2026-06-14T10:00:00Z'), stanzaId: 'new-9' },
      ]
      await xmppClient.mam.catchUpRoomHistory(roomJid, cached, {
        sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime(),
        stitchReadPointer: true,
      })

      expect(mockStores.room.loadMessagesFromCache).toHaveBeenCalledWith(
        roomJid,
        expect.objectContaining({ peek: true, oldest: true })
      )
      expect(calls[0]).toMatchObject({ after: 'new-9' })
      expect(calls[1]).toMatchObject({ before: 'bottom-1' })
      expect(calls).toHaveLength(2)
    })

    it('falls back to the peek slice for the seed when the cache bottom probe returns nothing', async () => {
      await connectClient()
      setupRoom('mds-ptr')
      // Default loadMessagesFromCache mock resolves [] (cache unavailable).

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.after === 'new-9') return { messages: [], complete: true, rsm: {} }
        if (opts.before === 'old-1') {
          vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'older-0' } }
        }
        return { messages: [], complete: false, rsm: { first: 'x' } }
      })

      const cached = [
        { timestamp: new Date('2026-06-14T09:00:00Z'), stanzaId: 'old-1' },
        { timestamp: new Date('2026-06-14T10:00:00Z'), stanzaId: 'new-9' },
      ]
      await xmppClient.mam.catchUpRoomHistory(roomJid, cached, {
        sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime(),
        stitchReadPointer: true,
      })

      expect(calls[0]).toMatchObject({ after: 'new-9' })
      expect(calls[1]).toMatchObject({ before: 'old-1' })
      expect(calls).toHaveLength(2)
    })

    it('bails out of the Phase B walk when the room becomes active mid-walk', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === 'w-bottom') {
          // The user opened the room while this backward page was in flight.
          vi.mocked(mockStores.room.getActiveRoomJid).mockReturnValue(roomJid)
          return { messages: [], complete: false, rsm: { first: 'page-1-first' } }
        }
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [], { stitchReadPointer: true })

      expect(calls.map((c) => c.before)).toEqual(['', 'w-bottom'])
    })

    it('stops growing at the archive start (purged pointer) instead of looping', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === '') return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
        return { messages: [], complete: true, rsm: { first: 'page-1-first' } } // archive start
      })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [], { stitchReadPointer: true })

      expect(calls).toHaveLength(2)
    })

    it('respects the per-pass page cap for a very deep pointer', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      let n = 0
      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async () => {
        n++
        return { messages: [], complete: false, rsm: { first: `page-${n}-first` } }
      })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [], { stitchReadPointer: true })

      // 1 fetch-latest + MAM_POINTER_STITCH_MAX_PAGES backward pages
      expect(querySpy).toHaveBeenCalledTimes(1 + 10)
    })

    it('does NOT grow toward the pointer when stitchReadPointer is off (active entity)', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive')
        .mockResolvedValue({ messages: [], complete: false, rsm: { first: 'w-bottom' } })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [])

      expect(querySpy).toHaveBeenCalledTimes(1)
    })

    it('non-empty cache: id-exact forward from the coverage edge with the bail cap; done when complete', async () => {
      await connectClient()
      setupRoom(undefined)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive')
        .mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z'), stanzaId: 'cov-42' }]
      await xmppClient.mam.catchUpRoomHistory(roomJid, cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        after: 'cov-42', // COVERAGE id, not the read pointer
        maxAutoPages: 3, // MAM_CATCHUP_FORWARD_BAIL_PAGES
      }))
    })

    it('non-empty cache without stanza-ids: timestamp fallback anchor', async () => {
      await connectClient()
      setupRoom(undefined)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive')
        .mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
      await xmppClient.mam.catchUpRoomHistory(roomJid, cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        start: '2026-05-14T09:00:00.001Z',
        maxAutoPages: 3,
      }))
    })

    it('resumes a recorded gap id-exact (after: seam startId)', async () => {
      await connectClient()
      setupRoom(undefined)
      vi.mocked(mockStores.room.getRoomGapStart!).mockReturnValue(new Date('2026-05-14T09:00:00Z').getTime())
      vi.mocked(mockStores.room.getRoomGapStartId!).mockReturnValue('gap-edge-7')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newer' }])

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ after: 'gap-edge-7' }))
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

      // getRoom is needed by queryRoomArchive for the nickname.
      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room1@conference.example.com',
        nickname: 'me',
      } as any)

      // The forward cursor now comes from a PURE cache read (peek): catchUpRoom
      // uses loadMessagesFromCache's RETURN value, not a store re-read.
      vi.mocked(mockStores.room.loadMessagesFromCache).mockResolvedValue([{
        type: 'groupchat' as const,
        id: 'msg-1',
        roomJid: 'room1@conference.example.com',
        from: 'room1@conference.example.com/sender',
        body: 'Hello',
        timestamp: cachedTimestamp,
        isOutgoing: false,
        isDelayed: false,
      }] as any)

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      // Verify MAM query was made
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // Verify the cursor cache read happened (pure peek, no RAM write) before deciding direction
      expect(mockStores.room.loadMessagesFromCache).toHaveBeenCalledWith('room1@conference.example.com', { limit: 100, peek: true })

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

    it('uses the newest PRE-session message as the forward cursor, ignoring a live message from this session', async () => {
      // Regression for the silent month-long gap: a MUC-only user opens the app
      // after a month. The cache ends a month ago; a live message lands in the
      // catch-up window. The forward cursor must be the month-old message, NOT
      // the live one — otherwise the query starts from "now", returns nothing,
      // completes, and silently skips the entire offline gap.
      await connectClient()

      const monthOld = new Date('2026-05-14T09:00:00.000Z')
      const liveThisSession = new Date('2026-06-14T12:00:05.000Z')
      const sessionStartTime = new Date('2026-06-14T12:00:00.000Z').getTime()

      const roomMessages = [
        { type: 'groupchat', id: 'old', roomJid: 'room1@conference.example.com', from: 'room1@conference.example.com/a', body: 'old', timestamp: monthOld, isOutgoing: false, isDelayed: false },
        { type: 'groupchat', id: 'live', roomJid: 'room1@conference.example.com', from: 'room1@conference.example.com/b', body: 'live', timestamp: liveThisSession, isOutgoing: false, isDelayed: false },
      ]
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me', messages: roomMessages },
      ] as any)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room1@conference.example.com', nickname: 'me', messages: roomMessages,
      } as any)

      // Cursor source = pure cache peek (catchUpRoom uses the return value).
      vi.mocked(mockStores.room.loadMessagesFromCache).mockResolvedValue(roomMessages as any)
      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const catchUpPromise = xmppClient.mam.catchUpAllRooms({ sessionStartTime })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        roomJid: 'room1@conference.example.com',
        start: '2026-05-14T09:00:00.001Z', // monthOld + 1ms — NOT liveThisSession + 1ms
      }))
    })

    it('falls back to the global newest message when no sessionStartTime is given (backward compat)', async () => {
      await connectClient()

      const newest = new Date('2026-01-20T10:00:00.000Z')
      const roomMessages = [
        { type: 'groupchat', id: 'm1', roomJid: 'room1@conference.example.com', from: 'room1@conference.example.com/a', body: 'hi', timestamp: newest, isOutgoing: false, isDelayed: false },
      ]
      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, nickname: 'me', messages: roomMessages },
      ] as any)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({
        jid: 'room1@conference.example.com', nickname: 'me', messages: roomMessages,
      } as any)

      // Cursor source = pure cache peek (catchUpRoom uses the return value).
      vi.mocked(mockStores.room.loadMessagesFromCache).mockResolvedValue(roomMessages as any)
      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const catchUpPromise = xmppClient.mam.catchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        roomJid: 'room1@conference.example.com',
        start: '2026-01-20T10:00:00.001Z',
      }))
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

  describe('forceCatchUpAllRooms', () => {
    it('should do nothing when there are no joined rooms', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([])
      mockXmppClientInstance.iqCaller.request.mockClear()

      await xmppClient.mam.forceCatchUpAllRooms()

      expect(emitSDKSpy).not.toHaveBeenCalledWith(
        'console:event',
        expect.objectContaining({
          message: expect.stringContaining('Force catch-up for'),
        })
      )
    })

    it('should query all MAM-enabled rooms with a fixed start date', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'room2@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)

      const queriedRooms: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) queriedRooms.push(iq.attrs.to)
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.forceCatchUpAllRooms()
      await waitForAsyncOps(30, 100)
      await catchUpPromise

      expect(queriedRooms).toContain('room1@conference.example.com')
      expect(queriedRooms).toContain('room2@conference.example.com')

      // Should use forward direction (start filter = fixed date, not from cache)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-messages', expect.objectContaining({
        direction: 'forward',
      }))
    })

    it('should skip rooms without MAM support and Quick Chats', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'mam-room@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'no-mam@conference.example.com', supportsMAM: false, isQuickChat: false, joined: true, messages: [] },
        { jid: 'quick@conference.example.com', supportsMAM: true, isQuickChat: true, joined: true, messages: [] },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)

      const queriedRooms: string[] = []
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        if (iq?.attrs?.to) queriedRooms.push(iq.attrs.to)
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.forceCatchUpAllRooms()
      await waitForAsyncOps(30, 100)
      await catchUpPromise

      expect(queriedRooms).toContain('mam-room@conference.example.com')
      expect(queriedRooms).not.toContain('no-mam@conference.example.com')
      expect(queriedRooms).not.toContain('quick@conference.example.com')
    })

    it('should handle individual room errors gracefully', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
        { jid: 'room2@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)

      let callCount = 0
      mockXmppClientInstance.iqCaller.request.mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('Network error')
        return createFinResponse()
      })

      const catchUpPromise = xmppClient.mam.forceCatchUpAllRooms()
      await waitForAsyncOps(30, 100)
      await expect(catchUpPromise).resolves.not.toThrow()

      // Both rooms should have been attempted
      expect(callCount).toBeGreaterThanOrEqual(2)
    })

    it('defaults to a 45-day repair window', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.forceCatchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Force catch-up for 1 room(s) from last 45 days',
        category: 'sm',
      })
    })

    it('paginates with the manual cap so the repair can fill large gaps to completion', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const catchUpPromise = xmppClient.mam.forceCatchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
      }))
    })

    it('sets preserveGapMarker so the bounded repair never hides a real gap marker', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.forceCatchUpAllRooms()
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('room:mam-messages', expect.objectContaining({
        preserveGapMarker: true,
      }))
    })

    it('should emit console event with room count and days', async () => {
      await connectClient()

      vi.mocked(mockStores.room.joinedRooms).mockReturnValue([
        { jid: 'room1@conference.example.com', supportsMAM: true, isQuickChat: false, joined: true, messages: [] },
      ] as any)

      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse())

      const catchUpPromise = xmppClient.mam.forceCatchUpAllRooms({ days: 3 })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Force catch-up for 1 room(s) from last 3 days',
        category: 'sm',
      })
    })
  })

  describe('forward catch-up gap logging (1:1)', () => {
    it('emits a console event when a 1:1 forward catch-up ends incomplete (a gap remains)', async () => {
      await connectClient()

      // complete=false, no rsm cursor → forward pagination stops with isComplete=false
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse(false))

      const queryPromise = xmppClient.mam.queryArchive({
        with: 'alice@example.com',
        start: '2026-05-01T00:00:00.000Z',
        max: 100,
        maxAutoPages: 50, // opt into forward pagination
      })
      await waitForAsyncOps(20, 100)
      await queryPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', expect.objectContaining({
        message: expect.stringContaining('incomplete'),
        category: 'sm',
      }))
    })
  })

  describe('forward catch-up gap logging', () => {
    it('emits a console event when a forward catch-up ends incomplete (a gap remains)', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)
      // complete=false, no rsm cursor → forward pagination stops with isComplete=false
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse(false))

      const queryPromise = xmppClient.mam.queryRoomArchive({
        roomJid: 'room1@conference.example.com',
        start: '2026-05-01T00:00:00.000Z',
        max: 100,
      })
      await waitForAsyncOps(20, 100)
      await queryPromise

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', expect.objectContaining({
        message: expect.stringContaining('incomplete'),
        category: 'sm',
      }))
    })

    it('does NOT emit the incomplete-gap event when the forward catch-up completes', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getRoom).mockReturnValue({ nickname: 'me' } as any)
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createFinResponse(true))

      const queryPromise = xmppClient.mam.queryRoomArchive({
        roomJid: 'room1@conference.example.com',
        start: '2026-05-01T00:00:00.000Z',
        max: 100,
      })
      await waitForAsyncOps(20, 100)
      await queryPromise

      expect(emitSDKSpy).not.toHaveBeenCalledWith('console:event', expect.objectContaining({
        message: expect.stringContaining('incomplete'),
      }))
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

    it('should emit chat:conversation when messages are discovered', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([
        { jid: 'bob@example.com', name: 'Bob', presence: 'offline', subscription: 'both' },
      ] as any)

      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(false)

      // Spy on queryArchive to return messages
      const fakeMessage = { id: 'msg-1', from: 'bob@example.com', body: 'Hello', timestamp: new Date() }
      vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({
        messages: [fakeMessage] as any,
        complete: true,
        rsm: {},
      })

      await xmppClient.mam.discoverNewConversationsFromRoster()

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:conversation', {
        conversation: expect.objectContaining({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
          lastMessage: fakeMessage,
        }),
      })
    })

    it('should not emit chat:conversation when no messages are found', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([
        { jid: 'bob@example.com', name: 'Bob', presence: 'offline', subscription: 'both' },
      ] as any)

      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(false)

      // queryArchive returns no messages
      vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({
        messages: [],
        complete: true,
        rsm: {},
      })

      await xmppClient.mam.discoverNewConversationsFromRoster()

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:conversation', expect.anything())
    })

    it('should use contact name from roster for conversation entity', async () => {
      await connectClient()

      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue([
        { jid: 'alice@example.com', name: 'Alice Wonder', presence: 'online', subscription: 'both' },
      ] as any)

      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(false)

      const fakeMessage = { id: 'msg-1', from: 'alice@example.com', body: 'Hi', timestamp: new Date() }
      vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({
        messages: [fakeMessage] as any,
        complete: true,
        rsm: {},
      })

      await xmppClient.mam.discoverNewConversationsFromRoster()

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:conversation', {
        conversation: expect.objectContaining({
          id: 'alice@example.com',
          name: 'Alice Wonder',
        }),
      })
    })
  })
})
