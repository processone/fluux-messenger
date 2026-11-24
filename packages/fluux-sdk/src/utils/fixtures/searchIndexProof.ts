import type { Message } from '../../core/types'
import * as index from '../searchIndex'
import * as cache from '../messageCache'
import { setStorageScopeJid } from '../storageScope'
import { generateSearchHistory, seedVersion5SearchHistory } from './searchHistory'

export { generateSearchHistory, seedVersion5SearchHistory }

const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]

/** Run only in an isolated browser profile: the fixture uses its own account-scoped stores. */
export async function measureSearchHistory(corpus: readonly Message[], count = 50_000, stage: 'version5' | 'candidate' = 'candidate') {
  const scope = 'search-proof@example.test'
  setStorageScopeJid(scope)
  const messages = generateSearchHistory(corpus, count)
  await seedVersion5SearchHistory(scope, messages)
  await cache.saveMessages('chat', messages as Message[])
  const expectedWordIds = messages.filter(message => /\bsearch\w*/i.test(message.body ?? ''))
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime()).slice(0, 50).map(message => message.id)
  if (!expectedWordIds.length) throw new Error('The corpus needs searchable conversation text')
  const timings = async () => {
    const values: number[] = []
    for (let round = 0; round < 30; round++) {
      const started = performance.now()
      const results = await index.search('search')
      values.push(performance.now() - started)
      if (JSON.stringify(results.map(row => row.messageId)) !== JSON.stringify(expectedWordIds)) {
        throw new Error('Word search disagrees with the independently selected fixture messages')
      }
    }
    return { medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95) }
  }
  try {
    const version5 = await timings()
    if (stage === 'version5') return { stage, count: messages.length, corpusMessages: corpus.length, version5 }
    const started = performance.now()
    await index.migrateSearchFilters()
    const migrationMs = performance.now() - started
    const candidate = await timings()
    const state = await index.getFilterIndexState()
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`fluux-search-index:${scope}`)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    let facetRows = 0
    try {
      const tx = db.transaction('search-postings')
      facetRows = await new Promise<number>((resolve, reject) => {
        const request = tx.objectStore('search-postings').count(IDBKeyRange.bound(['\u0001'], ['\u0002']))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
    const reads: Array<{ window: string; documentReads: number; postingRows: number; outOfSpan: number; resultIds: string[] }> = []
    const originalGet = IDBIndex.prototype.get
    const originalKeys = IDBObjectStore.prototype.getAllKeys
    for (const [window, after, before] of [
      ['narrow', Date.UTC(2024, 0, 10), Date.UTC(2024, 0, 11)],
      ['broad', Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)],
    ] as const) {
      let documentReads = 0
      let postingRows = 0
      let outOfSpan = 0
      IDBIndex.prototype.get = function (...args) {
        if (this.objectStore.name === 'search-docs') documentReads++
        return originalGet.apply(this, args)
      }
      IDBObjectStore.prototype.getAllKeys = function (...args) {
        const request = originalKeys.apply(this, args)
        if (this.name === 'search-postings') request.addEventListener('success', () => {
          for (const key of request.result) {
            const stamp = -(key as [string, number, number])[1]
            postingRows++
            if (stamp < after || stamp >= before) outOfSpan++
          }
        })
        return request
      }
      try {
        const results = await index.search('search', { after, before })
        reads.push({ window, documentReads, postingRows, outOfSpan, resultIds: results.map(row => row.messageId) })
      } finally {
        IDBIndex.prototype.get = originalGet
        IDBObjectStore.prototype.getAllKeys = originalKeys
      }
    }
    return { stage, count: messages.length, corpusMessages: corpus.length, version5, candidate, migrationMs, facetRows, state, reads }
  } finally {
    await index.closeSearchIndex()
    setStorageScopeJid(null)
  }
}
