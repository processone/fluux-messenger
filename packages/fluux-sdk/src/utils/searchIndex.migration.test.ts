import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import type { Message } from '../core/types'
import { setStorageScopeJid, _resetStorageScopeForTesting } from './storageScope'
import * as cache from './messageCache'
import { generateSearchHistory, seedVersion5SearchHistory } from './fixtures/searchHistory'
import { _resetDBForTesting, closeSearchIndex, getFilterIndexState, indexMessages, migrateSearchFilters, search } from './searchIndex'
import { filterToken } from './searchFilters'

const scope = 'search@example.test'
const photo: Message = { type: 'chat', id: 'photo', originId: undefined, stanzaId: 'archive-photo', conversationId: 'alice@example.test',
  from: 'alice@example.test', isOutgoing: false, timestamp: new Date('2024-03-31T01:30:00Z'),
  body: 'https://upload.example.test/team.png', attachment: { url: 'https://upload.example.test/team.png', mediaType: 'image/png' } }
const resultIds = async (value: 'image' | 'link') => (await search('', { filterGroups: [[filterToken.has(value)]] })).map(row => row.messageId)

describe('historical filter preparation', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    _resetStorageScopeForTesting()
    _resetDBForTesting()
    cache._resetDBForTesting()
    setStorageScopeJid(scope)
  })
  afterEach(async () => { await closeSearchIndex(); vi.restoreAllMocks() })

  it('keeps unknown old attachments out of Links and repairs them on authoritative replay', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    expect(await getFilterIndexState()).toEqual({ status: 'preparing' })
    await migrateSearchFilters()
    expect(await getFilterIndexState()).toEqual({ status: 'incomplete' })
    expect(await resultIds('link')).toEqual([])
    expect(await resultIds('image')).toEqual([])
    await indexMessages([photo])
    expect(await getFilterIndexState()).toEqual({ status: 'usable' })
    expect(await resultIds('image')).toEqual(['photo'])
    expect(await resultIds('link')).toEqual([])
  })

  it('gives known v5 attachments the same facets as fresh indexing', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    await cache.saveMessages('chat', [photo])
    await migrateSearchFilters()
    expect(await getFilterIndexState()).toEqual({ status: 'usable' })
    expect(await resultIds('image')).toEqual(['photo'])
    expect(await resultIds('link')).toEqual([])
  })

  it('repairs prerelease v6 content guesses even when its old ready marker is set', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    const db = await openDB(`fluux-search-index:${scope}`, 6)
    const tx = db.transaction(['search-docs', 'search-meta', 'search-postings'], 'readwrite')
    const doc = (await tx.objectStore('search-docs').getAll())[0]
    await tx.objectStore('search-docs').put({ ...doc, filterTokens: [filterToken.has('link')] })
    await tx.objectStore('search-postings').put(1, [filterToken.has('link'), -doc.timestamp, doc.docNo])
    await tx.objectStore('search-meta').put({ key: 'filters-ready', value: '1' })
    await tx.done
    db.close()
    await migrateSearchFilters()
    expect(await getFilterIndexState()).toEqual({ status: 'incomplete' })
    expect(await resultIds('link')).toEqual([])
  })

  it('reports a failed metadata read and retries without certifying an unfinished migration', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    const read = vi.spyOn(cache, 'resolveMessagesForIndex').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'))
    await migrateSearchFilters()
    expect(await getFilterIndexState()).toEqual({ status: 'unavailable', reason: 'Storage full' })
    expect(await resultIds('image')).toEqual([])
    read.mockRestore()
    await cache.saveMessages('chat', [photo])
    await migrateSearchFilters()
    expect(await resultIds('image')).toEqual(['photo'])
    expect(await getFilterIndexState()).toEqual({ status: 'usable' })
  })
  it('rolls back documents, facet rows and the checkpoint together when a facet write fails', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    await cache.saveMessages('chat', [photo])
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'search-postings' && Array.isArray(key) && String(key[0]).startsWith('\u0001')) {
        throw new DOMException('Facet storage full', 'QuotaExceededError')
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    })
    await migrateSearchFilters()
    expect(await getFilterIndexState()).toEqual({ status: 'unavailable', reason: 'Facet storage full' })
    const db = await openDB(`fluux-search-index:${scope}`)
    try {
      expect((await db.getAll('search-docs'))[0].filterBuild).toBeUndefined()
      expect(await db.get('search-meta', 'filters-cursor')).toBeUndefined()
      expect((await db.getAllKeys('search-postings')).filter(key => Array.isArray(key) && String(key[0]).startsWith('\u0001'))).toEqual([])
    } finally { db.close() }
    failure.mockRestore()
    await migrateSearchFilters()
    expect(await resultIds('image')).toEqual(['photo'])
  })

  it('never regresses a checkpoint when independent tab workers prepare the same history', async () => {
    const messages = generateSearchHistory([photo], 250) as Message[]
    await seedVersion5SearchHistory(scope, messages)
    await cache.saveMessages('chat', messages)
    vi.resetModules()
    const otherScope = await import('./storageScope')
    const other = await import('./searchIndex')
    otherScope.setStorageScopeJid(scope)
    const checkpoints: string[] = []
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'search-meta' && value.key === 'filters-cursor') checkpoints.push(value.value)
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    })
    try {
      await Promise.all([migrateSearchFilters(), other.migrateSearchFilters()])
      expect(await getFilterIndexState()).toEqual({ status: 'usable' })
      expect((await search('', { limit: 1000, filterGroups: [[filterToken.has('image')]] })).length).toBe(250)
      expect(checkpoints.length).toBeGreaterThan(1)
      expect(checkpoints.every((cursor, index) => index === 0 || indexedDB.cmp(cursor, checkpoints[index - 1]) >= 0)).toBe(true)
    } finally { await other.closeSearchIndex() }
  })

  it('ignores a stale batch even when the reader returns to the original account', async () => {
    await seedVersion5SearchHistory(scope, [photo])
    const resolve = cache.resolveMessagesForIndex
    vi.spyOn(cache, 'resolveMessagesForIndex').mockImplementationOnce(async (...args) => {
      const result = await resolve(...args)
      setStorageScopeJid('other@example.test')
      setStorageScopeJid(scope)
      return result
    })
    await migrateSearchFilters()
    expect(await getFilterIndexState()).toEqual({ status: 'preparing' })
    const db = await openDB(`fluux-search-index:${scope}`)
    try {
      expect(await db.get('search-meta', 'filters-ready')).toBeUndefined()
      expect(await db.get('search-meta', 'filters-cursor')).toBeUndefined()
    } finally { db.close() }
  })

})
