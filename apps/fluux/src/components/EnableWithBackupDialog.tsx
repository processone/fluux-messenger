import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'

interface EnableWithBackupDialogProps {
  /** Called with the passphrase when the user chooses to restore. */
  onRestore: (passphrase: string) => Promise<void>
  /** Called when the user chooses to start fresh (generate a new key). */
  onUseFresh: () => Promise<void>
  /** Called when the user cancels — the toggle should roll back to OFF. */
  onCancel: () => void
}

/**
 * Shown at E2EE-toggle time when the server already holds a backup for
 * this account and the local device has no persisted key. Three exits:
 *
 * - **Restore** — adopt the existing identity via passphrase. The
 *   primary action because the product assumption is that a backup's
 *   existence means the user previously opted into it on another
 *   device and wants continuity.
 * - **Start fresh** — ignore the backup and generate a new key. Ends
 *   the forking state the user is currently in (publishing a new
 *   public key to PEP, losing backup-based restoreability until they
 *   re-back-up).
 * - **Cancel** — back out of enabling E2EE entirely. The caller is
 *   expected to revert the store toggle so the user doesn't end up
 *   in a half-enabled state.
 *
 * The dialog deliberately doesn't resolve on its own — the parent
 * closes it only after a successful restore or fresh-gen. This keeps
 * the loading state legible even when the Argon2id decrypt is slow.
 */
export function EnableWithBackupDialog({
  onRestore,
  onUseFresh,
  onCancel,
}: EnableWithBackupDialogProps) {
  const { t } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState<'idle' | 'restoring' | 'fresh'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busy === 'idle') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, busy])

  const handleRestore = useCallback(async () => {
    if (!passphrase.trim()) return
    setBusy('restoring')
    setError(null)
    try {
      await onRestore(passphrase)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy('idle')
    }
  }, [onRestore, passphrase])

  const handleUseFresh = useCallback(async () => {
    setBusy('fresh')
    setError(null)
    try {
      await onUseFresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy('idle')
    }
  }, [onUseFresh])

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target
      }}
      onClick={(e) => {
        if (busy !== 'idle') return
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
          onCancel()
        }
      }}
    >
      <div className="bg-fluux-sidebar rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-fluux-text mb-1">
          {t('settings.encryption.enableBackupFoundTitle')}
        </h3>
        <p className="text-sm text-fluux-muted mb-4">
          {t('settings.encryption.enableBackupFoundBody')}
        </p>

        <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="font-medium text-fluux-text">
            {t('settings.encryption.enableBackupFoundWarning')}
          </p>
        </div>

        <label className="block text-sm text-fluux-text mb-1">
          {t('settings.encryption.restorePassphraseLabel')}
        </label>
        <input
          ref={inputRef}
          type="password"
          value={passphrase}
          disabled={busy !== 'idle'}
          onChange={(e) => {
            setPassphrase(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && passphrase.trim() && busy === 'idle') {
              void handleRestore()
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

        {/*
          Three-button row — wraps on narrow viewports. Cancel is a
          neutral outline, "Start fresh" is a secondary (hover-grey)
          because it's destructive-to-history (you won't be able to
          decrypt with the server-stored key), and Restore is the
          primary brand-coloured action.
        */}
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={busy !== 'idle'}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleUseFresh}
            disabled={busy !== 'idle'}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {busy === 'fresh' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('settings.encryption.enableBackupFoundUseFresh')}
          </button>
          <button
            onClick={handleRestore}
            disabled={!passphrase.trim() || busy !== 'idle'}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'restoring' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('settings.encryption.restoreAction')}
          </button>
        </div>
      </div>
    </div>
  )
}
