// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { useReferencedMessage } from './useReferencedMessage'
import { connectionStore, roomStore } from '../stores'
import * as cache from '../utils/messageCache'
import { _clearRetractedIdentitiesForTesting } from '../utils/retractedIdentities'
import { setStorageScopeJid } from '../utils/storageScope'
import type { RoomMessage } from '../core/types'

const ROOM = 'reply-cache@conference.example.com'
const original: RoomMessage = {
  type: 'groupchat', roomJid: ROOM, id: 'client', stanzaId: 'archive',
  from: `${ROOM}/Alice`, nick: 'Alice', occupantId: 'alice',
  body: 'spam', timestamp: new Date(), isOutgoing: false,
  isRetracted: true, isModerated: true, moderationReason: 'Spam', moderatedBy: `${ROOM}/Mod`,
}

function switchAccount(jid: string) {
  setStorageScopeJid(jid)
  roomStore.getState().switchAccount(jid)
  connectionStore.setState({ jid })
}

beforeEach(() => {
  _clearRetractedIdentitiesForTesting()
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  switchAccount('first@example.com')
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
})

it('resolves cached Spam past an resident client-ID collision and preserves the legacy quotation', async () => {
  await cache.saveRoomMessage(original)
  const legacy = { ...original, id: original.stanzaId!, stanzaId: 'legacy-archive', from: `${ROOM}/Bob`,
    occupantId: 'bob', body: 'Keep legacy quotation', isRetracted: false, isModerated: false, moderationReason: undefined }
  await cache.saveRoomMessage(legacy)
  roomStore.setState({ messages: new Map([[ROOM, [legacy]]]) })
  const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
    id: original.stanzaId, from: original.from, cache: true }))
  await waitFor(() => expect(result.current).toMatchObject({ id: original.id, body: '', isRetracted: true, moderationReason: 'Spam' }))
  const quote = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
    id: legacy.stanzaId, from: legacy.from, cache: true }))
  await waitFor(() => expect(quote.result.current).toMatchObject({ id: legacy.id, body: legacy.body, isRetracted: false }))
  expect(roomStore.getState().messages.get(ROOM)).toEqual([legacy])
})

describe('cached room reply references', () => {
  it('preserves client-id resolution for callers using the resident-only API', () => {
    roomStore.setState({ messages: new Map([[ROOM, [original]]]) })
    const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM, id: original.id }))
    expect(result.current).toBe(original)
  })

  it('applies known moderation before its cache write completes', async () => {
    await cache.saveRoomMessage({ ...original, isRetracted: false, isModerated: false, moderationReason: undefined })
    const { result } = renderHook(() => useReferencedMessage({
      type: 'groupchat', roomJid: ROOM, id: original.stanzaId, from: original.from, cache: true,
    }))
    await waitFor(() => expect(result.current?.isRetracted).toBe(false))
    act(() => roomStore.setState({ pendingRetractions: new Map([[ROOM, [{
      targetId: original.stanzaId!, actorJid: ROOM, retractedAt: Date.now(),
      moderation: { isModerated: true, moderationReason: 'Spam' },
    }]]]) }))
    await waitFor(() => expect(result.current).toMatchObject({ isRetracted: true, moderationReason: 'Spam' }))
  })

  it('waits for local cache knowledge and resolves a Spam target after resident history is cleared', async () => {
    await cache.saveRoomMessage(original)
    const { result } = renderHook(() => useReferencedMessage({
      type: 'groupchat', roomJid: ROOM, id: 'archive', from: original.from, cache: true,
    }))
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toMatchObject({
      id: original.id, isRetracted: true, isModerated: true, moderationReason: 'Spam', moderatedBy: original.moderatedBy,
    }))
    expect(roomStore.getState().messages.get(ROOM)).toBeUndefined()
  })

  it.each(['client', 'origin'])('does not use a different author with a colliding %s id as moderation evidence', async id => {
    await cache.saveRoomMessage({ ...original, originId: 'origin' })
    const { result } = renderHook(() => useReferencedMessage({
      type: 'groupchat', roomJid: ROOM, id, from: `${ROOM}/Bob`, cache: true,
    }))
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBeUndefined())
  })

  it('does not use ambiguous reused nick identities as moderation evidence', async () => {
    await cache.saveRoomMessages([original, {
      ...original, stanzaId: 'other-archive', occupantId: 'another-alice', isRetracted: false, isModerated: false,
    }])
    const { result } = renderHook(() => useReferencedMessage({
      type: 'groupchat', roomJid: ROOM, id: original.id, from: original.from, cache: true,
    }))
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBeUndefined())
  })

  it('keeps identical archive references scoped to the room and active account', async () => {
    await cache.saveRoomMessage(original)
    const { result, rerender } = renderHook(({ roomJid }) => useReferencedMessage({
      type: 'groupchat', roomJid, id: 'archive', from: original.from, cache: true,
    }), { initialProps: { roomJid: ROOM } })
    await waitFor(() => expect(result.current?.isModerated).toBe(true))
    rerender({ roomJid: 'different@conference.example.com' })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBeUndefined())
    rerender({ roomJid: ROOM })
    await waitFor(() => expect(result.current?.isModerated).toBe(true))
    act(() => switchAccount('second@example.com'))
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBeUndefined())
  })
})


describe('archive authority across resident and cached references', () => {
  it.each(['client', 'origin'])('keeps an authoritative cached original ahead of a resident %s alias', async tier => {
    const legitimate = { ...original, isRetracted: false, isModerated: false, moderationReason: undefined, body: 'Legitimate original' }
    await cache.saveRoomMessage(legitimate)
    const collision = { ...original, id: tier === 'client' ? original.stanzaId! : 'collision',
      originId: tier === 'origin' ? original.stanzaId : undefined, stanzaId: 'other-archive', occupantId: 'reused-nick' }
    roomStore.setState({ messages: new Map([[ROOM, [collision]]]) })
    const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
      id: original.stanzaId, from: original.from, cache: true }))
    await waitFor(() => expect(result.current).toMatchObject({ id: original.id, stanzaId: original.stanzaId, body: legitimate.body, isModerated: false }))
  })

  it('hides an authoritative cached Spam original despite a legitimate resident alias', async () => {
    await cache.saveRoomMessage(original)
    const collision = { ...original, id: original.stanzaId!, stanzaId: 'other-archive', occupantId: 'reused-nick',
      isRetracted: false, isModerated: false, moderationReason: undefined }
    roomStore.setState({ messages: new Map([[ROOM, [collision]]]) })
    const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
      id: original.stanzaId, from: original.from, cache: true }))
    await waitFor(() => expect(result.current).toMatchObject({ id: original.id, stanzaId: original.stanzaId, isModerated: true }))
  })

  it('preserves legacy resident-only alias resolution even when a cached archive owner exists', async () => {
    await cache.saveRoomMessage(original)
    const collision = { ...original, id: original.stanzaId!, stanzaId: 'other-archive', occupantId: 'reused-nick' }
    roomStore.setState({ messages: new Map([[ROOM, [collision]]]) })
    const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
      id: original.stanzaId, from: original.from }))
    expect(result.current).toBe(collision)
  })
})


it('uses an uncached search snapshot archive owner ahead of cached and resident aliases', async () => {
  const legitimate = { ...original, isRetracted: false, isModerated: false, moderationReason: undefined, body: 'Snapshot original' }
  const collision = { ...original, id: original.stanzaId!, stanzaId: 'collision-archive', occupantId: 'reused-nick' }
  await cache.saveRoomMessage(collision)
  roomStore.setState({ messages: new Map([[ROOM, [collision]]]) })
  const messages = [legitimate, collision]
  const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
    id: original.stanzaId, from: original.from, cache: true, messages }))
  expect(result.current).toBe(legitimate)
  await act(async () => {})
  expect(result.current).toBe(legitimate)
})

it('disregards a supplied snapshot belonging to another room', async () => {
  const messages = [{ ...original, roomJid: 'other@conference.example.com' }]
  const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
    id: original.stanzaId, from: original.from, cache: true, messages }))
  await waitFor(() => expect(result.current).toBeUndefined())
})


afterEach(() => vi.restoreAllMocks())

it('keeps a cached quotation stable through unrelated pending records and snapshot changes', async () => {
  const target = { ...original, isRetracted: false, isModerated: false, moderationReason: undefined }
  const unrelated: RoomMessage = { ...target, id: 'unrelated', stanzaId: 'unrelated-archive' }

  await cache.saveRoomMessages([target, unrelated])
  const reads = vi.spyOn(cache, 'getRoomMessageByReference')
  let renders = 0
  const { result, rerender } = renderHook(({ messages }: { messages: RoomMessage[] }) => {
    renders++
    return useReferencedMessage({ type: 'groupchat', roomJid: ROOM, id: target.stanzaId, from: target.from, cache: true, messages })
  }, { initialProps: { messages: [unrelated] } })
  await waitFor(() => expect(result.current?.id).toBe(target.id))
  const settled = result.current
  const settledRenders = renders
  act(() => roomStore.getState().recordPendingRetraction(ROOM, unrelated.stanzaId!, ROOM, undefined, {
    isModerated: true, moderationReason: 'Spam',
  }))
  expect(result.current).toBe(settled)
  await waitFor(() => expect(roomStore.getState().pendingRetractions.get(ROOM)).toBeUndefined())
  expect(result.current).toBe(settled)
  expect(renders).toBe(settledRenders)
  rerender({ messages: [{ ...unrelated, isRetracted: true, isModerated: true, moderationReason: 'Spam' }] })
  expect(result.current).toBe(settled)
  await act(async () => {})
  expect(reads).toHaveBeenCalledTimes(1)
})

it.each(['stanza', 'client', 'origin'])('applies relevant moderation to a cache-only %s reference without another read', async tier => {
  const target = { ...original, id: `client-${tier}`, stanzaId: `archive-${tier}`, originId: `origin-${tier}`, isRetracted: false, isModerated: false, moderationReason: undefined }

  await cache.saveRoomMessage(target)
  const reads = vi.spyOn(cache, 'getRoomMessageByReference')
  const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
    id: tier === 'stanza' ? target.stanzaId : tier === 'client' ? target.id : target.originId, from: target.from, cache: true }))
  await waitFor(() => expect(result.current?.isRetracted).toBe(false))
  act(() => roomStore.getState().recordPendingRetraction(ROOM, target.stanzaId!, ROOM, undefined, {
    isModerated: true, moderationReason: 'Spam',
  }))
  expect(result.current).toMatchObject({ isRetracted: true, isModerated: true, moderationReason: 'Spam' })
  await waitFor(() => expect(roomStore.getState().pendingRetractions.get(ROOM)).toBeUndefined())
  expect(result.current).toMatchObject({ isRetracted: true, isModerated: true, moderationReason: 'Spam' })
  expect(reads).toHaveBeenCalledTimes(1)
})


it.each(['room', 'actor'])('ignores pending moderation with an unrelated %s identity', async kind => {
  const target = { ...original, id: `negative-${kind}`, stanzaId: `negative-archive-${kind}`, isRetracted: false, isModerated: false }

  await cache.saveRoomMessage(target)
  const reads = vi.spyOn(cache, 'getRoomMessageByReference')
  const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
    id: target.stanzaId, from: target.from, cache: true }))
  await waitFor(() => expect(result.current?.isRetracted).toBe(false))
  const settled = result.current
  act(() => roomStore.setState({ pendingRetractions: new Map([[kind === 'room' ? 'other@conference.example.com' : ROOM, [{
    targetId: target.stanzaId!, actorJid: kind === 'actor' ? `${ROOM}/Mallory` : ROOM, retractedAt: Date.now(),
    moderation: { isModerated: true, moderationReason: 'Spam' },
  }]]]) }))
  expect(result.current).toBe(settled)
  act(() => roomStore.setState({ pendingRetractions: new Map() }))
  expect(result.current).toBe(settled)
  expect(reads).toHaveBeenCalledTimes(1)
})

it('applies pending moderation received during a cache read through a client alias', async () => {
  const target = { ...original, id: 'in-flight-client', stanzaId: 'in-flight-archive', isRetracted: false, isModerated: false }

  let finish!: (message: RoomMessage) => void
  const reads = vi.spyOn(cache, 'getRoomMessageByReference').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result } = renderHook(() => useReferencedMessage({ type: 'groupchat', roomJid: ROOM,
    id: target.id, from: target.from, cache: true }))
  expect(result.current).toBeNull()
  act(() => roomStore.setState({ pendingRetractions: new Map([[ROOM, [{
    targetId: target.stanzaId!, actorJid: ROOM, retractedAt: Date.now(),
    moderation: { isModerated: true, moderationReason: 'Spam' },
  }]]]) }))
  await act(async () => { finish(target) })
  expect(result.current).toMatchObject({ isRetracted: true, isModerated: true, moderationReason: 'Spam' })
  act(() => roomStore.setState({ pendingRetractions: new Map() }))
  expect(result.current).toMatchObject({ isRetracted: true, isModerated: true, moderationReason: 'Spam' })
  expect(reads).toHaveBeenCalledTimes(1)
})
