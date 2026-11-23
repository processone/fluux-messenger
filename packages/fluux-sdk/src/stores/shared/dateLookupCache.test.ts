import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, RoomMessage } from '../../core/types'
import * as cache from '../../utils/messageCache'
import { _resetDBForTesting, getMessages, saveMessage } from '../../utils/messageCache'
import { _resetStorageScopeForTesting } from '../../utils/storageScope'
import { chatStore } from '../chatStore'
import { roomStore } from '../roomStore'
import { DEFAULT_MAM_STATE } from './mamState'

const peer = 'alice@example.test'
const jid = 'team@conference.example.test'
const at = (month: number, day: number) => new Date(2026, month - 1, day, 10)
const chat = (id: string, timestamp: Date): Message => ({
  type: 'chat', id, stanzaId: `archive-${id}`, originId: undefined, conversationId: peer,
  from: peer, body: `Chat: ${id}`, timestamp, isOutgoing: false,
})
const room = (id: string, timestamp: Date): RoomMessage => ({
  type: 'groupchat', id, stanzaId: `archive-${id}`, originId: undefined, roomJid: jid,
  from: `${jid}/alice`, nick: 'alice', occupantId: undefined, body: `Room: ${id}`, timestamp, isOutgoing: false,
})

// FLM-660: an old date page can be a landing target without joining it to the live timeline.
describe('durable date-lookup page', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    _resetDBForTesting()
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('parks a chat page in the cache and records the gap to live without moving the resident window', async () => {
    const recent = chat('recent', at(10, 28))
    const old = chat('old', at(7, 16))
    const live = [recent]
    const mam = { ...DEFAULT_MAM_STATE, hasQueried: true, isCaughtUpToLive: true }
    chatStore.setState({ messages: new Map([[peer, live]]), windowAtLiveEdge: new Map([[peer, true]]),
      mamQueryStates: new Map([[peer, mam]]), conversationGaps: new Map() })
    await saveMessage('chat', recent)

    expect(await chatStore.getState().saveDateLookupPage(peer, [old], false)).toBe(true)

    const state = chatStore.getState()
    expect(state.messages.get(peer)).toBe(live)
    expect(state.windowAtLiveEdge.get(peer)).toBe(true)
    expect(state.getMAMQueryState(peer)).toBe(mam)
    expect(state.conversationGaps.get(peer)).toEqual([{ start: +old.timestamp, end: +recent.timestamp,
      startId: old.stanzaId, endId: recent.stanzaId }])
    expect((await getMessages('chat', peer)).map(row => row.id)).toEqual([old.id, recent.id])
  })

  it('applies a restored pending chat retraction to a date page before saving without consuming the record', async () => {
    const message = chat('retracted-page-row', at(7, 16))
    const pending = [{ targetId: message.id, actorJid: peer, retractedAt: Date.now() }]
    chatStore.setState({ pendingRetractions: new Map([[peer, pending]]) })

    const reconciled = await chatStore.getState().reconcileHistoryMessages([message])
    expect(reconciled[0]).toMatchObject({ isRetracted: true })
    expect(chatStore.getState().pendingRetractions.get(peer)).toHaveLength(1)

    expect(await chatStore.getState().saveDateLookupPage(peer, reconciled, false)).toBe(true)

    expect(await cache.getMessage('chat', peer, message.id)).toMatchObject({ isRetracted: true, body: '' })
    expect(chatStore.getState().pendingRetractions.get(peer)).toHaveLength(1)
  })

  it('splits a recorded room gap around a saved page without touching its catch-up status', async () => {
    const earliest = room('earliest', at(2, 14))
    const recent = room('recent', at(10, 28))
    const old = room('old', at(7, 16))
    const following = room('following', new Date(+old.timestamp + 1000))
    const live = [recent]
    const mam = { ...DEFAULT_MAM_STATE, hasQueried: true, isCaughtUpToLive: false }
    roomStore.setState({ messages: new Map([[jid, live]]), windowAtLiveEdge: new Map([[jid, true]]),
      mamQueryStates: new Map([[jid, mam]]), roomGaps: new Map([[jid, [{ start: +earliest.timestamp, end: +recent.timestamp,
        startId: earliest.stanzaId, endId: recent.stanzaId }]]]) })
    await saveMessage('room', earliest)
    await saveMessage('room', recent)

    expect(await roomStore.getState().saveDateLookupPage(jid, [old, following], false)).toBe(true)

    const state = roomStore.getState()
    expect(state.messages.get(jid)).toBe(live)
    expect(state.windowAtLiveEdge.get(jid)).toBe(true)
    expect(state.getRoomMAMQueryState(jid)).toBe(mam)
    expect(state.roomGaps.get(jid)).toEqual([
      { start: +earliest.timestamp, end: +old.timestamp, startId: earliest.stanzaId, endId: old.stanzaId },
      { start: +following.timestamp, end: +recent.timestamp, startId: following.stanzaId, endId: recent.stanzaId },
    ])
    expect((await getMessages('room', jid)).map(row => row.id)).toEqual([earliest.id, old.id, following.id, recent.id])
  })

  it('does not make a false gap when the page edge is an optimistic copy without an archive ID', async () => {
    const own = { ...chat('own', at(7, 16)), from: 'reader@example.test/phone', isOutgoing: true, originId: 'own-origin' }
    chatStore.setState({ conversationGaps: new Map() })
    await saveMessage('chat', chat('earlier', at(7, 15)))
    await saveMessage('chat', { ...own, stanzaId: undefined })
    await saveMessage('chat', chat('later', at(7, 17)))

    expect(await chatStore.getState().saveDateLookupPage(peer, [own], false)).toBe(true)

    expect(chatStore.getState().conversationGaps.has(peer)).toBe(false)
    expect((await getMessages('chat', peer)).map(row => [row.id, row.stanzaId])).toEqual([
      ['earlier', 'archive-earlier'], ['own', own.stanzaId], ['later', 'archive-later'],
    ])
  })

  it.each(['before', 'after'] as const)('refuses to place a page when the %s cache seek fails', async (direction) => {
    const recent = chat('recent', at(10, 28))
    const old = chat('old', at(7, 16))
    chatStore.setState({ conversationGaps: new Map() })
    await saveMessage('chat', recent)
    const read = cache.readMessages
    vi.spyOn(cache, 'readMessages').mockImplementation((...[kind, id, options]) =>
      options?.[direction] ? Promise.resolve({ status: 'unavailable' }) : read(kind, id, options))

    expect(await chatStore.getState().saveDateLookupPage(peer, [old], false)).toBe(false)

    expect(chatStore.getState().conversationGaps.has(peer)).toBe(false)
    expect((await getMessages('chat', peer)).map(row => row.id)).toEqual([recent.id])
  })

})
