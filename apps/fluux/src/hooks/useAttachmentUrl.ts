import { useProxiedUrl } from './useProxiedUrl'
import { useDecryptedMediaUrl } from './useDecryptedMediaUrl'
import type { FileEncryption } from '@fluux/sdk'

interface AttachmentUrlState {
  url: string | null
  isLoading: boolean
  error: string | null
}

/**
 * Resolve the URL for a (possibly encrypted) attachment. Picks the
 * decrypting path when `encryption` is present, the proxied/cached path
 * otherwise. Centralised so every renderer (image, video, audio) stays on
 * one branch: `src={state.url}` after this hook regardless of E2EE.
 *
 * Always calls both underlying hooks (React rule-of-hooks) and returns
 * whichever branch's state applies. The idle branch is disabled via its
 * `enabled` flag so it doesn't fetch anything.
 */
export function useAttachmentUrl(
  url: string | undefined,
  encryption: FileEncryption | undefined,
  enabled: boolean = true,
): AttachmentUrlState {
  const isEncrypted = Boolean(encryption)
  const proxied = useProxiedUrl(url, enabled && !isEncrypted)
  const decrypted = useDecryptedMediaUrl(url, encryption, enabled && isEncrypted)
  return isEncrypted ? decrypted : proxied
}
