import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { generateBackupPassphrase } from '@/e2ee/passphraseGenerator'

interface BackupPassphraseDialogProps {
  /** Called with the user-confirmed passphrase when they click "Back up". */
  onConfirm: (passphrase: string) => Promise<void>
  onCancel: () => void
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
}: BackupPassphraseDialogProps) {
  const { t } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  // Regenerate on every open rather than keeping a stable value — a
  // user who cancelled and reopened should get a fresh passphrase so
  // a shoulder-surfing observer of the first attempt can't reuse it.
  const [passphrase, setPassphrase] = useState<string>(() => generateBackupPassphrase())
  const [acknowledged, setAcknowledged] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPublishing) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, isPublishing])

  const handleRegenerate = useCallback(() => {
    if (isPublishing) return
    setPassphrase(generateBackupPassphrase())
    setAcknowledged(false)
    setIsCopied(false)
  }, [isPublishing])

  const handleCopy = useCallback(async () => {
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

  // Group the space-separated words into a grid of three columns so
  // long passphrases wrap cleanly and each word is readable on its
  // own — transcription onto a second device is the main use case.
  const wordGroups = useMemo(() => passphrase.split(' '), [passphrase])

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
      <div className="bg-fluux-sidebar rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-fluux-text mb-1">
          {t('settings.encryption.backupDialogTitle')}
        </h3>
        <p className="text-sm text-fluux-muted mb-4">
          {t('settings.encryption.backupDialogBody')}
        </p>

        {/* Warning callout — the single most important information in this dialog. */}
        <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="font-medium text-fluux-text">
            {t('settings.encryption.backupDialogWarning')}
          </p>
        </div>

        {/* Passphrase display */}
        <div className="rounded-lg border border-fluux-hover bg-fluux-bg p-3 mb-2">
          <div className="grid grid-cols-3 gap-2">
            {wordGroups.map((word, i) => (
              <code
                // Word positions are stable within a single passphrase instance;
                // React key is the index, which is fine because the list is
                // never reordered, only replaced on regenerate.
                key={i}
                className="text-sm font-mono text-fluux-text text-center py-1 rounded bg-fluux-hover/50"
              >
                {word}
              </code>
            ))}
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={handleCopy}
            disabled={isPublishing}
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
          <button
            onClick={handleRegenerate}
            disabled={isPublishing}
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

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={isPublishing}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!acknowledged || isPublishing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPublishing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('settings.encryption.backupPublish')}
          </button>
        </div>
      </div>
    </div>
  )
}
