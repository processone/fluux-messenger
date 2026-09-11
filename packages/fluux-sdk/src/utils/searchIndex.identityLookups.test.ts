import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb'
import { openDB } from 'idb'
import type { RoomMessage } from '../core/types'
import { identityKeys, roomScope } from './messageIdentity'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import { _resetDBForTesting as resetMessageCache } from './messageCache'
import {
  _resetDBForTesting, closeSearchIndex, indexMessages, initSearchIndex, removeMessage, search,
} from './searchIndex'

const SCOPE = 'identity-probe@example.test'
const ROOM = 'cleanup@conference.example.test'
const DB_NAME = `fluux-search-index:${SCOPE}`

function message(id: string, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    type: 'groupchat', id, stanzaId: `archive-${id}`, roomJid: ROOM,
    from: `${ROOM}/alice`, nick: 'alice', occupantId: 'alice-one',
    body: 'cleanup fixture', timestamp: new Date(1_700_000_000_000), isOutgoing: false,
    ...overrides,
  }
}

function document(row: RoomMessage) {
  return {
    indexId: `room:${row.stanzaId ?? `${row.roomJid}:${row.from}:${row.id}`}`,
    messageId: row.id, conversationId: row.roomJid, from: row.from, nick: row.nick,
    timestamp: row.timestamp.getTime(), isRoom: true, body: row.body, tokens: ['cleanup'],
    ...(row.stanzaId && { stanzaId: row.stanzaId }),
    ...(row.originId && { originId: row.originId }),
    ...(row.occupantId && { occupantId: row.occupantId }),
  }
}

/** An actual old database: no derived keys or identity index exist yet. */
async function seedLegacy(rows: RoomMessage[], version = 2) {
  const db = await openDB(DB_NAME, version, {
    upgrade(db) {
      db.createObjectStore('search-tokens', { keyPath: 'token' })
      const docs = db.createObjectStore('search-docs', { keyPath: 'indexId' })
      docs.createIndex('timestamp', 'timestamp')
      docs.createIndex('conversationId', 'conversationId')
      db.createObjectStore('search-meta', { keyPath: 'key' })
    },
  })
  const tx = db.transaction(['search-docs', 'search-tokens', 'search-meta'], 'readwrite')
  for (const row of rows) await tx.objectStore('search-docs').put(document(row))
  await tx.objectStore('search-tokens').put({ token: 'cleanup', postings: rows.map(row => document(row).indexId) })
  await tx.objectStore('search-meta').put({ key: 'fixture-marker', value: 'preserved' })
  await tx.done
  db.close()
}

function observeDocumentReads() {
  const fetched: string[] = []
  const getAll = IDBIndex.prototype.getAll
  vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
    const request = getAll.apply(this, args)
    if (this.objectStore.name === 'search-docs') {
      request.addEventListener('success', () => {
        fetched.push(...request.result.map((doc: { indexId: string }) => doc.indexId))
      })
    }
    return request
  })
  const gets = vi.spyOn(IDBObjectStore.prototype, 'get')
  return { fetched, gets }
}

describe('indexed room retraction identities', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    _resetDBForTesting()
    resetMessageCache()
    setStorageScopeJid(SCOPE)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await closeSearchIndex()
  })

  it('reads only matching copies from a freshly written room index', async () => {
    const target = message('target', { originId: 'shared-origin' })
    const copy = message('copy', { originId: target.originId })
    const unrelated = Array.from({ length: 40 }, (_, i) => message(`unrelated-${i}`))
    await indexMessages([target, copy, ...unrelated])
    const { fetched, gets } = observeDocumentReads()

    await removeMessage(target, SCOPE, {
      identityKeys: identityKeys(roomScope(ROOM), target), ids: [target.id, copy.id],
    })

    expect(new Set(fetched)).toEqual(new Set([document(copy).indexId]))
    expect(gets.mock.calls.map(([key]) => key)).not.toContain(document(unrelated[0]).indexId)
    expect((await search('cleanup')).map(row => row.messageId).sort()).toEqual(unrelated.map(row => row.id).sort())
  })

  it.each([1, 2])('migrates a v%i index without losing legacy aliases or unrelated records', async (version) => {
    const target = message('survivor', { originId: 'shared-origin' })
    const originCopy = message('absorbed', { originId: target.originId })
    const fallbackCopy = message('old-client-id', { stanzaId: undefined })
    const ambiguous = message('ambiguous', { stanzaId: undefined, occupantId: undefined })
    const otherOccupant = message('other-occupant', { originId: target.originId, occupantId: 'alice-two' })
    const otherRoom = message('other-room', { roomJid: 'other@conference.example.test', originId: target.originId })
    const unrelated = Array.from({ length: 270 }, (_, i) => message(`unrelated-${i}`))
    const rows = [originCopy, fallbackCopy, ambiguous, otherOccupant, otherRoom, ...unrelated]
    await seedLegacy(rows, version)
    const migrationReads = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    await initSearchIndex(SCOPE)
    expect(migrationReads.mock.calls.length).toBeGreaterThan(1)
    expect(migrationReads.mock.calls.every(([, count]) => typeof count === 'number' && count <= 256)).toBe(true)
    migrationReads.mockRestore()
    const db = await openDB(DB_NAME)
    try {
      expect(db.version).toBe(3)
      expect(await db.count('search-docs')).toBe(rows.length)
      expect(await db.getAll('search-docs')).toEqual(expect.arrayContaining(
        rows.map(row => expect.objectContaining(document(row))),
      ))
      expect(await db.get('search-meta', 'fixture-marker')).toEqual({ key: 'fixture-marker', value: 'preserved' })
      // Restart before removal: durable aliases, not an in-memory ownership map, must suffice.
      await closeSearchIndex()
      _resetDBForTesting()
      await initSearchIndex(SCOPE)
      const { fetched } = observeDocumentReads()
      const keys = [target, originCopy, fallbackCopy, ambiguous].flatMap(row => identityKeys(roomScope(ROOM), row))
      await removeMessage(target, SCOPE, { identityKeys: keys, ids: rows.map(row => row.id) })

      expect(new Set(fetched)).toEqual(new Set([originCopy, fallbackCopy, ambiguous, otherOccupant].map(row => document(row).indexId)))
      const expected = [ambiguous, otherOccupant, otherRoom, ...unrelated].map(row => row.id).sort()
      expect((await db.getAll('search-docs')).map(row => row.messageId).sort()).toEqual(expected)
      expect((await db.get('search-tokens', 'cleanup')).postings.sort()).toEqual(
        [ambiguous, otherOccupant, otherRoom, ...unrelated].map(row => document(row).indexId).sort(),
      )
    } finally { db.close() }
  })

  it('aborts the upgrade atomically if an identity backfill write fails', async () => {
    const rows = [message('first'), message('second')]
    await seedLegacy(rows)
    const put = IDBObjectStore.prototype.put
    let writes = 0
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'search-docs' && ++writes === 2) throw new Error('injected migration failure')
      return put.apply(this, args)
    })
    await expect(initSearchIndex(SCOPE)).rejects.toMatchObject({ name: 'AbortError' })
    fault.mockRestore()
    await closeSearchIndex()
    const old = await openDB(DB_NAME, 2)
    try {
      expect(await old.getAll('search-docs')).toEqual(rows.map(document))
      expect(old.transaction('search-docs').store.indexNames.contains('identityKeys')).toBe(false)
    } finally { old.close() }
    await initSearchIndex(SCOPE)
    const upgraded = await openDB(DB_NAME)
    try {
      expect(upgraded.version).toBe(3)
      expect(await upgraded.count('search-docs')).toBe(2)
    } finally { upgraded.close() }
  })
})
