// FLM-195: rooms keep a live picture after a long reconnect, in Prosody's join order
// (self-presence first, hashed room presence second) and for entries saved under a
// generated key by earlier versions. Real Profile + avatar cache over fake IndexedDB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xml } from '@xmpp/client'
import { IDBFactory } from 'fake-indexeddb'
import { createHash } from 'node:crypto'
import { Blob } from 'node:buffer'
import { createPresenceReader } from '../presenceReader'
import type { ModuleDependencies } from './BaseModule'

const ROOM = 'xsf@muc.xmpp.org'
// Public XSF room picture (64x64 PNG).
const B64 = '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'
const PNG = Buffer.from(B64, 'base64')
const HASH = createHash('sha1').update(PNG).digest('hex')
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const live = new Set<string>()
let n = 0

/** One app start. replyDelays orders the vCard replies (Prosody: hashless last). */
async function startApp(replyDelays: number[], legacyJoin = false) {
  live.clear()
  vi.resetModules()
  const { Profile } = await import('./Profile')
  const cache = await import('../../utils/avatarCache')
  const { AvatarStateOwner } = await import('../../utils/avatarState')
  const avatarState = new AvatarStateOwner(() => 'me@example.com')
  const room: Record<string, unknown> = { jid: ROOM, name: 'XSF', joined: true, occupants: new Map() }
  let call = 0
  const sendIQ = vi.fn(async () => {
    await wait(replyDelays[call++] ?? 0)
    return xml('iq', { type: 'result' }, xml('vCard', { xmlns: 'vcard-temp' },
      xml('PHOTO', {}, xml('TYPE', {}, 'image/png'), xml('BINVAL', {}, B64))))
  })
  const deps = {
    presence: createPresenceReader(), sendStanza: async () => {}, sendIQ,
    getCurrentJid: () => 'me@example.com/device', emit: vi.fn(), getXmpp: () => null, avatarState,
    emitSDK: (event: string, payload: { roomJid: string; updates: object }) => {
      if (event === 'room:updated' && payload.roomJid === ROOM) Object.assign(room, payload.updates)
    },
    stores: {
      room: { getRoom: (j: string) => (j === ROOM ? room : undefined), joinedRooms: () => [room], allRooms: () => [room] },
      roster: { getContact: () => undefined, sortedContacts: () => [] },
    },
  }
  const profile = new Profile(deps as unknown as ModuleDependencies)
  const pending: Promise<unknown>[] = []
  // Mirrors XMPPClient's mucJoined handler, then Roster's hashed room presence.
  const join = () => {
    if (!room.avatar && !room.avatarFromPresence) {
      const restored = typeof room.avatarHash === 'string' && /^[0-9a-f]{40}$/i.test(room.avatarHash) ? room.avatarHash : undefined
      pending.push(profile.fetchRoomAvatar(ROOM, legacyJoin ? undefined : restored))
    }
    const version = avatarState.capture(ROOM, HASH)
    version.apply(() => Object.assign(room, { avatarFromPresence: true, avatarHash: HASH }))
    pending.push(profile.fetchRoomAvatar(ROOM, HASH))
  }
  const start = async () => { await profile.restoreAllRoomAvatarHashes(); join(); await Promise.all(pending) }
  return { profile, cache, room, start, avatarState }
}

describe('room avatar after a long reconnect', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    vi.stubGlobal('Blob', Blob)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { const u = `blob:tauri://localhost/${++n}`; live.add(u); return u })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(u => { live.delete(u) })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  const shown = (room: Record<string, unknown>) => ({ loadable: live.has(room.avatar as string), avatarHash: room.avatarHash })

  it("keeps a live picture saved under the announced hash when the hashless reply lands last", async () => {
    const first = await startApp([0, 0])
    await first.start()
    await first.cache.clearAllAvatars() // picture bytes gone, saved entry kept

    const second = await startApp([30, 0]) // hashless reply arrives last
    await second.start()
    await second.profile.refreshAllAvatarBlobUrls()
    await wait(50)

    expect(shown(second.room)).toEqual({ loadable: true, avatarHash: HASH })
    expect(await second.cache.getAvatarHash(ROOM)).toBe(HASH)
  })

  it('heals a room saved under a generated key by earlier versions', async () => {
    const first = await startApp([0, 0])
    await first.start()
    await first.cache.clearAllAvatars()
    const old = await startApp([30, 0], true) // earlier version: hashless fetch
    await old.start()
    expect(String(await old.cache.getAvatarHash(ROOM))).toContain('-')

    const next = await startApp([0, 0])
    await next.start()
    await next.profile.refreshAllAvatarBlobUrls()
    await wait(50)

    expect(shown(next.room)).toEqual({ loadable: true, avatarHash: HASH })
  })

  // FLM-203 R1: a refresh begun before a newer announcement must not overwrite it.
  it('does not let an older refresh overwrite a room picture announced meanwhile', async () => {
    const app = await startApp([0, 0])
    await app.start()
    await app.cache.clearAllAvatars()
    Object.assign(app.room, { avatar: 'blob:tauri://localhost/dead' })

    const refresh = app.profile.refreshAllAvatarBlobUrls()
    const newer = app.avatarState.capture(ROOM, 'f'.repeat(40))
    newer.apply(() => Object.assign(app.room, { avatar: 'blob:tauri://localhost/newer', avatarHash: 'f'.repeat(40) }))
    await refresh
    await wait(50)

    expect(app.room.avatar).toBe('blob:tauri://localhost/newer')
    expect(app.room.avatarHash).toBe('f'.repeat(40))
  })
})
