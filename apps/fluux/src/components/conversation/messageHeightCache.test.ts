import { describe, it, expect, beforeEach } from 'vitest'
import {
  heightCacheKey,
  getCachedHeights,
  recordMeasuredHeight,
  noteConversationWidthBucket,
  getConversationWidthBucket,
  getCachedHeight,
  persistHeightSnapshot,
  hydrateHeightCache,
  HEIGHT_CACHE_STORAGE_KEY,
  __clearHeightCache,
} from './messageHeightCache'

beforeEach(() => __clearHeightCache())

describe('messageHeightCache', () => {
  it('keys by message id + width bucket + scale', () => {
    expect(heightCacheKey('m1', 560, 100)).toBe('m1@560@100')
    expect(heightCacheKey('m1', 560, 125)).not.toBe(heightCacheKey('m1', 560, 100))
  })
  it('records and reads back a measured height per conversation', () => {
    recordMeasuredHeight('conv1', heightCacheKey('m1', 560, 100), 84)
    expect(getCachedHeights('conv1').get('m1@560@100')).toBe(84)
    expect(getCachedHeights('conv2').get('m1@560@100')).toBeUndefined()
  })
  it('does not record zero or negative heights', () => {
    recordMeasuredHeight('conv1', heightCacheKey('m1', 560, 100), 0)
    recordMeasuredHeight('conv1', heightCacheKey('m2', 560, 100), -5)
    expect(getCachedHeights('conv1').get('m1@560@100')).toBeUndefined()
    expect(getCachedHeights('conv1').get('m2@560@100')).toBeUndefined()
  })
  it('evicts the oldest conversation when LRU limit is exceeded', () => {
    for (let i = 0; i < 8; i++) {
      recordMeasuredHeight(`conv${i}`, heightCacheKey('m1', 560, 100), 40 + i)
    }
    // All 8 conversations exist
    expect(getCachedHeights('conv0').get('m1@560@100')).toBe(40)
    // Adding a 9th (conv8) should evict the LRU entry. conv0 was accessed last by getCachedHeights
    // above, so conv1 is now LRU.
    recordMeasuredHeight('conv8', heightCacheKey('m1', 560, 100), 48)
    expect(getCachedHeights('conv8').get('m1@560@100')).toBe(48)
    expect(getCachedHeights('conv1').get('m1@560@100')).toBeUndefined()
  })
  it('resolves a cached height by item key, preferring the persisted real width bucket', () => {
    // Entries written under the conversation's REAL bucket (700), reader mounts at the 560 fallback
    recordMeasuredHeight('conv1', heightCacheKey('m1', 700, 100), 84)
    noteConversationWidthBucket('conv1', 700)
    expect(getCachedHeight('conv1', 'm1', 100, 560)).toBe(84)
    // Unknown key, other scale, other conversation -> undefined
    expect(getCachedHeight('conv1', 'm2', 100, 560)).toBeUndefined()
    expect(getCachedHeight('conv1', 'm1', 125, 560)).toBeUndefined()
    expect(getCachedHeight('conv2', 'm1', 100, 560)).toBeUndefined()
  })

  it('resolves via the fallback bucket when no real bucket was recorded', () => {
    recordMeasuredHeight('conv1', heightCacheKey('m1', 560, 100), 62)
    expect(getCachedHeight('conv1', 'm1', 100, 560)).toBe(62)
  })

  it('records and reads back the real width bucket per conversation', () => {
    expect(getConversationWidthBucket('c')).toBeUndefined()
    noteConversationWidthBucket('c', 580)
    expect(getConversationWidthBucket('c')).toBe(580)
    expect(getConversationWidthBucket('other')).toBeUndefined()
    __clearHeightCache()
    expect(getConversationWidthBucket('c')).toBeUndefined()
  })
})

/** Minimal in-memory Storage double for persistence tests. */
function memoryStorage(initial?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    _dump: () => Object.fromEntries(data),
  }
}

describe('messageHeightCache persistence across reloads', () => {
  const entries = (m: Record<string, number>) => new Map(Object.entries(m))

  it('round-trips a settled snapshot through storage (entries + width bucket)', () => {
    const storage = memoryStorage()
    persistHeightSnapshot('conv1', entries({ 'm1@880@100': 84, 'm2@880@100': 423 }), 880, {
      storage,
      version: '1.0.0',
      now: 1000,
    })

    __clearHeightCache() // simulate reload: in-memory cache is gone
    hydrateHeightCache({ storage, version: '1.0.0' })

    expect(getCachedHeights('conv1').get('m1@880@100')).toBe(84)
    expect(getCachedHeights('conv1').get('m2@880@100')).toBe(423)
    expect(getConversationWidthBucket('conv1')).toBe(880)
  })

  it('drops persisted heights written under a different app version', () => {
    const storage = memoryStorage()
    persistHeightSnapshot('conv1', entries({ 'm1@880@100': 84 }), 880, {
      storage,
      version: '1.0.0',
      now: 1000,
    })

    __clearHeightCache()
    hydrateHeightCache({ storage, version: '1.1.0' })

    expect(getCachedHeights('conv1').size).toBe(0)
    expect(getConversationWidthBucket('conv1')).toBeUndefined()
  })

  it('starts a fresh payload when persisting under a new version', () => {
    const storage = memoryStorage()
    persistHeightSnapshot('old', entries({ 'm1@880@100': 84 }), 880, {
      storage,
      version: '1.0.0',
      now: 1000,
    })
    persistHeightSnapshot('new', entries({ 'm2@880@100': 90 }), 880, {
      storage,
      version: '1.1.0',
      now: 2000,
    })

    __clearHeightCache()
    hydrateHeightCache({ storage, version: '1.1.0' })

    expect(getCachedHeights('old').size).toBe(0)
    expect(getCachedHeights('new').get('m2@880@100')).toBe(90)
  })

  it('tolerates corrupt stored JSON without throwing', () => {
    const storage = memoryStorage({ [HEIGHT_CACHE_STORAGE_KEY]: '{not json' })
    expect(() => hydrateHeightCache({ storage, version: '1.0.0' })).not.toThrow()
    expect(getCachedHeights('conv1').size).toBe(0)
    // A later persist still works on top of the corrupt payload
    expect(() =>
      persistHeightSnapshot('conv1', entries({ 'm1@880@100': 84 }), 880, {
        storage,
        version: '1.0.0',
        now: 1000,
      }),
    ).not.toThrow()
  })

  it('tolerates a throwing storage without throwing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(() => hydrateHeightCache({ storage: throwing, version: '1.0.0' })).not.toThrow()
    expect(() =>
      persistHeightSnapshot('c', entries({ 'm1@880@100': 84 }), 880, {
        storage: throwing,
        version: '1.0.0',
        now: 1000,
      }),
    ).not.toThrow()
  })

  it('merges snapshots for several conversations and evicts the oldest beyond the cap', () => {
    const storage = memoryStorage()
    for (let i = 0; i < 9; i++) {
      persistHeightSnapshot(`conv${i}`, entries({ [`m@880@100`]: 40 + i }), 880, {
        storage,
        version: '1.0.0',
        now: 1000 + i,
      })
    }

    __clearHeightCache()
    hydrateHeightCache({ storage, version: '1.0.0' })

    // conv0 (oldest) was evicted; conv1..conv8 survive. Probe conv0 LAST: getCachedHeights
    // creates-and-touches in the in-memory LRU, and a 9th map would evict a hydrated one.
    expect(getCachedHeights('conv1').get('m@880@100')).toBe(41)
    expect(getCachedHeights('conv8').get('m@880@100')).toBe(48)
    expect(getCachedHeights('conv0').size).toBe(0)
  })

  it('ignores an empty snapshot instead of clobbering the stored one', () => {
    const storage = memoryStorage()
    persistHeightSnapshot('conv1', entries({ 'm1@880@100': 84 }), 880, {
      storage,
      version: '1.0.0',
      now: 1000,
    })
    persistHeightSnapshot('conv1', new Map(), 880, { storage, version: '1.0.0', now: 2000 })

    __clearHeightCache()
    hydrateHeightCache({ storage, version: '1.0.0' })

    expect(getCachedHeights('conv1').get('m1@880@100')).toBe(84)
  })

  it('hydrates only once until the cache is cleared', () => {
    const storage = memoryStorage()
    persistHeightSnapshot('conv1', entries({ 'm1@880@100': 84 }), 880, {
      storage,
      version: '1.0.0',
      now: 1000,
    })

    __clearHeightCache()
    hydrateHeightCache({ storage, version: '1.0.0' })
    // In-session measurement overrides the hydrated value…
    recordMeasuredHeight('conv1', 'm1@880@100', 99)
    // …and a second hydrate call must NOT re-apply the stale persisted value.
    hydrateHeightCache({ storage, version: '1.0.0' })
    expect(getCachedHeights('conv1').get('m1@880@100')).toBe(99)
  })
})
