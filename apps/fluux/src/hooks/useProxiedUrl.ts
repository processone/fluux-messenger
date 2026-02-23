import { useState, useEffect } from 'react'

interface ProxiedUrlState {
  /** The URL to use for the media element */
  url: string | null
  /** True while loading (always false now since we use direct URLs) */
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
 * Applies path-segment sanitization so that special characters (& = etc.)
 * in filenames are percent-encoded before reaching the media loader.
 *
 * @param originalUrl - The URL to use
 * @param enabled - Whether to return the URL (useful for conditional loading)
 * @returns Object with url, loading state (always false), and error (always null)
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

    // Sanitize path segments and return the URL for WebView media loading
    setState({ url: sanitizeMediaUrl(originalUrl), isLoading: false, error: null })
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
 * No-op for backwards compatibility.
 * Previously cleared the blob URL cache, but we no longer use blob URLs.
 */
export function clearProxiedUrlCache(): void {
  // No-op - we no longer cache blob URLs
}
