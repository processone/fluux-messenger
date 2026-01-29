import { useState, useEffect } from 'react'
import { isTauri } from '@/utils/tauri'

/** Maximum bytes to fetch for text preview */
const MAX_PREVIEW_BYTES = 1024

/** Maximum lines to display in preview */
const MAX_PREVIEW_LINES = 15

interface TextPreviewState {
  content: string | null
  isLoading: boolean
  error: string | null
  isTruncated: boolean
}

/**
 * Fetch text content via Tauri's HTTP plugin (bypasses CORS).
 */
async function fetchViaTauri(url: string): Promise<{ text: string; isTruncated: boolean }> {
  const { fetch } = await import('@tauri-apps/plugin-http')

  // Tauri's fetch supports Range headers
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Range': `bytes=0-${MAX_PREVIEW_BYTES - 1}`,
    },
  })

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch: ${response.status}`)
  }

  const text = await response.text()

  // Check if content was truncated
  const contentRange = response.headers.get('Content-Range')
  const wasRangeTruncated = response.status === 206 && contentRange !== null

  return { text, isTruncated: wasRangeTruncated }
}

/**
 * Fetch text content via browser fetch.
 */
async function fetchViaBrowser(url: string): Promise<{ text: string; isTruncated: boolean }> {
  const response = await fetch(url, {
    headers: {
      'Range': `bytes=0-${MAX_PREVIEW_BYTES - 1}`,
    },
  })

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch: ${response.status}`)
  }

  const text = await response.text()

  // Check if content was truncated
  const contentRange = response.headers.get('Content-Range')
  const wasRangeTruncated = response.status === 206 && contentRange !== null

  return { text, isTruncated: wasRangeTruncated }
}

/**
 * Hook to fetch and display a text file preview.
 * Uses HTTP Range request to fetch only the first ~1KB.
 * In Tauri, uses the HTTP plugin to bypass CORS.
 */
export function useTextPreview(url: string | undefined, enabled: boolean = true): TextPreviewState {
  const [state, setState] = useState<TextPreviewState>({
    content: null,
    isLoading: false,
    error: null,
    isTruncated: false,
  })

  useEffect(() => {
    if (!url || !enabled) {
      setState({ content: null, isLoading: false, error: null, isTruncated: false })
      return
    }

    let cancelled = false

    const fetchPreview = async () => {
      setState(s => ({ ...s, isLoading: true, error: null }))

      try {
        // Use Tauri HTTP plugin in desktop, browser fetch in web
        const { text, isTruncated: wasRangeTruncated } = isTauri()
          ? await fetchViaTauri(url)
          : await fetchViaBrowser(url)

        if (cancelled) return

        // Split into lines and limit
        const lines = text.split('\n')
        const displayLines = lines.slice(0, MAX_PREVIEW_LINES)
        const wasLineTruncated = lines.length > MAX_PREVIEW_LINES

        setState({
          content: displayLines.join('\n'),
          isLoading: false,
          error: null,
          isTruncated: wasRangeTruncated || wasLineTruncated,
        })
      } catch (err) {
        if (cancelled) return
        setState({
          content: null,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load preview',
          isTruncated: false,
        })
      }
    }

    void fetchPreview()

    return () => {
      cancelled = true
    }
  }, [url, enabled])

  return state
}
