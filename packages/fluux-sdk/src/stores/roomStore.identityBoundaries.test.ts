import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { roomStore } from './roomStore'
import { connectionStore } from './connectionStore'
import { createRoom } from './roomStore.testHelpers'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import type { RoomMessage } from '../core/types'
import { setStorageScopeJid } from '../utils/storageScope'
import { backfillRoomStanzaId } from '../utils/roomStanzaId'
import { _clearRetractedIdentitiesForTesting } from '../utils/retractedIdentities'
import { findMessageRowIndex, messageRowRef } from '../utils/messageIdentity'
import { deserializeReadPointer, makeReadPointer, pointerRowRef, serializeReadPointer } from './shared/readPointer'
import { exactPosition } from './shared/readState'
import { currentViewportGeneration, reportViewport } from './shared/viewportEvidence'
import { transientCounts, _clearAllTransientForTesting } from './shared/transientUnread'
import { flush } from './shared/throttledStorage'
import * as cache from '../utils/messageCache'

vi.mock('../utils/messageCache', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return { ...actual, saveRoomMessageWithResult: vi.fn(actual.saveRoomMessageWithResult), saveRoomMessages: vi.fn(actual.saveRoomMessages) }
})
const saveOne = vi.mocked(cache.saveRoomMessageWithResult).getMockImplementation()!
const saveBatch = vi.mocked(cache.saveRoomMessages).getMockImplementation()!
const ROOM = 'identity@conference.example.com'
const ACCOUNT = 'review@example.com'
const key = { accountScope: ACCOUNT, kind: 'room' as const, entityId: ROOM }
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
function row(stanzaId: string, fields: Partial<RoomMessage> = {}): RoomMessage {
  const message: RoomMessage = { type: 'groupchat', roomJid: ROOM, from: ROOM + '/Peer', nick: 'Peer', occupantId: 'peer',
    id: 'shared', stanzaId, body: stanzaId, timestamp: new Date(1000), isOutgoing: false, ...fields }
  return { ...message }
}
const a = row('archive-a')
const b = row('archive-b', { isMention: true })
const bottom = row('bottom', { id: 'bottom', timestamp: new Date(1), isOutgoing: true })
function deferred() {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>(done => { resolve = done })
  return { promise, resolve }
}
function completeCoverage() {
  roomStore.getState().updateRoom(ROOM, { historyFloor: new Date(0) })
  roomStore.setState({ mamQueryStates: new Map([[ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true }]]),
    roomCoverage: new Map([[ROOM, { bottomId: bottom.stanzaId! }]]) })
}
beforeEach(async () => {
  cache._resetDBForTesting()
  _clearRetractedIdentitiesForTesting()
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  setStorageScopeJid(ACCOUNT)
  roomStore.getState().reset()
  roomStore.getState().switchAccount(ACCOUNT)
  _clearAllTransientForTesting()
  vi.mocked(cache.saveRoomMessageWithResult).mockReset().mockImplementation(saveOne)
  vi.mocked(cache.saveRoomMessages).mockReset().mockImplementation(saveBatch)
  connectionStore.setState({ windowVisible: true })
  roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
  await saveBatch([bottom])
  completeCoverage()
})
afterEach(() => { flush(); roomStore.getState().reset(); cache._resetDBForTesting(); setStorageScopeJid(null) })

it('mints a complete confirmed live-edge pointer and restores the same row after persistence', async () => {
  const uncertain = { ...b, stanzaId: 'earlier-archive', timestamp: new Date(500), body: 'Earlier uncertain A' }
  roomStore.setState({ messages: new Map([[ROOM, [uncertain]]]) })
  roomStore.getState().setActiveRoom(ROOM)
  reportViewport(key, currentViewportGeneration(key), 'at-edge')
  await roomStore.getState().addMessage(ROOM, b)
  const pointer = roomStore.getState().roomMeta.get(ROOM)!.readPointer!
  expect(pointer).toEqual(makeReadPointer(b, 'room'))
  expect(findMessageRowIndex(roomStore.getState().messages.get(ROOM)!, pointerRowRef(pointer))).toBe(1)
  await vi.waitFor(async () => expect(await cache.getRoomMessageByRowRef(ROOM, messageRowRef(b))).not.toBeNull())
  const restored = deserializeReadPointer(JSON.parse(JSON.stringify(serializeReadPointer(pointer))))!
  expect(await roomStore.getState().loadMessagesAroundFromCache(ROOM, pointerRowRef(restored), { before: 0, after: 0 })).toMatchObject([b])
  const state = roomStore.getState()
  state.advanceReadPointer(ROOM, messageRowRef(b))
  expect(roomStore.getState()).toBe(state)
  flush()
  setStorageScopeJid('other@example.com')
  roomStore.getState().switchAccount('other@example.com')
  roomStore.getState().addRoom(createRoom(ROOM))
  expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBeUndefined()
  setStorageScopeJid(ACCOUNT)
  roomStore.getState().switchAccount(ACCOUNT)
  roomStore.getState().addRoom(createRoom(ROOM))
  expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toEqual(pointer)
})

it('keeps a validated legacy alias order through live notification construction', async () => {
  const legacy = { ...a, stanzaId: undefined }
  const confirmed = backfillRoomStanzaId(legacy, a)
  roomStore.getState().setActiveRoom(ROOM)
  reportViewport(key, currentViewportGeneration(key), 'at-edge')
  await roomStore.getState().addMessage(ROOM, confirmed)
  const pointer = roomStore.getState().roomMeta.get(ROOM)!.readPointer!
  expect(pointer.order).toEqual(exactPosition(legacy, 'room'))
  expect(pointerRowRef(pointer)).toEqual(messageRowRef(confirmed))
  expect(findMessageRowIndex([confirmed], pointerRowRef(pointer))).toBe(0)
})

it.each(['single', 'batch', 'moderation'] as const)('keeps B transient after %s removes only A', async method => {
  connectionStore.setState({ windowVisible: false })
  const writeA = deferred()
  const writeB = deferred()
  vi.mocked(cache.saveRoomMessageWithResult).mockImplementationOnce(() => writeA.promise).mockImplementationOnce(() => writeB.promise)
  await roomStore.getState().addMessage(ROOM, a)
  await roomStore.getState().addMessage(ROOM, b, { incrementMentions: true })
  expect(transientCounts(key, undefined)).toEqual({ unread: 2 })
  expect(roomStore.getState().roomMeta.get(ROOM)).toMatchObject({ unreadCount: 2, mentionsCount: 1 })
  await roomStore.getState().addMessage(ROOM, { ...b })
  expect(transientCounts(key, undefined)).toEqual({ unread: 2 })
  if (method === 'single') {
    await saveOne(a)
    writeA.resolve(true)
  } else if (method === 'batch') {
    roomStore.setState({ messages: new Map([[ROOM, [b]]]) })
    roomStore.getState().mergeRoomMAMMessages(ROOM, [a], { first: a.stanzaId, last: a.stanzaId }, true, 'backward')
    await vi.waitFor(() => expect(transientCounts(key, undefined)).toEqual({ unread: 1 }))
    writeA.resolve(false)
  } else {
    roomStore.getState().updateMessage(ROOM, a.stanzaId!, { isRetracted: true, retractedAt: new Date(2000), moderationReason: 'Spam', moderatedBy: ROOM })
    writeA.resolve(false)
  }
  writeB.resolve(false)
  await vi.waitFor(() => expect(transientCounts(key, undefined)).toEqual({ unread: 1 }))
  completeCoverage()
  connectionStore.setState({ windowVisible: true })
  if (method === 'batch') await roomStore.getState().loadMessagesAroundFromCache(ROOM, messageRowRef(a))
  roomStore.getState().advanceReadPointer(ROOM, messageRowRef(a))
  await roomStore.getState().recomputeUnreadForRoom(ROOM)
  expect(roomStore.getState().rooms.get(ROOM)).toMatchObject({ unreadCount: 1, mentionsCount: 1 })
  roomStore.getState().advanceReadPointer(ROOM, messageRowRef(b))
  await roomStore.getState().recomputeUnreadForRoom(ROOM)
  expect(roomStore.getState().rooms.get(ROOM)).toMatchObject({ unreadCount: 0, mentionsCount: 0 })
})

it('preserves uncertain transient collisions while deduplicating genuine confirmation and pending replay', async () => {
  connectionStore.setState({ windowVisible: false })
  vi.mocked(cache.saveRoomMessageWithResult).mockResolvedValue(false)
  const legacy = { ...a, stanzaId: 'actual-a', body: 'Legacy A', timestamp: new Date(500) }
  await roomStore.getState().addMessage(ROOM, legacy)
  await roomStore.getState().addMessage(ROOM, b)
  expect(transientCounts(key, undefined)).toEqual({ unread: 2 })
  const confirmed = row('actual-a', { body: legacy.body, timestamp: legacy.timestamp })
  await roomStore.getState().addMessage(ROOM, confirmed)
  expect(transientCounts(key, undefined)).toEqual({ unread: 2 })
  roomStore.getState().updateMessage(ROOM, confirmed.stanzaId!, { isRetracted: true, retractedAt: new Date(2000), moderationReason: 'Spam', moderatedBy: ROOM })
  expect(transientCounts(key, undefined)).toEqual({ unread: 1 })
  await roomStore.getState().addMessage(ROOM, { ...confirmed, isDelayed: true })
  expect(transientCounts(key, undefined)).toEqual({ unread: 1 })
  expect(roomStore.getState().messages.get(ROOM)?.find(message => message.stanzaId === confirmed.stanzaId)?.isRetracted).toBe(true)
})

it('retires only a validated backfill after its archive patch commits', async () => {
  connectionStore.setState({ windowVisible: false })
  roomStore.setState({ activeRoomJid: ROOM })
  vi.mocked(cache.saveRoomMessageWithResult).mockResolvedValue(false)
  const legacy = { ...a, stanzaId: undefined }
  await roomStore.getState().addMessage(ROOM, legacy)
  await roomStore.getState().addMessage(ROOM, b)
  const gate = deferred()
  let written: RoomMessage[] = []
  vi.mocked(cache.saveRoomMessages).mockImplementationOnce(messages => { written = messages; return gate.promise })
  roomStore.getState().mergeRoomMAMMessages(ROOM, [a], { first: a.stanzaId, last: a.stanzaId }, true, 'backward')
  expect(written).toHaveLength(1)
  expect(written[0].localRowRef).toEqual(messageRowRef(legacy))
  expect(transientCounts(key, undefined)).toEqual({ unread: 2 })
  expect(await saveBatch(written)).toBe(true)
  gate.resolve(true)
  await vi.waitFor(() => expect(transientCounts(key, undefined)).toEqual({ unread: 1 }))
  expect((await cache.getRoomMessageByRowRef(ROOM, messageRowRef(a)))?.stanzaId).toBe(a.stanzaId)
  expect(transientCounts(key, makeReadPointer(a, 'room').order)).toEqual({ unread: 1 })
})

it.each([undefined, 'different original', 'archive-a'])('preserves another archive entry even when original content matches (%s)', async originalBody => {
  const legacy = { ...a, stanzaId: 'different-archive', body: 'edited content', originalBody, isEdited: true }
  await cache.saveRoomMessages([legacy, a])
  const rows = (await cache.getRoomMessages(ROOM)).filter(message => message.id === a.id)
  expect(rows).toHaveLength(2)
  expect(rows.find(message => message.stanzaId === legacy.stanzaId)).toMatchObject({ body: legacy.body })
  expect(rows.find(message => message.stanzaId === a.stanzaId)).toMatchObject({ body: a.body })
})
