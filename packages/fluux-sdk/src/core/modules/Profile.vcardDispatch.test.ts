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
  let joined: boolean

  beforeEach(async () => {
    const { createMockStores } = await import('../test-utils')
    // test-utils registers an XML mock; these dispatcher tests inspect real stanzas.
    vi.doUnmock('@xmpp/client')
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
    globalThis.indexedDB = new IDBFactory()
    const { XMPPClient, bindStoresForTesting, getInternalSurfaceForTesting } = await import('../XMPPClient')
    cache = await import('../../utils/avatarCache')
    class TestClient extends XMPPClient {
      constructor() {
        super({ debug: false })
        this.currentJid = `${OWN}/desktop`
      }
      protected override async sendStanza(): Promise<void> {}
    }
    client = new TestClient()
    joined = true
    const stores = createMockStores()
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

  })

})
