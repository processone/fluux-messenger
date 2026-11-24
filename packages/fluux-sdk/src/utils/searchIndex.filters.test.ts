import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import type { Message } from '../core/types'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import * as messageCache from './messageCache'
import { _resetDBForTesting, closeSearchIndex, indexMessages, initSearchIndex, search } from './searchIndex'

// Intent: a date span narrows the rows the time-sorted index reads, on the walk
// over a word's rows and on the in-memory path of a small conversation alike.

const SCOPE = 'filters@example.test'
const HOUR = 3_600_000
const T0 = Date.UTC(2024, 0, 1)

const chat = (i: number, conversationId: string, body: string) => ({
  type: 'chat', id: `m${i}`, conversationId, from: conversationId, body,
  timestamp: new Date(T0 + i * HOUR), isOutgoing: false,
}) as Message

describe('date spans on the search index', () => {
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

  it('keeps messages from the start included to the end excluded, newest first', async () => {
    await initSearchIndex(SCOPE)
    await indexMessages(Array.from({ length: 48 }, (_, i) => chat(i, 'alice@example.test', `report ${i}`)), {}, SCOPE)
    const span = { after: T0 + 10 * HOUR, before: T0 + 14 * HOUR, limit: 100 }
    const expected = ['m13', 'm12', 'm11', 'm10']
    expect((await search('report', span)).map(r => r.messageId)).toEqual(expected)
    // The same span on the small-conversation path, read whole and filtered in memory
    expect((await search('report', { ...span, conversationId: 'alice@example.test' })).map(r => r.messageId)).toEqual(expected)
    expect(await search('report', { after: T0 + 14 * HOUR, before: T0 + 10 * HOUR })).toEqual([])
  })

  it('reads only the rows inside the span', async () => {
    await initSearchIndex(SCOPE)
    await indexMessages(Array.from({ length: 400 }, (_, i) => chat(i, i % 2 ? 'alice@example.test' : 'bob@example.test', 'status update')), {}, SCOPE)
    const pages = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys')
    const results = await search('status update', { after: T0 + 100 * HOUR, before: T0 + 110 * HOUR, limit: 100 })
    expect(results.map(r => r.messageId)).toEqual(Array.from({ length: 10 }, (_, k) => `m${109 - k}`))
    // One page of the driving word, bounded by the span rather than the whole history
    const postingCalls = pages.mock.calls.filter((_, index) => {
      const store = pages.mock.contexts[index]
      return store instanceof IDBObjectStore && store.name === 'search-postings'
    })
    expect(postingCalls).toHaveLength(1)
    const range = postingCalls[0][0] as IDBKeyRange
    expect(range.lower[1]).toBe(-(T0 + 110 * HOUR))
    expect(range.upper[1]).toBe(-(T0 + 100 * HOUR))
  })

  it('narrows the old lists the same way before the time-sorted index is ready', async () => {
    await initSearchIndex(SCOPE)
    await indexMessages(Array.from({ length: 24 }, (_, i) => chat(i, 'alice@example.test', 'old lists')), {}, SCOPE)
    const { openDB } = await import('idb')
    const db = await openDB(`fluux-search-index:${SCOPE}`)
    await db.delete('search-meta', 'postings-ready')
    db.close()
    _resetDBForTesting()
    const results = await search('old', { after: T0 + 20 * HOUR })
    expect(results.map(r => r.messageId)).toEqual(['m23', 'm22', 'm21', 'm20'])
  })
})
