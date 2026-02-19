import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

// Must import after fake-indexeddb/auto
import {
  getCachedAvatar,
  cacheAvatar,
  revokeAllBlobUrls,
  clearAllAvatarData,
  _resetBlobUrlPoolForTesting,
  _resetDBForTesting,
} from './avatarCache'

// Track blob URLs created/revoked via spies
let blobUrlCounter = 0
const createSpy = vi.spyOn(URL, 'createObjectURL')
const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')

createSpy.mockImplementation(() => `blob:test-${++blobUrlCounter}`)
revokeSpy.mockImplementation(() => {})

describe('avatarCache blob URL pool', () => {
  beforeEach(() => {
    // Reset IndexedDB and module state for test isolation
    globalThis.indexedDB = new IDBFactory()
    _resetDBForTesting()
    _resetBlobUrlPoolForTesting()
    blobUrlCounter = 0
    createSpy.mockClear()
    revokeSpy.mockClear()
  })

  describe('getCachedAvatar deduplication', () => {
    it('returns same blob URL for same hash on repeated calls', async () => {
      // Cache an avatar first
      await cacheAvatar('hash-abc', btoa('imagedata'), 'image/png')
      createSpy.mockClear()

      // Retrieve it twice
      const url1 = await getCachedAvatar('hash-abc')
      const url2 = await getCachedAvatar('hash-abc')

      expect(url1).toBe(url2)
      // createObjectURL should not be called again since the pool returns the existing URL
      expect(createSpy).not.toHaveBeenCalled()
    })

    it('returns different blob URLs for different hashes', async () => {
      await cacheAvatar('hash-1', btoa('data1'), 'image/png')
      await cacheAvatar('hash-2', btoa('data2'), 'image/png')
      createSpy.mockClear()

      const url1 = await getCachedAvatar('hash-1')
      const url2 = await getCachedAvatar('hash-2')

      expect(url1).not.toBe(url2)
    })

    it('returns null for uncached hash', async () => {
      const url = await getCachedAvatar('nonexistent')
      expect(url).toBeNull()
    })

    it('creates blob URL on first call and caches it in pool', async () => {
      await cacheAvatar('hash-abc', btoa('imagedata'), 'image/png')
      // cacheAvatar created one blob URL
      expect(createSpy).toHaveBeenCalledTimes(1)
      createSpy.mockClear()

      // getCachedAvatar should return the pool hit, no new createObjectURL
      const url = await getCachedAvatar('hash-abc')
      expect(url).toBeTruthy()
      expect(createSpy).not.toHaveBeenCalled()
    })
  })

  describe('cacheAvatar', () => {
    it('revokes previous blob URL when re-caching same hash', async () => {
      const url1 = await cacheAvatar('hash-abc', btoa('data1'), 'image/png')
      const url2 = await cacheAvatar('hash-abc', btoa('data2'), 'image/png')

      expect(revokeSpy).toHaveBeenCalledWith(url1)
      expect(url2).not.toBe(url1)
    })

    it('does not revoke when caching a new hash', async () => {
      await cacheAvatar('hash-1', btoa('data1'), 'image/png')
      revokeSpy.mockClear()

      await cacheAvatar('hash-2', btoa('data2'), 'image/png')
      expect(revokeSpy).not.toHaveBeenCalled()
    })

    it('tracks blob URL in pool for later retrieval', async () => {
      const url = await cacheAvatar('hash-abc', btoa('data'), 'image/png')

      // getCachedAvatar should return the same URL from the pool
      const retrieved = await getCachedAvatar('hash-abc')
      expect(retrieved).toBe(url)
    })
  })

  describe('revokeAllBlobUrls', () => {
    it('revokes all tracked blob URLs', async () => {
      await cacheAvatar('hash-1', btoa('data1'), 'image/png')
      await cacheAvatar('hash-2', btoa('data2'), 'image/png')
      revokeSpy.mockClear()

      revokeAllBlobUrls()

      expect(revokeSpy).toHaveBeenCalledTimes(2)
    })

    it('clears the pool so subsequent getCachedAvatar creates new URLs', async () => {
      await cacheAvatar('hash-abc', btoa('data'), 'image/png')
      const urlBefore = await getCachedAvatar('hash-abc')

      revokeAllBlobUrls()
      createSpy.mockClear()

      // Should create a new blob URL from IndexedDB since pool is empty
      const urlAfter = await getCachedAvatar('hash-abc')
      expect(urlAfter).toBeTruthy()
      expect(urlAfter).not.toBe(urlBefore)
      expect(createSpy).toHaveBeenCalledTimes(1)
    })

    it('is a no-op when pool is empty', () => {
      revokeAllBlobUrls()
      expect(revokeSpy).not.toHaveBeenCalled()
    })
  })

  describe('clearAllAvatarData', () => {
    it('revokes blob URLs before clearing IndexedDB', async () => {
      await cacheAvatar('hash-1', btoa('data1'), 'image/png')
      await cacheAvatar('hash-2', btoa('data2'), 'image/png')
      revokeSpy.mockClear()

      await clearAllAvatarData()

      expect(revokeSpy).toHaveBeenCalledTimes(2)
    })

    it('clears pool and IndexedDB data', async () => {
      await cacheAvatar('hash-abc', btoa('data'), 'image/png')

      await clearAllAvatarData()

      // Pool is cleared, IndexedDB is cleared — should get null
      const url = await getCachedAvatar('hash-abc')
      expect(url).toBeNull()
    })
  })
})
