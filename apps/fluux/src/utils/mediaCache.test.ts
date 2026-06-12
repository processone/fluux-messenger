import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock tauri detection
const mockIsTauri = vi.fn()
vi.mock('./tauri', () => ({
  isTauri: () => mockIsTauri(),
}))

// Mock Tauri path API
const mockAppCacheDir = vi.fn()
const mockJoin = vi.fn()
vi.mock('@tauri-apps/api/path', () => ({
  appCacheDir: () => mockAppCacheDir(),
  join: (...args: string[]) => mockJoin(...args),
}))

// Mock Tauri fs API
const mockExists = vi.fn()
const mockMkdir = vi.fn()
const mockWriteFile = vi.fn()
const mockRemove = vi.fn()
const mockReadDir = vi.fn()
const mockStat = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (path: string) => mockExists(path),
  mkdir: (path: string, opts: unknown) => mockMkdir(path, opts),
  writeFile: (path: string, data: Uint8Array) => mockWriteFile(path, data),
  remove: (path: string, opts: unknown) => mockRemove(path, opts),
  readDir: (path: string) => mockReadDir(path),
  stat: (path: string) => mockStat(path),
}))

// Mock Tauri core API
const mockConvertFileSrc = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
}))

// Mock Tauri HTTP plugin
const mockTauriFetch = vi.fn()
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: (url: string, opts: unknown) => mockTauriFetch(url, opts),
}))

import { resolveMediaUrl, clearMediaCache, getMediaCacheSize, resetMediaUrlCache } from './mediaCache'

describe('mediaCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()

    mockIsTauri.mockReturnValue(true)
    mockAppCacheDir.mockResolvedValue('/Users/test/Library/Caches/com.processone.fluux')
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join('/')))
    mockExists.mockResolvedValue(false)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockConvertFileSrc.mockImplementation((path: string) => `https://asset.localhost/${path}`)
  })

  describe('resolveMediaUrl', () => {
    it('should fetch, cache, and return asset URL on cache miss', async () => {
      const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG header
      const mockBlob = new Blob([imageData], { type: 'image/png' })

      mockTauriFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        blob: () => Promise.resolve(mockBlob),
      })

      const result = await resolveMediaUrl('https://upload.example.com/files/photo.png')

      // Should have fetched the URL
      expect(mockTauriFetch).toHaveBeenCalledWith(
        'https://upload.example.com/files/photo.png',
        { method: 'GET' },
      )

      // Should have written the file
      expect(mockWriteFile).toHaveBeenCalledTimes(1)

      // Should return an asset.localhost URL
      expect(result).toMatch(/^https:\/\/asset\.localhost\//)
      expect(result).toMatch(/\.png$/)
    })

    it('should return cached URL from memory on second call', async () => {
      const mockBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
      mockTauriFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        blob: () => Promise.resolve(mockBlob),
      })

      const url1 = await resolveMediaUrl('https://upload.example.com/files/photo.jpg')
      const url2 = await resolveMediaUrl('https://upload.example.com/files/photo.jpg')

      // Should only fetch once
      expect(mockTauriFetch).toHaveBeenCalledTimes(1)
      expect(url1).toBe(url2)
    })

    it('should return asset URL from filesystem on cache hit', async () => {
      // exists returns: false for dir (triggers mkdir), true for cached file
      mockExists
        .mockResolvedValueOnce(false) // media dir check → mkdir
        .mockResolvedValueOnce(true)  // cached file exists

      const result = await resolveMediaUrl('https://upload.example.com/files/cached.png')

      // Should have created the media directory
      expect(mockMkdir).toHaveBeenCalled()

      // Should NOT have fetched (file was found on disk)
      expect(mockTauriFetch).not.toHaveBeenCalled()

      // Should return an asset URL
      expect(result).toMatch(/^https:\/\/asset\.localhost\//)
    })

    it('should throw on fetch failure', async () => {
      mockTauriFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })

      await expect(
        resolveMediaUrl('https://upload.example.com/files/missing.png')
      ).rejects.toThrow('Fetch failed: 404 Not Found')
    })

    it('should deduplicate concurrent requests for the same URL', async () => {
      const mockBlob = new Blob([new Uint8Array([1])], { type: 'image/png' })
      mockTauriFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        blob: () => Promise.resolve(mockBlob),
      })

      // Fire two concurrent requests
      const [url1, url2] = await Promise.all([
        resolveMediaUrl('https://upload.example.com/files/same.png'),
        resolveMediaUrl('https://upload.example.com/files/same.png'),
      ])

      // Should only fetch once
      expect(mockTauriFetch).toHaveBeenCalledTimes(1)
      expect(url1).toBe(url2)
    })

    it('should infer extension from URL when MIME type is unknown', async () => {
      const mockBlob = new Blob([new Uint8Array([1])], { type: '' })
      mockTauriFetch.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        blob: () => Promise.resolve(mockBlob),
      })

      await resolveMediaUrl('https://upload.example.com/files/photo.webp')

      // File should end with .webp (inferred from URL)
      const writtenPath = mockWriteFile.mock.calls[0][0] as string
      expect(writtenPath).toMatch(/\.webp$/)
    })
  })

  describe('clearMediaCache', () => {
    it('should clear in-memory cache and remove filesystem directory', async () => {
      // Populate memory cache first
      const mockBlob = new Blob([new Uint8Array([1])], { type: 'image/png' })
      mockTauriFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        blob: () => Promise.resolve(mockBlob),
      })

      await resolveMediaUrl('https://upload.example.com/test.png')
      expect(mockTauriFetch).toHaveBeenCalledTimes(1)

      await clearMediaCache()

      // Should have called remove on the media directory
      expect(mockRemove).toHaveBeenCalled()
      // Should have recreated the directory
      expect(mockMkdir).toHaveBeenCalled()

      // After clearing, next call should fetch again
      await resolveMediaUrl('https://upload.example.com/test.png')
      expect(mockTauriFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('getMediaCacheSize', () => {
    it('should return 0 when not in Tauri', async () => {
      mockIsTauri.mockReturnValue(false)
      const size = await getMediaCacheSize()
      expect(size).toBe(0)
    })

    it('should sum file sizes in the cache directory', async () => {
      mockExists.mockResolvedValue(true) // media dir exists
      mockReadDir.mockResolvedValue([
        { name: 'abc123.png', isFile: true },
        { name: 'def456.jpg', isFile: true },
      ])
      mockStat
        .mockResolvedValueOnce({ size: 50000 })
        .mockResolvedValueOnce({ size: 100000 })

      const size = await getMediaCacheSize()
      expect(size).toBe(150000)
    })
  })
})
