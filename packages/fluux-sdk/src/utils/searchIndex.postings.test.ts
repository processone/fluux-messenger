import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB, type IDBPDatabase } from 'idb'
import type { Message } from '../core/types'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import { _resetDBForTesting as resetMessageCache } from './messageCache'
import {
  _resetDBForTesting, clearSearchIndex, closeSearchIndex, indexMessage, initSearchIndex,
  isPostingsReady, migrateSearchPostings, removeConversation, removeMessage, search,
} from './searchIndex'

// Intent (FLM-470 step 1): every write keeps the time-sorted rows in step with the
// documents, and a resumable background copy numbers the documents of an upgraded
// version 4 database without changing what search returns.

const SCOPE = 'postings@example.test'
const DB_NAME = `fluux-search-index:${SCOPE}`

function chat(id: string, body: string, minute: number, conversationId = 'alice@example.test'): Message {
  return {
    type: 'chat', id, conversationId, from: conversationId, body,
    timestamp: new Date(Date.UTC(2024, 0, 1, 0, minute)), isOutgoing: false,
    stanzaId: undefined, originId: undefined,
  } as Message
}

/** A document as the version 4 code stored it: no docNo. */
function legacyDoc(n: number, body: string, conversationId = 'alice@example.test') {
  const id = `m${String(n).padStart(5, '0')}`
  return {
    indexId: `chat:${conversationId}\u0000${id}`, messageId: id, conversationId,
    from: conversationId, timestamp: Date.UTC(2024, 0, 1, 0, n), isRoom: false, body,
    tokens: [...new Set(body.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2))],
  }
}

async function seedV4(docs: ReturnType<typeof legacyDoc>[]) {
  const db = await openDB(DB_NAME, 4, {
    upgrade(db) {
      db.createObjectStore('search-tokens', { keyPath: 'token' })
      const store = db.createObjectStore('search-docs', { keyPath: 'indexId' })
      store.createIndex('conversationId', 'conversationId')
      store.createIndex('identityKeys', 'identityKeys', { multiEntry: true })
      db.createObjectStore('search-meta', { keyPath: 'key' })
    },
  })
  const lists = new Map<string, string[]>()
  const tx = db.transaction(['search-docs', 'search-tokens', 'search-meta'], 'readwrite')
  for (const doc of docs) {
    await tx.objectStore('search-docs').put(doc)
    for (const token of doc.tokens) lists.set(token, [...(lists.get(token) ?? []), doc.indexId])
  }
  for (const [token, postings] of lists) await tx.objectStore('search-tokens').put({ token, postings })
  await tx.objectStore('search-meta').put({ key: 'backfill-complete', value: 'chat-cache-key' })
  await tx.done
  db.close()
}

/** The rows the documents say should exist, against the rows that do. */
async function expectRowsMatchDocuments(db: IDBPDatabase<any>, options: { allNumbered: boolean }) {
  const docs = await db.getAll('search-docs')
  const numbers = docs.filter(d => d.docNo !== undefined).map(d => d.docNo)
  expect(new Set(numbers).size).toBe(numbers.length)
  if (options.allNumbered) expect(numbers).toHaveLength(docs.length)
  const expected = docs.flatMap(d => d.docNo === undefined ? [] : d.tokens.map((t: string) => [t, -d.timestamp, d.docNo]))
  const actual = await db.getAllKeys('search-postings')
  expect(actual).toHaveLength(expected.length)
  expect(new Set(actual.map(k => JSON.stringify(k)))).toEqual(new Set(expected.map(k => JSON.stringify(k))))
}

async function openRaw() { return openDB(DB_NAME) }

describe('time-sorted search index', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    _resetStorageScopeForTesting()
    _resetDBForTesting()
    resetMessageCache()
    setStorageScopeJid(SCOPE)
  })
  afterEach(async () => {
    await closeSearchIndex()
    vi.restoreAllMocks()
  })

  it('starts a brand-new database ready, with rows for every write', async () => {
    await initSearchIndex(SCOPE)
    expect(await isPostingsReady(SCOPE)).toBe(true)
    await indexMessage(chat('a', 'hello brave world', 1), SCOPE)
    await indexMessage(chat('b', 'hello again', 2), SCOPE)
    const db = await openRaw()
    await expectRowsMatchDocuments(db, { allNumbered: true })
    expect((await db.getAllKeys('search-postings')).filter(k => k[0] === 'hello')).toEqual([
      ['hello', -Date.UTC(2024, 0, 1, 0, 2), 2], ['hello', -Date.UTC(2024, 0, 1, 0, 1), 1],
    ])
    db.close()
  })

  it('removes rows with a removed message and with a removed conversation', async () => {
    await initSearchIndex(SCOPE)
    await indexMessage(chat('a', 'keep this one', 1), SCOPE)
    await indexMessage(chat('b', 'drop this one', 2), SCOPE)
    await indexMessage(chat('c', 'other chat text', 3, 'bob@example.test'), SCOPE)
    await removeMessage(chat('b', 'drop this one', 2), SCOPE)
    let db = await openRaw()
    await expectRowsMatchDocuments(db, { allNumbered: true })
    expect((await db.getAllKeys('search-postings')).some(k => k[0] === 'drop')).toBe(false)
    db.close()
    await removeConversation('chat', 'bob@example.test', SCOPE)
    db = await openRaw()
    await expectRowsMatchDocuments(db, { allNumbered: true })
    expect((await db.getAllKeys('search-postings')).some(k => k[0] === 'other')).toBe(false)
    expect(await db.count('search-docs')).toBe(1)
    db.close()
  })

  it('does not rewrite rows when the same message is indexed again', async () => {
    await initSearchIndex(SCOPE)
    await indexMessage(chat('a', 'stable words', 1), SCOPE)
    await indexMessage(chat('a', 'stable words', 1), SCOPE)
    const db = await openRaw()
    expect((await db.getAll('search-docs'))[0].docNo).toBe(1)
    expect(await db.get('search-meta', 'next-doc-no')).toEqual({ key: 'next-doc-no', value: '2' })
    await expectRowsMatchDocuments(db, { allNumbered: true })
    db.close()
  })

  describe('upgrading a version 4 database', () => {
    it('opens at version 5, not ready, with the old lists untouched and search unchanged', async () => {
      await seedV4(Array.from({ length: 5 }, (_, i) => legacyDoc(i + 1, `shared word number${i}`)))
      const before = await (async () => { await initSearchIndex(SCOPE); return search('shared') })()
      expect(before).toHaveLength(5)
      expect(await isPostingsReady(SCOPE)).toBe(false)
      const db = await openRaw()
      expect(db.version).toBe(5)
      expect((await db.get('search-tokens', 'shared')).postings).toHaveLength(5)
      expect(await db.count('search-postings')).toBe(0)
      db.close()
    })

    it('copies every stored document, including ones with no cached message, and then marks ready', async () => {
      const docs = Array.from({ length: 450 }, (_, i) => legacyDoc(i + 1, `shared word number${i}`))
      await seedV4(docs)
      await initSearchIndex(SCOPE)
      const before = await search('shared', { limit: 500 })
      await migrateSearchPostings()
      expect(await isPostingsReady(SCOPE)).toBe(true)
      const db = await openRaw()
      await expectRowsMatchDocuments(db, { allNumbered: true })
      expect(await db.count('search-docs')).toBe(450)
      db.close()
      expect(await search('shared', { limit: 500 })).toEqual(before)
    })

    it('resumes at the cursor after a quit without losing or duplicating a document', async () => {
      await seedV4(Array.from({ length: 450 }, (_, i) => legacyDoc(i + 1, `shared word number${i}`)))
      await initSearchIndex(SCOPE)
      // Stop after the first batch: the account changes, as on a quit or a switch.
      const timeout = vi.spyOn(globalThis, 'setTimeout')
      timeout.mockImplementationOnce(((fn: () => void) => {
        _resetStorageScopeForTesting(); setStorageScopeJid('someone-else@example.test')
        fn(); return 0 as never
      }) as never)
      await expect(migrateSearchPostings()).rejects.toThrow('Storage account changed')
      timeout.mockRestore()
      let db = await openRaw()
      expect((await db.get('search-meta', 'postings-cursor'))?.value).toBeDefined()
      expect((await db.getAll('search-docs')).filter(d => d.docNo !== undefined)).toHaveLength(200)
      expect(await isPostingsReady(SCOPE)).toBe(false)
      db.close()

      _resetStorageScopeForTesting(); setStorageScopeJid(SCOPE)
      await migrateSearchPostings()
      db = await openRaw()
      await expectRowsMatchDocuments(db, { allNumbered: true })
      expect(await isPostingsReady(SCOPE)).toBe(true)
      db.close()
    })

    it('never brings back a message removed between batches', async () => {
      const ROOM = 'room@conference.example.test'
      const roomDoc = (n: number) => ({
        indexId: `room:archive-${n}`, messageId: `r${n}`, conversationId: ROOM, from: `${ROOM}/alice`, nick: 'alice',
        timestamp: Date.UTC(2024, 0, 1, 0, n), isRoom: true, body: `shared word number${n}`,
        tokens: ['shared', 'word', `number${n}`], stanzaId: `archive-${n}`, occupantId: 'alice-one',
        identityKeys: [],
      })
      await seedV4(Array.from({ length: 450 }, (_, i) => roomDoc(i + 1)) as never)
      await initSearchIndex(SCOPE)
      const timeout = vi.spyOn(globalThis, 'setTimeout')
      let removed = false
      timeout.mockImplementation(((fn: () => void) => {
        if (removed) { fn(); return 0 as never }
        removed = true
        // After the first batch: one document already copied, one not yet copied.
        const room = (n: number) => ({
          type: 'groupchat', id: `r${n}`, roomJid: ROOM, from: `${ROOM}/alice`, nick: 'alice', occupantId: 'alice-one',
          stanzaId: `archive-${n}`, originId: undefined, body: '', timestamp: new Date(roomDoc(n).timestamp), isOutgoing: false,
        }) as never
        void Promise.all([removeMessage(room(1), SCOPE), removeMessage(room(400), SCOPE)]).then(() => fn())
        return 0 as never
      }) as never)
      await migrateSearchPostings()
      timeout.mockRestore()
      const db = await openRaw()
      await expectRowsMatchDocuments(db, { allNumbered: true })
      const ids = (await db.getAll('search-docs')).map(d => d.messageId)
      expect(ids).not.toContain('r1')
      expect(ids).not.toContain('r400')
      expect(ids).toHaveLength(448)
      db.close()
    })

    it('keeps a deleted conversation gone', async () => {
      await seedV4([
        ...Array.from({ length: 250 }, (_, i) => legacyDoc(i + 1, `shared word number${i}`)),
        ...Array.from({ length: 250 }, (_, i) => legacyDoc(i + 1000, `shared other number${i}`, 'zed@example.test')),
      ])
      await initSearchIndex(SCOPE)
      const timeout = vi.spyOn(globalThis, 'setTimeout')
      let done = false
      timeout.mockImplementation(((fn: () => void) => {
        if (!done) { done = true; void removeConversation('chat', 'zed@example.test', SCOPE).then(() => fn()); return 0 as never }
        fn(); return 0 as never
      }) as never)
      await migrateSearchPostings()
      timeout.mockRestore()
      const db = await openRaw()
      await expectRowsMatchDocuments(db, { allNumbered: true })
      expect((await db.getAll('search-docs')).some(d => d.conversationId === 'zed@example.test')).toBe(false)
      db.close()
    })

    it('stops quietly when storage is full and leaves search on the old lists', async () => {
      await seedV4(Array.from({ length: 10 }, (_, i) => legacyDoc(i + 1, `shared word number${i}`)))
      await initSearchIndex(SCOPE)
      const put = IDBObjectStorePut()
      put.mockImplementation(function () { throw new DOMException('full', 'QuotaExceededError') })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(migrateSearchPostings()).resolves.toBeUndefined()
      put.mockRestore()
      expect(warn).toHaveBeenCalled()
      expect(await isPostingsReady(SCOPE)).toBe(false)
      expect(await search('shared')).toHaveLength(10)
      await migrateSearchPostings()
      expect(await isPostingsReady(SCOPE)).toBe(true)
    })

    it('finishes one correct index when two copies run at once', async () => {
      await seedV4(Array.from({ length: 450 }, (_, i) => legacyDoc(i + 1, `shared word number${i}`)))
      await initSearchIndex(SCOPE)
      await Promise.all([migrateSearchPostings(), migrateSearchPostings()])
      const db = await openRaw()
      await expectRowsMatchDocuments(db, { allNumbered: true })
      db.close()
    })

    it('numbers a live write made before the copy reaches it', async () => {
      await seedV4(Array.from({ length: 5 }, (_, i) => legacyDoc(i + 1, `shared word number${i}`)))
      await initSearchIndex(SCOPE)
      await indexMessage(chat('live', 'shared live message', 99), SCOPE)
      let db = await openRaw()
      await expectRowsMatchDocuments(db, { allNumbered: false })
      db.close()
      await migrateSearchPostings()
      db = await openRaw()
      await expectRowsMatchDocuments(db, { allNumbered: true })
      db.close()
    })
  })

  it('sets the ready marker again after logout clears the index', async () => {
    await seedV4([legacyDoc(1, 'shared word')])
    await initSearchIndex(SCOPE)
    expect(await isPostingsReady(SCOPE)).toBe(false)
    await clearSearchIndex()
    expect(await isPostingsReady(SCOPE)).toBe(true)
    const db = await openRaw()
    expect(await db.count('search-postings')).toBe(0)
    expect(await db.count('search-docs')).toBe(0)
    db.close()
  })
})

import { IDBObjectStore } from 'fake-indexeddb'
function IDBObjectStorePut() {
  const original = IDBObjectStore.prototype.put
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    if (this.name === 'search-postings') throw new DOMException('full', 'QuotaExceededError')
    return original.apply(this, args)
  } as never)
}
