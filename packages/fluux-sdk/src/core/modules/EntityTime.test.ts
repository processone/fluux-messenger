import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EntityTime, parseTzo, getBestResource } from './EntityTime'
import { createMockElement, createMockStores } from '../test-utils'
import type { Element } from '@xmpp/client'
import type { ModuleDependencies } from './BaseModule'
import type { ResourcePresence } from '../types'

describe('parseTzo', () => {
  it('parses positive offsets', () => {
    expect(parseTzo('+01:00')).toBe(60)
    expect(parseTzo('+05:30')).toBe(330)
    expect(parseTzo('+12:00')).toBe(720)
  })

  it('parses negative offsets', () => {
    expect(parseTzo('-05:00')).toBe(-300)
    expect(parseTzo('-03:30')).toBe(-210)
    expect(parseTzo('-12:00')).toBe(-720)
  })

  it('parses zero offsets', () => {
    expect(parseTzo('Z')).toBe(0)
    expect(parseTzo('+00:00')).toBe(0)
    expect(parseTzo('-00:00')).toBe(0)
  })

  it('returns 0 for invalid formats', () => {
    expect(parseTzo('invalid')).toBe(0)
    expect(parseTzo('')).toBe(0)
    expect(parseTzo('1:00')).toBe(0)
  })
})

describe('getBestResource', () => {
  it('returns null for empty map', () => {
    expect(getBestResource(new Map())).toBeNull()
  })

  it('returns the only resource when there is one', () => {
    const resources = new Map<string, ResourcePresence>([
      ['mobile', { show: null, priority: 0 }],
    ])
    expect(getBestResource(resources)).toBe('mobile')
  })

  it('picks the higher priority resource', () => {
    const resources = new Map<string, ResourcePresence>([
      ['mobile', { show: null, priority: 0 }],
      ['desktop', { show: null, priority: 10 }],
    ])
    expect(getBestResource(resources)).toBe('desktop')
  })

  it('picks the more available resource on priority tie', () => {
    const resources = new Map<string, ResourcePresence>([
      ['mobile', { show: 'away', priority: 5 }],
      ['desktop', { show: null, priority: 5 }],  // null = online, more available
    ])
    expect(getBestResource(resources)).toBe('desktop')
  })

  it('prefers higher priority over better availability', () => {
    const resources = new Map<string, ResourcePresence>([
      ['mobile', { show: 'dnd', priority: 10 }],
      ['desktop', { show: 'chat', priority: 0 }],
    ])
    expect(getBestResource(resources)).toBe('mobile')
  })
})

/** Helper to create a successful entity time IQ response */
function createTimeResponse(tzo: string, utc: string) {
  return createMockElement('iq', { type: 'result' }, [
    {
      name: 'time',
      attrs: { xmlns: 'urn:xmpp:time' },
      children: [
        { name: 'tzo', text: tzo },
        { name: 'utc', text: utc },
      ],
    },
  ])
}

/** Helper to set up a contact with resources in the mock store */
function setupContact(
  mockStores: ReturnType<typeof createMockStores>,
  jid: string,
  resources: Map<string, ResourcePresence>,
) {
  mockStores.roster.getContact.mockReturnValue({
    jid,
    name: jid.split('@')[0],
    presence: resources.size > 0 ? 'online' : 'offline',
    subscription: 'both' as const,
    resources,
  })
}

describe('EntityTime module', () => {
  let entityTime: EntityTime
  let mockStores: ReturnType<typeof createMockStores>
  let sendIQ: ReturnType<typeof vi.fn<ModuleDependencies['sendIQ']>>

  beforeEach(() => {
    mockStores = createMockStores()
    sendIQ = vi.fn<ModuleDependencies['sendIQ']>()

    entityTime = new EntityTime({
      stores: mockStores,
      sendStanza: vi.fn(),
      sendIQ,
      getCurrentJid: () => 'user@example.com',
      emit: vi.fn(),
      emitSDK: vi.fn(),
      getXmpp: () => null,
    })
  })

  describe('handle', () => {
    it('returns false for all stanzas (no incoming handling)', () => {
      const stanza = createMockElement('iq', { type: 'get' })
      expect(entityTime.handle(stanza)).toBe(false)
    })
  })

  describe('queryTime', () => {
    it('returns null when contact has no resources (offline)', async () => {
      setupContact(mockStores, 'alice@example.com', new Map())

      const result = await entityTime.queryTime('alice@example.com')
      expect(result).toBeNull()
      expect(sendIQ).not.toHaveBeenCalled()
    })

    it('returns null when contact is not found', async () => {
      mockStores.roster.getContact.mockReturnValue(undefined)

      const result = await entityTime.queryTime('nobody@example.com')
      expect(result).toBeNull()
    })

    it('sends IQ to best resource and parses response', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['mobile', { show: 'away', priority: 0 }],
        ['desktop', { show: null, priority: 5 }],
      ]))

      sendIQ.mockResolvedValue(
        createTimeResponse('+01:00', '2026-03-16T14:30:00Z') as unknown as Element
      )

      const result = await entityTime.queryTime('alice@example.com')

      expect(result).not.toBeNull()
      expect(result!.supported).toBe(true)
      if (result!.supported) {
        expect(result!.offsetMinutes).toBe(60)
        expect(result!.resource).toBe('desktop')
      }

      // Should have sent to the best resource (desktop, priority 5)
      const sentIQ = sendIQ.mock.calls[0][0]
      expect(sentIQ.attrs.to).toBe('alice@example.com/desktop')
    })

    it('returns cached result on second call', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['web', { show: null, priority: 0 }],
      ]))

      sendIQ.mockResolvedValue(
        createTimeResponse('-05:00', '2026-03-16T09:30:00Z') as unknown as Element
      )

      const first = await entityTime.queryTime('alice@example.com')
      const second = await entityTime.queryTime('alice@example.com')

      expect(first).toEqual(second)
      expect(sendIQ).toHaveBeenCalledTimes(1)
    })

    it('avoids duplicate in-flight queries for same JID', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['web', { show: null, priority: 0 }],
      ]))

      let resolveIQ: (value: any) => void
      sendIQ.mockReturnValue(new Promise((resolve) => { resolveIQ = resolve }))

      const promise1 = entityTime.queryTime('alice@example.com')
      const promise2 = entityTime.queryTime('alice@example.com')

      // Second call returns null (in-flight guard)
      expect(await promise2).toBeNull()

      resolveIQ!(createTimeResponse('+02:00', '2026-03-16T16:30:00Z'))

      const result1 = await promise1
      expect(result1!.supported).toBe(true)
      if (result1!.supported) {
        expect(result1!.offsetMinutes).toBe(120)
      }
      expect(sendIQ).toHaveBeenCalledTimes(1)
    })
  })

  describe('negative caching', () => {
    it('caches failure when sendIQ throws', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['web', { show: null, priority: 0 }],
      ]))

      sendIQ.mockRejectedValue(new Error('feature-not-implemented'))

      const result = await entityTime.queryTime('alice@example.com')
      expect(result).not.toBeNull()
      expect(result!.supported).toBe(false)

      // Second call should return negative cache without sending IQ
      sendIQ.mockClear()
      const second = await entityTime.queryTime('alice@example.com')
      expect(second!.supported).toBe(false)
      expect(sendIQ).not.toHaveBeenCalled()
    })

    it('caches failure when response has no time element', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['web', { show: null, priority: 0 }],
      ]))

      sendIQ.mockResolvedValue(
        createMockElement('iq', { type: 'result' }) as unknown as Element
      )

      const result = await entityTime.queryTime('alice@example.com')
      expect(result!.supported).toBe(false)

      // Cached — no re-query
      sendIQ.mockClear()
      const second = await entityTime.queryTime('alice@example.com')
      expect(second!.supported).toBe(false)
      expect(sendIQ).not.toHaveBeenCalled()
    })

    it('caches failure when response has no tzo element', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['web', { show: null, priority: 0 }],
      ]))

      const responseElement = createMockElement('iq', { type: 'result' }, [
        {
          name: 'time',
          attrs: { xmlns: 'urn:xmpp:time' },
          children: [
            { name: 'utc', text: '2026-03-16T14:30:00Z' },
            // no tzo element
          ],
        },
      ])
      sendIQ.mockResolvedValue(responseElement as unknown as Element)

      const result = await entityTime.queryTime('alice@example.com')
      expect(result!.supported).toBe(false)
    })
  })

  describe('resource change detection', () => {
    it('re-queries when best resource changes', async () => {
      // First query: desktop is best
      setupContact(mockStores, 'alice@example.com', new Map([
        ['mobile', { show: 'away', priority: 0 }],
        ['desktop', { show: null, priority: 5 }],
      ]))

      sendIQ.mockResolvedValue(
        createTimeResponse('+01:00', '2026-03-16T15:30:00Z') as unknown as Element
      )

      const first = await entityTime.queryTime('alice@example.com')
      expect(first!.supported).toBe(true)
      if (first!.supported) {
        expect(first!.resource).toBe('desktop')
        expect(first!.offsetMinutes).toBe(60)
      }

      // Desktop goes offline — mobile becomes best (different timezone)
      setupContact(mockStores, 'alice@example.com', new Map([
        ['mobile', { show: null, priority: 0 }],
      ]))

      sendIQ.mockResolvedValue(
        createTimeResponse('+09:00', '2026-03-16T23:30:00Z') as unknown as Element
      )

      const second = await entityTime.queryTime('alice@example.com')
      expect(second!.supported).toBe(true)
      if (second!.supported) {
        expect(second!.resource).toBe('mobile')
        expect(second!.offsetMinutes).toBe(540) // +09:00 = 540 minutes
      }

      // Two IQs sent total (cache was invalidated)
      expect(sendIQ).toHaveBeenCalledTimes(2)
    })

    it('uses cache when best resource is the same', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['desktop', { show: null, priority: 5 }],
      ]))

      sendIQ.mockResolvedValue(
        createTimeResponse('+01:00', '2026-03-16T15:30:00Z') as unknown as Element
      )

      await entityTime.queryTime('alice@example.com')

      // Same resource, different presence — should still use cache
      setupContact(mockStores, 'alice@example.com', new Map([
        ['desktop', { show: 'away', priority: 5 }],
      ]))

      await entityTime.queryTime('alice@example.com')
      expect(sendIQ).toHaveBeenCalledTimes(1) // No re-query
    })

    it('does not re-query for negatively cached contacts even if resource changes', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['desktop', { show: null, priority: 5 }],
      ]))

      sendIQ.mockRejectedValue(new Error('feature-not-implemented'))

      await entityTime.queryTime('alice@example.com')

      // Resource changes — but negative cache should still hold
      setupContact(mockStores, 'alice@example.com', new Map([
        ['mobile', { show: null, priority: 0 }],
      ]))

      sendIQ.mockClear()
      const result = await entityTime.queryTime('alice@example.com')
      expect(result!.supported).toBe(false)
      expect(sendIQ).not.toHaveBeenCalled()
    })
  })

  describe('clearCache', () => {
    it('clears cached results including negative cache', async () => {
      setupContact(mockStores, 'alice@example.com', new Map([
        ['web', { show: null, priority: 0 }],
      ]))

      sendIQ.mockRejectedValue(new Error('feature-not-implemented'))
      await entityTime.queryTime('alice@example.com')
      expect(entityTime.getCached('alice@example.com')).not.toBeNull()

      entityTime.clearCache()
      expect(entityTime.getCached('alice@example.com')).toBeNull()
    })
  })

  describe('getCached', () => {
    it('returns null when no cached data', () => {
      expect(entityTime.getCached('alice@example.com')).toBeNull()
    })
  })
})
