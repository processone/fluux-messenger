import { useState, useEffect } from 'react'
import { decryptFile, type FileEncryption } from '@fluux/sdk'
import { isTauri } from '@/utils/tauri'

interface DecryptedUrlState {
  /** Object URL for the decrypted bytes, or null while loading/on error. */
  url: string | null
  /** True while fetching + decrypting. */
  isLoading: boolean
  /** Populated when fetch or AES-GCM auth-tag verification failed. */
  error: string | null
}

/**
 * Fetches ciphertext from `url`, decrypts it with the supplied AES-GCM
 * key/IV, and returns a short-lived object URL for use as an img/video
 * source. Rejects on any AEAD failure — tampered bytes never reach the
 * renderer.
 *
 * Use only when `encryption` is present on the attachment. Plaintext
 * rendering should stay on the existing `useProxiedUrl` path so we keep
 * all the platform-specific caching behaviour it has.
 */
export function useDecryptedMediaUrl(
  url: string | undefined,
  encryption: FileEncryption | undefined,
  enabled: boolean = true,
): DecryptedUrlState {
  const [state, setState] = useState<DecryptedUrlState>({
    url: null,
    isLoading: Boolean(url && encryption && enabled),
    error: null,
  })

  useEffect(() => {
    if (!url || !encryption || !enabled) {
      setState({ url: null, isLoading: false, error: null })
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setState({ url: null, isLoading: true, error: null })

    const fetchFn = async (target: string): Promise<ArrayBuffer> => {
      // Tauri fetch bypasses CORS restrictions; fall back to web fetch
      // for the browser build.
      if (isTauri()) {
        const { fetch } = await import('@tauri-apps/plugin-http')
        const resp = await fetch(target)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        return await resp.arrayBuffer()
      }
      const resp = await fetch(target)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return await resp.arrayBuffer()
    }

    ;(async () => {
      try {
        const buf = await fetchFn(url)
        if (cancelled) return
        const plaintext = await decryptFile(
          new Uint8Array(buf),
          encryption.key,
          encryption.iv,
        )
        if (cancelled) return
        const blob = new Blob([plaintext as BlobPart])
        objectUrl = URL.createObjectURL(blob)
        setState({ url: objectUrl, isLoading: false, error: null })
      } catch (err) {
        if (cancelled) return
        setState({
          url: null,
          isLoading: false,
          error: err instanceof Error ? err.message : 'decrypt failed',
        })
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url, encryption, enabled])

  return state
}
