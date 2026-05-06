import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'

interface RestorePassphraseDialogProps {
  /** Called with the user's passphrase when they click the confirm button. */
  onConfirm: (passphrase: string) => Promise<void>
  onCancel: () => void
  /** Override the dialog title. Defaults to the server-restore title. */
  title?: string
  /** Override the dialog body. Defaults to the server-restore body. */
  body?: string
  /** Override the confirm button label. Defaults to "Restore from server". */
  confirmLabel?: string
}

/**
 * Modal for the XEP-0373 §5 secret-key restore flow.
 *
 * The companion to {@link BackupPassphraseDialog}: the user has told
 * us they want to adopt the backup on the server, and here we take
 * the passphrase that was handed to them at backup time. A wrong
 * passphrase surfaces inline so the user can retry without closing;
 * the only disabling gate is a non-empty input.
 *
 * Replaces any previously-loaded local key on success — the parent
 * is expected to set up `onConfirm` so it is appropriate to treat as
 * a confirmed destructive action. (The restore itself IS destructive
 * in the sense that the ephemeral local key the user had before is
 * overwritten; their next ensureIdentity returns the restored one.)
 */
export function RestorePassphraseDialog({
  onConfirm,
  onCancel,
  title,
  body,
  confirmLabel,
}: RestorePassphraseDialogProps) {
  const { t } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [passphrase, setPassphrase] = useState('')
  const [isRestoring, setIsRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isRestoring) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, isRestoring])

  const handleConfirm = useCallback(async () => {
    if (!passphrase.trim()) return
    setIsRestoring(true)
    setError(null)
    try {
      await onConfirm(passphrase)
      // Parent is expected to close the dialog on success; we stay
      // mounted and spinner-disabled so a successful-but-slow path
      // doesn't let the user mash the button.
    } catch (err) {
      // Rust surfaces "no SKESK matched the supplied passphrase" for
      // wrong passphrase; we don't try to parse that specifically —
      // whatever the message, the UX is the same: show it, let the
      // user edit the field and retry.
      setError(err instanceof Error ? err.message : String(err))
      setIsRestoring(false)
    }
  }, [onConfirm, passphrase])

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target
      }}
      onClick={(e) => {
        if (isRestoring) return
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
          onCancel()
        }
      }}
    >
      <div className="bg-fluux-sidebar rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-fluux-text mb-1">
          {title ?? t('settings.encryption.restoreDialogTitle')}
        </h3>
        <p className="text-sm text-fluux-muted mb-4">
          {body ?? t('settings.encryption.restoreDialogBody')}
        </p>

        <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="font-medium text-fluux-text">
            {t('settings.encryption.restoreDialogWarning')}
          </p>
        </div>

        <label className="block text-sm text-fluux-text mb-1">
          {t('settings.encryption.restorePassphraseLabel')}
        </label>
        <input
          ref={inputRef}
          type="password"
          value={passphrase}
          disabled={isRestoring}
          onChange={(e) => {
            setPassphrase(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && passphrase.trim() && !isRestoring) {
              void handleConfirm()
            }
          }}
          placeholder={t('settings.encryption.restorePassphrasePlaceholder')}
          className="w-full px-3 py-2 mb-4 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand disabled:opacity-50"
        />

        {error && (
          <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={isRestoring}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!passphrase.trim() || isRestoring}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRestoring && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {confirmLabel ?? t('settings.encryption.restoreAction')}
          </button>
        </div>
      </div>
    </div>
  )
}
