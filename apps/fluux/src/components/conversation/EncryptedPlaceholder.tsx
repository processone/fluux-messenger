import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, LockOpen, Loader2 } from 'lucide-react'
import { useWebKeyLocked } from '@/hooks/useWebKeyLocked'
import { useWebUnlockDialogStore } from '@/stores/webUnlockDialogStore'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useRouteSync } from '@/hooks/useRouteSync'
import { Tooltip } from '@/components/Tooltip'
import type { DecryptFailureReason } from '@fluux/sdk'

export interface EncryptedPlaceholderProps {
  /**
   * Why the message could not be shown, as recorded by the SDK.
   *
   * Absent on messages stored before the reason was recorded — those fall
   * back to the neutral string rather than asserting a cause we never
   * established. See #1059: a single fixed "encrypted to a key not available
   * on this device" was rendered for every failure, including ones that had
   * nothing to do with keys, and it misdirected the investigation for weeks.
   */
  reason?: DecryptFailureReason
}

const REASON_KEYS: Record<DecryptFailureReason, string> = {
  'key-unavailable': 'chat.encryption.couldNotDecryptKeyUnavailable',
  'signature-invalid': 'chat.encryption.couldNotDecryptSignature',
  unreadable: 'chat.encryption.couldNotDecryptUnreadable',
}

/**
 * Rendered inside a message bubble when {@link BaseMessage.encryptedPayload}
 * is set — meaning the SDK received an E2EE-claimed stanza but could not
 * decrypt it. Three visual states:
 *
 * - **OpenPGP disabled** (toggle off in Settings): a click routes to
 *   `/settings/encryption` so the user can re-enable explicitly.
 *   We intentionally don't offer the unlock dialog here — turning the
 *   toggle on republishes the key and flips the send policy, which the
 *   user must opt back into rather than have happen as a side effect of
 *   clicking a placeholder.
 * - **Locked** (`useWebKeyLocked()` is true): a click prompts for the
 *   session passphrase. Once unlocked, the SDK's
 *   `retryPendingDecrypts()` re-runs and the placeholder is replaced
 *   by the real body on success.
 * - **Unlocked, decryption still failed**: the cipher rejected the
 *   unlocked key — most often because the message was encrypted to a
 *   sibling-device or rotated key that this browser doesn't hold
 *   (XEP-0373 has no multi-device encryption). The placeholder is
 *   static; a tooltip explains why clicking again won't help.
 */
export const EncryptedPlaceholder = memo(function EncryptedPlaceholder(
  props: EncryptedPlaceholderProps,
) {
  const { t } = useTranslation()
  const locked = useWebKeyLocked()
  const openpgpEnabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  const pluginRegisteredAt = useEncryptionSettingsStore((s) => s.pluginRegisteredAt)
  const registrationError = useEncryptionSettingsStore((s) => s.registrationError)
  const openWebUnlockDialog = useWebUnlockDialogStore((s) => s.openWebUnlockDialog)
  const { navigateToSettings } = useRouteSync()

  if (!openpgpEnabled) {
    return (
      <button
        type="button"
        onClick={() => navigateToSettings('encryption')}
        className="flex items-center gap-2 text-fluux-muted italic hover:text-fluux-text transition-colors cursor-pointer text-start"
        aria-label={t('chat.encryption.encryptedDisabled')}
      >
        <Lock className="size-3.5 flex-shrink-0 text-fluux-muted" aria-hidden="true" />
        <span className="underline underline-offset-2 decoration-dotted">
          {t('chat.encryption.encryptedDisabled')}
        </span>
      </button>
    )
  }

  if (locked) {
    return (
      <button
        type="button"
        onClick={() => openWebUnlockDialog()}
        className="flex items-center gap-2 text-fluux-muted italic hover:text-fluux-text transition-colors cursor-pointer text-start"
        aria-label={t('chat.encryption.encryptedClickToUnlock')}
      >
        <Lock className="size-3.5 flex-shrink-0 text-yellow-500" aria-hidden="true" />
        <span className="underline underline-offset-2 decoration-dotted">
          {t('chat.encryption.encryptedClickToUnlock')}
        </span>
      </button>
    )
  }

  if (pluginRegisteredAt === 0 && !registrationError) {
    return (
      <span className="flex items-center gap-2 text-fluux-muted italic">
        <Loader2 className="size-3.5 flex-shrink-0 animate-spin" aria-hidden="true" />
        <span>{t('chat.encryption.encryptedDecrypting')}</span>
      </span>
    )
  }

  // The reason is rendered in the visible span as well as the tooltip: the
  // tooltip only surfaces on hover, so the span is what actually tells the
  // user what happened (and what a test can assert against).
  const reasonKey = REASON_KEYS[props.reason ?? 'unreadable']

  return (
    <Tooltip
      content={t(reasonKey)}
      position="top"
      className="flex items-center gap-2 text-fluux-muted italic"
    >
      <LockOpen className="size-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{t(reasonKey)}</span>
    </Tooltip>
  )
})
