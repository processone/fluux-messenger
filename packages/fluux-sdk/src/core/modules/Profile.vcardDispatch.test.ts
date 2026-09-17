import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { IDBFactory } from 'fake-indexeddb'
import type { XMPPClient } from '../XMPPClient'
import type { RoomOccupant } from '../types/room'

const OWN = 'me@example.com'
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
const occupantPresence = (options: { hash?: string; unavailable?: boolean; self?: boolean; id?: string; anonymous?: boolean } = {}) =>
  xml('presence', { from: OCCUPANT, ...(options.unavailable && { type: 'unavailable' }) },
    xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' },
      xml('item', { affiliation: 'member', role: 'participant', ...(!options.anonymous && { jid: `${JID}/phone` }) }),
      ...(options.self ? [xml('status', { code: '110' })] : [])),
    ...(options.hash ? [xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, options.hash))] : []),
    ...(options.id ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: options.id })] : []))

let interceptedGetCachedAvatar: ((hash: string) => Promise<string | null>) | undefined
let interceptedHasNoAvatarForHash: ((jid: string, hash: string) => Promise<boolean>) | undefined
let interceptedCacheAvatar: ((hash: string, data: string, mimeType: string) => Promise<string>) | undefined

describe('vCard cache through avatar dispatchers', () => {
  let client: XMPPClient
  let cache: typeof import('../../utils/avatarCache')
  let internal: ReturnType<typeof import('../XMPPClient')['getInternalSurfaceForTesting']>
  let sendIQ: MockInstance<XMPPClient['sendIQ']>
  let occupants: Map<string, RoomOccupant>
  let joined: boolean
  let privacyOptions: { disableOccupantAvatarsInAnonymousRooms?: boolean }
  let switchAccount: (jid: string) => void

  beforeEach(async () => {
    const { createMockStores } = await import('../test-utils')
    // test-utils registers an XML mock; these dispatcher tests inspect real stanzas.
    vi.doUnmock('@xmpp/client')
    vi.doUnmock('../../utils/avatarCache')
    vi.resetModules()
    vi.doMock('../../utils/avatarCache', async importOriginal => {
      const actual = await importOriginal<typeof import('../../utils/avatarCache')>()
      return {
        ...actual,
        getCachedAvatar: (hash: string) =>
          interceptedGetCachedAvatar?.(hash) ?? actual.getCachedAvatar(hash),
        hasNoAvatarForHash: (jid: string, hash: string) =>
          interceptedHasNoAvatarForHash?.(jid, hash) ?? actual.hasNoAvatarForHash(jid, hash),
        cacheAvatar: (hash: string, data: string, mimeType: string) =>
          interceptedCacheAvatar?.(hash, data, mimeType) ?? actual.cacheAvatar(hash, data, mimeType),
      }
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
    globalThis.indexedDB = new IDBFactory()
    const { XMPPClient, bindStoresForTesting, getInternalSurfaceForTesting } = await import('../XMPPClient')
    cache = await import('../../utils/avatarCache')
    privacyOptions = {}
    class TestClient extends XMPPClient {
      constructor() {
        super({ debug: false, privacyOptions })
        this.currentJid = `${OWN}/desktop`
        switchAccount = jid => { this.currentJid = jid }
      }
      protected override async sendStanza(): Promise<void> {}
    }
    client = new TestClient()
    joined = true
    const stores = createMockStores()
    stores.connection.getJid.mockReturnValue(`${OWN}/desktop`)
    occupants = new Map([['guest', {
      nick: 'guest', affiliation: 'member', role: 'participant',
      jid: `${JID}/phone`, avatarHash: HASH, avatar: 'blob:loaded', occupantId: 'alice-id',
    }]])
    stores.room.getRoom.mockImplementation(jid => jid === ROOM ? {
      jid: ROOM, name: 'Room', nickname: 'me', joined, isBookmarked: false,
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
    interceptedGetCachedAvatar = undefined
    interceptedHasNoAvatarForHash = undefined
    interceptedCacheAvatar = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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
    vi.doUnmock('../../utils/avatarCache')
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
      vi.doUnmock('../../utils/avatarCache')
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

  describe('rejoin and avatar completion', () => {
    const dataReply = () => xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: 'urn:xmpp:avatar:data' },
          xml('item', { id: HASH }, xml('data', { xmlns: 'urn:xmpp:avatar:data' }, 'aW1hZ2U=')))))

    it.each(['positive', 'negative', 'pending'])(
      'discards %s anonymous occupant details on a fresh room rejoin', async outcome => {
        occupants.set('guest', { nick: 'guest', affiliation: 'member', role: 'participant' })
        let reply!: (value: Element) => void
        if (outcome === 'pending') sendIQ.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
        else sendIQ.mockResolvedValueOnce(outcome === 'positive' ? namedCard() : card())
        const first = client.profile.fetchProfileDetails(OCCUPANT)
        if (outcome !== 'pending') await first
        joined = false
        vi.spyOn(client.rooms, 'queryRoomFeatures').mockResolvedValue(null)
        await client.rooms.joinRoom(ROOM, 'me')
        occupants.set('guest', { nick: 'guest', affiliation: 'member', role: 'participant' })
        sendIQ.mockResolvedValue(namedCard('Bob'))
        const replacement = client.profile.fetchProfileDetails(OCCUPANT)
        expect(sendIQ).toHaveBeenCalledTimes(2)
        expect(await replacement).toMatchObject({ fullName: 'Bob' })
        if (outcome === 'pending') {
          reply(namedCard())
          expect(await first).toBeNull()
        }
        expect(sendIQ).toHaveBeenCalledTimes(2)
      },
    )

    describe.each(['contact PEP', 'occupant PEP', 'occupant vCard', 'anonymous vCard'])(
      '%s success', route => {
        it.each(['timeout', 'empty', 'service-unavailable'])(
          'lifts a %s profile negative created during the download', async outcome => {
            let reply!: (value: Element) => void
            if (route === 'occupant vCard') sendIQ.mockResolvedValueOnce(xml('iq', { type: 'result' }))
            sendIQ.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
            const download = route === 'contact PEP'
              ? client.profile.fetchAvatarData(JID, HASH)
              : client.profile.fetchOccupantAvatar(ROOM, 'guest', HASH,
                route === 'anonymous vCard' ? undefined : JID)
            await vi.waitFor(() => expect(sendIQ).toHaveBeenCalledTimes(route === 'occupant vCard' ? 2 : 1))
            if (outcome === 'empty') sendIQ.mockResolvedValue(card())
            else sendIQ.mockRejectedValue(outcome === 'timeout' ? new Error('Timeout') : error(outcome))
            const targets = route === 'contact PEP' ? [JID]
              : route === 'anonymous vCard' ? [OCCUPANT] : [JID, OCCUPANT]
            for (const target of targets) expect(await client.profile.fetchProfileDetails(target)).toBeNull()
            reply(route.includes('PEP') ? dataReply()
              : card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U='))))
            await download
            sendIQ.mockResolvedValue(namedCard('Recovered'))
            for (const target of targets) {
              expect(await client.profile.fetchProfileDetails(target)).toMatchObject({ fullName: 'Recovered' })
            }
          },
        )
      },
    )

    it('shares empty-photo contact checks until the avatar download completes', async () => {
      const { bindStoresForTesting } = await import('../XMPPClient')
      const { createMockStores } = await import('../test-utils')
      bindStoresForTesting(client, createMockStores())
      const metadata = xml('iq', { type: 'result' },
        xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
          xml('items', { node: 'urn:xmpp:avatar:metadata' },
            xml('item', { id: HASH }, xml('metadata', { xmlns: 'urn:xmpp:avatar:metadata' },
              xml('info', { id: HASH, type: 'image/png' }))))))
      let reply!: (value: Element) => void
      sendIQ.mockResolvedValueOnce(metadata)
        .mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
        .mockResolvedValue(metadata)
      const fetchMetadata = vi.spyOn(client.profile, 'fetchContactAvatarMetadata')
      client.contacts.handle(contactPresence(''))
      await vi.waitFor(() => expect(sendIQ).toHaveBeenCalledTimes(2))
      client.contacts.handle(contactPresence(''))
      expect(fetchMetadata).toHaveBeenCalledTimes(1)
      reply(dataReply())
      await fetchMetadata.mock.results[0].value
      expect(sendIQ).toHaveBeenCalledTimes(2)
    })
  })

  describe('shared positive profile/avatar boundary', () => {
    const metadataReply = () => xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: 'urn:xmpp:avatar:metadata' },
          xml('item', { id: HASH }, xml('metadata', { xmlns: 'urn:xmpp:avatar:metadata' },
            xml('info', { id: HASH, type: 'image/png' }))))))
    const dataReply = () => xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: 'urn:xmpp:avatar:data' },
          xml('item', { id: HASH }, xml('data', { xmlns: 'urn:xmpp:avatar:data' }, 'aW1hZ2U=')))))

    describe.each(['cached', 'downloaded'])(
      'own %s avatar at startup', route => {
        it.each(['timeout', 'empty', 'service-unavailable'])(
          'lifts a %s own-profile negative after concurrent startup queries', async outcome => {
            if (route === 'cached') await cache.cacheAvatar(HASH, 'aW1hZ2U=', 'image/png')
            let release!: (value: Element) => void
            let profileQueries = 0
            let recovered = false
            sendIQ.mockImplementation(async iq => {
              if (iq.getChild('vCard')) {
                profileQueries++
                if (recovered) return namedCard('Recovered')
                if (outcome === 'empty') return card()
                throw outcome === 'timeout' ? new Error('Timeout') : error(outcome)
              }
              const node = iq.getChild('pubsub')?.getChild('items')?.attrs.node
              if (node === 'urn:xmpp:avatar:metadata') {
                if (route === 'cached') return new Promise(resolve => { release = resolve })
                return metadataReply()
              }
              if (node === 'urn:xmpp:avatar:data') return new Promise(resolve => { release = resolve })
              return xml('iq', { type: 'result' })
            })
            const startup = client.profile.fetchOwnProfile()
            await vi.waitFor(() => expect(release).toBeTypeOf('function'))
            expect(await client.profile.fetchProfileDetails(OWN)).toBeNull()
            const queriesBeforeAvatar = profileQueries
            expect(await client.profile.fetchProfileDetails(OWN)).toBeNull()
            expect(profileQueries).toBe(queriesBeforeAvatar)
            await cache.markNoAvatar(OWN, 'contact', outcome === 'timeout' ? 'transient' : 'definitive')
            release(route === 'cached' ? metadataReply() : dataReply())
            await startup
            recovered = true
            expect(await client.profile.fetchOwnProfileDetails()).toMatchObject({ fullName: 'Recovered' })
            expect(profileQueries).toBe(queriesBeforeAvatar + 1)
            expect(await cache.hasNoAvatar(OWN)).toBe(false)
          },
        )
      },
    )

    it.each(['own restore', 'contact restore', 'contact hashes', 'occupant restore',
      'stable occupant restore', 'own refresh', 'contact refresh', 'occupant refresh'])(
      'invalidates only the publishing identities through %s', async route => {
        // fake-indexeddb's cloned happy-dom Blob is not a native URL Blob.
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored')
        const { bindStoresForTesting } = await import('../XMPPClient')
        const { createMockStores } = await import('../test-utils')
        const stores = createMockStores()
        const occupant: RoomOccupant = {
          nick: 'guest', affiliation: 'member', role: 'participant',
          jid: `${JID}/phone`, avatarHash: HASH, occupantId: 'alice-id',
        }
        const room = {
          jid: ROOM, name: 'Room', nickname: 'me', joined: true, isBookmarked: false,
          occupants: new Map([['guest', occupant]]),
          occupantIdToNick: new Map([['alice-id', 'guest']]),
          unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>(),
        }
        stores.room.getRoom.mockImplementation(jid => jid === ROOM ? room : undefined)
        if (route === 'occupant refresh') stores.room.joinedRooms.mockReturnValue([room])
        stores.roster.getContact.mockImplementation(jid => jid === JID ? {
          jid: JID, name: 'Alice', subscription: 'both', presence: 'online',
        } : undefined)
        bindStoresForTesting(client, stores)
        await cache.cacheAvatar(HASH, 'aW1hZ2U=', 'image/png')
        if (route === 'own refresh') await cache.saveAvatarHash(OWN, HASH, 'contact')
        else if (route === 'stable occupant restore') await cache.saveRoomOccupantAvatarHash(ROOM, 'alice-id', HASH)
        else if (!route.includes('own')) await cache.saveAvatarHash(JID, HASH, 'contact')
        const targets = route.includes('own') ? [OWN]
          : route.includes('occupant') ? [JID, OCCUPANT] : [JID]
        const identities = [OWN, JID, OCCUPANT, ROOM, 'other@example.com', 'other@conference.example.com/guest']
        sendIQ.mockRejectedValue(error('service-unavailable'))
        for (const jid of identities) {
          expect(await client.profile.fetchProfileDetails(jid)).toBeNull()
          await cache.markNoAvatar(jid, 'contact', 'definitive')
        }
        sendIQ.mockClear().mockResolvedValue(namedCard('Recovered'))
        if (route === 'own restore') expect(await client.profile.restoreOwnAvatarFromCache(HASH)).toBe(true)
        else if (route === 'contact restore') expect(await client.profile.restoreContactAvatarFromCache(`${JID}/phone`, HASH)).toBe(true)
        else if (route === 'contact hashes') await client.profile.restoreAllContactAvatarHashes()
        else if (route.endsWith('restore')) await client.profile.restoreOccupantAvatarsFromCache(ROOM)
        else await client.profile.refreshAllAvatarBlobUrls()
        expect(sendIQ).not.toHaveBeenCalled()
        for (const jid of identities) {
          const details = await client.profile.fetchProfileDetails(jid)
          if (targets.includes(jid)) expect(details).toMatchObject({ fullName: 'Recovered' })
          else expect(details).toBeNull()
          expect(await cache.hasNoAvatar(jid)).toBe(!targets.includes(jid))
        }
        expect(sendIQ).toHaveBeenCalledTimes(targets.length)
      },
    )

    it.each(['avatar cache', 'avatar download', 'avatar publication', 'avatar removal', 'profile publication',
      'profile fetch', 'avatar restoration'])(
      'rejects a late own %s completion after the account changes', async route => {
        const nextAccount = 'next@example.com'
        let release!: () => void
        let started!: () => void
        const pendingStarted = new Promise<void>(resolve => { started = resolve })
        const hold = (reply: Element) => new Promise<Element>(resolve => {
          release = () => resolve(reply)
          started()
        })
        if (route === 'avatar cache') await cache.cacheAvatar(HASH, 'aW1hZ2U=', 'image/png')
        if (route === 'avatar restoration') {
          vi.spyOn(cache, 'getCachedAvatar').mockImplementationOnce(() => new Promise(resolve => {
            release = () => resolve('blob:restored')
            started()
          }))
        }
        sendIQ.mockImplementation(async iq => {
          if (iq.attrs.to === nextAccount) throw error('service-unavailable')
          if (iq.getChild('vCard')) {
            if (route === 'profile fetch' || iq.attrs.type === 'set') return hold(namedCard('Previous account'))
            return namedCard('Previous account')
          }
          const itemsNode = iq.getChild('pubsub')?.getChild('items')?.attrs.node
          if (itemsNode === 'urn:xmpp:avatar:metadata') {
            return route === 'avatar cache' ? hold(metadataReply()) : metadataReply()
          }
          if (itemsNode === 'urn:xmpp:avatar:data') return hold(dataReply())
          const publishNode = iq.getChild('pubsub')?.getChild('publish')?.attrs.node
          if (publishNode === 'urn:xmpp:avatar:metadata') return hold(xml('iq', { type: 'result' }))
          return xml('iq', { type: 'result' })
        })
        const ownUpdate = vi.fn()
        client.subscribe('connection:own-avatar', ownUpdate)
        client.subscribe('connection:own-profile', ownUpdate)
        const pending = route === 'avatar restoration' ? client.profile.restoreOwnAvatarFromCache(HASH)
          : route === 'avatar removal' ? client.profile.clearOwnAvatar()
          : route === 'profile fetch' ? client.profile.fetchOwnProfileDetails()
          : route === 'profile publication' ? client.profile.publishOwnProfileDetails({ fullName: 'Previous account' })
          : route === 'avatar publication' ? client.profile.publishOwnAvatar('data:image/png;base64,aW1hZ2U=', 'image/png', 1, 1)
          : client.profile.fetchOwnAvatar()
        await pendingStarted
        switchAccount(`${nextAccount}/desktop`)
        expect(await client.profile.fetchProfileDetails(nextAccount)).toBeNull()
        await cache.markNoAvatar(nextAccount, 'contact', 'definitive')
        release()
        await pending
        expect(await cache.hasNoAvatar(nextAccount)).toBe(true)
        const count = sendIQ.mock.calls.length
        expect(await client.profile.fetchProfileDetails(nextAccount)).toBeNull()
        expect(sendIQ).toHaveBeenCalledTimes(count)
        expect(ownUpdate).not.toHaveBeenCalled()
      },
    )

  })

  describe('review regressions', () => {
    const photoCard = () => card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U=')))
    const dataReply = () => xml('iq', { type: 'result' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: 'urn:xmpp:avatar:data' },
          xml('item', { id: 'positive-hash' },
            xml('data', { xmlns: 'urn:xmpp:avatar:data' }, 'aW1hZ2U=')))))

    it.each(['timeout', 'empty', 'service-unavailable', 'feature-not-implemented', 'item-not-found'])(
      'invalidates %s negatives without repeated own-presence avatar queries', async outcome => {
        sendIQ.mockResolvedValueOnce(photoCard())
        await client.profile.fetchVCardAvatar(OWN)
        if (outcome === 'empty') sendIQ.mockResolvedValue(card())
        else sendIQ.mockRejectedValue(outcome === 'timeout' ? new Error('Timeout') : error(outcome))
        await client.profile.fetchVCardAvatar(OWN)
        expect(await client.profile.fetchOwnProfileDetails()).toBeNull()
        await client.profile.fetchProfileDetails(JID)
        sendIQ.mockClear().mockImplementation(async iq => iq.getChild('vCard')
          ? card(xml('FN', {}, 'Recovered'), xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U=')))
          : xml('iq', { type: 'result' }))
        const fetch = vi.spyOn(client.profile, 'fetchAvatarData')
        const evidence = vi.spyOn(client.profile, 'clearVCardNegativeCache')
        for (let repeat = 0; repeat < 3; repeat++) {
          client.contacts.handle(xml('presence', { from: `${OWN}/phone` },
            xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, HASH))))
          await vi.waitFor(async () => expect(await cache.hasNoAvatar(OWN)).toBe(false))
          await evidence.mock.results.at(-1)!.value
          await Promise.resolve()
          await Promise.all(fetch.mock.results.map(result => result.value))
          expect(sendIQ).not.toHaveBeenCalled()
          expect(fetch).not.toHaveBeenCalled()
        }
        expect(await client.profile.fetchOwnProfileDetails()).toMatchObject({ fullName: 'Recovered' })
        expect(await client.profile.fetchProfileDetails(JID)).toBeNull()
        expect(sendIQ).toHaveBeenCalledTimes(1)
      },
    )

    it('still downloads ordinary-contact presence avatars through the vCard fallback', async () => {
      sendIQ.mockRejectedValue(error('service-unavailable'))
      await client.profile.fetchVCardAvatar(JID)
      await client.profile.fetchProfileDetails(JID)
      sendIQ.mockClear().mockImplementation(async iq => iq.getChild('vCard')
        ? photoCard() : xml('iq', { type: 'result' }))
      const updated = vi.fn()
      client.subscribe('contacts:avatar', updated)
      client.contacts.handle(contactPresence('new-contact-hash'))
      await vi.waitFor(() => expect(updated).toHaveBeenCalledWith(expect.objectContaining({
        jid: JID, avatar: expect.stringMatching(/^blob:/),
      })))
      expect(sendIQ).toHaveBeenCalledTimes(2)
      expect(await cache.hasNoAvatar(JID)).toBe(false)
      sendIQ.mockResolvedValue(namedCard('Recovered'))
      expect(await client.profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Recovered' })
    })

    it.each(['join', 'nick change'])(
      'lifts own negatives on MUC self %s without a disclosed JID', async route => {
        occupants.set('guest', {
          nick: 'guest', affiliation: 'member', role: 'participant',
          avatarHash: HASH, avatar: 'blob:loaded', occupantId: 'self-id',
        })
        vi.spyOn(client.profile, 'fetchRoomAvatar').mockResolvedValue()
        vi.spyOn(client.rooms, 'setBookmark').mockResolvedValue()
        sendIQ.mockResolvedValue(card())
        for (const jid of [OWN, OCCUPANT]) {
          await client.profile.fetchProfileDetails(jid)
          await cache.markNoAvatar(jid, 'contact', 'definitive')
        }
        const changeNick = route === 'nick change' ? client.rooms.changeNick(ROOM, 'guest') : undefined
        client.rooms.handle(xml('presence', { from: OCCUPANT },
          xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' },
            xml('item', { affiliation: 'member', role: 'participant' }), xml('status', { code: '110' })),
          xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, HASH)),
          xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'self-id' })))
        await changeNick
        await vi.waitFor(async () => expect(await cache.hasNoAvatar(OCCUPANT)).toBe(false))
        await vi.waitFor(async () => expect(await cache.hasNoAvatar(OWN)).toBe(false))
        sendIQ.mockClear().mockResolvedValue(namedCard('Recovered'))
        expect(await client.profile.fetchOwnProfileDetails()).toMatchObject({ fullName: 'Recovered' })
        expect(await client.profile.fetchProfileDetails(OCCUPANT)).toMatchObject({ fullName: 'Recovered' })
        expect(sendIQ).toHaveBeenCalledTimes(2)
      },
    )

    describe.each(['join', 'nick change'])('self-MUC %s avatar identity', route => {
      async function seedNegatives(outcome: string) {
        occupants.clear()
        vi.spyOn(client.profile, 'fetchRoomAvatar').mockResolvedValue()
        vi.spyOn(client.rooms, 'setBookmark').mockResolvedValue()
        if (outcome === 'empty') sendIQ.mockResolvedValue(card())
        else sendIQ.mockRejectedValue(outcome === 'timeout' ? new Error('Timeout') : error(outcome))
        for (const jid of [OWN, OCCUPANT]) {
          expect(await client.profile.fetchProfileDetails(jid)).toBeNull()
          await cache.markNoAvatar(jid, 'contact', outcome === 'timeout' ? 'transient' : 'definitive')
          expect(await cache.hasNoAvatar(jid)).toBe(true)
        }
        sendIQ.mockClear().mockImplementation(async iq => iq.getChild('vCard')
          ? photoCard() : xml('iq', { type: 'result' }))
      }

      async function announce(realJid?: string) {
        const fetch = vi.spyOn(client.profile, 'fetchOccupantAvatar')
        const changeNick = route === 'nick change' ? client.rooms.changeNick(ROOM, 'guest') : undefined
        client.rooms.handle(xml('presence', { from: OCCUPANT },
          xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' },
            xml('item', { affiliation: 'member', role: 'participant', ...(realJid && { jid: realJid }) }),
            xml('status', { code: '110' })),
          xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, HASH)),
          xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'self-id' })))
        await changeNick
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
        await fetch.mock.results[0].value
      }

      async function expectRecoveredProfiles() {
        for (const jid of [OWN, OCCUPANT]) expect(await cache.hasNoAvatar(jid)).toBe(false)
        sendIQ.mockClear().mockResolvedValue(namedCard('Recovered'))
        expect(await client.profile.fetchOwnProfileDetails()).toMatchObject({ fullName: 'Recovered' })
        expect(await client.profile.fetchProfileDetails(OCCUPANT)).toMatchObject({ fullName: 'Recovered' })
        expect(sendIQ).toHaveBeenCalledTimes(2)
      }

      it.each(['timeout', 'empty', 'service-unavailable', 'feature-not-implemented', 'item-not-found'])(
        'invalidates %s negatives without anonymous avatar requests when disabled', async outcome => {
          privacyOptions.disableOccupantAvatarsInAnonymousRooms = true
          await seedNegatives(outcome)
          const updated = vi.fn()
          client.subscribe('room:occupant-avatar', updated)
          await announce()
          expect(sendIQ).not.toHaveBeenCalled()
          expect(updated).not.toHaveBeenCalled()
          await expectRecoveredProfiles()
        },
      )

      it.each(['anonymous', 'disclosed'])(
        'preserves the original %s avatar request target when permitted', async identity => {
          privacyOptions.disableOccupantAvatarsInAnonymousRooms = identity === 'disclosed'
          await seedNegatives('service-unavailable')
          const updated = vi.fn()
          client.subscribe('room:occupant-avatar', updated)
          await announce(identity === 'disclosed' ? `${OWN}/phone` : undefined)
          expect(sendIQ.mock.calls.map(([iq]) => ({
            to: iq.attrs.to, vcard: Boolean(iq.getChild('vCard', 'vcard-temp')),
          }))).toEqual(identity === 'disclosed'
            ? [{ to: OWN, vcard: false }, { to: OWN, vcard: true }]
            : [{ to: OCCUPANT, vcard: true }])
          expect(updated).toHaveBeenCalledWith(expect.objectContaining({
            roomJid: ROOM, nick: 'guest', occupantId: 'self-id', avatarHash: HASH,
            avatar: expect.any(String),
          }))
          await expectRecoveredProfiles()
        },
      )
    })

    describe.each(['contact vCard', 'contact PEP fallback', 'occupant vCard', 'occupant PEP fallback'])(
      '%s started before positive evidence', route => {
        it.each(['timeout', 'empty', 'service-unavailable'])(
          'does not restore a late %s avatar negative', async outcome => {
            let resolve!: (value: Element) => void
            let reject!: (reason: Error) => void
            if (route === 'occupant vCard') sendIQ.mockResolvedValueOnce(xml('iq', { type: 'result' }))
            sendIQ.mockImplementationOnce(() => new Promise((res, rej) => { resolve = res; reject = rej }))
            const stale = route === 'contact vCard' ? client.profile.fetchVCardAvatar(JID)
              : route === 'contact PEP fallback' ? client.profile.fetchContactAvatarMetadata(JID)
              : client.profile.fetchOccupantAvatar(ROOM, 'guest', HASH, `${JID}/phone`, 'alice-id')
            await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
            sendIQ.mockResolvedValue(dataReply())
            const fetch = vi.spyOn(client.profile, 'fetchAvatarData')
            const published = vi.fn()
            client.subscribe('contacts:avatar', published)
            internal.pubsub.handle(xml('message', { from: JID },
              xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
                xml('items', { node: 'urn:xmpp:avatar:metadata' },
                  xml('item', { id: 'positive-hash' },
                    xml('metadata', { xmlns: 'urn:xmpp:avatar:metadata' },
                      xml('info', { id: 'positive-hash', type: 'image/png' })))))))
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
            await fetch.mock.results[0].value
            expect(published).toHaveBeenCalledWith(expect.objectContaining({ avatarHash: 'positive-hash' }))
            expect(await cache.hasNoAvatar(JID)).toBe(false)
            const failure = outcome === 'timeout' ? new Error('Timeout') : error(outcome)
            if (route.endsWith('PEP fallback')) {
              if (outcome === 'empty') sendIQ.mockResolvedValue(card())
              else sendIQ.mockRejectedValue(failure)
              resolve(xml('iq', { type: 'result' }))
            } else if (outcome === 'empty') resolve(card())
            else reject(failure)
            await stale
            expect(await cache.hasNoAvatar(JID)).toBe(false)
            vi.doUnmock('../../utils/avatarCache')
            vi.resetModules()
            const restartedCache = await import('../../utils/avatarCache')
            expect(await restartedCache.hasNoAvatar(JID)).toBe(false)
          },
        )
      },
    )

    describe.each(['unavailable', 'open failure'])(
      'IndexedDB %s', storage => {
        it.each(['empty', 'service-unavailable', 'feature-not-implemented', 'item-not-found'])(
          'suppresses repeated empty-photo queries for definitive %s absence', async outcome => {
            const { bindStoresForTesting } = await import('../XMPPClient')
            const { createMockStores } = await import('../test-utils')
            bindStoresForTesting(client, createMockStores())
            if (storage === 'unavailable') vi.stubGlobal('indexedDB', undefined)
            else {
              vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('Storage unavailable') })
              vi.spyOn(console, 'warn').mockImplementation(() => {})
            }
            sendIQ.mockImplementation(async iq => {
              if (!iq.getChild('vCard') || outcome === 'empty') return card()
              throw error(outcome)
            })
            const fetch = vi.spyOn(client.profile, 'fetchContactAvatarMetadata')
            const dispatch = async () => {
              const count = fetch.mock.calls.length
              client.contacts.handle(contactPresence(''))
              expect(fetch).toHaveBeenCalledTimes(count + 1)
              await fetch.mock.results.at(-1)!.value
            }
            await dispatch()
            expect(sendIQ).toHaveBeenCalledTimes(2)
            vi.setSystemTime(Date.now() + 5 * MINUTE + 1)
            await dispatch()
            expect(sendIQ).toHaveBeenCalledTimes(2)
            vi.setSystemTime(Date.now() + 24 * 60 * MINUTE)
            await dispatch()
            expect(sendIQ).toHaveBeenCalledTimes(4)
            await client.profile.clearVCardNegativeCache(JID)
            await dispatch()
            expect(sendIQ).toHaveBeenCalledTimes(6)
          },
        )
      },
    )

    it('does not restore a negative when storage fails after positive evidence', async () => {
      let failOpen!: () => void
      vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        const request = {
          error: new Error('Storage unavailable'), onerror: null as null | (() => void),
        }
        failOpen = () => request.onerror?.()
        return request as unknown as IDBOpenDBRequest
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const mark = cache.markNoAvatar(JID, 'contact', 'definitive')
      const evidence = client.profile.clearVCardNegativeCache(JID)
      failOpen()
      await Promise.all([mark, evidence])
      expect(await cache.hasNoAvatar(JID)).toBe(false)
    })

    it.each(['preservation read', 'publication completion'])(
      'lifts avatar negatives through own-profile %s with PHOTO', async stage => {
        await cache.markNoAvatar(OWN, 'contact', 'definitive')
        sendIQ.mockResolvedValueOnce(card())
        expect(await client.profile.fetchOwnProfileDetails()).toBeNull()
        let resolve!: (value: Element) => void
        let reject!: (reason: Error) => void
        sendIQ.mockResolvedValueOnce(photoCard())
          .mockImplementationOnce(() => new Promise((res, rej) => { resolve = res; reject = rej }))
        const publication = client.profile.publishOwnProfileDetails({ fullName: 'Recovered' })
        const settled = publication.catch(reason => reason)
        await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
        if (stage === 'publication completion') {
          await cache.markNoAvatar(OWN, 'contact', 'definitive')
          resolve(xml('iq', { type: 'result' }))
        } else reject(new Error('Publication failed'))
        await settled
        expect(await cache.hasNoAvatar(OWN)).toBe(false)
        sendIQ.mockResolvedValue(namedCard('Recovered'))
        expect(await client.profile.fetchOwnProfileDetails()).toMatchObject({ fullName: 'Recovered' })
      },
    )
  })

  describe('same-hash avatar re-announcements', () => {
    const OTHER_ROOM = 'other@conference.example.com'
    const ANONYMOUS = `${ROOM}/anon`
    const vcardGets = () => sendIQ.mock.calls.flatMap(([iq]) =>
      iq.getChild('vCard', 'vcard-temp') ? [iq.attrs.to as string] : [])
    const answer = (vcard: () => Element | Promise<Element>) => sendIQ.mockImplementation(async iq => {
      if (iq.getChild('vCard', 'vcard-temp')) return vcard()
      throw error('forbidden')
    })
    const roomPresence = (from: string, hash: string, options: { jid?: string; show?: string } = {}) =>
      xml('presence', { from },
        ...(options.show ? [xml('show', {}, options.show)] : []),
        xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' },
          xml('item', { affiliation: 'member', role: 'participant', ...(options.jid && { jid: options.jid }) })),
        xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, hash)))
    const disclosed = (room: string, hash: string, show?: string) =>
      roomPresence(`${room}/alice`, hash, { jid: `${JID}/phone`, show })
    const roomAvatarPresence = (hash: string) => xml('presence', { from: ROOM },
      xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, hash)))

    beforeEach(async () => {
      const { bindStoresForTesting } = await import('../XMPPClient')
      const { createMockStores } = await import('../test-utils')
      const stores = createMockStores()
      stores.connection.getJid.mockReturnValue(`${OWN}/desktop`)
      const rooms = new Map([ROOM, OTHER_ROOM].map(jid => [jid, {
        jid, name: 'Room', nickname: 'me', joined: true, isBookmarked: false,
        occupants: new Map<string, RoomOccupant>(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>(),
      }]))
      stores.room.getRoom.mockImplementation(jid => rooms.get(jid))
      bindStoresForTesting(client, stores)
    })

    async function announce(
      stanza: Element,
      method: 'fetchOccupantAvatar' | 'fetchAvatarData' | 'fetchRoomAvatar',
    ) {
      const fetch = vi.spyOn(client.profile, method)
      const count = fetch.mock.calls.length
      if (stanza.getChild('x', 'http://jabber.org/protocol/muc#user')) client.rooms.handle(stanza)
      else client.contacts.handle(stanza)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(count + 1))
      await fetch.mock.results.at(-1)!.value
    }

    it('queries a disclosed occupant vCard once across presence updates and rooms', async () => {
      answer(() => namedCard())
      await announce(disclosed(ROOM, HASH), 'fetchOccupantAvatar')
      await announce(disclosed(ROOM, HASH, 'away'), 'fetchOccupantAvatar')
      await announce(disclosed(OTHER_ROOM, HASH), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([JID])
      expect(await cache.hasNoAvatar(JID)).toBe(true)
    })

    it('queries an anonymous occupant vCard once across presence updates', async () => {
      answer(() => card())
      await announce(roomPresence(ANONYMOUS, HASH), 'fetchOccupantAvatar')
      await announce(roomPresence(ANONYMOUS, HASH, { show: 'away' }), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([ANONYMOUS])
    })

    it('queries a contact vCard once across presence updates', async () => {
      answer(() => card())
      await announce(contactPresence(HASH), 'fetchAvatarData')
      await announce(contactPresence(HASH), 'fetchAvatarData')
      expect(vcardGets()).toEqual([JID])
    })

    it('queries a photo-bearing contact vCard once across presence updates', async () => {
      answer(() => card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U='))))
      await announce(contactPresence(HASH), 'fetchAvatarData')
      await announce(contactPresence(HASH), 'fetchAvatarData')
      expect(vcardGets()).toEqual([JID])
    })

    it('shares a photo lookup while its cache write is pending', async () => {
      let resolveCache!: (url: string) => void
      interceptedCacheAvatar = () => new Promise(resolve => { resolveCache = resolve })
      answer(() => card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U='))))
      const fetch = vi.spyOn(client.profile, 'fetchAvatarData')

      client.contacts.handle(contactPresence(HASH))
      await vi.waitFor(() => expect(resolveCache).toBeTypeOf('function'))
      client.contacts.handle(contactPresence(HASH))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

      expect(vcardGets()).toEqual([JID])
      resolveCache('blob:cached')
      await Promise.all(fetch.mock.results.map(result => result.value))
    })

    it('shares a no-photo contact negative with its disclosed MUC occupant', async () => {
      answer(() => card())
      await announce(contactPresence(HASH), 'fetchAvatarData')
      await announce(disclosed(ROOM, HASH), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([JID])
    })

    it('does not carry an anonymous occupant negative across nick reuse', async () => {
      answer(() => card())
      const fetch = vi.spyOn(client.profile, 'fetchOccupantAvatar')
      client.rooms.handle(occupantPresence({ hash: HASH, id: 'first-id', anonymous: true }))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      await fetch.mock.results[0].value
      client.rooms.handle(occupantPresence({ unavailable: true, anonymous: true }))

      answer(() => card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U='))))
      client.rooms.handle(occupantPresence({ hash: HASH, id: 'second-id', anonymous: true }))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      await fetch.mock.results[1].value

      expect(vcardGets()).toEqual([OCCUPANT, OCCUPANT])
    })

    it('does not carry an anonymous nick negative without an occupant ID', async () => {
      answer(() => card())
      const fetch = vi.spyOn(client.profile, 'fetchOccupantAvatar')
      client.rooms.handle(occupantPresence({ hash: HASH, anonymous: true }))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      await fetch.mock.results[0].value
      client.rooms.handle(occupantPresence({ unavailable: true, anonymous: true }))

      answer(() => card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U='))))
      client.rooms.handle(occupantPresence({ hash: HASH, anonymous: true }))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      await fetch.mock.results[1].value

      expect(vcardGets()).toEqual([OCCUPANT, OCCUPANT])
    })

    it('keeps the newer anonymous occupant negative when its hash changes in flight', async () => {
      const replies: Array<(value: Element) => void> = []
      sendIQ.mockImplementation(iq => iq.getChild('vCard', 'vcard-temp')
        ? new Promise(resolve => { replies.push(resolve) })
        : Promise.reject(error('forbidden')))
      const first = client.profile.fetchOccupantAvatar(ROOM, 'guest', 'first-hash', undefined, 'occupant-id')
      await vi.waitFor(() => expect(vcardGets()).toEqual([OCCUPANT]))
      const second = client.profile.fetchOccupantAvatar(ROOM, 'guest', 'second-hash', undefined, 'occupant-id')
      await vi.waitFor(() => expect(vcardGets()).toEqual([OCCUPANT, OCCUPANT]))

      replies[1](card())
      replies[0](card())
      await Promise.all([first, second])
      sendIQ.mockResolvedValue(card())
      await client.profile.fetchOccupantAvatar(ROOM, 'guest', 'second-hash', undefined, 'occupant-id')

      expect(vcardGets()).toEqual([OCCUPANT, OCCUPANT])
    })

    it('refreshes cached profile details for a repeated avatar hash', async () => {
      answer(() => card())
      await client.profile.fetchAvatarData(JID, HASH)
      expect(await client.profile.fetchProfileDetails(JID)).toBeNull()

      sendIQ.mockClear().mockResolvedValue(namedCard('Updated'))
      await announce(contactPresence(HASH), 'fetchAvatarData')

      expect(await client.profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Updated' })
      expect(vcardGets()).toEqual([JID])
      expect(await cache.hasNoAvatarForHash(JID, HASH)).toBe(true)
    })

    it('keeps a no-photo contact vCard negative through a same-hash presence race', async () => {
      const cachedReplies: Array<(url: string | null) => void> = []
      interceptedGetCachedAvatar = () =>
        new Promise(resolve => { cachedReplies.push(resolve) })
      answer(() => card())
      const fetch = vi.spyOn(client.profile, 'fetchAvatarData')

      client.contacts.handle(contactPresence(HASH))
      await vi.waitFor(() => expect(cachedReplies).toHaveLength(1))
      client.contacts.handle(contactPresence(HASH))
      await vi.waitFor(() => expect(cachedReplies).toHaveLength(2))

      cachedReplies[0](null)
      await vi.waitFor(() => expect(vcardGets()).toEqual([JID]))
      cachedReplies[1](null)
      await Promise.all(fetch.mock.results.map(result => result.value))

      expect(await cache.hasNoAvatarForHash(JID, HASH)).toBe(true)
      interceptedGetCachedAvatar = undefined
      await announce(contactPresence(HASH), 'fetchAvatarData')
      expect(vcardGets()).toEqual([JID])
    })

    it('voids a stale negative when a different hash arrives during its lookup', async () => {
      const replies: Array<(value: Element) => void> = []
      sendIQ.mockImplementation(iq => iq.getChild('vCard', 'vcard-temp')
        ? new Promise(resolve => { replies.push(resolve) })
        : Promise.reject(error('forbidden')))
      const fetch = vi.spyOn(client.profile, 'fetchAvatarData')

      client.contacts.handle(contactPresence(HASH))
      await vi.waitFor(() => expect(vcardGets()).toEqual([JID]))
      client.contacts.handle(contactPresence('new-hash'))
      await vi.waitFor(() => expect(vcardGets()).toEqual([JID, JID]))
      replies[0](card())
      replies[1](card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U='))))
      await Promise.all(fetch.mock.results.map(result => result.value))

      expect(await cache.hasNoAvatarForHash(JID, HASH)).toBe(false)
    })

    it('queries a room vCard once across room presence updates', async () => {
      answer(() => card())
      await announce(roomAvatarPresence(HASH), 'fetchRoomAvatar')
      await announce(roomAvatarPresence(HASH), 'fetchRoomAvatar')
      expect(vcardGets()).toEqual([ROOM])
    })

    it('shares a room vCard lookup while an announced hash is in flight', async () => {
      const cachedReplies: Array<(url: string | null) => void> = []
      interceptedGetCachedAvatar = () =>
        new Promise(resolve => { cachedReplies.push(resolve) })
      interceptedHasNoAvatarForHash = async () => false
      const replies: Array<(value: Element) => void> = []
      sendIQ.mockImplementation(iq => iq.getChild('vCard', 'vcard-temp')
        ? replies.length ? Promise.resolve(card()) : new Promise(resolve => { replies.push(resolve) })
        : Promise.reject(error('forbidden')))
      const first = client.profile.fetchRoomAvatar(ROOM, HASH)
      await vi.waitFor(() => expect(cachedReplies).toHaveLength(1))
      const second = client.profile.fetchRoomAvatar(ROOM, HASH)
      await vi.waitFor(() => expect(cachedReplies).toHaveLength(2))
      cachedReplies[0](null)
      await vi.waitFor(() => expect(vcardGets()).toEqual([ROOM]))
      cachedReplies[1](null)
      await vi.advanceTimersByTimeAsync(1)

      replies[0](card())
      await Promise.all([first, second])
      expect(vcardGets()).toEqual([ROOM])
    })

    it('keeps the newer room negative when announced hashes overlap', async () => {
      const replies: Array<(value: Element) => void> = []
      sendIQ.mockImplementation(iq => iq.getChild('vCard', 'vcard-temp')
        ? new Promise(resolve => { replies.push(resolve) })
        : Promise.reject(error('forbidden')))
      const first = client.profile.fetchRoomAvatar(ROOM, 'first-room-hash')
      await vi.waitFor(() => expect(vcardGets()).toEqual([ROOM]))
      const second = client.profile.fetchRoomAvatar(ROOM, 'second-room-hash')
      await vi.waitFor(() => expect(vcardGets()).toEqual([ROOM, ROOM]))

      replies[1](card())
      replies[0](card())
      await Promise.all([first, second])
      sendIQ.mockResolvedValue(card())
      await client.profile.fetchRoomAvatar(ROOM, 'second-room-hash')

      expect(vcardGets()).toEqual([ROOM, ROOM])
    })

    it('shares a lookup still pending when another room announces the same hash', async () => {
      const replies: Array<(value: Element) => void> = []
      sendIQ.mockImplementation(iq => iq.getChild('vCard', 'vcard-temp')
        ? new Promise(resolve => { replies.push(resolve) })
        : Promise.reject(error('forbidden')))
      const fetch = vi.spyOn(client.profile, 'fetchOccupantAvatar')
      client.rooms.handle(disclosed(ROOM, HASH))
      await vi.waitFor(() => expect(vcardGets()).toHaveLength(1))
      client.rooms.handle(disclosed(OTHER_ROOM, HASH))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      replies.splice(0).forEach(reply => reply(card()))
      answer(() => card())
      await Promise.all(fetch.mock.results.map(result => result.value))
      await announce(disclosed(ROOM, HASH, 'away'), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([JID])
      expect(await cache.hasNoAvatar(JID)).toBe(true)
    })

    it('completes every announcing occupant from one shared photo', async () => {
      const replies: Array<(value: Element) => void> = []
      sendIQ.mockImplementation(iq => iq.getChild('vCard', 'vcard-temp')
        ? new Promise(resolve => { replies.push(resolve) })
        : Promise.reject(error('forbidden')))
      const updated = vi.fn()
      client.subscribe('room:occupant-avatar', updated)
      const fetch = vi.spyOn(client.profile, 'fetchOccupantAvatar')
      client.rooms.handle(disclosed(ROOM, HASH))
      await vi.waitFor(() => expect(vcardGets()).toHaveLength(1))
      client.rooms.handle(disclosed(OTHER_ROOM, HASH))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
      replies.splice(0).forEach(reply => reply(card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U=')))))
      await Promise.all(fetch.mock.results.map(result => result.value))
      expect(vcardGets()).toEqual([JID])
      expect(updated.mock.calls.map(([payload]) => payload.roomJid).sort()).toEqual([OTHER_ROOM, ROOM])
    })

    it('queries again when the announced hash changes', async () => {
      answer(() => card())
      await announce(disclosed(ROOM, HASH), 'fetchOccupantAvatar')
      await announce(disclosed(ROOM, 'new-hash'), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([JID, JID])
    })

    it('replaces a negative stored without a hash on the first announcement only', async () => {
      await cache.markNoAvatar(JID, 'contact', 'definitive')
      answer(() => card())
      await announce(disclosed(ROOM, HASH), 'fetchOccupantAvatar')
      await announce(disclosed(ROOM, HASH, 'away'), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([JID])
    })

    it('keeps the five-minute timeout backoff for a re-announced hash', async () => {
      sendIQ.mockImplementation(async iq => {
        throw iq.getChild('vCard', 'vcard-temp') ? new Error('Timeout') : error('forbidden')
      })
      await announce(disclosed(ROOM, HASH), 'fetchOccupantAvatar')
      await announce(disclosed(ROOM, HASH, 'away'), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([JID])
      vi.setSystemTime(Date.now() + 5 * MINUTE + 1)
      await announce(disclosed(ROOM, HASH), 'fetchOccupantAvatar')
      expect(vcardGets()).toEqual([JID, JID])
      vi.doUnmock('../../utils/avatarCache')
      vi.resetModules()
      const restartedCache = await import('../../utils/avatarCache')
      expect(await restartedCache.hasNoAvatar(JID)).toBe(false)
    })
  })

})
