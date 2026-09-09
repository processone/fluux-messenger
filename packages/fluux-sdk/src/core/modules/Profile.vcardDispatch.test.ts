import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { IDBFactory } from 'fake-indexeddb'
import type { XMPPClient } from '../XMPPClient'
import type { RoomOccupant } from '../types/room'

const JID = 'alice@example.com'
const ROOM = 'room@conference.example.com'
const OCCUPANT = `${ROOM}/guest`
const HASH = 'known-hash'
const MINUTE = 60_000
const card = (...children: Element[]) => xml('iq', { type: 'result' },
  xml('vCard', { xmlns: 'vcard-temp' }, ...children))
const namedCard = (name = 'Alice') => card(xml('FN', {}, name))
const error = (condition: string) => Object.assign(new Error(condition), { condition })
const contactPresence = (hash: string) => xml('presence', { from: `${JID}/phone` },
  xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, hash)))
const occupantPresence = (options: { hash?: string; unavailable?: boolean; self?: boolean; id?: string } = {}) =>
  xml('presence', { from: OCCUPANT, ...(options.unavailable && { type: 'unavailable' }) },
    xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' },
      xml('item', { affiliation: 'member', role: 'participant', jid: `${JID}/phone` }),
      ...(options.self ? [xml('status', { code: '110' })] : [])),
    ...(options.hash ? [xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, options.hash))] : []),
    ...(options.id ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: options.id })] : []))

describe('vCard cache through avatar dispatchers', () => {
  let client: XMPPClient
  let cache: typeof import('../../utils/avatarCache')
  let internal: ReturnType<typeof import('../XMPPClient')['getInternalSurfaceForTesting']>
  let sendIQ: MockInstance<XMPPClient['sendIQ']>
  let occupants: Map<string, RoomOccupant>

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
    globalThis.indexedDB = new IDBFactory()
    const { XMPPClient, bindStoresForTesting, getInternalSurfaceForTesting } = await import('../XMPPClient')
    const { createMockStores } = await import('../test-utils')
    cache = await import('../../utils/avatarCache')
    client = new XMPPClient({ debug: false })
    const stores = createMockStores()
    occupants = new Map([['guest', {
      nick: 'guest', affiliation: 'member', role: 'participant',
      jid: `${JID}/phone`, avatarHash: HASH, avatar: 'blob:loaded', occupantId: 'alice-id',
    }]])
    stores.room.getRoom.mockImplementation(jid => jid === ROOM ? {
      jid: ROOM, name: 'Room', nickname: 'me', joined: true, isBookmarked: false,
      occupants, unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>(),
    } : undefined)
    stores.roster.getContact.mockImplementation(jid => jid === JID ? {
      jid: JID, name: 'Alice', subscription: 'both', presence: 'online',
      avatarHash: HASH, avatar: 'blob:loaded',
    } : undefined)
    bindStoresForTesting(client, stores)
    internal = getInternalSurfaceForTesting(client)
    sendIQ = vi.spyOn(client, 'sendIQ')
  })

  afterEach(() => {
    client.destroy()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function dispatchOccupantFallback() {
    const fetch = vi.spyOn(client.profile, 'fetchOccupantAvatar')
    const count = fetch.mock.calls.length
    client.rooms.handle(occupantPresence({ hash: 'new-hash', id: 'alice-id' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(count + 1))
    await fetch.mock.results.at(-1)!.value
  }

  it('keeps occupant fallback timeouts volatile with five-minute backoff', async () => {
    sendIQ.mockRejectedValue(new Error('Timeout'))
    await dispatchOccupantFallback()
    expect(sendIQ).toHaveBeenCalledTimes(2)
    expect(await cache.hasNoAvatar(JID)).toBe(true)
    vi.setSystemTime(Date.now() + 5 * MINUTE + 1)
    expect(await cache.hasNoAvatar(JID)).toBe(false)
    await dispatchOccupantFallback()
    expect(await cache.hasNoAvatar(JID)).toBe(true)
    vi.resetModules()
    const restartedCache = await import('../../utils/avatarCache')
    expect(await restartedCache.hasNoAvatar(JID)).toBe(false)
  })

  it.each(['empty', 'service-unavailable', 'feature-not-implemented', 'item-not-found'])(
    'persists definitive occupant fallback absence: %s', async outcome => {
      sendIQ.mockRejectedValueOnce(new Error('Timeout'))
      if (outcome === 'empty') sendIQ.mockResolvedValueOnce(card())
      else sendIQ.mockRejectedValueOnce(error(outcome))
      await dispatchOccupantFallback()
      expect(sendIQ).toHaveBeenCalledTimes(2)
      vi.resetModules()
      const restartedCache = await import('../../utils/avatarCache')
      expect(await restartedCache.hasNoAvatar(JID)).toBe(true)
      vi.setSystemTime(Date.now() + 24 * 60 * MINUTE + 1)
      expect(await restartedCache.hasNoAvatar(JID)).toBe(false)
    },
  )

  describe.each(['timeout', 'empty', 'service-unavailable', 'feature-not-implemented', 'item-not-found'])(
    'cached negative %s', outcome => {
      it.each(['presence', 'metadata', 'occupant'])(
        'invalidates before loaded-hash deduplication through %s', async source => {
          if (outcome === 'empty') sendIQ.mockResolvedValue(card())
          else sendIQ.mockRejectedValue(outcome === 'timeout' ? new Error('Timeout') : error(outcome))
          await client.profile.fetchVCardAvatar(JID)
          await client.profile.fetchProfileDetails(JID)
          await client.profile.fetchProfileDetails(OCCUPANT)
          await cache.cacheAvatar(HASH, 'aW1hZ2U=', 'image/png')
          sendIQ.mockClear().mockResolvedValue(namedCard())
          if (source === 'presence') client.contacts.handle(contactPresence(HASH))
          else if (source === 'occupant') client.rooms.handle(occupantPresence({ hash: HASH, id: 'alice-id' }))
          else internal.pubsub.handle(xml('message', { from: JID },
            xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
              xml('items', { node: 'urn:xmpp:avatar:metadata' },
                xml('item', { id: HASH }, xml('metadata', { xmlns: 'urn:xmpp:avatar:metadata' },
                  xml('info', { id: HASH, type: 'image/png' })))))))
          await vi.waitFor(async () => expect(await cache.hasNoAvatar(JID)).toBe(false))
          expect(sendIQ).not.toHaveBeenCalled()
          expect(await client.profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
          if (source === 'occupant') {
            expect(await client.profile.fetchProfileDetails(OCCUPANT)).toMatchObject({ fullName: 'Alice' })
          }
          expect(sendIQ).toHaveBeenCalledTimes(source === 'occupant' ? 2 : 1)
        },
      )
    },
  )

  it('retries empty-photo contact presence after timeout backoff expires', async () => {
    const { bindStoresForTesting } = await import('../XMPPClient')
    const { createMockStores } = await import('../test-utils')
    bindStoresForTesting(client, createMockStores())
    sendIQ.mockRejectedValue(new Error('Timeout'))
    const fetchMetadata = vi.spyOn(client.profile, 'fetchContactAvatarMetadata')
    const dispatch = async () => {
      client.contacts.handle(contactPresence(''))
      await vi.waitFor(() => expect(fetchMetadata).toHaveBeenCalled())
      await fetchMetadata.mock.results.at(-1)!.value
    }
    await dispatch()
    expect(sendIQ).toHaveBeenCalledTimes(2)
    await dispatch()
    expect(sendIQ).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + 5 * MINUTE + 1)
    sendIQ.mockResolvedValue(card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U='))))
    await dispatch()
    expect(sendIQ).toHaveBeenCalledTimes(4)
    expect(await cache.hasNoAvatar(JID)).toBe(false)
  })

  it('shares concurrent empty-photo presence checks while the query is pending', async () => {
    const { bindStoresForTesting } = await import('../XMPPClient')
    const { createMockStores } = await import('../test-utils')
    bindStoresForTesting(client, createMockStores())
    let reply!: (value: Element) => void
    sendIQ.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
    const fetchMetadata = vi.spyOn(client.profile, 'fetchContactAvatarMetadata')
    client.contacts.handle(contactPresence(''))
    await vi.waitFor(() => expect(sendIQ).toHaveBeenCalledTimes(1))
    client.contacts.handle(contactPresence(''))
    expect(fetchMetadata).toHaveBeenCalledTimes(1)
    sendIQ.mockResolvedValue(card())
    reply(xml('iq', { type: 'result' }))
    await fetchMetadata.mock.results[0].value
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })

  it('preserves populated profile results when another room announces the cached avatar', async () => {
    sendIQ.mockResolvedValue(namedCard())
    await client.profile.fetchProfileDetails(JID)
    await cache.cacheAvatar(HASH, 'aW1hZ2U=', 'image/png')
    await client.profile.fetchOccupantAvatar(ROOM, 'guest', HASH, JID)
    expect(await client.profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
    expect(sendIQ).toHaveBeenCalledTimes(1)
  })

  it.each(['positive', 'negative'])(
    'shares pending %s profile queries across avatar evidence', async outcome => {
      let reply!: (value: Element) => void
      sendIQ.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
      const first = client.profile.fetchProfileDetails(JID)
      await cache.cacheAvatar(HASH, 'aW1hZ2U=', 'image/png')
      await client.profile.fetchOccupantAvatar(ROOM, 'guest', HASH, JID)
      const second = client.profile.fetchProfileDetails(JID)
      expect(sendIQ).toHaveBeenCalledTimes(1)
      reply(outcome === 'positive' ? namedCard() : card())
      expect(await second).toEqual(await first)
      sendIQ.mockResolvedValue(namedCard())
      expect(await client.profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
      expect(sendIQ).toHaveBeenCalledTimes(outcome === 'positive' ? 1 : 2)
    },
  )

  it.each(['positive', 'negative', 'pending'])(
    'discards %s occupant details after departure and nick reuse', async outcome => {
      let reply!: (value: Element) => void
      if (outcome === 'pending') sendIQ.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
      else sendIQ.mockResolvedValueOnce(outcome === 'positive' ? namedCard() : card())
      const first = client.profile.fetchProfileDetails(OCCUPANT)
      if (outcome !== 'pending') await first
      client.rooms.handle(occupantPresence({ unavailable: true }))
      client.rooms.handle(occupantPresence())
      sendIQ.mockResolvedValue(namedCard('Bob'))
      expect(await client.profile.fetchProfileDetails(OCCUPANT)).toMatchObject({ fullName: 'Bob' })
      if (outcome === 'pending') {
        reply(namedCard())
        expect(await first).toBeNull()
      }
      expect(await client.profile.fetchProfileDetails(OCCUPANT)).toMatchObject({ fullName: 'Bob' })
      expect(sendIQ).toHaveBeenCalledTimes(2)
    },
  )

  it('discards occupant details when the local user leaves the room', async () => {
    sendIQ.mockResolvedValueOnce(namedCard())
    await client.profile.fetchProfileDetails(OCCUPANT)
    client.rooms.handle(occupantPresence({ unavailable: true, self: true }))
    sendIQ.mockResolvedValue(namedCard('Bob'))
    expect(await client.profile.fetchProfileDetails(OCCUPANT)).toMatchObject({ fullName: 'Bob' })
  })

  it.each(['occupantId', 'jid'] as const)('detects a replaced occupant by %s without departure', async field => {
    sendIQ.mockResolvedValueOnce(namedCard())
    await client.profile.fetchProfileDetails(OCCUPANT)
    occupants.set('guest', { ...occupants.get('guest')!, [field]: 'bob' })
    sendIQ.mockResolvedValue(namedCard('Bob'))
    expect(await client.profile.fetchProfileDetails(OCCUPANT)).toMatchObject({ fullName: 'Bob' })
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })
})
