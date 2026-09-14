import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setupMdsSideEffects } from './mdsSideEffects'
import { localStorageMock } from './sideEffects.testHelpers'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { createRoom } from '../stores/roomStore.testHelpers'
import { makeReadPointer, pointerRowRef, serializeReadPointer, deserializeReadPointer, type ReadPointer } from '../stores/shared/readPointer'
import { flush } from '../stores/shared/throttledStorage'
import { findMessageRowIndex, messageRowRef } from '../utils/messageIdentity'
import { backfillRoomStanzaId, roomStanzaIdAuthority } from '../utils/roomStanzaId'
import { setStorageScopeJid } from '../utils/storageScope'
import * as cache from '../utils/messageCache'
import type { RoomMessage } from './types'

const ACCOUNT = 'review@example.com'
const ROOM = 'mds@conference.example.com'
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
let cleanup: (() => void) | undefined

function row(stanzaId: string | undefined, time: number, confirmed = true): RoomMessage {
  const message: RoomMessage = { type: 'groupchat', roomJid: ROOM, from: ROOM + '/Peer', nick: 'Peer',
    occupantId: 'peer', id: 'shared', stanzaId, body: 'Message ' + time, timestamp: new Date(time), isOutgoing: false }
  return { ...message, stanzaIdAuthority: confirmed ? roomStanzaIdAuthority(message, ACCOUNT) : undefined }
}

function pointer(value: ReadPointer) {
  roomStore.getState().updateRoom(ROOM, { readPointer: value })
}

function startPublisher() {
  const handlers = new Map<string, Array<(payload?: unknown) => void>>()
  const subscribe = (event: string, handler: (payload?: unknown) => void) => {
    handlers.set(event, [...handlers.get(event) ?? [], handler])
    return () => handlers.set(event, (handlers.get(event) ?? []).filter(candidate => candidate !== handler))
  }
  const mds = { fetchAllDisplayedResult: vi.fn().mockResolvedValue({ status: 'authoritative', markers: [] }),
    publishDisplayed: vi.fn().mockResolvedValue(undefined), retractDisplayed: vi.fn().mockResolvedValue(undefined) }
  const client = { subscribe, internal: { on: subscribe, mds } }
  cleanup = setupMdsSideEffects(client as never)
  handlers.get('online')?.forEach(handler => handler())
  return { ...mds, emit: (event: string, payload: unknown) => handlers.get(event)?.forEach(handler => handler(payload)) }
}

async function drain() {
  for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve))
  await vi.advanceTimersByTimeAsync(1600)
}

beforeEach(() => {
  cache._resetDBForTesting()
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  setStorageScopeJid(ACCOUNT)
  roomStore.getState().reset()
  roomStore.getState().switchAccount(ACCOUNT)
  connectionStore.setState({ status: 'online', jid: ACCOUNT + '/test', windowVisible: true })
  roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  cleanup?.(); cleanup = undefined
  flush(); roomStore.getState().reset(); cache._resetDBForTesting(); setStorageScopeJid(null)
  vi.useRealTimers(); vi.restoreAllMocks()
})

it.each(['resident', 'preview', 'cache'] as const)('does not publish unread B for local A through %s resolution', async source => {
  const a = row(undefined, 1000, false)
  const b = row('archive-b', 2000)
  if (source === 'resident') roomStore.setState({ messages: new Map([[ROOM, [b]]]) })
  if (source === 'preview') roomStore.getState().updateRoom(ROOM, { lastMessage: b })
  if (source === 'cache') await cache.saveRoomMessages([b])
  pointer(makeReadPointer(a, 'room'))
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
  roomStore.setState({ messages: new Map([[ROOM, [a, b]]]) })
  roomStore.getState().advanceReadPointer(ROOM, messageRowRef(b))
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'archive-b', ROOM]])
  const state = roomStore.getState()
  state.advanceReadPointer(ROOM, messageRowRef(b))
  expect(roomStore.getState()).toBe(state)
  await drain()
  expect(publisher.publishDisplayed).toHaveBeenCalledTimes(1)
})

it('withholds an uncertain addressable pointer until confirmed B is actually read', async () => {
  const a = row('foreign', 1000, false)
  const b = row('foreign', 2000)
  roomStore.setState({ messages: new Map([[ROOM, [a, b]]]) })
  pointer(makeReadPointer(a, 'room'))
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
  roomStore.getState().advanceReadPointer(ROOM, messageRowRef(b))
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'foreign', ROOM]])
})

it.each(['resident', 'preview', 'cache'] as const)('publishes a validated legacy alias through %s without changing its order', async source => {
  const a = row('foreign', 1000, false)
  const canonical = backfillRoomStanzaId(a, row('actual', 1000))
  const b = row('foreign', 2000)
  const saved = makeReadPointer(a, 'room')
  if (source === 'resident') roomStore.setState({ messages: new Map([[ROOM, [b, canonical]]]) })
  if (source === 'preview') roomStore.getState().updateRoom(ROOM, { lastMessage: canonical })
  if (source === 'cache') await cache.saveRoomMessages([b, canonical])
  pointer(saved)
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'actual', ROOM]])
  expect(roomStore.getState().roomMeta.get(ROOM)!.readPointer).toBe(saved)
})

it('keeps incoming markers pending until a confirmed owner is present', async () => {
  const a = row('same', 1000, false)
  const b = row('same', 2000)
  roomStore.setState({ messages: new Map([[ROOM, [a]]]) })
  roomStore.getState().applyRemoteDisplayed(ROOM, 'same')
  expect(roomStore.getState().roomMeta.get(ROOM)).toMatchObject({ pendingRemoteDisplayedStanzaId: 'same', readPointer: undefined })
  const pending = roomStore.getState()
  pending.applyRemoteDisplayed(ROOM, 'same')
  expect(roomStore.getState()).toBe(pending)
  roomStore.setState({ messages: new Map([[ROOM, [a, b]]]) })
  roomStore.getState().applyRemoteDisplayed(ROOM, 'same')
  const meta = roomStore.getState().roomMeta.get(ROOM)!
  expect(meta.pendingRemoteDisplayedStanzaId).toBeUndefined()
  expect(findMessageRowIndex([a, b], pointerRowRef(meta.readPointer!))).toBe(1)
})

it('retries an unresolved local pointer after validated cache confirmation with the same order', async () => {
  const a = row(undefined, 1000, false)
  const b = row('unread', 1000)
  const saved = makeReadPointer(a, 'room')
  pointer(saved)
  await cache.saveRoomMessages([b])
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
  const confirmed = backfillRoomStanzaId(a, { ...row('actual', 1000), body: a.body })
  await cache.saveRoomMessages([confirmed])
  roomStore.getState().updateRoom(ROOM, { unreadCount: 1 })
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'actual', ROOM]])
  expect(roomStore.getState().roomMeta.get(ROOM)!.readPointer).toBe(saved)
})

it('keeps old saved references usable only through the validated alias', async () => {
  const a = row('foreign', 1000, false)
  const confirmed = backfillRoomStanzaId(a, row('actual', 1000))
  const saved = makeReadPointer(a, 'room')
  const { unconfirmed: _flag, ...identity } = saved.identity
  const { row: _row, ...tiebreak } = saved.order.role === 'exact' && saved.order.tiebreak.kind === 'room'
    ? saved.order.tiebreak : { kind: 'room' as const, from: a.from, id: a.id }
  const legacy: ReadPointer = { order: { role: 'exact', timestamp: 1000, tiebreak }, identity }
  pointer(legacy)
  await cache.saveRoomMessages([row('foreign', 2000), confirmed])
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'actual', ROOM]])
  expect(roomStore.getState().roomMeta.get(ROOM)!.readPointer).toBe(legacy)
})

it('does not infer confirmation for an old pointer from a colliding wire ID and millisecond', async () => {
  const a = row('same', 1000, false)
  const b = { ...row('same', 1000), body: 'Distinct confirmed B' }
  const legacy: ReadPointer = { identity: { state: 'addressable', messageId: a.id, occupantId: a.occupantId, archiveId: 'same' },
    order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: a.from, id: a.id, occupantId: a.occupantId } } }
  roomStore.setState({ messages: new Map([[ROOM, [b]]]) })
  pointer(legacy)
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
  roomStore.getState().advanceReadPointer(ROOM, messageRowRef(b))
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'same', ROOM]])
})

it('discards a cache resolution across an account switch', async () => {
  const a = row(undefined, 1000, false)
  const confirmed = backfillRoomStanzaId(a, row('actual', 1000))
  let resolve!: (value: RoomMessage[] | null) => void
  const gate = new Promise<RoomMessage[] | null>(done => { resolve = done })
  const lookup = vi.spyOn(cache, 'getRoomMessageCandidates').mockReturnValue(gate)
  pointer(makeReadPointer(a, 'room'))
  const publisher = startPublisher()
  await drain()
  expect(lookup).toHaveBeenCalled()
  setStorageScopeJid('other@example.com')
  roomStore.getState().switchAccount('other@example.com')
  connectionStore.setState({ jid: 'other@example.com/test' })
  resolve([confirmed])
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
})

it.each(['room', 'account'] as const)('rejects incoming and outgoing authority from another %s', async other => {
  const b = row('same', 2000)
  const foreign = other === 'account'
    ? { ...b, stanzaIdAuthority: roomStanzaIdAuthority(b, 'other@example.com') }
    : { ...b, roomJid: 'other@conference.example.com', from: 'other@conference.example.com/Peer' }
  if (other === 'room') foreign.stanzaIdAuthority = roomStanzaIdAuthority(foreign, ACCOUNT)
  roomStore.setState({ messages: new Map([[ROOM, [foreign]]]) })
  pointer(makeReadPointer(foreign, 'room'))
  const saved = roomStore.getState().roomMeta.get(ROOM)!.readPointer
  roomStore.getState().applyRemoteDisplayed(ROOM, 'same')
  expect(roomStore.getState().roomMeta.get(ROOM)).toMatchObject({ pendingRemoteDisplayedStanzaId: 'same', readPointer: saved })
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
})

it('keeps the newest preview through older cursor invalidation, eviction and Spam moderation', async () => {
  const a = row('archive-a', 1000)
  const b = row('archive-b', 2000)
  await cache.saveRoomMessages([a, b])
  roomStore.getState().setActiveRoom(ROOM)
  roomStore.setState({ messages: new Map([[ROOM, [a, b]]]) })
  roomStore.getState().updateRoom(ROOM, { lastMessage: b })
  roomStore.getState().clearMessageStanzaId(ROOM, a.stanzaId!)
  expect(roomStore.getState().roomMeta.get(ROOM)!.lastMessage).toBe(b)
  expect(roomStore.getState().rooms.get(ROOM)!.lastMessage).toBe(b)
  await roomStore.getState().activateRoom(null)
  expect(roomStore.getState().messages.get(ROOM) ?? []).toEqual([])
  roomStore.getState().recordPendingRetraction(ROOM, b.stanzaId!, ROOM, undefined,
    { isModerated: true, moderatedBy: ROOM, moderationReason: 'Spam' })
  expect(roomStore.getState().roomMeta.get(ROOM)!.lastMessage).toMatchObject({ stanzaId: b.stanzaId, isRetracted: true, moderationReason: 'Spam' })
  await drain()
  expect((await cache.getRoomMessages(ROOM)).find(message => message.body === a.body)?.isRetracted).not.toBe(true)
})

it.each([false, true])('publishes a confirmed pointer without a local row, cache available: %s', async available => {
  vi.spyOn(cache, 'isMessageCacheAvailable').mockReturnValue(available)
  const lookup = vi.spyOn(cache, 'getRoomMessageCandidates')
  const saved = makeReadPointer(row('confirmed-read', 1000), 'room')
  pointer(saved)
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'confirmed-read', ROOM]])
  expect(lookup).not.toHaveBeenCalled()
  expect(roomStore.getState().roomMeta.get(ROOM)!.readPointer).toBe(saved)
})

it('withholds a confirmed pointer when the storage account differs from the session', async () => {
  pointer(makeReadPointer(row('confirmed-read', 1000), 'room'))
  setStorageScopeJid('other@example.com')
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
})

it.each(['resident', 'preview', 'cache'] as const)('resolves an older occupant-less pointer only at its validated occurrence through %s', async source => {
  const legacy = row(undefined, 1000, false)
  const canonical = backfillRoomStanzaId(legacy, row('actual', 1000))
  const newer = row('unread', 2000)
  const saved: ReadPointer = {
    identity: { state: 'local', messageId: legacy.id },
    order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: legacy.from, id: legacy.id } },
  }
  const put = async (messages: RoomMessage[]) => {
    if (source === 'resident') roomStore.setState({ messages: new Map([[ROOM, messages]]) })
    if (source === 'preview') roomStore.getState().updateRoom(ROOM, { lastMessage: messages.at(-1) })
    if (source === 'cache') await cache.saveRoomMessages(messages)
    roomStore.getState().updateRoom(ROOM, { unreadCount: messages.length })
  }
  await put([newer])
  pointer(saved)
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
  await put([newer, canonical])
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'actual', ROOM]])
  expect(roomStore.getState().roomMeta.get(ROOM)!.readPointer).toBe(saved)
})

it('retains account-bound publication evidence when a confirmed pointer is restored', async () => {
  const minted = makeReadPointer(row('confirmed-read', 1000), 'room')
  const restored = deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(minted))))!
  expect(restored).toEqual(minted)
  pointer(restored)
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'confirmed-read', ROOM]])
})

it.each(['resident', 'cache'] as const)('withholds an occupant-less pointer with ambiguous validated aliases in %s', async source => {
  const legacy = row(undefined, 1000, false)
  const a = backfillRoomStanzaId(legacy, row('archive-a', 1000))
  const other = { ...legacy, occupantId: 'other' }
  const donor = { ...row('archive-b', 1000), occupantId: 'other' }
  const b = backfillRoomStanzaId(other, { ...donor, stanzaIdAuthority: roomStanzaIdAuthority(donor, ACCOUNT) })
  if (source === 'resident') {
    roomStore.setState({ messages: new Map([[ROOM, [a, b]]]) })
    // A cached copy of only one candidate must not override the resident ambiguity.
    await cache.saveRoomMessages([a])
  } else await cache.saveRoomMessages([a, b])
  pointer({ identity: { state: 'local', messageId: legacy.id },
    order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: legacy.from, id: legacy.id } } })
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
})


it.each(['only-a', 'only-b', 'preview-a', 'split', 'resident-preview'] as const)(
  'withholds an incomplete pointer across all local candidates: %s', async source => {
    const legacy = row(undefined, 1000, false)
    const a = backfillRoomStanzaId(legacy, row('archive-a', 1000))
    const other = { ...legacy, occupantId: 'other' }
    const donor = { ...row('archive-b', 1000), occupantId: 'other' }
    const b = backfillRoomStanzaId(other, { ...donor, stanzaIdAuthority: roomStanzaIdAuthority(donor, ACCOUNT) })
    await cache.saveRoomMessages(source === 'split' ? [b] : source === 'resident-preview' ? [] : [a, b])
    roomStore.setState({ messages: new Map([[ROOM, source === 'only-b' ? [b] : source === 'preview-a' ? [] : [a]]]) })
    if (source === 'preview-a' || source === 'resident-preview') roomStore.getState().updateRoom(ROOM, { lastMessage: source === 'preview-a' ? a : b })
    const saved: ReadPointer = { identity: { state: 'local', messageId: legacy.id },
      order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: legacy.from, id: legacy.id } } }
    pointer(saved)
    const publisher = startPublisher()
    await drain()
    expect(publisher.publishDisplayed).not.toHaveBeenCalled()
    expect(roomStore.getState().roomMeta.get(ROOM)!.readPointer).toBe(saved)
  },
)

it('does not treat failed cache access as an empty candidate set', async () => {
  const legacy = row(undefined, 1000, false)
  const canonical = backfillRoomStanzaId(legacy, row('actual', 1000))
  roomStore.setState({ messages: new Map([[ROOM, [canonical]]]) })
  cache._resetDBForTesting()
  const open = vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => { throw new Error('Unavailable') })
  pointer(makeReadPointer(legacy, 'room'))
  const publisher = startPublisher()
  await drain()
  expect(publisher.publishDisplayed).not.toHaveBeenCalled()
  open.mockRestore()
  cache._resetDBForTesting()
  roomStore.getState().updateRoom(ROOM, { unreadCount: 1 })
  await drain()
  expect(publisher.publishDisplayed.mock.calls).toEqual([[ROOM, 'actual', ROOM]])
})
