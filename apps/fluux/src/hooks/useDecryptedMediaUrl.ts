import { useState, useEffect } from 'react'
import { type FileEncryption } from '@fluux/sdk'
import { isTauri } from '@/utils/tauri'
import { resolveEncryptedMediaUrl, resolveWebEncryptedMediaUrl } from '@/utils/mediaCache'

interface DecryptedUrlState {
  /** Asset or blob URL for the decrypted bytes, or null while loading/on error. */
  url: string | null
  /** True while fetching + decrypting (first access only; cache hits are instant). */
  isLoading: boolean
  /** Populated when fetch or AES-GCM auth-tag verification failed. */
  error: string | null
}

/**
 * Resolves an encrypted attachment to a playable URL.
 *
 * On first access: downloads ciphertext, AES-GCM decrypts, and writes the
 * plaintext to the platform cache (filesystem on Tauri, Cache API on web).
 * On subsequent accesses: returns the cached URL instantly — no keys needed.
 *
 * Rejects on any AEAD failure so tampered bytes never reach the renderer.
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
    setState({ url: null, isLoading: true, error: null })

    const resolve = isTauri() ? resolveEncryptedMediaUrl : resolveWebEncryptedMediaUrl

    void resolve(url, encryption).then(
      resolvedUrl => {
        if (!cancelled) setState({ url: resolvedUrl, isLoading: false, error: null })
      },
      err => {
        if (!cancelled) setState({
          url: null,
          isLoading: false,
          error: err instanceof Error ? err.message : 'decrypt failed',
        })
      },
    )

    return () => { cancelled = true }
  }, [url, encryption, enabled])

  return state
}
