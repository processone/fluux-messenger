import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { IDBFactory } from 'fake-indexeddb'
import { createPresenceReader } from '../presenceReader'
import type { ModuleDependencies } from './BaseModule'
import type { Profile } from './Profile'

const JID = 'alice@example.com'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const card = (...children: Element[]) => xml('iq', { type: 'result' },
  xml('vCard', { xmlns: 'vcard-temp' }, ...children))
const namedCard = () => card(xml('FN', {}, 'Alice'))
const photoCard = () => card(xml('PHOTO', {}, xml('BINVAL', {}, 'aW1hZ2U=')))
const stanzaError = (condition: string) => Object.assign(new Error(condition), { condition })

// Keep IndexedDB across module reloads: a restart must discard only volatile state.
async function loadProfile(deps: ModuleDependencies) {
  vi.resetModules()
  const { Profile } = await import('./Profile')
  const cache = await import('../../utils/avatarCache')
  return { profile: new Profile(deps), cache }
}

describe('vCard cache outcomes', () => {
  let deps: ModuleDependencies
  let sendIQ: ReturnType<typeof vi.fn<ModuleDependencies['sendIQ']>>
  let profile: Profile
  let cache: typeof import('../../utils/avatarCache')

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
    globalThis.indexedDB = new IDBFactory()
    sendIQ = vi.fn<ModuleDependencies['sendIQ']>()
    deps = {
      stores: null, presence: createPresenceReader(), sendStanza: async () => {}, sendIQ,
      getCurrentJid: () => 'me@example.com/device', emit: vi.fn(), emitSDK: vi.fn(), getXmpp: () => null,
    }
    ;({ profile, cache } = await loadProfile(deps))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries an avatar after five minutes of timeout backoff', async () => {
    sendIQ.mockRejectedValueOnce(new Error('Timeout')).mockResolvedValue(photoCard())
    await profile.fetchVCardAvatar(JID)
    await profile.fetchVCardAvatar(JID)
    expect(sendIQ).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 5 * MINUTE + 1)
    await profile.fetchVCardAvatar(JID)
    expect(sendIQ).toHaveBeenCalledTimes(2)
    expect(deps.emitSDK).toHaveBeenCalledWith('contacts:avatar', expect.objectContaining({ jid: JID }))
    expect(await cache.hasNoAvatar(JID)).toBe(false)
  })

  it('does not retain an avatar timeout after a module reload', async () => {
    sendIQ.mockRejectedValueOnce(new Error('Timeout')).mockResolvedValue(photoCard())
    await profile.fetchVCardAvatar(JID)
    expect(await cache.hasNoAvatar(JID)).toBe(true)
    ;({ profile, cache } = await loadProfile(deps))
    expect(await cache.hasNoAvatar(JID)).toBe(false)
    await profile.fetchVCardAvatar(JID)
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })

  it('retains a returned vCard without PHOTO after reload until its 24-hour expiry', async () => {
    sendIQ.mockResolvedValue(card())
    await profile.fetchVCardAvatar(JID)
    ;({ profile, cache } = await loadProfile(deps))
    expect(await cache.hasNoAvatar(JID)).toBe(true)
    vi.setSystemTime(Date.now() + DAY - 1)
    await profile.fetchVCardAvatar(JID)
    expect(sendIQ).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 2)
    await profile.fetchVCardAvatar(JID)
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })

  it.each(['service-unavailable', 'feature-not-implemented', 'item-not-found'])(
    'retains an explicit %s avatar refusal after reload for 24 hours', async (condition) => {
      sendIQ.mockRejectedValue(stanzaError(condition))
      await profile.fetchVCardAvatar(JID)
      ;({ profile, cache } = await loadProfile(deps))
      expect(await cache.hasNoAvatar(JID)).toBe(true)
      vi.setSystemTime(Date.now() + DAY - 1)
      await profile.fetchVCardAvatar(JID)
      expect(sendIQ).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 2)
      await profile.fetchVCardAvatar(JID)
      expect(sendIQ).toHaveBeenCalledTimes(2)
    },
  )

  it.each([new Error('Network disconnected'), stanzaError('remote-server-timeout'), new Error('service-unavailable')])(
    'does not persist an ambiguous avatar failure: %s', async (error) => {
      sendIQ.mockRejectedValue(error)
      await profile.fetchVCardAvatar(JID)
      ;({ profile, cache } = await loadProfile(deps))
      expect(await cache.hasNoAvatar(JID)).toBe(false)
    },
  )

  it('shares pending profile queries, caches the result and refreshes after five minutes', async () => {
    let reply!: (value: Element) => void
    sendIQ.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
    const first = profile.fetchProfileDetails(JID)
    const second = profile.fetchProfileDetails(JID)
    expect(sendIQ).toHaveBeenCalledTimes(1)
    reply(namedCard())
    expect(await first).toMatchObject({ fullName: 'Alice' })
    expect(await second).toMatchObject({ fullName: 'Alice' })
    expect(await profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
    expect(sendIQ).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 5 * MINUTE + 1)
    sendIQ.mockResolvedValue(card(xml('FN', {}, 'Updated')))
    expect(await profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Updated' })
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })

  it.each(['empty', 'missing', 'service-unavailable', 'feature-not-implemented', 'item-not-found'])(
    'caches definitive profile absence (%s) for 24 hours', async (outcome) => {
      if (outcome === 'empty') sendIQ.mockResolvedValue(card())
      else if (outcome === 'missing') sendIQ.mockResolvedValue(xml('iq', { type: 'result' }))
      else sendIQ.mockRejectedValue(stanzaError(outcome))
      expect(await profile.fetchProfileDetails(JID)).toBeNull()
      vi.setSystemTime(Date.now() + DAY - 1)
      expect(await profile.fetchProfileDetails(JID)).toBeNull()
      expect(sendIQ).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 2)
      sendIQ.mockResolvedValue(namedCard())
      expect(await profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
      expect(sendIQ).toHaveBeenCalledTimes(2)
    },
  )

  it('backs off profile timeouts for five minutes and retries after reload', async () => {
    sendIQ.mockRejectedValue(new Error('Timeout'))
    expect(await profile.fetchProfileDetails(JID)).toBeNull()
    expect(await profile.fetchProfileDetails(JID)).toBeNull()
    expect(sendIQ).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 5 * MINUTE + 1)
    expect(await profile.fetchProfileDetails(JID)).toBeNull()
    expect(sendIQ).toHaveBeenCalledTimes(2)
    ;({ profile, cache } = await loadProfile(deps))
    sendIQ.mockResolvedValue(namedCard())
    expect(await profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
    expect(sendIQ).toHaveBeenCalledTimes(3)
  })

  it('keeps full occupant JIDs distinct from each other and the room', async () => {
    sendIQ.mockImplementation(async iq => card(xml('FN', {}, iq.attrs.to)))
    const jids = ['room@conf.example/alice', 'room@conf.example/bob', 'room@conf.example']
    for (const jid of jids) expect(await profile.fetchProfileDetails(jid)).toMatchObject({ fullName: jid })
    for (const jid of jids) expect(await profile.fetchProfileDetails(jid)).toMatchObject({ fullName: jid })
    expect(sendIQ.mock.calls.map(([iq]) => iq.attrs.to)).toEqual(jids)
  })

  it('refreshes cached own details after publication', async () => {
    const ownJid = 'me@example.com'
    sendIQ.mockResolvedValue(namedCard())
    expect(await profile.fetchProfileDetails(ownJid)).toMatchObject({ fullName: 'Alice' })
    await profile.publishOwnProfileDetails({ fullName: 'New Name' })
    sendIQ.mockResolvedValue(card(xml('FN', {}, 'New Name')))
    expect(await profile.fetchProfileDetails(ownJid)).toMatchObject({ fullName: 'New Name' })
  })

  it('does not reuse profile details across accounts', async () => {
    sendIQ.mockResolvedValue(namedCard())
    await profile.fetchProfileDetails(JID)
    deps.getCurrentJid = () => 'another@example.com/device'
    sendIQ.mockResolvedValue(card(xml('FN', {}, 'Visible to another account')))
    expect(await profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Visible to another account' })
    expect(sendIQ).toHaveBeenCalledTimes(2)
  })

  describe.each(['timeout', 'no-photo', 'service-unavailable', 'feature-not-implemented', 'item-not-found'])(
    'positive evidence after %s', (outcome) => {
      async function seedNegative() {
        if (outcome === 'no-photo') sendIQ.mockResolvedValue(card())
        else sendIQ.mockRejectedValue(outcome === 'timeout' ? new Error('Timeout') : stanzaError(outcome))
        await profile.fetchVCardAvatar(JID)
        await profile.fetchProfileDetails(JID)
        expect(await cache.hasNoAvatar(JID)).toBe(true)
        sendIQ.mockClear()
      }

      it.each(['presence', 'metadata'])(
        'clears both caches on %s even when the image is already cached', async (source) => {
          await seedNegative()
          await cache.cacheAvatar('known-hash', 'aW1hZ2U=', 'image/png')
          const fetches: Promise<void>[] = []
          deps.emit = vi.fn((event, ...args) => {
            if (event === 'avatarMetadataUpdate') {
              const [jid, hash] = args as [string, string]
              fetches.push(profile.fetchAvatarData(jid, hash))
            }
          })
          if (source === 'presence') {
            const { Roster } = await import('./Roster')
            new Roster(deps).handle(xml('presence', { from: `${JID}/phone` },
              xml('x', { xmlns: 'vcard-temp:x:update' }, xml('photo', {}, 'known-hash'))))
          } else {
            const { PubSub } = await import('./PubSub')
            new PubSub(deps).handle(xml('message', { from: JID },
              xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
                xml('items', { node: 'urn:xmpp:avatar:metadata' },
                  xml('item', { id: 'known-hash' },
                    xml('metadata', { xmlns: 'urn:xmpp:avatar:metadata' },
                      xml('info', { id: 'known-hash', type: 'image/png' })))))))
          }
          expect(fetches).toHaveLength(1)
          await Promise.all(fetches)
          expect(await cache.hasNoAvatar(JID)).toBe(false)
          sendIQ.mockResolvedValue(namedCard())
          expect(await profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
          expect(sendIQ).toHaveBeenCalledTimes(1)
      })

      it('clears both caches on occupant presence even when the image is already cached', async () => {
        await seedNegative()
        await cache.cacheAvatar('known-hash', 'aW1hZ2U=', 'image/png')
        await profile.fetchOccupantAvatar('room@conf.example', 'alice', 'known-hash', `${JID}/phone`)
        expect(await cache.hasNoAvatar(JID)).toBe(false)
        sendIQ.mockResolvedValue(namedCard())
        expect(await profile.fetchProfileDetails(JID)).toMatchObject({ fullName: 'Alice' })
      })

      it('allows vCard fallback immediately after a contact hash when PEP cannot answer', async () => {
        await seedNegative()
        sendIQ.mockRejectedValueOnce(new Error('Timeout')).mockResolvedValue(photoCard())
        await profile.fetchAvatarData(JID, 'new-hash')
        expect(sendIQ).toHaveBeenCalledTimes(2)
        expect(await cache.hasNoAvatar(JID)).toBe(false)
        expect(deps.emitSDK).toHaveBeenCalledWith('contacts:avatar', expect.objectContaining({ jid: JID }))
      })
    },
  )
})
