/**
 * Media cache with platform-specific backends:
 *
 * - **Tauri (desktop):** Filesystem-based cache at {appCacheDir}/media/{sha256(url)}.{ext},
 *   served as https://asset.localhost/... URLs via convertFileSrc().
 * - **Web:** Cache API-based persistent cache ('fluux-media'), served as blob: URLs.
 *   Previously-viewed media survives page reloads without re-fetching from the server.
 */

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
 * 3. Fetch via Tauri HTTP plugin → write to cache → return asset URL
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

async function doResolve(originalUrl: string): Promise<string> {
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { exists } = await import('@tauri-apps/plugin-fs')

  // 2. Check filesystem cache
  // We don't know the MIME type yet, so try to infer from the URL
  const filePath = await getCacheFilePath(originalUrl)

  if (await exists(filePath)) {
    const assetUrl = convertFileSrc(filePath)
    urlCache.set(originalUrl, assetUrl)
    return assetUrl
  }

  // 3. Fetch and cache
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')

  const response = await tauriFetch(originalUrl, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const blob = await response.blob()
  const mimeType = blob.type || response.headers.get('content-type') || undefined

  // Recalculate path with MIME type for proper extension
  const finalPath = await getCacheFilePath(originalUrl, mimeType)

  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const arrayBuffer = await blob.arrayBuffer()
  await writeFile(finalPath, new Uint8Array(arrayBuffer))

  const assetUrl = convertFileSrc(finalPath)
  urlCache.set(originalUrl, assetUrl)
  return assetUrl
}

// ---------------------------------------------------------------------------
// Web Cache API backend
// ---------------------------------------------------------------------------

const WEB_CACHE_NAME = 'fluux-media'

/** Blob URLs created from web cache — tracked for revocation on cleanup */
const webBlobUrls = new Map<string, string>()

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
  const cache = await caches.open(WEB_CACHE_NAME)

  // 2. Check Cache API
  const cachedResponse = await cache.match(originalUrl)
  if (cachedResponse) {
    const blob = await cachedResponse.blob()
    const blobUrl = URL.createObjectURL(blob)
    urlCache.set(originalUrl, blobUrl)
    webBlobUrls.set(originalUrl, blobUrl)
    return blobUrl
  }

  // 3. Fetch and cache
  const response = await fetch(originalUrl)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  // Clone before consuming — one copy for Cache API, one for blob URL
  const responseClone = response.clone()
  await cache.put(originalUrl, responseClone)

  const blob = await response.blob()
  const blobUrl = URL.createObjectURL(blob)
  urlCache.set(originalUrl, blobUrl)
  webBlobUrls.set(originalUrl, blobUrl)
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

  // Clear web Cache API
  if (typeof caches !== 'undefined') {
    try {
      await caches.delete(WEB_CACHE_NAME)
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
