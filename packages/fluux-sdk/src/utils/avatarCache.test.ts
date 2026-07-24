import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

// Must import after fake-indexeddb/auto
import {
  getCachedAvatar,
  cacheAvatar,
  revokeAllBlobUrls,
  refreshAllBlobUrls,
  clearAllAvatarData,
  getBlobUrlPoolSize,
  bumpAvatarResumeCount,
  getAvatarResumeCount,
  saveRoomOccupantAvatarHash,
  getRoomOccupantAvatarHashes,
  getAllAvatarHashes,
  groupRoomOccupantAvatarHashes,
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

  describe('refreshAllBlobUrls', () => {
    it('re-creates blob URLs from IndexedDB for all cached avatars', async () => {
      await cacheAvatar('hash-a', btoa('imgA'), 'image/png')
      await cacheAvatar('hash-b', btoa('imgB'), 'image/png')
      createSpy.mockClear()

      // Simulate stale pool (clear without revoking, as WebKit would)
      _resetBlobUrlPoolForTesting()

      const freshUrls = await refreshAllBlobUrls()

      expect(freshUrls.size).toBe(2)
      expect(freshUrls.has('hash-a')).toBe(true)
      expect(freshUrls.has('hash-b')).toBe(true)
      // Should have created 2 new blob URLs
      expect(createSpy).toHaveBeenCalledTimes(2)
    })

    it('returns empty map when no avatars are cached', async () => {
      const freshUrls = await refreshAllBlobUrls()
      expect(freshUrls.size).toBe(0)
    })

    it('makes getCachedAvatar return fresh URLs after refresh', async () => {
      await cacheAvatar('hash-x', btoa('data'), 'image/png')
      const originalUrl = await getCachedAvatar('hash-x')

      // Simulate stale pool
      _resetBlobUrlPoolForTesting()

      await refreshAllBlobUrls()
      const freshUrl = await getCachedAvatar('hash-x')

      // Should be a new blob URL, not the stale one
      expect(freshUrl).toBeTruthy()
      expect(freshUrl).not.toBe(originalUrl)
    })

    it('revokes the previously-pooled blob URLs before recreating them (no leak across refreshes)', async () => {
      // Real SM-resumption case: the pool is STILL populated because WebKit did
      // not reclaim the URLs (an ordinary network blip, not an OS sleep). Clearing
      // without revoking would orphan these URLs and leak decoded-image memory on
      // every resumption.
      const urlA = await cacheAvatar('hash-a', btoa('imgA'), 'image/png')
      const urlB = await cacheAvatar('hash-b', btoa('imgB'), 'image/png')
      revokeSpy.mockClear()

      // Refresh WITHOUT first emptying the pool.
      await refreshAllBlobUrls()

      // The stale pooled URLs must be revoked, not orphaned.
      expect(revokeSpy).toHaveBeenCalledWith(urlA)
      expect(revokeSpy).toHaveBeenCalledWith(urlB)
      expect(revokeSpy).toHaveBeenCalledTimes(2)
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

  describe('room-scoped occupant-id mappings', () => {
    it('restores a stable occupant mapping only in its own room', async () => {
      await saveRoomOccupantAvatarHash(
        'room-a@conference.example.com',
        'opaque:id/with separators',
        'hash-a',
      )
      await saveRoomOccupantAvatarHash(
        'room-b@conference.example.com',
        'opaque:id/with separators',
        'hash-b',
      )

      await expect(
        getRoomOccupantAvatarHashes('room-a@conference.example.com')
      ).resolves.toEqual([
        { occupantId: 'opaque:id/with separators', hash: 'hash-a' },
      ])
      await expect(
        getRoomOccupantAvatarHashes('room-b@conference.example.com')
      ).resolves.toEqual([
        { occupantId: 'opaque:id/with separators', hash: 'hash-b' },
      ])
    })

    it('groups every room from one occupant-mapping snapshot', async () => {
      await saveRoomOccupantAvatarHash(
        'room-a@conference.example.com',
        'occupant-a',
        'hash-a',
      )
      await saveRoomOccupantAvatarHash(
        'room-b@conference.example.com',
        'occupant-b',
        'hash-b',
      )

      const mappings = await getAllAvatarHashes('occupant')
      expect(groupRoomOccupantAvatarHashes(mappings)).toEqual(new Map([
        ['room-a@conference.example.com', [
          { occupantId: 'occupant-a', hash: 'hash-a' },
        ]],
        ['room-b@conference.example.com', [
          { occupantId: 'occupant-b', hash: 'hash-b' },
        ]],
      ]))
    })

    it('shares one grouped read across room joins and updates it after writes', async () => {
      await saveRoomOccupantAvatarHash(
        'room-a@conference.example.com',
        'occupant-a',
        'hash-a',
      )
      await saveRoomOccupantAvatarHash(
        'room-b@conference.example.com',
        'occupant-b',
        'hash-b',
      )
      const getAllSpy = vi.spyOn(IDBIndex.prototype, 'getAll')

      await expect(
        getRoomOccupantAvatarHashes('room-a@conference.example.com')
      ).resolves.toEqual([{ occupantId: 'occupant-a', hash: 'hash-a' }])
      await expect(
        getRoomOccupantAvatarHashes('room-b@conference.example.com')
      ).resolves.toEqual([{ occupantId: 'occupant-b', hash: 'hash-b' }])
      expect(getAllSpy).toHaveBeenCalledTimes(1)

      // Writes after the first join update the loaded snapshot in place, so a
      // later manual/autojoined room is visible without another full read.
      await saveRoomOccupantAvatarHash(
        'room-c@conference.example.com',
        'occupant-c',
        'hash-c',
      )
      await expect(
        getRoomOccupantAvatarHashes('room-c@conference.example.com')
      ).resolves.toEqual([{ occupantId: 'occupant-c', hash: 'hash-c' }])
      expect(getAllSpy).toHaveBeenCalledTimes(1)

      await clearAllAvatarData()
      await expect(
        getRoomOccupantAvatarHashes('room-a@conference.example.com')
      ).resolves.toEqual([])
      expect(getAllSpy).toHaveBeenCalledTimes(2)
      getAllSpy.mockRestore()
    })
  })

  describe('diagnostics', () => {
    it('getBlobUrlPoolSize reflects the number of live pooled blob URLs', async () => {
      expect(getBlobUrlPoolSize()).toBe(0)
      await cacheAvatar('hash-1', btoa('a'), 'image/png')
      await cacheAvatar('hash-2', btoa('b'), 'image/png')
      expect(getBlobUrlPoolSize()).toBe(2)

      revokeAllBlobUrls()
      expect(getBlobUrlPoolSize()).toBe(0)
    })

    it('bumpAvatarResumeCount increments the resume counter monotonically', () => {
      const before = getAvatarResumeCount()
      bumpAvatarResumeCount()
      bumpAvatarResumeCount()
      expect(getAvatarResumeCount()).toBe(before + 2)
    })
  })
})
