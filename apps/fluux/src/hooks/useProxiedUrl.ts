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
 * Hook that returns a URL suitable for use in img/video/audio elements.
 *
 * Previously this used Tauri's HTTP plugin to proxy requests and bypass CORS,
 * but this caused issues with certain XMPP servers due to reqwest/TLS
 * compatibility problems.
 *
 * Now it simply returns the original URL directly, which works because:
 * - HTML media elements (<img>, <video>, <audio>) don't have the same CORS
 *   restrictions as fetch() requests
 * - The WebView can load cross-origin media directly
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

    // Return the original URL directly - WebView can load cross-origin media
    setState({ url: originalUrl, isLoading: false, error: null })
  }, [originalUrl, enabled])

  return state
}

/**
 * Preload a URL by triggering browser prefetch.
 * Since we no longer proxy URLs, this just returns the original URL.
 * The browser will cache it when the image is actually loaded.
 */
export async function preloadUrl(url: string): Promise<string | null> {
  return url
}

/**
 * No-op for backwards compatibility.
 * Previously cleared the blob URL cache, but we no longer use blob URLs.
 */
export function clearProxiedUrlCache(): void {
  // No-op - we no longer cache blob URLs
}
