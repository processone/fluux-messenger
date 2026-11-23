import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Message, RoomMessage } from '../../core/types'
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

  it('parks a room page between two cached blocks without touching its catch-up status', async () => {
    const earliest = room('earliest', at(2, 14))
    const recent = room('recent', at(10, 28))
    const old = room('old', at(7, 16))
    const live = [recent]
    const mam = { ...DEFAULT_MAM_STATE, hasQueried: true, isCaughtUpToLive: false }
    roomStore.setState({ messages: new Map([[jid, live]]), windowAtLiveEdge: new Map([[jid, true]]),
      mamQueryStates: new Map([[jid, mam]]), roomGaps: new Map() })
    await saveMessage('room', earliest)
    await saveMessage('room', recent)

    expect(await roomStore.getState().saveDateLookupPage(jid, [old], false)).toBe(true)

    const state = roomStore.getState()
    expect(state.messages.get(jid)).toBe(live)
    expect(state.windowAtLiveEdge.get(jid)).toBe(true)
    expect(state.getRoomMAMQueryState(jid)).toBe(mam)
    expect(state.roomGaps.get(jid)?.map(({ start, end }) => [start, end])).toEqual([
      [+earliest.timestamp, +old.timestamp], [+old.timestamp, +recent.timestamp],
    ])
    expect((await getMessages('room', jid)).map(row => row.id)).toEqual([earliest.id, old.id, recent.id])
  })
})
