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

// Mock the native download transport (tauriDownload → Rust download_file)
const mockDownloadFileTauri = vi.fn()
vi.mock('./tauriDownload', () => ({
  downloadFileTauri: (params: unknown) => mockDownloadFileTauri(params),
}))

import { resolveMediaUrl, resolveWebMediaUrl, resolveEncryptedMediaUrl, clearMediaCache, getMediaCacheSize, resetMediaUrlCache, peekMediaCache, peekEncryptedMediaCache, peekWebMediaCache, peekWebEncryptedMediaCache, resolveWebEncryptedMediaUrl } from './mediaCache'
import { encryptFile, decryptFile } from '@fluux/sdk'

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

      mockDownloadFileTauri.mockResolvedValue({ bytes: imageData, contentType: 'image/png' })

      const result = await resolveMediaUrl('https://upload.example.com/files/photo.png')

      // Should have fetched the URL through the native transport
      expect(mockDownloadFileTauri).toHaveBeenCalledWith({
        url: 'https://upload.example.com/files/photo.png',
      })

      // Should have written the file
      expect(mockWriteFile).toHaveBeenCalledTimes(1)

      // Should return an asset.localhost URL
      expect(result).toMatch(/^https:\/\/asset\.localhost\//)
      expect(result).toMatch(/\.png$/)
    })

    it('should return cached URL from memory on second call', async () => {
      mockDownloadFileTauri.mockResolvedValue({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
      })

      const url1 = await resolveMediaUrl('https://upload.example.com/files/photo.jpg')
      const url2 = await resolveMediaUrl('https://upload.example.com/files/photo.jpg')

      // Should only fetch once
      expect(mockDownloadFileTauri).toHaveBeenCalledTimes(1)
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
      expect(mockDownloadFileTauri).not.toHaveBeenCalled()

      // Should return an asset URL
      expect(result).toMatch(/^https:\/\/asset\.localhost\//)
    })

    it('should throw on fetch failure', async () => {
      mockDownloadFileTauri.mockRejectedValue(new Error('Download failed: 404'))

      await expect(
        resolveMediaUrl('https://upload.example.com/files/missing.png')
      ).rejects.toThrow('Download failed: 404')
    })

    it('should deduplicate concurrent requests for the same URL', async () => {
      mockDownloadFileTauri.mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      })

      // Fire two concurrent requests
      const [url1, url2] = await Promise.all([
        resolveMediaUrl('https://upload.example.com/files/same.png'),
        resolveMediaUrl('https://upload.example.com/files/same.png'),
      ])

      // Should only fetch once
      expect(mockDownloadFileTauri).toHaveBeenCalledTimes(1)
      expect(url1).toBe(url2)
    })

    it('should infer extension from URL when MIME type is unknown', async () => {
      mockDownloadFileTauri.mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: null,
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
      mockDownloadFileTauri.mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: 'image/png',
      })

      await resolveMediaUrl('https://upload.example.com/test.png')
      expect(mockDownloadFileTauri).toHaveBeenCalledTimes(1)

      await clearMediaCache()

      // Should have called remove on the media directory
      expect(mockRemove).toHaveBeenCalled()
      // Should have recreated the directory
      expect(mockMkdir).toHaveBeenCalled()

      // After clearing, next call should fetch again
      await resolveMediaUrl('https://upload.example.com/test.png')
      expect(mockDownloadFileTauri).toHaveBeenCalledTimes(2)
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

describe('peekMediaCache (Tauri, network-free)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(true)
    mockAppCacheDir.mockResolvedValue('/cache/com.processone.fluux')
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join('/')))
    mockMkdir.mockResolvedValue(undefined)
    mockConvertFileSrc.mockImplementation((p: string) => `https://asset.localhost/${p}`)
  })

  it('returns null on a miss without fetching', async () => {
    mockExists.mockResolvedValue(false)
    const result = await peekMediaCache('https://upload.example.com/a.png')
    expect(result).toBeNull()
    expect(mockDownloadFileTauri).not.toHaveBeenCalled()
  })

  it('returns the asset URL on a filesystem hit without fetching', async () => {
    mockExists.mockResolvedValue(true)
    const result = await peekMediaCache('https://upload.example.com/a.png')
    expect(result).toMatch(/^https:\/\/asset\.localhost\//)
    expect(mockDownloadFileTauri).not.toHaveBeenCalled()
  })
})

describe('resolveEncryptedMediaUrl (Tauri filesystem, encrypted full path)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(true)
    mockAppCacheDir.mockResolvedValue('/cache/com.processone.fluux')
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join('/')))
    mockExists.mockResolvedValue(false)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockConvertFileSrc.mockImplementation((p: string) => `https://asset.localhost/${p}`)
  })

  it('downloads+decrypts natively, writes plaintext, and returns a .dec asset URL', async () => {
    const plaintext = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7])
    const enc = await encryptFile(plaintext)
    // Faithful native-transport mock: decrypt with the key/iv the caller
    // actually passed, exactly like the Rust command — wrong params throw.
    mockDownloadFileTauri.mockImplementation(
      async ({ decrypt }: { decrypt: { key: Uint8Array; iv: Uint8Array } }) => ({
        bytes: new Uint8Array(await decryptFile(enc.ciphertext, decrypt.key, decrypt.iv)),
        contentType: 'application/octet-stream',
      }),
    )

    const url = await resolveEncryptedMediaUrl('https://upload.example.com/enc.bin', {
      cipher: 'aes-256-gcm',
      key: enc.key,
      iv: enc.iv,
    })

    expect(mockDownloadFileTauri).toHaveBeenCalledWith({
      url: 'https://upload.example.com/enc.bin',
      decrypt: { key: enc.key, iv: enc.iv },
    })
    // The DECRYPTED plaintext (not the ciphertext) is what gets written to the
    // `.dec` cache file, so no AES key needs to persist across sessions.
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenBytes] = mockWriteFile.mock.calls[0]
    expect(writtenPath).toMatch(/\.dec$/)
    expect(Array.from(writtenBytes as Uint8Array)).toEqual(Array.from(plaintext))
    expect(url).toMatch(/^https:\/\/asset\.localhost\/.*\.dec$/)
  })

  it('serves the cached .dec file on a second call without re-fetching or re-decrypting', async () => {
    mockDownloadFileTauri.mockResolvedValue({
      bytes: new Uint8Array([1, 1, 2, 3, 5, 8]),
      contentType: null,
    })
    const httpsUrl = 'https://upload.example.com/enc-again.bin'
    const encryption = { cipher: 'aes-256-gcm' as const, key: new Uint8Array(32), iv: new Uint8Array(12) }

    const first = await resolveEncryptedMediaUrl(httpsUrl, encryption)
    resetMediaUrlCache()               // drop in-memory index → consult filesystem
    mockExists.mockResolvedValue(true) // the `.dec` plaintext now exists on disk
    const second = await resolveEncryptedMediaUrl(httpsUrl, encryption)

    expect(first).toMatch(/\.dec$/)
    expect(second).toMatch(/\.dec$/)
    // Second resolve is a pure cache hit: no download, no second decrypt+write.
    expect(mockDownloadFileTauri).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
  })

  it('throws on a failed download without writing anything', async () => {
    mockDownloadFileTauri.mockRejectedValue(new Error('Download failed: 404'))

    await expect(
      resolveEncryptedMediaUrl('https://upload.example.com/missing.bin', {
        cipher: 'aes-256-gcm',
        key: new Uint8Array(32),
        iv: new Uint8Array(12),
      }),
    ).rejects.toThrow('Download failed: 404')
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

describe('peekEncryptedMediaCache (Tauri, network-free)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(true)
    mockAppCacheDir.mockResolvedValue('/cache/com.processone.fluux')
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join('/')))
    mockMkdir.mockResolvedValue(undefined)
    mockConvertFileSrc.mockImplementation((p: string) => `https://asset.localhost/${p}`)
  })

  it('returns the decrypted asset URL on a hit, with no fetch and no key', async () => {
    mockExists.mockResolvedValue(true)
    const result = await peekEncryptedMediaCache('https://upload.example.com/enc.bin')
    expect(result).toMatch(/^https:\/\/asset\.localhost\/.*\.dec$/)
    expect(mockDownloadFileTauri).not.toHaveBeenCalled()
  })

  it('returns null on a miss', async () => {
    mockExists.mockResolvedValue(false)
    expect(await peekEncryptedMediaCache('https://upload.example.com/enc.bin')).toBeNull()
  })
})

describe('peekWebMediaCache (web Cache API, network-free)', () => {
  let matchResult: Response | undefined
  const fetchSpy = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(false)
    matchResult = undefined
    vi.stubGlobal('caches', {
      open: async () => ({ match: async () => matchResult }),
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('returns null on a miss without fetching', async () => {
    matchResult = undefined
    expect(await peekWebMediaCache('https://x/a.png')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a blob URL on a Cache API hit without fetching', async () => {
    matchResult = new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    const result = await peekWebMediaCache('https://x/a.png')
    expect(result).toMatch(/^blob:/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null when the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await peekWebMediaCache('https://x/a.png')).toBeNull()
  })
})

describe('resolveWebEncryptedMediaUrl (web Cache API, scheme safety)', () => {
  const fetchSpy = vi.fn()
  let store: Map<string, Response>

  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(false)
    store = new Map()
    // Faithful Cache API mock: like a real browser, put() rejects any request
    // whose URL scheme is not http/https. This is what catches a cache key
    // such as `decrypted:https://...` (scheme = "decrypted").
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (key: unknown) => store.get(String(key)),
        put: async (key: unknown, res: Response) => {
          const k = String(key)
          const scheme = k.slice(0, k.indexOf(':'))
          if (scheme !== 'http' && scheme !== 'https') {
            throw new TypeError(
              `Failed to execute 'put' on 'Cache': Request scheme '${scheme}' is unsupported`,
            )
          }
          store.set(k, res)
        },
      }),
      delete: async () => true,
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('fetches, decrypts, and caches without tripping the Cache API scheme guard', async () => {
    const plaintext = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) // PNG-ish
    const enc = await encryptFile(plaintext)
    fetchSpy.mockResolvedValue(new Response(new Blob([enc.ciphertext.slice()])))

    const url = await resolveWebEncryptedMediaUrl('https://upload.example.com/file.bin', {
      cipher: 'aes-256-gcm',
      key: enc.key,
      iv: enc.iv,
    })

    // A successful decrypt must yield a blob URL the renderer can use — not throw
    // because the plaintext could not be written to the decrypted-media cache.
    expect(url).toMatch(/^blob:/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('serves the cached plaintext on a second call without re-fetching', async () => {
    const enc = await encryptFile(new Uint8Array([10, 20, 30, 40]))
    fetchSpy.mockResolvedValue(new Response(new Blob([enc.ciphertext.slice()])))

    const httpsUrl = 'https://upload.example.com/again.bin'
    const encryption = { cipher: 'aes-256-gcm' as const, key: enc.key, iv: enc.iv }

    const first = await resolveWebEncryptedMediaUrl(httpsUrl, encryption)
    resetMediaUrlCache() // drop the in-memory index so the Cache API is consulted
    const second = await resolveWebEncryptedMediaUrl(httpsUrl, encryption)

    expect(first).toMatch(/^blob:/)
    expect(second).toMatch(/^blob:/)
    // Second resolve is served from the persisted plaintext, not a new download.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('resolveWebMediaUrl (web Cache API, scheme safety)', () => {
  const fetchSpy = vi.fn()
  let store: Map<string, Response>

  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(false)
    store = new Map()
    // Same faithful Cache API mock as the encrypted suite: put() rejects any
    // request whose URL scheme is not http/https, mirroring the real browser.
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (key: unknown) => store.get(String(key)),
        put: async (key: unknown, res: Response) => {
          const k = String(key)
          const scheme = k.slice(0, k.indexOf(':'))
          if (scheme !== 'http' && scheme !== 'https') {
            throw new TypeError(
              `Failed to execute 'put' on 'Cache': Request scheme '${scheme}' is unsupported`,
            )
          }
          store.set(k, res)
        },
      }),
      delete: async () => true,
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('fetches and caches plaintext without tripping the Cache API scheme guard', async () => {
    fetchSpy.mockResolvedValue(new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })))

    const url = await resolveWebMediaUrl('https://upload.example.com/plain.png')

    expect(url).toMatch(/^blob:/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('serves the cached bytes on a second call without re-fetching', async () => {
    fetchSpy.mockResolvedValue(new Response(new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' })))
    const httpsUrl = 'https://upload.example.com/plain-again.png'

    const first = await resolveWebMediaUrl(httpsUrl)
    resetMediaUrlCache() // drop the in-memory index so the Cache API is consulted
    const second = await resolveWebMediaUrl(httpsUrl)

    expect(first).toMatch(/^blob:/)
    expect(second).toMatch(/^blob:/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('peekWebEncryptedMediaCache (web Cache API, encrypted, network-free)', () => {
  let matchResult: Response | undefined
  const fetchSpy = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(false)
    matchResult = undefined
    vi.stubGlobal('caches', {
      open: async () => ({ match: async () => matchResult }),
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('returns null on a miss without fetching', async () => {
    matchResult = undefined
    expect(await peekWebEncryptedMediaCache('https://x/enc.bin')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a blob URL on a Cache API hit without fetching or decryption', async () => {
    matchResult = new Response(new Blob([new Uint8Array([4, 5, 6])], { type: 'application/octet-stream' }))
    const result = await peekWebEncryptedMediaCache('https://x/enc.bin')
    expect(result).toMatch(/^blob:/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null when the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await peekWebEncryptedMediaCache('https://x/enc.bin')).toBeNull()
  })
})
