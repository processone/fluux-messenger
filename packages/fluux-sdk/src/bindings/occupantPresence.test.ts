import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreBindings, type StoreRefs } from './storeBindings'
import { createMockClientWithSDKEvents, createMockStoreRefs, createMockRoom } from '../core/test-utils'
import { roomStore } from '../stores/roomStore'
import { eventsStore } from '../stores/eventsStore'
import type { RoomOccupant } from '../core/types'

const roomJid = 'burst@conference.example.test'
const alice: RoomOccupant = { nick: 'Alice', occupantId: 'alice-id', role: 'visitor', affiliation: 'member' }

describe('post-join occupant presence binding', () => {
  let client: ReturnType<typeof createMockClientWithSDKEvents>
  let unsubscribe: () => void
  let batch: ReturnType<typeof vi.fn<(jid: string, occupants: RoomOccupant[]) => void>>
  beforeEach(() => {
    vi.useFakeTimers()
    roomStore.getState().reset()
    eventsStore.getState().reset()
    roomStore.getState().addRoom(createMockRoom(roomJid, {
      joined: true, nickname: 'Me', occupants: new Map([[alice.nick, alice]]),
    }))
    vi.runOnlyPendingTimers()
    client = createMockClientWithSDKEvents()
    const refs = createMockStoreRefs()
    batch = vi.fn((jid: string, occupants: RoomOccupant[]) => roomStore.getState().batchAddOccupants(jid, occupants))
    unsubscribe = createStoreBindings(client, () => ({
      ...refs, room: { ...roomStore.getState(), batchAddOccupants: batch }, events: eventsStore.getState(),
    }) as unknown as StoreRefs)
  })
  afterEach(() => {
    unsubscribe()
    roomStore.getState().reset()
    eventsStore.getState().reset()
    vi.useRealTimers()
  })
  const presence = (occupant: RoomOccupant) => client.emit('room:occupant-joined', { roomJid, occupant })

  it('applies every queued update in order in one notification, including intermediate avatar caches', () => {
    const listener = vi.fn()
    const detach = roomStore.subscribe(listener)
    try {
      presence({ ...alice, show: 'away', avatar: 'old-image', avatarHash: 'old-hash' })
      presence({ ...alice, show: 'chat', avatarHash: 'new-hash', role: 'participant', affiliation: 'admin' })
      expect(listener).not.toHaveBeenCalled()
      vi.advanceTimersByTime(16)
      expect(listener).toHaveBeenCalledTimes(1)
      const room = roomStore.getState().getRoom(roomJid)!
      expect(room.occupants.get('Alice')).toMatchObject({ show: 'chat', avatarHash: 'new-hash', role: 'participant', affiliation: 'admin' })
      expect(room.nickToAvatarCache?.get('Alice')).toBe('old-image')
      expect(room.occupantIdToAvatarCache?.get('alice-id')).toBe('old-image')
    } finally { detach() }
  })

  it('flushes before leave/nick reuse so old identity cannot return', () => {
    presence({ ...alice, show: 'away' })
    client.emit('room:occupant-left', { roomJid, nick: 'Alice' })
    presence({ ...alice, nick: 'Renamed', show: 'chat' })
    presence({ nick: 'Alice', occupantId: 'bob-id', role: 'participant', affiliation: 'none' })
    vi.advanceTimersByTime(16)
    const room = roomStore.getState().getRoom(roomJid)!
    expect(room.occupants.get('Alice')?.occupantId).toBe('bob-id')
    expect(room.occupants.get('Renamed')?.occupantId).toBe('alice-id')
    expect(room.occupantIdToNick?.get('alice-id')).toBe('Renamed')
  })

  it('keeps voice transitions ordered even when the final role is visitor again', () => {
    client.emit('events:voice-request', { id: 'request', roomJid, nick: 'Alice', jid: 'alice@example.test' })
    presence({ ...alice, role: 'participant' })
    presence(alice)
    client.emit('events:voice-request', { id: 'new-request', roomJid, nick: 'Alice', jid: 'alice@example.test' })
    vi.advanceTimersByTime(16)
    expect(eventsStore.getState().voiceRequests.map(r => r.id)).toEqual(['new-request'])
    expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')?.role).toBe('visitor')
  })

  it('flushes before self-presence, avatar resolution, room replacement and removal', () => {
    presence({ ...alice, show: 'away' })
    client.emit('room:self-occupant', { roomJid, occupant: { ...alice, nick: 'Me', role: 'moderator' } })
    expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')?.show).toBe('away')
    presence({ ...alice, avatarHash: 'hash' })
    client.emit('room:occupant-avatar', { roomJid, nick: 'Alice', occupantId: 'alice-id', avatar: 'image', avatarHash: 'hash' })
    vi.advanceTimersByTime(200)
    expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')?.avatar).toBe('image')
    presence({ ...alice, show: 'chat' })
    client.emit('room:updated', { roomJid, updates: { occupants: new Map() } })
    vi.advanceTimersByTime(16)
    expect(roomStore.getState().getRoom(roomJid)?.occupants.size).toBe(0)
    presence(alice)
    client.emit('room:removed', { roomJid })
    vi.advanceTimersByTime(16)
    expect(roomStore.getState().getRoom(roomJid)).toBeUndefined()
  })

  it.each([0, 17])('handles 400 updates at %ims spacing without losing intermediate updates', spacing => {
    const occupants = Array.from({ length: 200 }, (_, i) => ({ ...alice, nick: `Occupant${i}`, occupantId: `id-${i}` }))
    roomStore.getState().batchAddOccupants(roomJid, occupants)
    const expected: RoomOccupant[] = []
    for (const occupant of occupants) {
      for (const show of ['away', 'chat'] as const) {
        const update = { ...occupant, show }
        expected.push(update)
        presence(update)
        if (spacing) vi.advanceTimersByTime(spacing)
      }
    }
    vi.advanceTimersByTime(16)
    expect(batch.mock.calls.flatMap(([, updates]) => updates)).toEqual(expected)
    expect(batch).toHaveBeenCalledTimes(spacing ? 400 : 1)
    for (const occupant of occupants) {
      expect(roomStore.getState().getRoom(roomJid)?.occupants.get(occupant.nick)?.show).toBe('chat')
    }
  })

  it('continues flushing other rooms when a store subscriber throws after commit', () => {
    const otherRoom = 'other@conference.example.test'
    roomStore.getState().addRoom(createMockRoom(otherRoom, { joined: true }))
    const error = new Error('UI subscriber failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detach = roomStore.subscribe(() => { throw error })
    try {
      presence({ ...alice, show: 'away' })
      client.emit('room:occupant-joined', { roomJid: otherRoom, occupant: { ...alice, show: 'chat' } })
      expect(() => vi.advanceTimersByTime(16)).not.toThrow()
      expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')?.show).toBe('away')
      expect(roomStore.getState().getRoom(otherRoom)?.occupants.get('Alice')?.show).toBe('chat')
      expect(report).toHaveBeenCalledTimes(2)
      expect(report).toHaveBeenCalledWith('[SDK] Store subscriber failed:', error)
    } finally { detach(); report.mockRestore() }
  })

  it('preserves queued updates across unrelated traffic and other-room barriers', () => {
    const otherRoom = 'other@conference.example.test'
    roomStore.getState().addRoom(createMockRoom(otherRoom, { joined: true, nickname: 'Me' }))
    presence({ ...alice, show: 'away' })
    client.emit('console:event', { message: 'unrelated' })
    client.emit('admin:is-admin', { isAdmin: true })
    client.emit('contacts:presence-offline', { fullJid: 'contact@example.test/mobile' })
    client.emit('room:occupant-joined', { roomJid: otherRoom, occupant: alice })
    client.emit('room:self-occupant', { roomJid: otherRoom, occupant: { ...alice, nick: 'Me' } })
    expect(batch.mock.calls.map(([jid]) => jid)).toEqual([otherRoom])
    expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')?.show).toBeUndefined()
    presence({ ...alice, show: 'chat' })
    vi.advanceTimersByTime(16)
    expect(batch.mock.calls.map(([jid]) => jid)).toEqual([otherRoom, roomJid])
    expect(batch.mock.calls[1][1].map(occupant => occupant.show)).toEqual(['away', 'chat'])
  })

  it('preserves presence batching across avatar completions and reactions', () => {
    presence({ ...alice, show: 'away' })
    client.emit('room:occupant-avatar', { roomJid, nick: 'Alice', occupantId: 'alice-id', avatar: 'image', avatarHash: 'hash' })
    client.emit('room:reactions', { roomJid, messageId: 'message', reactorNick: 'Alice', emojis: ['👍'], isLive: true })
    presence({ ...alice, show: 'chat', avatarHash: 'hash' })
    expect(batch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0][1].map(occupant => occupant.show)).toEqual(['away', 'chat'])
    vi.advanceTimersByTime(200)
    expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')).toMatchObject({ show: 'chat', avatar: 'image' })
  })

  it('flushes every room on disconnect without leaving a pending timer', () => {
    const otherRoom = 'other@conference.example.test'
    roomStore.getState().addRoom(createMockRoom(otherRoom, { joined: true }))
    vi.runOnlyPendingTimers()
    presence({ ...alice, show: 'away' })
    client.emit('room:occupant-joined', { roomJid: otherRoom, occupant: alice })
    client.emit('connection:status', { status: 'offline' })
    expect(batch.mock.calls.map(([jid]) => jid)).toEqual([roomJid, otherRoom])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes accepted updates on unbinding and cancels the timer', () => {
    presence({ ...alice, show: 'away' })
    unsubscribe()
    expect(roomStore.getState().getRoom(roomJid)?.occupants.get('Alice')?.show).toBe('away')
    expect(vi.getTimerCount()).toBe(0)
  })
})
