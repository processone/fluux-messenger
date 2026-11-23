import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { openDB } from 'idb'
import type { Message } from '../core/types'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import * as messageCache from './messageCache'
import {
  _resetDBForTesting, closeSearchIndex, indexMessage, indexMessages, initSearchIndex, updateMessage,
  isPostingsReady, migrateSearchPostings, search, type SearchIndexResult,
} from './searchIndex'

// Intent (FLM-470 step 2): once the ready marker is set, search reads the
// time-sorted index and answers what the old lists answered, newest first,
// keeping deleted messages hidden; until then it reads the old lists.

const SCOPE = 'switch@example.test'
const DB_NAME = `fluux-search-index:${SCOPE}`
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'message', 'messages', 'meeting', 'reconnect', 'the', 'and']

/** A deterministic mix of words, so queries have common, rare and prefix matches. */
function bodyFor(n: number): string {
  const pick = (k: number) => WORDS[(n * k + (n >> 2)) % WORDS.length]
  return `${pick(1)} ${pick(3)} ${pick(7)} number${n % 9}${n % 17 === 0 ? ' rareword' : ''}${n % 11 === 0 ? ' "quoted phrase" here' : ''}`
}

function legacyDoc(n: number, conversationId: string, isRoom = false) {
  const body = bodyFor(n)
  const id = `m${String(n).padStart(5, '0')}`
  return {
    indexId: `${isRoom ? 'room' : 'chat'}:${conversationId}\u0000${id}`, messageId: id, conversationId,
    from: isRoom ? `${conversationId}/nick` : conversationId, timestamp: Date.UTC(2024, 0, 1) + n * 60_000, isRoom, body,
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

const ids = (results: SearchIndexResult[]) => results.map(r => r.indexId)

describe('search on the time-sorted index', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    _resetStorageScopeForTesting()
    _resetDBForTesting()
    messageCache._resetDBForTesting()
    setStorageScopeJid(SCOPE)
  })
  afterEach(async () => {
    await closeSearchIndex()
    vi.restoreAllMocks()
  })

  const QUERIES: Array<[string, { limit?: number; conversationId?: string; isRoom?: boolean }]> = [
    ['the', { limit: 1000 }],
    ['the', {}],
    ['the and', { limit: 1000 }],
    ['me', { limit: 1000 }],
    ['mess', { limit: 40 }],
    ['alpha mes', { limit: 1000 }],
    ['beta gamma', { limit: 1000 }],
    ['rareword', { limit: 1000 }],
    ['rareword alpha', { limit: 1000 }],
    ['"quoted phrase"', { limit: 1000 }],
    ['"quoted phrase" alpha', { limit: 1000 }],
    ['nothingmatches', {}],
    ['alpha nothingmatches', {}],
    ['the', { conversationId: 'alice@example.test', limit: 1000 }],
    ['me', { conversationId: 'alice@example.test', limit: 7 }],
    ['rareword', { isRoom: true, limit: 1000 }],
    ['the', { isRoom: false, limit: 1000 }],
    ['the', { conversationId: 'dev@conference.example.test', isRoom: true, limit: 1000 }],
  ]

  it('returns what the old lists returned, in the same order, for every query shape', async () => {
    const docs = [
      ...Array.from({ length: 700 }, (_, i) => legacyDoc(i, i % 3 ? 'alice@example.test' : 'bob@example.test')),
      ...Array.from({ length: 150 }, (_, i) => legacyDoc(1000 + i, 'dev@conference.example.test', true)),
    ]
    await seedV4(docs)
    await initSearchIndex(SCOPE)
    expect(await isPostingsReady(SCOPE)).toBe(false)
    const before = await Promise.all(QUERIES.map(([q, o]) => search(q, o)))
    expect(before.some(r => r.length > 50)).toBe(true)

    await migrateSearchPostings()
    expect(await isPostingsReady(SCOPE)).toBe(true)
    const after = await Promise.all(QUERIES.map(([q, o]) => search(q, o)))
    QUERIES.forEach(([q, o], i) => expect(ids(after[i]), `${q} ${JSON.stringify(o)}`).toEqual(ids(before[i])))
    expect(after.map(r => r.length)).toEqual(before.map(r => r.length))
  })

  it('uses the old lists until the ready marker is set', async () => {
    await seedV4([legacyDoc(1, 'alice@example.test'), legacyDoc(2, 'alice@example.test')])
    await initSearchIndex(SCOPE)
    // No rows exist yet: only the old lists can answer.
    expect(await search('number1')).toHaveLength(1)
    const db = await openDB(DB_NAME)
    expect(await db.count('search-postings')).toBe(0)
    db.close()
  })

  it('answers from the rows alone once ready', async () => {
    await initSearchIndex(SCOPE)
    await indexMessage({ type: 'chat', id: 'a', conversationId: 'alice@example.test', from: 'alice@example.test',
      body: 'only in rows', timestamp: new Date(1_700_000_000_000), isOutgoing: false } as Message, SCOPE)
    const db = await openDB(DB_NAME)
    await db.clear('search-tokens')
    db.close()
    expect((await search('rows')).map(r => r.messageId)).toEqual(['a'])
  })

  it('orders messages with equal timestamps by document number', async () => {
    await initSearchIndex(SCOPE)
    for (const id of ['first', 'second', 'third']) {
      await indexMessage({ type: 'chat', id, conversationId: 'alice@example.test', from: 'alice@example.test',
        body: 'tied stamp', timestamp: new Date(1_700_000_000_000), isOutgoing: false } as Message, SCOPE)
    }
    expect((await search('tied')).map(r => r.messageId)).toEqual(['first', 'second', 'third'])
    expect((await search('tied', { conversationId: 'alice@example.test' })).map(r => r.messageId))
      .toEqual(['first', 'second', 'third'])
  })

  describe('keeping deleted messages hidden', () => {
    async function seedChat(count: number) {
      await initSearchIndex(SCOPE)
      await indexMessages(Array.from({ length: count }, (_, i) => ({
        type: 'chat', id: `r${i}`, conversationId: 'alice@example.test', from: 'alice@example.test',
        body: `retract test ${i}`, timestamp: new Date(1_700_000_000_000 + i * 1000), isOutgoing: false,
      }) as Message), {}, SCOPE)
    }

    it('skips retracted messages, fills the limit past them and removes their documents', async () => {
      await seedChat(60)
      const gone = new Set(['r59', 'r58', 'r40'])
      vi.spyOn(messageCache, 'areRetractedInCache').mockImplementation(async (messages) => messages.map(m => gone.has(m.id)))
      const results = await search('retract', { limit: 3 })
      expect(results.map(r => r.messageId)).toEqual(['r57', 'r56', 'r55'])
      const wide = await search('retract', { limit: 100 })
      expect(wide.map(r => r.messageId)).not.toContain('r40')
      const db = await openDB(DB_NAME)
      const left = (await db.getAll('search-docs')).map(d => d.messageId)
      expect(left).not.toContain('r59')
      expect(left).not.toContain('r40')
      expect(await db.count('search-docs')).toBe(57)
      // The rows left with their documents.
      expect(await db.count('search-postings', IDBKeyRange.bound(['retract', -Infinity, -Infinity], ['retract', Infinity, Infinity])))
        .toBe(57)
      db.close()
    })

    it('judges only the documents it walks, in the same two-pass way for a scoped search', async () => {
      await seedChat(200)
      const spy = vi.spyOn(messageCache, 'areRetractedInCache')
      await search('retract', { limit: 3 })
      await search('retract', { limit: 3, conversationId: 'alice@example.test' })
      for (const [messages] of spy.mock.calls) expect(messages.length).toBeLessThan(30)
    })
  })

  it('walks past many candidates that fail the other words', async () => {
    await initSearchIndex(SCOPE)
    // "needle" (600 rows) drives; 700 "thread" rows exist, but only the 3 oldest share a message with it.
    const make = (i: number, body: string) => ({
      type: 'chat', id: `p${i}`, conversationId: 'alice@example.test', from: 'alice@example.test',
      body, timestamp: new Date(1_700_000_000_000 + i * 1000), isOutgoing: false,
    }) as Message
    await indexMessages([
      ...[0, 1, 2].map(i => make(i, 'needle thread')),
      ...Array.from({ length: 600 }, (_, i) => make(10 + i, 'needle only')),
      ...Array.from({ length: 700 }, (_, i) => make(1000 + i, 'thread only')),
    ], {}, SCOPE)
    const pages = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys')
    expect((await search('needle thread')).map(r => r.messageId)).toEqual(['p2', 'p1', 'p0'])
    // More than one page of the driving word was read.
    expect(pages.mock.calls.filter(([range]) => String((range as IDBKeyRange).lower?.[0]) === 'needle').length).toBeGreaterThan(1)
    expect((await search('needle thr')).map(r => r.messageId)).toEqual(['p2', 'p1', 'p0'])
  })

  it('matches a non-driving prefix on the documents, not by probing every expansion', async () => {
    await initSearchIndex(SCOPE)
    const make = (i: number, body: string) => ({
      type: 'chat', id: `x${i}`, conversationId: 'alice@example.test', from: 'alice@example.test',
      body, timestamp: new Date(1_700_000_000_000 + i * 1000), isOutgoing: false,
    }) as Message
    await indexMessages([
      make(0, 'needle zzzmatch'),
      ...Array.from({ length: 20 }, (_, i) => make(1 + i, `needle other`)),
      ...Array.from({ length: 300 }, (_, i) => make(100 + i, `zzz${i} filler zzzx${i}`)),
    ], {}, SCOPE)
    const probes = vi.spyOn(IDBObjectStore.prototype, 'getKey')
    expect((await search('needle zzz')).map(r => r.messageId)).toEqual(['x0'])
    // No lookup per expansion: the 600 expanded tokens are never probed per candidate.
    expect(probes.mock.calls.length).toBeLessThan(25)
  })

  it('does not return a message twice when a correction moves it past the cursor between pages', async () => {
    await initSearchIndex(SCOPE)
    const stamp = new Date(1_700_000_000_000)
    const make = (i: number, body: string) => ({
      type: 'chat', id: `d${i}`, conversationId: 'alice@example.test', from: 'alice@example.test',
      body, timestamp: stamp, isOutgoing: false,
    }) as Message
    await indexMessages([
      make(0, 'needle thread'),
      ...Array.from({ length: 599 }, (_, i) => make(1 + i, 'needle words thread')),
    ], {}, SCOPE)
    let corrected = false
    const real = messageCache.areRetractedInCache
    vi.spyOn(messageCache, 'areRetractedInCache').mockImplementation(async (messages, scope) => {
      if (!corrected) {
        corrected = true
        // The correction lands between page transactions and keeps the phrase.
        await updateMessage(make(0, 'needle thread, corrected'), SCOPE)
      }
      return real(messages, scope)
    })
    const results = await search('"needle thread"', { limit: 50 })
    expect(corrected).toBe(true)
    const found = results.map(r => r.messageId)
    expect(new Set(found).size).toBe(found.length)
    expect(found.filter(id => id === 'd0')).toHaveLength(1)
  })

  it('reads a conversation of more than 5,000 documents through the rows', async () => {
    await initSearchIndex(SCOPE)
    const make = (i: number) => ({
      type: 'chat', id: `b${i}`, conversationId: 'big@example.test', from: 'big@example.test',
      body: i % 1000 === 0 ? 'bulk marker' : `bulk filler ${i}`, timestamp: new Date(1_700_000_000_000 + i * 1000), isOutgoing: false,
    }) as Message
    for (let start = 0; start < 5100; start += 500) {
      await indexMessages(Array.from({ length: 500 }, (_, k) => make(start + k)).filter(m => Number(m.id.slice(1)) < 5100), {}, SCOPE)
    }
    const results = await search('bulk marker', { conversationId: 'big@example.test' })
    expect(results.map(r => r.messageId)).toEqual(['b5000', 'b4000', 'b3000', 'b2000', 'b1000', 'b0'])
  }, 120_000)
})
