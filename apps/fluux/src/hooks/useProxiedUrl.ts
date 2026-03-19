import { useState, useEffect } from 'react'
import { isTauri } from '@/utils/tauri'
import { resolveMediaUrl, resetMediaUrlCache } from '@/utils/mediaCache'

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
  const [state, setState] = useState<ProxiedUrlState>({
    url: null,
    isLoading: false,
    error: null,
  })

  useEffect(() => {
    if (!originalUrl || !enabled) {
      setState({ url: null, isLoading: false, error: null })
      return
    }

    const sanitized = sanitizeMediaUrl(originalUrl)

    // Web: direct sanitized URL (no caching)
    if (!isTauri()) {
      setState({ url: sanitized, isLoading: false, error: null })
      return
    }

    // Tauri: resolve through filesystem cache
    let cancelled = false
    setState({ url: null, isLoading: true, error: null })

    resolveMediaUrl(originalUrl)
      .then(assetUrl => {
        if (!cancelled) {
          setState({ url: assetUrl, isLoading: false, error: null })
        }
      })
      .catch(() => {
        // Fall back to direct sanitized URL on any cache/fetch error
        if (!cancelled) {
          setState({ url: sanitized, isLoading: false, error: null })
        }
      })

    return () => { cancelled = true }
  }, [originalUrl, enabled])

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
