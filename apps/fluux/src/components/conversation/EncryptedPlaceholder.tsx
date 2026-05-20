import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, LockOpen } from 'lucide-react'
import { useWebKeyLocked } from '@/hooks/useWebKeyLocked'
import { useWebUnlockDialogStore } from '@/stores/webUnlockDialogStore'

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
 * decrypt it. Two visual states:
 *
 * - **Locked** (`useWebKeyLocked()` is true): a click prompts for the
 *   session passphrase. Once unlocked, the SDK's
 *   `retryPendingDecrypts()` re-runs and the placeholder is replaced
 *   by the real body on success.
 * - **Unlocked**: the cipher rejected the unlocked key (revoked
 *   identity, wrong recipient, corrupt payload). The placeholder is
 *   static — clicking again won't help.
 */
export const EncryptedPlaceholder = memo(function EncryptedPlaceholder(
  _props: EncryptedPlaceholderProps,
) {
  const { t } = useTranslation()
  const locked = useWebKeyLocked()
  const openWebUnlockDialog = useWebUnlockDialogStore((s) => s.openWebUnlockDialog)

  if (locked) {
    return (
      <button
        type="button"
        onClick={() => openWebUnlockDialog()}
        className="flex items-center gap-2 text-fluux-muted italic hover:text-fluux-text transition-colors cursor-pointer text-start"
        aria-label={t('chat.encryption.encryptedClickToUnlock')}
      >
        <Lock className="w-3.5 h-3.5 flex-shrink-0 text-yellow-500" aria-hidden="true" />
        <span className="underline underline-offset-2 decoration-dotted">
          {t('chat.encryption.encryptedClickToUnlock')}
        </span>
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 text-fluux-muted italic">
      <LockOpen className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{t('chat.encryption.encryptedCouldNotDecrypt')}</span>
    </div>
  )
})
