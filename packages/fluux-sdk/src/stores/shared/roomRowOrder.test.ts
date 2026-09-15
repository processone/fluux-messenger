import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { roomStore } from '../roomStore'
import { connectionStore } from '../connectionStore'
import { createRoom } from '../roomStore.testHelpers'
import { localStorageMock } from '../../core/sideEffects.testHelpers'
import type { RoomMessage } from '../../core/types/room'
import * as cache from '../../utils/messageCache'
import { setStorageScopeJid } from '../../utils/storageScope'
import { backfillRoomStanzaId } from '../../utils/roomStanzaId'
import { messageRowRef } from '../../utils/messageIdentity'
import { sortMessagesByTimestamp } from './messageArrayUtils'
import { compareExact, exactPosition, isAfterBoundary, mayAdvanceTo } from './readState'
import { advance, makeReadPointer, pointerRowRef, serializeReadPointer, deserializeReadPointer, withArchiveId } from './readPointer'
import { onActivate, onMessageSeen, type EntityNotificationState } from './notificationState'
import { flush } from './throttledStorage'

const ROOM = 'order@conference.example.com'
const ACCOUNT = 'first@example.com'
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
function row(stanzaId: string, fields: Partial<RoomMessage> = {}): RoomMessage {
  const message: RoomMessage = { type: 'groupchat', roomJid: ROOM, from: `${ROOM}/Peer`, nick: 'Peer',
    id: 'shared', occupantId: 'peer', stanzaId, timestamp: new Date(1000), body: stanzaId, isOutgoing: false, ...fields }
  return { ...message }
}
const a = row('archive-a')
const b = row('archive-b', { isMention: true })
const count = (pointer: ReturnType<typeof makeReadPointer>) => cache.countRoomUnreadInArchive(ROOM, { floor: new Date(0), pointer: pointer.order })

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  localStorage.clear()
  setStorageScopeJid(ACCOUNT)
  roomStore.getState().reset()
  roomStore.getState().switchAccount(ACCOUNT)
  connectionStore.setState({ windowVisible: true })
})
afterEach(() => { flush(); roomStore.getState().reset(); cache._resetDBForTesting(); setStorageScopeJid(null) })

it('orders and counts distinct confirmed archive rows within one sender/client/occupant millisecond', async () => {
  expect(compareExact(exactPosition(a, 'room'), exactPosition(b, 'room'))).toBeLessThan(0)
  expect(sortMessagesByTimestamp([b, a], 'room')).toEqual([a, b])
  expect(compareExact(exactPosition(a, 'chat'), exactPosition(b, 'chat'))).toBe(0)
  await cache.saveRoomMessages([b, a])
  const first = makeReadPointer(a, 'room')
  expect(await count(first)).toEqual({ unread: 1 })
  const state = { unreadCount: 2, mentionsCount: 1, readPointer: first }
  expect(onActivate(state, [a, b], 'room').firstNewMessageRow).toEqual(messageRowRef(b))
  const seen = onMessageSeen(state, messageRowRef(b), [a, b], 'room')
  expect(seen.readPointer).not.toBe(first)
  expect(pointerRowRef(seen.readPointer!)).toEqual(messageRowRef(b))
  expect(await count(seen.readPointer!)).toEqual({ unread: 0 })
  expect(onMessageSeen(seen, messageRowRef(b), [a, b], 'room')).toBe(seen)
})

it('advances the real store and clears unread and mentions only after complete cache derivation', async () => {
  const bottom = row('bottom', { id: 'bottom', timestamp: new Date(0), isOutgoing: true })
  await cache.saveRoomMessages([bottom, b, a])
  roomStore.getState().addRoom(createRoom(ROOM, { unreadCount: 2, mentionsCount: 1, historyFloor: new Date(0) }), [a, b])
  roomStore.setState({ activeRoomJid: null, windowAtLiveEdge: new Map([[ROOM, false]]),
    mamQueryStates: new Map([[ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true }]]),
    roomCoverage: new Map([[ROOM, { bottomId: bottom.stanzaId! }]]) })
  roomStore.getState().advanceReadPointer(ROOM, messageRowRef(a))
  await roomStore.getState().recomputeUnreadForRoom(ROOM)
  expect(roomStore.getState().roomMeta.get(ROOM)).toMatchObject({ unreadCount: 1, mentionsCount: 1 })
  const first = roomStore.getState().roomMeta.get(ROOM)!.readPointer!
  roomStore.getState().advanceReadPointer(ROOM, messageRowRef(b))
  await roomStore.getState().recomputeUnreadForRoom(ROOM)
  const last = roomStore.getState().roomMeta.get(ROOM)!.readPointer!
  expect(last).not.toBe(first)
  expect(roomStore.getState().rooms.get(ROOM)).toMatchObject({ unreadCount: 0, mentionsCount: 0 })
  flush()
  setStorageScopeJid('second@example.com')
  roomStore.getState().switchAccount('second@example.com')
  roomStore.getState().addRoom(createRoom(ROOM))
  expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBeUndefined()
  setStorageScopeJid(ACCOUNT)
  roomStore.getState().switchAccount(ACCOUNT)
  roomStore.getState().addRoom(createRoom(ROOM))
  expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toEqual(last)
})

it('round-trips local order and preserves it through validated confirmation and name convergence', () => {
  const legacy = { ...a, stanzaId: undefined }
  const confirmed = backfillRoomStanzaId(legacy, row('actual', { body: legacy.body }))
  const pointer = makeReadPointer(legacy, 'room')
  expect(exactPosition(confirmed, 'room')).toEqual(pointer.order)
  for (const source of [pointer, serializeReadPointer(pointer)]) {
    expect(deserializeReadPointer(JSON.parse(JSON.stringify(source)))).toEqual(pointer)
  }
  const local = makeReadPointer({ ...legacy, stanzaId: undefined }, 'room')
  const enriched = withArchiveId(local, 'actual')
  expect(enriched.order).toBe(local.order)
  expect(deserializeReadPointer(serializeReadPointer(enriched))!.order).toEqual(local.order)
})

it('preserves old pointer progress conservatively until the named row or a later millisecond is read', async () => {
  await cache.saveRoomMessages([a, b])
  const raw = serializeReadPointer(makeReadPointer(a, 'room'))
  if (raw.order.role !== 'exact') throw new Error('Expected exact pointer')
  delete (raw.order.tiebreak as { row?: string }).row
  const old = deserializeReadPointer(JSON.parse(JSON.stringify(raw)))!
  expect(old.order.timestamp).toBe(1000)
  expect(await count(old)).toEqual({ unread: 2 })
  const state: EntityNotificationState = { readPointer: old, unreadCount: 2, mentionsCount: 1 }
  expect(onMessageSeen(state, messageRowRef(b), [a, b], 'room')).toBe(state)
  const refined = onMessageSeen(state, messageRowRef(a), [a, b], 'room')
  expect(refined.readPointer!.identity).toBe(old.identity)
  expect(refined.readPointer!.order.timestamp).toBe(old.order.timestamp)
  expect(await count(refined.readPointer!)).toEqual({ unread: 1 })
  expect(advance(old, makeReadPointer(a, 'room'))).toBe(old)
  expect(advance(makeReadPointer(a, 'room'), old)).toBe(old)
  const uncertain = { ...a, body: 'Uncertain collision' }
  const { unconfirmed: _flag, ...oldIdentity } = old.identity
  const ambiguous = { ...state, readPointer: { ...old, identity: oldIdentity } }
  expect(onMessageSeen(ambiguous, messageRowRef(a), [uncertain, a], 'room')).toBe(ambiguous)
  const later = row('later', { id: 'later', timestamp: new Date(1001) })
  const advanced = onMessageSeen(ambiguous, messageRowRef(later), [uncertain, a, b, later], 'room')
  expect(advanced.readPointer!.order.timestamp).toBe(1001)
  expect(isAfterBoundary(exactPosition(b, 'room'), advanced.readPointer!.order)).toBe(false)
})

it.each([true, false])('keeps the same read boundary for an old unconfirmed=%s order key', unconfirmed => {
  const message = row('cached-archive')
  const current = exactPosition(message, 'room')
  if (current.tiebreak.kind !== 'room') throw new Error('Expected a room order')
  const saved = { ...current, tiebreak: { ...current.tiebreak, row: JSON.stringify([message.stanzaId, unconfirmed]) } }
  expect(compareExact(current, saved)).toBe(0)
  expect(isAfterBoundary(current, saved)).toBe(false)
  expect(mayAdvanceTo(current, saved)).toBe(false)
})
