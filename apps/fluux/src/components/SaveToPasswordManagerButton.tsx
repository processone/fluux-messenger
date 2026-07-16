import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Check } from 'lucide-react'
import { saveCredentialToManager } from '@/utils/saveCredentialToManager'
import { USE_V6_KEYS } from '@fluux/openpgp-plugin'
import { isTauri } from '@/utils/tauri'

interface SaveToPasswordManagerButtonProps {
  /** Stable credential identifier; matches the dialog's hidden username so save and autofill share an entry. */
  id: string
  /** Human-readable label persisted in the PM entry list. Selected in the user's UI language. */
  name: string
  /** Passphrase to save. Button is disabled while this is null. */
  passphrase: string | null
  /** External disable (e.g. while the dialog is publishing). */
  disabled?: boolean
}

/**
 * Explicit "save to password manager" affordance for Tauri.
 *
 * Web is intentionally not handled here — the hidden form inputs +
 * `autoComplete="new-password"` already drive the browser PM detection on
 * form submission, so a button would be redundant. In Tauri the embedded
 * webview doesn't reliably trigger that detection, hence this explicit path.
 *
 * Gated on `USE_V6_KEYS`: V4 backup codes don't fit the PM model because
 * the restore flow uses a formatted input with `autoComplete="off"`, so we
 * don't offer to save them. Returns null in V4 mode and on the web.
 */
export function SaveToPasswordManagerButton({
  id,
  name,
  passphrase,
  disabled,
}: SaveToPasswordManagerButtonProps) {
  const { t } = useTranslation()
  const [feedback, setFeedback] = useState<'saved' | 'fallback' | null>(null)

  const handleClick = useCallback(async () => {
    if (!passphrase) return
    const outcome = await saveCredentialToManager({ id, name, password: passphrase })
    if (outcome === 'saved') {
      setFeedback('saved')
    } else {
      try {
        await navigator.clipboard.writeText(passphrase)
      } catch {
        // Clipboard may also be unavailable (no user gesture, secure context, etc.);
        // we still show the fallback hint so the user knows the save didn't go through.
      }
      setFeedback('fallback')
    }
    setTimeout(() => setFeedback(null), 2000)
  }, [id, name, passphrase])

  if (!isTauri() || !USE_V6_KEYS) return null

  const isFallback = feedback === 'fallback'
  const isSaved = feedback === 'saved'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || !passphrase}
      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
    >
      {isSaved ? (
        <Check className="size-3.5 text-green-500" />
      ) : (
        <KeyRound className="size-3.5" />
      )}
      {isSaved
        ? t('settings.encryption.savePassphraseManagerSaved')
        : isFallback
          ? t('settings.encryption.savePassphraseManagerFallback')
          : t('settings.encryption.savePassphraseManager')}
    </button>
  )
}
