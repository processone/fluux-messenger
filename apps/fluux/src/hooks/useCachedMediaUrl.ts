import { useState, useEffect } from 'react'
import { type FileEncryption } from '@fluux/sdk'
import { isTauri } from '@/utils/tauri'
import {
  peekMediaCache,
  peekWebMediaCache,
  peekEncryptedMediaCache,
  peekWebEncryptedMediaCache,
} from '@/utils/mediaCache'

interface CachedUrlState {
  /** Local URL (asset/blob) if the bytes are already cached, else null. */
  cachedUrl: string | null
  /** True while the network-free cache peek is in flight. */
  isPeeking: boolean
}

/**
 * Read-only sibling of useAttachmentUrl: returns the already-cached local URL
 * for a (possibly encrypted) attachment WITHOUT ever fetching from the network.
 *
 * Used to display media that the autoload policy would defer but whose bytes
 * are already present locally — a cache hit leaks nothing, so the deferral has
 * no privacy purpose for it.
 */
export function useCachedMediaUrl(
  url: string | undefined,
  encryption: FileEncryption | undefined,
  enabled: boolean = true,
): CachedUrlState {
  const [state, setState] = useState<CachedUrlState>(() => ({
    cachedUrl: null,
    isPeeking: Boolean(url && enabled),
  }))

  useEffect(() => {
    if (!url || !enabled) {
      setState({ cachedUrl: null, isPeeking: false })
      return
    }
    let cancelled = false
    setState({ cachedUrl: null, isPeeking: true })

    const isEncrypted = Boolean(encryption)
    const peek = isTauri()
      ? (isEncrypted ? peekEncryptedMediaCache : peekMediaCache)
      : (isEncrypted ? peekWebEncryptedMediaCache : peekWebMediaCache)

    peek(url).then(
      result => { if (!cancelled) setState({ cachedUrl: result, isPeeking: false }) },
      () => { if (!cancelled) setState({ cachedUrl: null, isPeeking: false }) },
    )

    return () => { cancelled = true }
  }, [url, encryption, enabled])

  return state
}
