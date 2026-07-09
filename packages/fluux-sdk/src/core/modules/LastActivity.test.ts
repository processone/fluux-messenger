import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LastActivity } from './LastActivity'
import { createMockElement, createMockStores, createMockPresenceReader } from '../test-utils'
import type { Element } from '@xmpp/client'
import type { ModuleDependencies } from './BaseModule'

/** Helper to create a successful last activity IQ response */
function createLastActivityResponse(seconds: number) {
  return createMockElement('iq', { type: 'result' }, [
    {
      name: 'query',
      attrs: { xmlns: 'jabber:iq:last', seconds: String(seconds) },
    },
  ])
}

/** Helper to set up an offline contact in the mock store */
function setupOfflineContact(
  mockStores: ReturnType<typeof createMockStores>,
  jid: string,
  lastSeen?: Date,
) {
  mockStores.roster.getContact.mockReturnValue({
    jid,
    name: jid.split('@')[0],
    presence: 'offline' as const,
    subscription: 'both' as const,
    resources: new Map(),
    lastSeen,
  })
}

/** Helper to set up an online contact in the mock store */
function setupOnlineContact(
  mockStores: ReturnType<typeof createMockStores>,
  jid: string,
) {
  mockStores.roster.getContact.mockReturnValue({
    jid,
    name: jid.split('@')[0],
    presence: 'online' as const,
    subscription: 'both' as const,
    resources: new Map([['desktop', { show: null, priority: 0 }]]),
  })
}

describe('LastActivity module', () => {
  let lastActivity: LastActivity
  let mockStores: ReturnType<typeof createMockStores>
  let sendIQ: ReturnType<typeof vi.fn<ModuleDependencies['sendIQ']>>

  beforeEach(() => {
    mockStores = createMockStores()
    sendIQ = vi.fn<ModuleDependencies['sendIQ']>()

    lastActivity = new LastActivity({
      stores: mockStores,
      presence: createMockPresenceReader(),
      sendStanza: vi.fn(),
      sendIQ,
      getCurrentJid: () => 'user@example.com',
      emit: vi.fn(),
      emitSDK: vi.fn(),
      getXmpp: () => null,
    })
  })

  describe('queryLastActivity', () => {
    it('returns null for online contacts', async () => {
      setupOnlineContact(mockStores, 'alice@example.com')

      const result = await lastActivity.queryLastActivity('alice@example.com')
      expect(result).toBeNull()
      expect(sendIQ).not.toHaveBeenCalled()
    })

    it('returns null when contact is not found', async () => {
      mockStores.roster.getContact.mockReturnValue(undefined)

      const result = await lastActivity.queryLastActivity('nobody@example.com')
      expect(result).toBeNull()
    })

    it('sends IQ to bare JID and parses seconds', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createLastActivityResponse(903) as unknown as Element
      )

      const result = await lastActivity.queryLastActivity('alice@example.com')

      expect(result).not.toBeNull()
      expect(result!.supported).toBe(true)
      if (result!.supported) {
        expect(result!.seconds).toBe(903)
      }

      // Should have sent to bare JID (server answers for offline users)
      const sentIQ = sendIQ.mock.calls[0][0]
      expect(sentIQ.attrs.to).toBe('alice@example.com')
    })

    it('writes lastSeen to roster store on success', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      const beforeQuery = Date.now()
      sendIQ.mockResolvedValue(
        createLastActivityResponse(600) as unknown as Element
      )

      await lastActivity.queryLastActivity('alice@example.com')

      expect(mockStores.roster.updateContact).toHaveBeenCalledWith(
        'alice@example.com',
        expect.objectContaining({ lastSeen: expect.any(Date) })
      )

      const lastSeen = mockStores.roster.updateContact.mock.calls[0][1].lastSeen as Date
      // lastSeen should be approximately 600 seconds ago
      const diff = beforeQuery - lastSeen.getTime()
      expect(diff).toBeGreaterThanOrEqual(599000)
      expect(diff).toBeLessThanOrEqual(601000)
    })

    it('returns cached result on second call', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createLastActivityResponse(120) as unknown as Element
      )

      const first = await lastActivity.queryLastActivity('alice@example.com')
      const second = await lastActivity.queryLastActivity('alice@example.com')

      expect(first).toEqual(second)
      expect(sendIQ).toHaveBeenCalledTimes(1)
    })

    it('avoids duplicate in-flight queries for same JID', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      let resolveIQ: (value: any) => void
      sendIQ.mockReturnValue(new Promise((resolve) => { resolveIQ = resolve }))

      const promise1 = lastActivity.queryLastActivity('alice@example.com')
      const promise2 = lastActivity.queryLastActivity('alice@example.com')

      // Second call returns null (in-flight guard)
      expect(await promise2).toBeNull()

      resolveIQ!(createLastActivityResponse(300))

      const result1 = await promise1
      expect(result1!.supported).toBe(true)
      if (result1!.supported) {
        expect(result1!.seconds).toBe(300)
      }
      expect(sendIQ).toHaveBeenCalledTimes(1)
    })
  })

  describe('negative caching', () => {
    it('caches failure when sendIQ throws', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockRejectedValue(new Error('feature-not-implemented'))

      const result = await lastActivity.queryLastActivity('alice@example.com')
      expect(result).not.toBeNull()
      expect(result!.supported).toBe(false)

      // Second call should return negative cache without sending IQ
      sendIQ.mockClear()
      const second = await lastActivity.queryLastActivity('alice@example.com')
      expect(second!.supported).toBe(false)
      expect(sendIQ).not.toHaveBeenCalled()
    })

    it('caches failure when response has no query element', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createMockElement('iq', { type: 'result' }) as unknown as Element
      )

      const result = await lastActivity.queryLastActivity('alice@example.com')
      expect(result!.supported).toBe(false)

      // Cached — no re-query
      sendIQ.mockClear()
      const second = await lastActivity.queryLastActivity('alice@example.com')
      expect(second!.supported).toBe(false)
      expect(sendIQ).not.toHaveBeenCalled()
    })

    it('caches failure when seconds attribute is missing', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          { name: 'query', attrs: { xmlns: 'jabber:iq:last' } },
        ]) as unknown as Element
      )

      const result = await lastActivity.queryLastActivity('alice@example.com')
      expect(result!.supported).toBe(false)
    })

    it('caches failure when seconds attribute is not a number', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          { name: 'query', attrs: { xmlns: 'jabber:iq:last', seconds: 'abc' } },
        ]) as unknown as Element
      )

      const result = await lastActivity.queryLastActivity('alice@example.com')
      expect(result!.supported).toBe(false)
    })
  })

  describe('handle (cache invalidation on presence)', () => {
    it('invalidates cache when available presence stanza received', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createLastActivityResponse(600) as unknown as Element
      )

      await lastActivity.queryLastActivity('alice@example.com')
      expect(lastActivity.getCached('alice@example.com')).not.toBeNull()

      // Simulate contact coming back online
      const presenceStanza = createMockElement('presence', {
        from: 'alice@example.com/desktop',
      })
      lastActivity.handle(presenceStanza as unknown as Element)

      expect(lastActivity.getCached('alice@example.com')).toBeNull()
    })

    it('returns false (never consumes stanza)', () => {
      const stanza = createMockElement('presence', {
        from: 'alice@example.com/desktop',
      })
      expect(lastActivity.handle(stanza as unknown as Element)).toBe(false)
    })

    it('does not invalidate on unavailable presence', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createLastActivityResponse(600) as unknown as Element
      )

      await lastActivity.queryLastActivity('alice@example.com')

      // type='unavailable' means going offline — cache should stay
      const presenceStanza = createMockElement('presence', {
        from: 'alice@example.com/desktop',
        type: 'unavailable',
      })
      lastActivity.handle(presenceStanza as unknown as Element)

      expect(lastActivity.getCached('alice@example.com')).not.toBeNull()
    })

    it('ignores non-presence stanzas', () => {
      const stanza = createMockElement('message', {
        from: 'alice@example.com/desktop',
      })
      expect(lastActivity.handle(stanza as unknown as Element)).toBe(false)
    })
  })

  describe('invalidate', () => {
    it('clears cache for a specific JID', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createLastActivityResponse(120) as unknown as Element
      )

      await lastActivity.queryLastActivity('alice@example.com')
      expect(lastActivity.getCached('alice@example.com')).not.toBeNull()

      lastActivity.invalidate('alice@example.com')
      expect(lastActivity.getCached('alice@example.com')).toBeNull()
    })

    it('does not affect other JIDs', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')
      sendIQ.mockResolvedValue(
        createLastActivityResponse(120) as unknown as Element
      )
      await lastActivity.queryLastActivity('alice@example.com')

      setupOfflineContact(mockStores, 'bob@example.com')
      sendIQ.mockResolvedValue(
        createLastActivityResponse(300) as unknown as Element
      )
      await lastActivity.queryLastActivity('bob@example.com')

      lastActivity.invalidate('alice@example.com')
      expect(lastActivity.getCached('alice@example.com')).toBeNull()
      expect(lastActivity.getCached('bob@example.com')).not.toBeNull()
    })
  })

  describe('clearCache', () => {
    it('clears all cached results including negative cache', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockRejectedValue(new Error('feature-not-implemented'))
      await lastActivity.queryLastActivity('alice@example.com')
      expect(lastActivity.getCached('alice@example.com')).not.toBeNull()

      lastActivity.clearCache()
      expect(lastActivity.getCached('alice@example.com')).toBeNull()
    })
  })

  describe('getCached', () => {
    it('returns null when no cached data', () => {
      expect(lastActivity.getCached('alice@example.com')).toBeNull()
    })
  })
})
