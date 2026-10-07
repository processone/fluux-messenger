import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Parser } from '@xmpp/xml'
import { XMPPClient } from './XMPPClient'
import { createMockRoom } from './test-utils'
import { roomStore } from '../stores/roomStore'
import * as avatarCache from '../utils/avatarCache'

const roomJid = 'avatar-burst@conference.example.test'

beforeEach(() => {
  vi.useFakeTimers()
  roomStore.getState().reset()
})

afterEach(async () => {
  roomStore.getState().reset()
  await avatarCache.clearAllNoAvatarEntries()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('presence batching with avatar announcements', () => {
  it.each([0, 17])('coalesces anonymous avatar-backoff presences at %ims spacing', async spacing => {
    const occupants = Array.from({ length: 200 }, (_, i) => ({
      nick: `Occupant${i}`, role: 'participant' as const, affiliation: 'member' as const,
      avatarHash: `hash-${i}`, show: 'chat' as const,
    }))
    roomStore.getState().addRoom(createMockRoom(roomJid, {
      joined: true, nickname: 'Me', isNonAnonymous: false,
      occupants: new Map(occupants.map(occupant => [occupant.nick, occupant])),
    }))
    await Promise.all(occupants.map(occupant => avatarCache.markNoAvatar(
      `${roomJid}/${occupant.nick}`, 'occupant', 'transient', undefined, occupant.avatarHash,
    )))
    vi.spyOn(avatarCache, 'getCachedAvatar').mockResolvedValue(null)
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = new XMPPClient({ debug: false })
    const batch = vi.spyOn(roomStore.getState(), 'batchAddOccupants')
    const notify = vi.fn()
    const detach = roomStore.subscribe(state => state.roomRuntime.get(roomJid)?.occupants, notify)
    let accepted = 0
    const detachEvents = client.subscribe('room:occupant-joined', () => accepted++)
    const parser = new Parser()
    const parserErrors: Error[] = []
    parser.on('error', error => parserErrors.push(error))
    parser.on('element', stanza => client.rooms.handle(stanza))
    try {
      parser.write('<stream:stream xmlns:stream="http://etherx.jabber.org/streams" xmlns="jabber:client">')
      for (const occupant of occupants) {
        for (const show of ['away', 'chat']) {
          parser.write(`<presence from="${roomJid}/${occupant.nick}"><show>${show}</show><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="member" role="participant"/></x><x xmlns="vcard-temp:x:update"><photo>${occupant.avatarHash}</photo></x></presence>`)
          await vi.advanceTimersByTimeAsync(spacing)
        }
      }
      if (!spacing) expect(notify).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(16)
      expect(accepted).toBe(400)
      expect(batch.mock.calls.flatMap(([, updates]) => updates).map(update => [update.nick, update.show])).toEqual(
        occupants.flatMap(occupant => ['away', 'chat'].map(show => [occupant.nick, show])),
      )
      expect(notify).toHaveBeenCalledTimes(spacing ? 400 : 1)
      expect(roomStore.getState().getRoom(roomJid)?.occupants.size).toBe(200)
      for (const occupant of occupants) {
        expect(roomStore.getState().getRoom(roomJid)?.occupants.get(occupant.nick)).toMatchObject(occupant)
        expect(await avatarCache.hasNoAvatarForHash(`${roomJid}/${occupant.nick}`, occupant.avatarHash)).toBe(true)
      }
      expect(parserErrors).toEqual([])
      expect(report).not.toHaveBeenCalled()
    } finally {
      detach(); detachEvents(); client.destroy()
    }
  })

  it('publishes cached avatars after pending presences without eager notifications', async () => {
    roomStore.getState().addRoom(createMockRoom(roomJid, { joined: true, nickname: 'Me' }))
    await avatarCache.markNoAvatar(`${roomJid}/Alice`, 'occupant', 'transient', undefined, 'hash')
    vi.spyOn(avatarCache, 'getCachedAvatar').mockResolvedValue('image')
    const client = new XMPPClient({ debug: false })
    const notify = vi.fn()
    const detach = roomStore.subscribe(state => state.roomRuntime.get(roomJid)?.occupants, notify)
    try {
      client.emitSDK('room:occupant-joined', { roomJid,
        occupant: { nick: 'Alice', role: 'participant', affiliation: 'member', avatarHash: 'hash' } })
      const completion = client.profile.fetchOccupantAvatar(roomJid, 'Alice', 'hash')
      await vi.advanceTimersByTimeAsync(0)
      expect(notify).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(16)
      await completion
      expect(notify).toHaveBeenCalledTimes(1)
      expect(await avatarCache.hasNoAvatar(`${roomJid}/Alice`)).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect(notify).toHaveBeenCalledTimes(2)
      expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')).toMatchObject({ avatar: 'image', avatarHash: 'hash' })
    } finally {
      detach(); client.destroy()
    }
  })

  it('keeps an old avatar completion from invalidating or painting a queued replacement identity', async () => {
    const alice = { nick: 'Alice', occupantId: 'old-id', role: 'participant', affiliation: 'member', avatarHash: 'old-hash' } as const
    roomStore.getState().addRoom(createMockRoom(roomJid, {
      joined: true, nickname: 'Me', occupants: new Map([['Alice', alice]]),
    }))
    const client = new XMPPClient({ debug: false })
    const stateJid = client.profile.getOccupantAvatarStateKey(roomJid, 'Alice', undefined, 'old-id')
    await avatarCache.markNoAvatar(`${roomJid}/Alice`, 'occupant', 'transient', undefined, 'old-hash')
    await avatarCache.markNoAvatar(stateJid, 'occupant', 'transient', undefined, 'old-hash')
    vi.spyOn(avatarCache, 'getCachedAvatar').mockResolvedValue('old-image')
    const notify = vi.fn()
    const detach = roomStore.subscribe(state => state.roomRuntime.get(roomJid)?.occupants, notify)
    try {
      client.emitSDK('room:occupant-joined', { roomJid, occupant: { ...alice, occupantId: 'new-id', avatarHash: 'new-hash' } })
      const completion = client.profile.fetchOccupantAvatar(roomJid, 'Alice', 'old-hash', undefined, 'old-id')
      await vi.advanceTimersByTimeAsync(0)
      expect(notify).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(16)
      await completion
      expect(await avatarCache.hasNoAvatarForHash(`${roomJid}/Alice`, 'old-hash')).toBe(true)
      await vi.advanceTimersByTimeAsync(200)
      const room = roomStore.getState().getRoom(roomJid)!
      expect(room.occupants.get('Alice')).toMatchObject({ occupantId: 'new-id', avatarHash: 'new-hash' })
      expect(room.occupants.get('Alice')?.avatar).toBeUndefined()
      expect(room.nickToAvatarCache?.get('Alice')).toBeUndefined()
      expect(room.occupantIdToAvatarCache?.get('old-id')).toBe('old-image')
    } finally {
      detach(); client.destroy()
    }
  })
})
