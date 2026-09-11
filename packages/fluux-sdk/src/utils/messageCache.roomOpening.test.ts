import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import type { RoomMessage } from '../core/types'
import * as identity from './messageIdentity'
import * as cache from './messageCache'
import { _resetStorageScopeForTesting } from './storageScope'

const ROOM = 'large-room@conference.example.test'

function message(index: number): RoomMessage {
  return {
    type: 'groupchat', roomJid: ROOM, from: `${ROOM}/sender`, nick: 'sender',
    id: `client-${index}`, stanzaId: `archive-${index}`, occupantId: 'occupant',
    timestamp: new Date(1700000000000 + index), isOutgoing: false,
    body: '', isRetracted: true, retractedAt: new Date(1700001000000),
  }
}

beforeEach(() => {
  _resetStorageScopeForTesting()
  cache._resetDBForTesting()
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  vi.restoreAllMocks()
  cache._resetDBForTesting()
})

it('restores a long room tail without deriving identities for every pair of rows', async () => {
  const rows = Array.from({ length: 256 }, (_, index) => message(index))
  await cache.saveRoomMessages(rows)
  const keys = vi.spyOn(identity, 'identityKeys')
  const restored = await cache.getRoomMessagesAround(ROOM, { id: rows[0].id }, { before: 0 })
  expect(restored.map(row => row.id)).toEqual(rows.map(row => row.id))
  expect(keys.mock.calls.length).toBeLessThanOrEqual(rows.length * 4)
})

async function restoreCopies(copies: Partial<RoomMessage>[]) {
  await cache.getRoomMessages(ROOM)
  const db = await openDB('fluux-message-cache')
  const tx = db.transaction('room-messages-canonical', 'readwrite')
  const rows = copies.map((copy, index) => ({ ...message(index), ...copy }))
  // Seed separate stored copies so the write-side merge cannot hide read-side deduplication.
  for (const [index, row] of rows.entries()) {
    await tx.store.put({
      ...row, cacheKey: `copy-${index}`, ids: [row.id],
      identityKeys: identity.identityKeys(identity.roomScope(ROOM), row),
      timestamp: row.timestamp.getTime(), retractedAt: row.retractedAt?.getTime(),
    })
  }
  await tx.done
  db.close()
  return cache.getRoomMessagesAround(ROOM, { id: rows[0].id }, { before: 0 })
}

it('keeps the first copy when a later copy shares several identities', async () => {
  const restored = await restoreCopies([
    { id: 'original', stanzaId: 'shared-stanza', originId: 'shared-origin' },
    { id: 'rewritten', stanzaId: 'shared-stanza', originId: 'shared-origin' },
    { id: 'unrelated' },
  ])
  expect(restored.map(row => row.id)).toEqual(['original', 'unrelated'])
})

it('retains distinct occupants and an ambiguous legacy copy sharing an identity', async () => {
  const restored = await restoreCopies([
    { id: 'a', originId: 'shared-origin', occupantId: 'a' },
    { id: 'b', originId: 'shared-origin', occupantId: 'b' },
    { id: 'unknown', originId: 'shared-origin', occupantId: undefined },
    { id: 'copy-of-a', originId: 'shared-origin', occupantId: 'a' },
  ])
  expect(restored.map(row => row.id)).toEqual(['a', 'b', 'unknown'])
})

it('does not use a discarded copy to bridge two otherwise distinct messages', async () => {
  const restored = await restoreCopies([
    { id: 'first', stanzaId: 'shared-stanza' },
    { id: 'discarded', stanzaId: 'shared-stanza', originId: 'extra-origin' },
    { id: 'independent', originId: 'extra-origin' },
  ])
  expect(restored.map(row => row.id)).toEqual(['first', 'independent'])
})
