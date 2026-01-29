import { useState, useEffect, useRef } from 'react'
import { isTauri } from '@/utils/tauri'

interface ProxiedUrlState {
  /** The blob URL to use (or original URL in web mode) */
  url: string | null
  /** True while fetching */
  isLoading: boolean
  /** Error message if fetch failed */
  error: string | null
}

/**
 * Cache for blob URLs to avoid re-fetching the same resource.
 * Maps original URL -> blob URL.
 */
const blobUrlCache = new Map<string, string>()

/**
 * Hook that fetches a URL via Tauri's HTTP plugin (bypassing CORS)
 * and returns a blob URL that can be used in img/video/audio elements.
 *
 * In web mode, returns the original URL directly since CORS is typically
 * not an issue for same-origin requests or properly configured servers.
 *
 * @param originalUrl - The external URL to fetch
 * @param enabled - Whether to fetch (useful for conditional loading)
 * @returns Object with proxied url, loading state, and error
 */
export function useProxiedUrl(originalUrl: string | undefined, enabled: boolean = true): ProxiedUrlState {
  const [state, setState] = useState<ProxiedUrlState>({
    url: null,
    isLoading: false,
    error: null,
  })

  // Track the current URL to handle cleanup properly
  const currentUrlRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!originalUrl || !enabled) {
      setState({ url: null, isLoading: false, error: null })
      return
    }

    // In web mode, just use the original URL directly
    if (!isTauri()) {
      setState({ url: originalUrl, isLoading: false, error: null })
      return
    }

    // Check cache first
    const cached = blobUrlCache.get(originalUrl)
    if (cached) {
      setState({ url: cached, isLoading: false, error: null })
      return
    }

    currentUrlRef.current = originalUrl
    let cancelled = false

    const fetchViaProxy = async () => {
      setState(s => ({ ...s, isLoading: true, error: null }))

      try {
        // Dynamic import to avoid bundling Tauri code in web builds
        const { fetch } = await import('@tauri-apps/plugin-http')

        const response = await fetch(originalUrl, {
          method: 'GET',
        })

        if (cancelled) return

        if (!response.ok) {
          throw new Error(`Failed to fetch: ${response.status}`)
        }

        // Get the response as array buffer
        const arrayBuffer = await response.arrayBuffer()

        if (cancelled) return

        // Determine content type from response headers
        const contentType = response.headers.get('content-type') || 'application/octet-stream'

        // Create blob from array buffer
        const blob = new Blob([arrayBuffer], { type: contentType })
        const blobUrl = URL.createObjectURL(blob)

        // Cache the blob URL
        blobUrlCache.set(originalUrl, blobUrl)

        setState({
          url: blobUrl,
          isLoading: false,
          error: null,
        })
      } catch (err) {
        if (cancelled) return
        console.error('[useProxiedUrl] Failed to fetch:', originalUrl, err)
        setState({
          url: null,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load',
        })
      }
    }

    void fetchViaProxy()

    return () => {
      cancelled = true
      // Note: We don't revoke blob URLs here because they're cached
      // and may be used by other components. They'll be cleaned up
      // when the page unloads.
    }
  }, [originalUrl, enabled])

  return state
}

/**
 * Preload a URL into the cache without rendering.
 * Useful for preloading thumbnails or images before they're displayed.
 */
export async function preloadUrl(url: string): Promise<string | null> {
  // Check cache first
  const cached = blobUrlCache.get(url)
  if (cached) return cached

  // In web mode, just return the original URL
  if (!isTauri()) return url

  try {
    const { fetch } = await import('@tauri-apps/plugin-http')

    const response = await fetch(url, { method: 'GET' })

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const blob = new Blob([arrayBuffer], { type: contentType })
    const blobUrl = URL.createObjectURL(blob)

    blobUrlCache.set(url, blobUrl)
    return blobUrl
  } catch (err) {
    console.error('[preloadUrl] Failed to preload:', url, err)
    return null
  }
}

/**
 * Clear the blob URL cache. Useful for memory management.
 * Revokes all cached blob URLs.
 */
export function clearProxiedUrlCache(): void {
  blobUrlCache.forEach((blobUrl) => {
    URL.revokeObjectURL(blobUrl)
  })
  blobUrlCache.clear()
}
