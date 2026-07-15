/**
 * Media cache with platform-specific backends:
 *
 * - **Tauri (desktop):** Filesystem-based cache at {appCacheDir}/media/{sha256(url)}.{ext},
 *   served as https://asset.localhost/... URLs via convertFileSrc().
 * - **Web:** Cache API-based persistent cache ('fluux-media'), served as blob: URLs.
 *   Previously-viewed media survives page reloads without re-fetching from the server.
 */

import { decryptFile, type FileEncryption } from '@fluux/sdk'
import { isTauri } from './tauri'

/** In-memory index: original URL → local URL (asset.localhost or blob:) */
const urlCache = new Map<string, string>()

/** In-flight fetch deduplication: URL → pending promise */
const inflight = new Map<string, Promise<string>>()

/** Cached base path for the media cache directory */
let mediaDirPath: string | null = null

const MEDIA_SUBDIR = 'media'

/**
 * MIME type to file extension mapping.
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
}

/**
 * Get the media cache directory path, creating it if needed.
 */
async function getMediaDir(): Promise<string> {
  if (mediaDirPath) return mediaDirPath

  const { appCacheDir, join } = await import('@tauri-apps/api/path')
  const { mkdir, exists } = await import('@tauri-apps/plugin-fs')

  const cacheDir = await appCacheDir()
  const mediaDir = await join(cacheDir, MEDIA_SUBDIR)

  if (!await exists(mediaDir)) {
    await mkdir(mediaDir, { recursive: true })
  }

  mediaDirPath = mediaDir
  return mediaDir
}

/**
 * Generate a deterministic cache filename from a URL.
 * Uses SHA-256 hash of the URL + extension from MIME type.
 */
async function getCacheFileName(url: string, mimeType?: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  // Determine extension from MIME type, or extract from URL, fallback to 'bin'
  let ext = mimeType ? MIME_TO_EXT[mimeType] : undefined
  if (!ext) {
    const urlPath = new URL(url).pathname
    const match = urlPath.match(/\.([a-zA-Z0-9]+)$/)
    ext = match ? match[1].toLowerCase() : 'bin'
  }

  return `${hex}.${ext}`
}

/**
 * Get the full file path for a cached media URL.
 */
async function getCacheFilePath(url: string, mimeType?: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path')
  const mediaDir = await getMediaDir()
  const fileName = await getCacheFileName(url, mimeType)
  return join(mediaDir, fileName)
}

/**
 * Resolve a media URL to a local asset URL, using cache if available.
 *
 * 1. Check in-memory map (instant)
 * 2. Check filesystem (fast)
 * 3. Fetch via the native download_file command → write to cache → return asset URL
 *
 * @returns asset.localhost URL for use in <img>/<video>/<audio> tags
 * @throws on fetch/write failure (caller should fall back to direct URL)
 */
export async function resolveMediaUrl(originalUrl: string): Promise<string> {
  // 1. Check in-memory cache
  const cached = urlCache.get(originalUrl)
  if (cached) return cached

  // Deduplicate concurrent requests for the same URL
  const existing = inflight.get(originalUrl)
  if (existing) return existing

  const promise = doResolve(originalUrl)
  inflight.set(originalUrl, promise)

  try {
    return await promise
  } finally {
    inflight.delete(originalUrl)
  }
}

/**
 * Network-free cache read for plaintext media on Tauri.
 * Checks the in-memory index then the filesystem. Never fetches.
 */
export async function peekMediaCache(originalUrl: string): Promise<string | null> {
  const cached = urlCache.get(originalUrl)
  if (cached) return cached

  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { exists } = await import('@tauri-apps/plugin-fs')

  const filePath = await getCacheFilePath(originalUrl)
  if (await exists(filePath)) {
    const assetUrl = convertFileSrc(filePath)
    urlCache.set(originalUrl, assetUrl)
    return assetUrl
  }
  return null
}

async function doResolve(originalUrl: string): Promise<string> {
  // 1-2. In-memory + filesystem cache (network-free)
  const peeked = await peekMediaCache(originalUrl)
  if (peeked) return peeked

  // 3. Fetch and cache. Native `download_file` command, NOT
  // @tauri-apps/plugin-http — its chunked number-array marshaling blocks the
  // WebView main thread ~20ms/MB on large media (see tauriDownload.ts).
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { downloadFileTauri } = await import('./tauriDownload')

  const { bytes, contentType } = await downloadFileTauri({ url: originalUrl })

  const finalPath = await getCacheFilePath(originalUrl, contentType ?? undefined)

  const { writeFile } = await import('@tauri-apps/plugin-fs')
  await writeFile(finalPath, bytes)

  const assetUrl = convertFileSrc(finalPath)
  urlCache.set(originalUrl, assetUrl)
  return assetUrl
}

// ---------------------------------------------------------------------------
// Encrypted media cache (Tauri + web)
// ---------------------------------------------------------------------------

/**
 * Returns the filesystem path used to cache the decrypted content of an
 * encrypted attachment. Uses a `.dec` extension so the lookup is deterministic
 * regardless of the server-side MIME type.
 */
async function getDecryptedCacheFilePath(httpsUrl: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path')
  const mediaDir = await getMediaDir()
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(httpsUrl))
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return join(mediaDir, `${hex}.dec`)
}

/**
 * Resolve an encrypted attachment URL for Tauri desktop.
 *
 * Downloads and AES-GCM-decrypts `httpsUrl` in Rust (native `download_file`
 * command), then writes the plaintext to `{appCacheDir}/media/{sha256}.dec`.
 * Subsequent calls return
 * the cached `asset://localhost` URL without re-downloading or re-decrypting.
 *
 * Storing the decrypted content means no AES key needs to be persisted
 * across sessions — the key is only required on the first download.
 */
export async function resolveEncryptedMediaUrl(
  httpsUrl: string,
  encryption: FileEncryption,
): Promise<string> {
  const cacheKey = `enc:${httpsUrl}`

  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  const existing = inflight.get(cacheKey)
  if (existing) return existing

  const promise = doResolveEncrypted(httpsUrl, encryption, cacheKey)
  inflight.set(cacheKey, promise)

  try {
    return await promise
  } finally {
    inflight.delete(cacheKey)
  }
}

/**
 * Network-free cache read for encrypted media on Tauri. Returns the cached
 * decrypted (`.dec`) asset URL on a hit. Needs no encryption key.
 */
export async function peekEncryptedMediaCache(httpsUrl: string): Promise<string | null> {
  const cacheKey = `enc:${httpsUrl}`
  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { exists } = await import('@tauri-apps/plugin-fs')

  const filePath = await getDecryptedCacheFilePath(httpsUrl)
  if (await exists(filePath)) {
    const assetUrl = convertFileSrc(filePath)
    urlCache.set(cacheKey, assetUrl)
    return assetUrl
  }
  return null
}

async function doResolveEncrypted(
  httpsUrl: string,
  encryption: FileEncryption,
  cacheKey: string,
): Promise<string> {
  const peeked = await peekEncryptedMediaCache(httpsUrl)
  if (peeked) return peeked

  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { writeFile } = await import('@tauri-apps/plugin-fs')

  // Native `download_file` command with the AES params passed through:
  // Rust downloads AND decrypts (XEP-0454), so neither the ciphertext nor
  // the plaintext takes plugin-http's number-array path through the WebView
  // main thread (see tauriDownload.ts).
  const { downloadFileTauri } = await import('./tauriDownload')
  const { bytes: plaintext } = await downloadFileTauri({
    url: httpsUrl,
    decrypt: { key: encryption.key, iv: encryption.iv },
  })

  const filePath = await getDecryptedCacheFilePath(httpsUrl)
  await writeFile(filePath, plaintext)

  const assetUrl = convertFileSrc(filePath)
  urlCache.set(cacheKey, assetUrl)
  return assetUrl
}

// ---------------------------------------------------------------------------
// Web Cache API backend
// ---------------------------------------------------------------------------

const WEB_CACHE_NAME = 'fluux-media'

/** Blob URLs created from web cache — tracked for revocation on cleanup */
const webBlobUrls = new Map<string, string>()

/**
 * Network-free cache read for plaintext media on web. Checks the in-memory
 * index then the Cache API. Returns null if no Cache API or no entry.
 */
export async function peekWebMediaCache(originalUrl: string): Promise<string | null> {
  const cached = urlCache.get(originalUrl)
  if (cached) return cached

  if (typeof caches === 'undefined') return null
  const cache = await caches.open(WEB_CACHE_NAME)
  const cachedResponse = await cache.match(originalUrl)
  if (cachedResponse) {
    const blob = await cachedResponse.blob()
    const blobUrl = URL.createObjectURL(blob)
    urlCache.set(originalUrl, blobUrl)
    webBlobUrls.set(originalUrl, blobUrl)
    return blobUrl
  }
  return null
}

/**
 * Resolve a media URL through the browser Cache API (web mode only).
 *
 * 1. Check in-memory map (instant)
 * 2. Check Cache API for a stored response → create blob URL
 * 3. Fetch, store in Cache API, return blob URL
 *
 * @returns blob: URL for use in <img>/<video>/<audio> tags
 * @throws on fetch failure (caller should show error UI)
 */
export async function resolveWebMediaUrl(originalUrl: string): Promise<string> {
  // 1. In-memory hit
  const cached = urlCache.get(originalUrl)
  if (cached) return cached

  // Deduplicate concurrent requests
  const existing = inflight.get(originalUrl)
  if (existing) return existing

  const promise = doResolveWeb(originalUrl)
  inflight.set(originalUrl, promise)

  try {
    return await promise
  } finally {
    inflight.delete(originalUrl)
  }
}

async function doResolveWeb(originalUrl: string): Promise<string> {
  const peeked = await peekWebMediaCache(originalUrl)
  if (peeked) return peeked

  const cache = await caches.open(WEB_CACHE_NAME)

  // Fetch and cache
  const response = await fetch(originalUrl)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const responseClone = response.clone()
  await cache.put(originalUrl, responseClone)

  const blob = await response.blob()
  const blobUrl = URL.createObjectURL(blob)
  urlCache.set(originalUrl, blobUrl)
  webBlobUrls.set(originalUrl, blobUrl)
  return blobUrl
}

const WEB_DECRYPTED_CACHE_NAME = 'fluux-media-decrypted'

/**
 * Network-free cache read for encrypted media on web. Returns a blob URL
 * built from the cached decrypted plaintext. Needs no encryption key.
 */
export async function peekWebEncryptedMediaCache(httpsUrl: string): Promise<string | null> {
  const cacheKey = `enc:${httpsUrl}`
  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  if (typeof caches === 'undefined') return null
  // Key the dedicated decrypted-media cache with the plain https URL. The
  // Cache API rejects put()/match() requests whose scheme is not http(s), so a
  // synthetic prefix like `decrypted:` would make put() throw — a separate
  // cache name (WEB_DECRYPTED_CACHE_NAME) already isolates it from plaintext.
  const webCacheKey = httpsUrl
  const cache = await caches.open(WEB_DECRYPTED_CACHE_NAME)
  const cachedResponse = await cache.match(webCacheKey)
  if (cachedResponse) {
    const blob = await cachedResponse.blob()
    const blobUrl = URL.createObjectURL(blob)
    urlCache.set(cacheKey, blobUrl)
    webBlobUrls.set(cacheKey, blobUrl)
    return blobUrl
  }
  return null
}

/**
 * Resolve an encrypted attachment URL for web browser.
 *
 * Downloads ciphertext from `httpsUrl`, AES-GCM decrypts it, stores the
 * plaintext in the browser Cache API under a dedicated cache, and returns
 * a blob URL. Subsequent calls return a fresh blob URL from the cached
 * plaintext without re-downloading or re-decrypting.
 */
export async function resolveWebEncryptedMediaUrl(
  httpsUrl: string,
  encryption: FileEncryption,
): Promise<string> {
  const cacheKey = `enc:${httpsUrl}`

  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  const existing = inflight.get(cacheKey)
  if (existing) return existing

  const promise = doResolveWebEncrypted(httpsUrl, encryption, cacheKey)
  inflight.set(cacheKey, promise)

  try {
    return await promise
  } finally {
    inflight.delete(cacheKey)
  }
}

async function doResolveWebEncrypted(
  httpsUrl: string,
  encryption: FileEncryption,
  cacheKey: string,
): Promise<string> {
  const peeked = await peekWebEncryptedMediaCache(httpsUrl)
  if (peeked) return peeked

  // Plain https key: the Cache API rejects non-http(s) request schemes, so the
  // key cannot carry a synthetic prefix. See peekWebEncryptedMediaCache.
  const webCacheKey = httpsUrl
  const cache = await caches.open(WEB_DECRYPTED_CACHE_NAME)

  const response = await fetch(httpsUrl)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const ciphertext = new Uint8Array(await response.arrayBuffer())
  const plaintext = await decryptFile(ciphertext, encryption.key, encryption.iv)
  const plaintextBytes = new Uint8Array(plaintext)

  await cache.put(webCacheKey, new Response(new Blob([plaintextBytes])))

  const blobUrl = URL.createObjectURL(new Blob([plaintextBytes]))
  urlCache.set(cacheKey, blobUrl)
  webBlobUrls.set(cacheKey, blobUrl)
  return blobUrl
}

// ---------------------------------------------------------------------------
// Shared cleanup
// ---------------------------------------------------------------------------

/**
 * Clear the entire media cache (files and in-memory index).
 */
export async function clearMediaCache(): Promise<void> {
  urlCache.clear()

  // Revoke web blob URLs
  for (const blobUrl of webBlobUrls.values()) {
    URL.revokeObjectURL(blobUrl)
  }
  webBlobUrls.clear()

  // Clear web Cache API (both plaintext and decrypted caches)
  if (typeof caches !== 'undefined') {
    try {
      await caches.delete(WEB_CACHE_NAME)
      await caches.delete(WEB_DECRYPTED_CACHE_NAME)
    } catch (error) {
      console.warn('[MediaCache] Failed to clear web cache:', error)
    }
  }

  if (!isTauri()) return

  try {
    const { remove, mkdir } = await import('@tauri-apps/plugin-fs')
    const mediaDir = await getMediaDir()

    // Remove and recreate the directory
    await remove(mediaDir, { recursive: true })
    await mkdir(mediaDir, { recursive: true })
  } catch (error) {
    console.warn('[MediaCache] Failed to clear Tauri cache:', error)
  }
}

/**
 * Get the total size of the media cache in bytes.
 */
export async function getMediaCacheSize(): Promise<number> {
  let totalSize = 0

  // Web Cache API size estimation
  if (!isTauri() && typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(WEB_CACHE_NAME)
      const keys = await cache.keys()
      for (const request of keys) {
        const response = await cache.match(request)
        if (response) {
          const blob = await response.clone().blob()
          totalSize += blob.size
        }
      }
    } catch (error) {
      console.warn('[MediaCache] Failed to get web cache size:', error)
    }
    return totalSize
  }

  if (!isTauri()) return 0

  try {
    const { readDir, stat } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const mediaDir = await getMediaDir()

    const entries = await readDir(mediaDir)

    for (const entry of entries) {
      if (entry.isFile) {
        const filePath = await join(mediaDir, entry.name)
        const info = await stat(filePath)
        totalSize += info.size
      }
    }

    return totalSize
  } catch (error) {
    console.warn('[MediaCache] Failed to get cache size:', error)
    return 0
  }
}

/**
 * Reset the in-memory URL cache.
 * Call on disconnect/logout to ensure stale entries don't persist.
 */
export function resetMediaUrlCache(): void {
  urlCache.clear()
  // Revoke web blob URLs
  for (const blobUrl of webBlobUrls.values()) {
    URL.revokeObjectURL(blobUrl)
  }
  webBlobUrls.clear()
  mediaDirPath = null
}
