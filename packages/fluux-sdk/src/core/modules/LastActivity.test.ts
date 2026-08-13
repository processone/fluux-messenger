import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LastActivity } from './LastActivity'
import { Roster } from './Roster'
import { createMockElement, createMockStores, createMockPresenceReader } from '../test-utils'
import type { Element } from '@xmpp/client'
import type { ModuleDependencies } from './BaseModule'
import { routeStanza } from '../stanzaRouting'

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
  let deps: ModuleDependencies

  beforeEach(() => {
    mockStores = createMockStores()
    sendIQ = vi.fn<ModuleDependencies['sendIQ']>()

    deps = {
      stores: mockStores,
      presence: createMockPresenceReader(),
      sendStanza: vi.fn(),
      sendIQ,
      getCurrentJid: () => 'user@example.com',
      emit: vi.fn(),
      emitSDK: vi.fn(),
      getXmpp: () => null,
    }
    lastActivity = new LastActivity(deps)
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

      // Simulate contact coming back online. Routed rather than calling
      // observe() directly: the path is what this is about.
      const presenceStanza = createMockElement('presence', {
        from: 'alice@example.com/desktop',
      })
      routeStanza(presenceStanza as unknown as Element, [], [lastActivity])

      expect(lastActivity.getCached('alice@example.com')).toBeNull()
    })

    // Regression: Roster claims essentially all presence and consumes it. While
    // this module was a CLAIMANT ordered after Roster, it never saw an
    // available presence and the cache was never invalidated — a contact coming
    // back online kept its stale "last seen". As an observer it runs regardless
    // of who claimed.
    it('still invalidates when Roster consumes the same presence', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')
      sendIQ.mockResolvedValue(createLastActivityResponse(600) as unknown as Element)
      await lastActivity.queryLastActivity('alice@example.com')
      expect(lastActivity.getCached('alice@example.com')).not.toBeNull()

      const roster = new Roster(deps)
      const presence = createMockElement('presence', {
        from: 'alice@example.com/desktop',
      }) as unknown as Element

      routeStanza(presence, [roster], [lastActivity])

      expect(roster.handle(presence)).toBe(true) // Roster does claim it...
      expect(lastActivity.getCached('alice@example.com')).toBeNull() // ...and it ran anyway
    })

    it('observes rather than claims, so it cannot consume a stanza', () => {
      // Structural: an observer has no `claims`/`handle` for the router to
      // offer a stanza to, so nothing it does can stop another module handling.
      expect((lastActivity as unknown as { claims?: unknown }).claims).toBeUndefined()
      expect((lastActivity as unknown as { handle?: unknown }).handle).toBeUndefined()
    })

    it('does not invalidate on unavailable presence', async () => {
      setupOfflineContact(mockStores, 'alice@example.com')

      sendIQ.mockResolvedValue(
        createLastActivityResponse(600) as unknown as Element
      )

      await lastActivity.queryLastActivity('alice@example.com')

      // type='unavailable' means going offline — cache should stay. The filter
      // is the declared claim, so route the stanza rather than calling observe.
      const presenceStanza = createMockElement('presence', {
        from: 'alice@example.com/desktop',
        type: 'unavailable',
      })
      routeStanza(presenceStanza as unknown as Element, [], [lastActivity])

      expect(lastActivity.getCached('alice@example.com')).not.toBeNull()
    })

    it('is not offered non-presence stanzas', () => {
      const invalidate = vi.spyOn(lastActivity, 'invalidate')
      const stanza = createMockElement('message', { from: 'alice@example.com/desktop' })
      routeStanza(stanza as unknown as Element, [], [lastActivity])
      expect(invalidate).not.toHaveBeenCalled()
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
