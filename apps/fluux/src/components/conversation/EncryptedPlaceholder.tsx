import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, LockOpen, Loader2 } from 'lucide-react'
import { useWebKeyLocked } from '@/hooks/useWebKeyLocked'
import { useWebUnlockDialogStore } from '@/stores/webUnlockDialogStore'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useRouteSync } from '@/hooks/useRouteSync'
import { Tooltip } from '@/components/Tooltip'

export interface EncryptedPlaceholderProps {
  /**
   * `true` when the failure was almost certainly a wrong-key situation
   * (we tried to decrypt and the cipher rejected the unlocked private
   * key). The placeholder still renders, but the click affordance is
   * dropped — unlocking again won't help.
   *
   * Left optional for now; consumers don't yet distinguish.
   */
  hardFailure?: boolean
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
  _props: EncryptedPlaceholderProps,
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

  return (
    <Tooltip
      content={t('chat.encryption.couldNotDecryptTooltip')}
      position="top"
      className="flex items-center gap-2 text-fluux-muted italic"
    >
      <LockOpen className="size-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{t('chat.encryption.encryptedCouldNotDecrypt')}</span>
    </Tooltip>
  )
})
