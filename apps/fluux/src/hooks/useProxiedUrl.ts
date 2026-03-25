import { useState, useEffect } from 'react'
import { isTauri } from '@/utils/tauri'
import { resolveMediaUrl, resolveWebMediaUrl, resetMediaUrlCache } from '@/utils/mediaCache'

interface ProxiedUrlState {
  /** The URL to use for the media element */
  url: string | null
  /** True while loading (fetching/caching in Tauri) */
  isLoading: boolean
  /** Error message if something went wrong */
  error: string | null
}

/**
 * Percent-encode special characters in URL path segments for use in
 * HTML media element src attributes.
 *
 * Characters like & and = are valid in URL paths per RFC 3986, but some
 * media loading implementations (e.g., macOS WKWebView / AVFoundation)
 * misinterpret them as query parameter delimiters, causing fetch failures.
 *
 * This function round-trips each path segment through decodeURIComponent /
 * encodeURIComponent so that bare & becomes %26, = becomes %3D, etc.
 * Normal URLs without special path characters pass through unchanged.
 */
export function sanitizeMediaUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const encodedPath = parsed.pathname
      .split('/')
      .map(segment => {
        if (!segment) return segment
        try {
          return encodeURIComponent(decodeURIComponent(segment))
        } catch {
          return encodeURIComponent(segment)
        }
      })
      .join('/')
    return `${parsed.origin}${encodedPath}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

/**
 * Hook that returns a URL suitable for use in img/video/audio elements.
 *
 * - **Web:** Applies path-segment sanitization and returns the direct URL.
 * - **Tauri:** Checks the local filesystem cache, fetches and caches on miss,
 *   and returns an `asset.localhost` URL via `convertFileSrc()`.
 *   Falls back to the direct sanitized URL on any error.
 *
 * @param originalUrl - The URL to use
 * @param enabled - Whether to return the URL (useful for conditional loading)
 */
export function useProxiedUrl(originalUrl: string | undefined, enabled: boolean = true): ProxiedUrlState {
  // Check if web Cache API is available (not in all test environments)
  const hasWebCache = !isTauri() && typeof caches !== 'undefined'

  // Synchronous initialization: use sanitized URL immediately when no async
  // cache is involved (web without Cache API). Otherwise start as loading.
  const [state, setState] = useState<ProxiedUrlState>(() => {
    if (!originalUrl || !enabled) {
      return { url: null, isLoading: false, error: null }
    }
    if (!isTauri() && !hasWebCache) {
      // No async cache available — use direct URL
      return { url: sanitizeMediaUrl(originalUrl), isLoading: false, error: null }
    }
    // Tauri or web with Cache API — resolve asynchronously
    return { url: null, isLoading: true, error: null }
  })

  useEffect(() => {
    if (!originalUrl || !enabled) {
      setState({ url: null, isLoading: false, error: null })
      return
    }

    const sanitized = sanitizeMediaUrl(originalUrl)

    // Web without Cache API: direct URL passthrough
    if (!isTauri() && !hasWebCache) {
      setState({ url: sanitized, isLoading: false, error: null })
      return
    }

    // Resolve through platform-specific cache
    let cancelled = false
    setState({ url: null, isLoading: true, error: null })

    const resolve = isTauri() ? resolveMediaUrl : resolveWebMediaUrl

    resolve(originalUrl)
      .then(cachedUrl => {
        if (!cancelled) {
          setState({ url: cachedUrl, isLoading: false, error: null })
        }
      })
      .catch(() => {
        if (!cancelled) {
          if (isTauri()) {
            // Tauri: fall back to direct sanitized URL on cache/fetch error
            setState({ url: sanitized, isLoading: false, error: null })
          } else {
            // Web: report error so the error UI shows (the fetch already failed)
            setState({ url: null, isLoading: false, error: 'Fetch failed' })
          }
        }
      })

    return () => { cancelled = true }
  }, [originalUrl, enabled, hasWebCache])

  return state
}

/**
 * Preload a URL by triggering browser prefetch.
 * Returns the sanitized URL for consistent caching.
 */
export async function preloadUrl(url: string): Promise<string | null> {
  return sanitizeMediaUrl(url)
}

/**
 * Clear the in-memory media URL cache.
 * Call on disconnect/logout.
 */
export function clearProxiedUrlCache(): void {
  resetMediaUrlCache()
}
