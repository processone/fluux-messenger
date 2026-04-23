import { Lock, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

interface EncryptionChipProps {
  state: ConversationEncryptionState
  /** Display name for the current peer, used in the "Encrypted to {name}" label. */
  peerName: string
}

/**
 * A small pill rendered above the message composer showing whether
 * the next outgoing message will be end-to-end encrypted.
 *
 * Renders nothing for `disabled` (master toggle off, not a 1:1 chat,
 * offline, or plugin not yet ready) and `unsupported` (peer has no
 * published OpenPGP key). Most peers today fall into the latter —
 * surfacing a persistent "Not encrypted" warning in every such
 * conversation would be noise for a population that hasn't adopted
 * E2EE yet. Positive signals only: `checking` and `encrypted`.
 *
 * For the `encrypted` state the chip's tooltip carries the peer's
 * full hex fingerprint, which is the fastest way to read it off during
 * interop testing without diving into the PEP tree.
 */
export function EncryptionChip({ state, peerName }: EncryptionChipProps) {
  const { t } = useTranslation()

  if (state.kind === 'disabled' || state.kind === 'unsupported') return null

  const commonClasses =
    'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium select-none'

  if (state.kind === 'checking') {
    return (
      <div
        className={`${commonClasses} text-fluux-muted bg-fluux-hover/40`}
        role="status"
        aria-live="polite"
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>{t('chat.encryption.checking')}</span>
      </div>
    )
  }

  // encrypted
  return (
    <div
      className={`${commonClasses} text-fluux-muted bg-fluux-hover/40`}
      title={`OpenPGP\n${formatFingerprint(state.fingerprint)}`}
      role="status"
    >
      <Lock className="w-3 h-3" />
      <span>{t('chat.encryption.encryptedTo', { name: peerName })}</span>
    </div>
  )
}

/**
 * Group a hex fingerprint into space-separated blocks of 4 for the
 * chip's tooltip. Mirrors the formatter used in Settings → Encryption
 * so the fingerprint reads the same in both places.
 */
function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
