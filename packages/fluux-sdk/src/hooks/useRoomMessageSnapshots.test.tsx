// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb'
import { useRoomMessageSnapshots } from './useRoomMessageSnapshots'
import { resolveRoomMessageSnapshot } from '../utils/roomMessageSnapshots'
import { connectionStore, roomStore } from '../stores'
import * as cache from '../utils/messageCache'
import { setStorageScopeJid } from '../utils/storageScope'
import type { RoomMessage } from '../core/types'

const ROOM = 'snapshots@conference.example.com'
const original: RoomMessage = {
  type: 'groupchat', roomJid: ROOM, id: 'client', stanzaId: 'archive',
  from: `${ROOM}/Alice`, nick: 'Alice', occupantId: 'alice',
  body: 'original body', timestamp: new Date(), isOutgoing: false,
}

const spam = { ...original, isRetracted: true, isModerated: true, moderationReason: 'Spam' }
const snapshots = [original]

function switchAccount(jid: string) {
  setStorageScopeJid(jid)
  roomStore.getState().switchAccount(jid)
  connectionStore.setState({ jid })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  switchAccount('first@example.com')
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
})
afterEach(() => vi.restoreAllMocks())

describe('room message snapshots', () => {
  it('tries the validated local alias after an unrelated wire-ID cache hit', async () => {
    const legacy = { ...original, stanzaId: 'foreign' }
    await cache.saveRoomMessage({ ...original, localRowRef: { id: legacy.id, occupantId: legacy.occupantId, stanzaId: legacy.stanzaId, unconfirmed: true } })
    await cache.saveRoomMessage({ ...original, isRetracted: true, isModerated: true, moderationReason: 'Spam' })
    const unrelated = { ...original, id: 'other-client', stanzaId: 'foreign', body: 'Keep B', timestamp: new Date(+original.timestamp + 1000) }

    await cache.saveRoomMessage(unrelated)
    expect(await cache.getRoomMessageByReference(ROOM, 'foreign', original.from)).toMatchObject({ id: unrelated.id })
    expect(await cache.getRoomMessageByRowRef(ROOM, { id: legacy.id, occupantId: legacy.occupantId, stanzaId: legacy.stanzaId, unconfirmed: true }))
      .toMatchObject({ stanzaId: original.stanzaId, isModerated: true })
    const indexReads = vi.spyOn(IDBIndex.prototype, 'getAll')
    const scans = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(await resolveRoomMessageSnapshot(legacy)).toMatchObject({ stanzaId: original.stanzaId, isModerated: true, moderationReason: 'Spam' })
    expect(indexReads.mock.calls.every(([query]) => query !== undefined && query !== null)).toBe(true)
    expect(scans).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps cache-only moderation scoped to the room and current account', async () => {
    await cache.saveRoomMessage(spam)
    const { result } = renderHook(() => useRoomMessageSnapshots(ROOM, snapshots))
    await waitFor(() => expect(result.current[0].isModerated).toBe(true))
    const otherRoom = { ...original, roomJid: 'other@conference.example.com', from: 'other@conference.example.com/Alice' }
    expect(await resolveRoomMessageSnapshot(otherRoom)).toEqual(otherRoom)
    act(() => switchAccount('second@example.com'))
    expect(result.current[0].isModerated).not.toBe(true)
    expect(await resolveRoomMessageSnapshot(original)).toEqual(original)
    await act(async () => {})
    expect(result.current[0].isModerated).not.toBe(true)
  })

  it.each(['resident', 'cache'])('rejects %s occupant, archive and author collisions', async source => {
    for (const fields of [
      { occupantId: 'other' },
      { stanzaId: 'other-archive' },
      { stanzaId: undefined, occupantId: 'other', from: `${ROOM}/Bob` },
    ]) {
      const collision = { ...spam, ...fields }
      if (source === 'resident') roomStore.setState({ messages: new Map([[ROOM, [collision]]]) })
      else { await cache.clearAllMessages(); await cache.saveRoomMessage(collision) }
      expect(await resolveRoomMessageSnapshot(original)).toEqual(original)
    }
  })

  it('retains moderation when the pending record is consumed by its cache write', async () => {
    await cache.saveRoomMessage(original)
    const { result } = renderHook(() => useRoomMessageSnapshots(ROOM, snapshots))
    await waitFor(() => expect(result.current[0].body).toBe(original.body))
    act(() => roomStore.getState().recordPendingRetraction(ROOM, original.stanzaId!, ROOM, undefined, {
      isModerated: true, moderationReason: 'Spam',
    }))
    expect(result.current[0].isModerated).toBe(true)
    await waitFor(() => expect(roomStore.getState().pendingRetractions.get(ROOM)).toBeUndefined())
    expect(result.current[0].isModerated).toBe(true)
    expect(await resolveRoomMessageSnapshot(original)).toMatchObject({ isModerated: true, moderationReason: 'Spam' })
    expect(snapshots).toEqual([original])
  })

  it('applies pending moderation arriving during a local read', async () => {
    let finish!: (message: RoomMessage) => void
    vi.spyOn(cache, 'getRoomMessageByRowRef').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const resolving = resolveRoomMessageSnapshot(original)
    roomStore.setState({ pendingRetractions: new Map([[ROOM, [{
      targetId: original.stanzaId!, actorJid: ROOM, retractedAt: Date.now(),
      moderation: { isModerated: true, moderationReason: 'Spam' },
    }]]]) })
    finish(original)
    expect(await resolving).toMatchObject({ isModerated: true, moderationReason: 'Spam' })
  })

  it('rejects an in-flight cache result after the account changes', async () => {
    let finish!: (message: RoomMessage) => void
    vi.spyOn(cache, 'getRoomMessageByRowRef').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const resolving = resolveRoomMessageSnapshot(original)
    const rejection = expect(resolving).rejects.toMatchObject({ name: 'AbortError' })
    switchAccount('second@example.com')
    finish(spam)
    await rejection
  })

  it('uses indexed local reads without fetching history or using the network', async () => {
    await cache.saveRoomMessage(spam)
    const fetch = vi.spyOn(globalThis, 'fetch')
    const history = vi.spyOn(roomStore.getState(), 'loadOlderMessagesFromCache')
    const indexReads = vi.spyOn(IDBIndex.prototype, 'getAll')
    const scans = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    expect(await resolveRoomMessageSnapshot(original)).toMatchObject({ isModerated: true })
    expect(indexReads).toHaveBeenCalled()
    expect(indexReads.mock.calls.every(([query]) => query !== undefined && query !== null)).toBe(true)
    expect(scans).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not subscribe an empty composer to resident message churn', async () => {
    const empty: RoomMessage[] = []
    let renders = 0
    renderHook(() => { renders++; return useRoomMessageSnapshots(ROOM, empty) })
    await act(async () => {})
    const before = renders
    act(() => roomStore.setState({ messages: new Map([[ROOM, [original]]]) }))
    expect(renders).toBe(before)
  })
})


it.each(['resident', 'pending'])('ignores unrelated traffic and retains relevant %s moderation through eviction', async source => {
  await cache.saveRoomMessage(original)
  const reads = vi.spyOn(cache, 'getRoomMessageByRowRef')
  let renders = 0
  const { result } = renderHook(() => { renders++; return useRoomMessageSnapshots(ROOM, snapshots) })
  await waitFor(() => expect(reads).toHaveResolvedTimes(1))
  await act(async () => {})
  const settled = result.current
  const settledRenders = renders
  const unrelated = { ...original, id: 'unrelated', stanzaId: 'unrelated-archive' }
  act(() => roomStore.setState({ messages: new Map([[ROOM, [unrelated]]]) }))
  act(() => roomStore.setState({ pendingRetractions: new Map([[ROOM, [{
    targetId: unrelated.stanzaId, actorJid: ROOM, retractedAt: Date.now(),
    moderation: { isModerated: true, moderationReason: 'Spam' },
  }]]]) }))
  await act(async () => {})
  expect(reads).toHaveBeenCalledTimes(1)
  expect(result.current).toBe(settled)
  expect(renders).toBe(settledRenders)
  act(() => {
    if (source === 'resident') roomStore.setState({ messages: new Map([[ROOM, [spam, unrelated]]]) })
    else roomStore.setState({ pendingRetractions: new Map([[ROOM, [{
      targetId: original.stanzaId!, actorJid: ROOM, retractedAt: Date.now(),
      moderation: { isModerated: true, moderationReason: 'Spam' },
    }]]]) })
  })
  expect(result.current[0]).toMatchObject({ isModerated: true, moderationReason: 'Spam' })
  act(() => roomStore.setState({ messages: new Map(), pendingRetractions: new Map() }))
  expect(result.current[0]).toMatchObject({ isModerated: true, moderationReason: 'Spam' })
  expect(reads).toHaveBeenCalledTimes(1)
  expect(snapshots).toEqual([original])
})
