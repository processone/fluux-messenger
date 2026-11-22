import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import { _resetStorageScopeForTesting } from './storageScope'
import * as messageCache from './messageCache'

const chat = (id: string, overrides: Partial<Message> = {}): Message => ({
  type: 'chat', id, conversationId: 'peer@example.com', from: 'peer@example.com', body: `body ${id}`,
  timestamp: new Date(1_000), isOutgoing: false, stanzaId: undefined, originId: undefined, ...overrides,
})

const roomJid = 'room@conference.example.com'
const room = (id: string, overrides: Partial<RoomMessage> = {}): RoomMessage => ({
  type: 'groupchat', id, roomJid, from: `${roomJid}/alice`, nick: 'alice', body: `body ${id}`,
  timestamp: new Date(1_000), isOutgoing: false, stanzaId: undefined, originId: undefined, occupantId: undefined, ...overrides,
})

describe('history reconcile against the resident window', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
  })

  it('follows a chat page row through identity keys it gains from an earlier resident copy', async () => {
    // The page copy only knows the origin id. The first resident copy shares it and carries the
    // archive id; the second shares only that archive id and records a retraction.
    const page = chat('page', { originId: 'origin-1' })
    const first = chat('first', { originId: 'origin-1', stanzaId: 'archive-1' })
    const second = chat('second', { stanzaId: 'archive-1', isRetracted: true, retractedAt: new Date(2_000) })
    const unrelated = Array.from({ length: 50 }, (_, i) => chat(`other-${i}`, { stanzaId: `archive-other-${i}` }))

    const [reconciled] = await messageCache.reconcileHistoryMessages('chat', [page], () => [...unrelated, first, ...unrelated, second], null)

    expect(reconciled.stanzaId).toBe('archive-1')
    expect(reconciled.isRetracted).toBe(true)
  })

  it('ignores resident chat messages that share no identity key with the page row', async () => {
    const page = chat('page', { stanzaId: 'archive-1' })
    const resident = [chat('a', { stanzaId: 'archive-2', isRetracted: true, retractedAt: new Date(2_000) })]

    const [reconciled] = await messageCache.reconcileHistoryMessages('chat', [page], () => resident, null)

    expect(reconciled.isRetracted).toBeFalsy()
  })

  it('merges a retracted resident room copy into the page row, in its own room only', async () => {
    const page = room('same-id', { stanzaId: 'archive-1' })
    const sameRoom = room('same-id', { stanzaId: 'archive-1', isRetracted: true, retractedAt: new Date(2_000) })
    const otherRoom = room('same-id', { roomJid: 'other@conference.example.com', from: 'other@conference.example.com/alice', stanzaId: 'archive-1', isRetracted: true, retractedAt: new Date(2_000) })

    const [withSameRoom] = await messageCache.reconcileHistoryMessages('room', [page], () => [sameRoom], null)
    const [withOtherRoom] = await messageCache.reconcileHistoryMessages('room', [page], () => [otherRoom], null)

    expect(withSameRoom.isRetracted).toBe(true)
    expect(withOtherRoom.isRetracted).toBeFalsy()
  })

  it('reconciles a 100-row page against a full resident window within a bounded number of key reads', async () => {
    const resident = Array.from({ length: 5_000 }, (_, i) => chat(`m${i}`, { stanzaId: `archive-${i}` }))
    const page = Array.from({ length: 100 }, (_, i) => chat(`p${i}`, { stanzaId: `archive-${4_000 + i}` }))
    let reads = 0
    const counted = resident.map(message => new Proxy(message, {
      get(target, property, receiver) { if (property === 'stanzaId') reads++; return Reflect.get(target, property, receiver) },
    }))

    const result = await messageCache.reconcileHistoryMessages('chat', page, () => counted, null)

    expect(result).toHaveLength(100)
    // Indexing reads each resident's identity once; a scan per row would read it about once per row.
    expect(reads).toBeLessThan(3 * resident.length)
  })
})
