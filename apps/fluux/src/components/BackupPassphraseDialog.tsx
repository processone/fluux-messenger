import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { generateBackupPassphrase, generateBackupCode, USE_V6_KEYS } from '@/e2ee/passphraseGenerator'
import { SaveToPasswordManagerButton } from './SaveToPasswordManagerButton'

// Draw a fresh passphrase in the user's UI language. 8 words ×
// 11 bits (BIP-39) = 88 bits, which matches the acceptability gate
// for user-supplied passphrases and gives durable Argon2id margin
// over the 10–20-year lifetime of the OpenPGP identity key.
const BACKUP_WORD_COUNT = 8

interface BackupPassphraseDialogProps {
  /** Called with the user-confirmed passphrase when they click the confirm button. */
  onConfirm: (passphrase: string) => Promise<void>
  onCancel: () => void
  /** Override the dialog title. Defaults to the server-backup title. */
  title?: string
  /** Override the dialog body. Defaults to the server-backup body. */
  body?: string
  /** Override the confirm button label. Defaults to "Back up". */
  confirmLabel?: string
}

/**
 * Modal for the XEP-0373 §5 secret-key backup flow.
 *
 * Generates a diceware passphrase on mount (never reused across
 * openings of the dialog), displays it prominently with a copy button,
 * and refuses to publish until the user explicitly acknowledges they
 * have saved it. The passphrase is the ONLY way to restore the
 * account's encrypted history on a new device; if the user loses it,
 * the backup is usable only for destroying the backup.
 *
 * The dialog owns the passphrase string. `onConfirm` receives the
 * value once; the parent is expected to call the Rust/plugin side and
 * report success/failure via a toast (we don't surface per-error
 * details here — the dialog closes on success and stays open on error
 * so the user can retry).
 */
export function BackupPassphraseDialog({
  onConfirm,
  onCancel,
  title,
  body,
  confirmLabel,
}: BackupPassphraseDialogProps) {
  const { t, i18n } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  // Regenerate on every open rather than keeping a stable value — a
  // user who cancelled and reopened should get a fresh passphrase so
  // a shoulder-surfing observer of the first attempt can't reuse it.
  // `null` while the language-specific wordlist chunk is loading.
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Generate on mount and whenever the UI language changes — a user
  // who switches locale mid-dialog gets a passphrase in the new
  // language rather than a stale one. Cancellation guards against a
  // late-arriving chunk overwriting a newer draw.
  useEffect(() => {
    let cancelled = false
    setPassphrase(null)
    const generate = USE_V6_KEYS
      ? generateBackupPassphrase(BACKUP_WORD_COUNT, i18n.language)
      : Promise.resolve(generateBackupCode())
    generate
      .then((pp) => {
        if (!cancelled) setPassphrase(pp)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [i18n.language])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPublishing) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, isPublishing])

  const handleRegenerate = useCallback(async () => {
    if (isPublishing) return
    setAcknowledged(false)
    setIsCopied(false)
    setPassphrase(null)
    try {
      const pp = USE_V6_KEYS
        ? await generateBackupPassphrase(BACKUP_WORD_COUNT, i18n.language)
        : generateBackupCode()
      setPassphrase(pp)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [isPublishing, i18n.language])

  const handleCopy = useCallback(async () => {
    if (!passphrase) return
    try {
      await navigator.clipboard.writeText(passphrase)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch {
      // Clipboard write can fail on web platforms without user gesture
      // consent; the user can still read and type the passphrase.
      setError(t('settings.encryption.backupCopyFailed'))
    }
  }, [passphrase, t])

  const handleConfirm = useCallback(async () => {
    if (!passphrase) return
    setIsPublishing(true)
    setError(null)
    try {
      await onConfirm(passphrase)
      // Parent closes the dialog on success; don't assume we will be
      // unmounted before any further state updates run.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsPublishing(false)
    }
  }, [onConfirm, passphrase])

  const isBackupCode = !USE_V6_KEYS
  // Group the space-separated words into a grid of three columns so
  // long passphrases wrap cleanly and each word is readable on its
  // own — transcription onto a second device is the main use case.
  const wordGroups = useMemo(() => (passphrase && !isBackupCode ? passphrase.split(' ') : []), [passphrase, isBackupCode])

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target
      }}
      onClick={(e) => {
        if (isPublishing) return
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
          onCancel()
        }
      }}
    >
      <div className="bg-fluux-sidebar rounded-lg max-w-md w-full mx-4 shadow-xl max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden">
        <form
          onSubmit={(e) => { e.preventDefault(); void handleConfirm() }}
          className="contents"
        >
        {/*
          Hidden fields for password manager detection. The "username" isolates this
          entry from the XMPP login. The "password" carries the generated passphrase so
          1Password / Bitwarden / browser managers offer to save it on confirm.
        */}
        <input type="text" name="username" autoComplete="section-openpgp username" value="openpgp-passphrase" readOnly aria-hidden="true" className="hidden" />
        <input type="password" name="passphrase" autoComplete="section-openpgp new-password" value={passphrase ?? ''} readOnly aria-hidden="true" className="hidden" />
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-lg font-semibold text-fluux-text mb-1">
            {title ?? t('settings.encryption.backupDialogTitle')}
          </h3>
          <p className="text-sm text-fluux-muted">
            {body ?? t('settings.encryption.backupDialogBody')}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5">
        {/* Warning callout — the single most important information in this dialog. */}
        <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="font-medium text-fluux-text">
            {t('settings.encryption.backupDialogWarning')}
          </p>
        </div>

        {/* Passphrase display */}
        <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-3 mb-2 min-h-[3.5rem] flex items-center justify-center">
          {passphrase ? (
            isBackupCode ? (
              <code className="text-base font-mono text-fluux-text tracking-wider select-all">
                {passphrase}
              </code>
            ) : (
              <div className="grid grid-cols-3 gap-2 w-full">
                {wordGroups.map((word, i) => (
                  <code
                    key={i}
                    className="text-sm font-mono text-fluux-text text-center py-1 rounded bg-fluux-hover/50"
                  >
                    {word}
                  </code>
                ))}
              </div>
            )
          ) : (
            <Loader2 className="w-4 h-4 animate-spin text-fluux-muted" />
          )}
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={handleCopy}
            disabled={isPublishing || !passphrase}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {isCopied ? (
              <Check className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {isCopied
              ? t('settings.encryption.backupCopied')
              : t('settings.encryption.backupCopy')}
          </button>
          <SaveToPasswordManagerButton
            id="openpgp-passphrase"
            name={t('settings.encryption.savePassphraseManagerLabel')}
            passphrase={passphrase}
            disabled={isPublishing}
          />
          <button
            onClick={handleRegenerate}
            disabled={isPublishing || !passphrase}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
            title={t('settings.encryption.backupRegenerate')}
            aria-label={t('settings.encryption.backupRegenerate')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Acknowledgment gate */}
        <label className="flex items-start gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={isPublishing}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 flex-shrink-0 cursor-pointer"
          />
          <span className="text-sm text-fluux-text leading-snug">
            {t('settings.encryption.backupAcknowledgment')}
          </span>
        </label>

        {error && (
          <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
            {error}
          </p>
        )}
        </div>

        <div className="px-5 pb-5 pt-3">
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onCancel}
              disabled={isPublishing}
              className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!acknowledged || isPublishing || !passphrase}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPublishing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {confirmLabel ?? t('settings.encryption.backupPublish')}
            </button>
          </div>
        </div>
        </form>
      </div>
    </div>
  )
}
