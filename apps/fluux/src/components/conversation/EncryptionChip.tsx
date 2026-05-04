import { Lock, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

interface EncryptionChipProps {
  state: ConversationEncryptionState
  /** Display name for the current peer, used in the "Encrypted to {name}" label. */
  peerName: string
  /**
   * Click handler invoked when the user clicks the chip in the
   * `encrypted` state. Used to open the verify-peer dialog. Omitted
   * when the chip should stay non-interactive (e.g. tests, or future
   * read-only contexts).
   */
  onVerifyClick?: () => void
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
 * interop testing without diving into the PEP tree. The chip also
 * becomes a button — clicking it opens the verify-peer dialog so the
 * user can promote BTBV `unverified` to `verified`.
 */
export function EncryptionChip({ state, peerName, onVerifyClick }: EncryptionChipProps) {
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

  // encrypted — colour split on trust level. `verified` lifts the chip
  // to the green palette that matches MessageBubble's verified-message
  // lock; `unverified` stays in the muted palette so the eye learns
  // "green ⇒ I confirmed this", not "green ⇒ encrypted".
  const verified = state.trust === 'verified'
  const palette = verified
    ? 'text-green-600 dark:text-green-400 bg-green-500/10 hover:bg-green-500/15'
    : 'text-fluux-muted bg-fluux-hover/40 hover:bg-fluux-hover'
  const tooltip = `${verified ? t('chat.encryption.verifiedTooltip') : t('chat.encryption.openpgpTooltip')}\n${formatFingerprint(state.fingerprint)}`
  const Icon = verified ? ShieldCheck : Lock

  // Non-clickable form when no handler is supplied (tests, screenshots).
  if (!onVerifyClick) {
    return (
      <div className={`${commonClasses} ${palette}`} title={tooltip} role="status">
        <Icon className="w-3 h-3" />
        <span>{t('chat.encryption.encryptedTo', { name: peerName })}</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onVerifyClick}
      className={`${commonClasses} ${palette} cursor-pointer transition-colors`}
      title={tooltip}
      aria-label={
        verified
          ? t('chat.encryption.encryptedTo', { name: peerName })
          : t('chat.verifyPeer.chipAriaLabel', { name: peerName })
      }
    >
      <Icon className="w-3 h-3" />
      <span>{t('chat.encryption.encryptedTo', { name: peerName })}</span>
    </button>
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
