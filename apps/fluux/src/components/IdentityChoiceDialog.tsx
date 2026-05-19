import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Server, FileUp, RotateCcw } from 'lucide-react'

type Phase = 'choose' | 'restoring' | 'importing' | 'confirm-replace' | 'replacing'

interface IdentityChoiceDialogProps {
  /** True when the server holds a secret-key backup the user can restore. */
  hasServerBackup: boolean
  /** Fingerprint(s) currently published on PEP — surfaced so the user sees what they're choosing between. */
  publishedFingerprints: string[]
  /** Called with the backup passphrase. Returns when the import succeeded. */
  onRestoreFromServer: (passphrase: string) => Promise<void>
  /** Triggers the platform file picker + import with the user-supplied passphrase. */
  onImportFromFile: () => Promise<void>
  /** Retracts the published identity and generates a fresh key. */
  onReplaceIdentity: () => Promise<void>
  /** Closes the dialog without doing anything. Caller decides what to roll back. */
  onCancel: () => void
}

/**
 * Shown when a Fluux web session detects that the server already holds an
 * OpenPGP identity for the account (public key published and/or backup
 * present) but this device has no local key. The dialog refuses to silent-
 * generate (the WebOpenPGPPlugin guard does the same at the crypto layer)
 * and forces the user to choose one of three explicit recovery paths.
 *
 * The dialog is shared between two entry points:
 *   - `App.tsx` auto-init, when the plugin is registered but rejects
 *     ensureKeyMaterial with `needs-identity-decision`.
 *   - `EncryptionSettings.handleToggle`, when the user opts into E2EE
 *     and the probe finds existing server-side material.
 *
 * Cancel does NOT silently generate — the caller must decide whether to
 * leave encryption disabled, retry the toggle, or guide the user back to
 * the dialog. This is intentional: we never lose the safety property
 * because the user closed a modal.
 */
export function IdentityChoiceDialog({
  hasServerBackup,
  publishedFingerprints,
  onRestoreFromServer,
  onImportFromFile,
  onReplaceIdentity,
  onCancel,
}: IdentityChoiceDialogProps) {
  const { t } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const passphraseInputRef = useRef<HTMLInputElement | null>(null)

  const [phase, setPhase] = useState<Phase>('choose')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Focus the passphrase input as soon as the user enters the restore phase.
  useEffect(() => {
    if (phase === 'restoring') {
      passphraseInputRef.current?.focus()
    }
  }, [phase])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape backs out of the sub-phase to the chooser, NOT out of the
      // dialog entirely — Cancel is the only path that closes, to make
      // sure the user is making an explicit choice.
      if (phase === 'restoring' || phase === 'confirm-replace') {
        setPhase('choose')
        setPassphrase('')
        setError(null)
      } else if (phase === 'choose') {
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [phase, onCancel])

  const handleStartRestore = useCallback(() => {
    setPhase('restoring')
    setPassphrase('')
    setError(null)
  }, [])

  const handleConfirmRestore = useCallback(async () => {
    if (!passphrase.trim()) return
    setError(null)
    try {
      await onRestoreFromServer(passphrase)
      // Parent unmounts the dialog on success — no need to reset state.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // Stay in `restoring` so the user can retry with a different passphrase.
    }
  }, [onRestoreFromServer, passphrase])

  const handleImportFile = useCallback(async () => {
    setPhase('importing')
    setError(null)
    try {
      await onImportFromFile()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('choose')
    }
  }, [onImportFromFile])

  const handleStartReplace = useCallback(() => {
    setPhase('confirm-replace')
    setError(null)
  }, [])

  const handleConfirmReplace = useCallback(async () => {
    setPhase('replacing')
    setError(null)
    try {
      await onReplaceIdentity()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('confirm-replace')
    }
  }, [onReplaceIdentity])

  const isBusy = phase === 'importing' || phase === 'replacing'

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target
      }}
      onClick={(e) => {
        if (isBusy) return
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
          onCancel()
        }
      }}
    >
      <div className="bg-fluux-sidebar rounded-lg p-5 max-w-lg w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-fluux-text mb-1">
          {t('settings.encryption.identityChoice.title')}
        </h3>
        <p className="text-sm text-fluux-muted mb-4">
          {t('settings.encryption.identityChoice.body')}
        </p>

        {publishedFingerprints.length > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-fluux-bg/50 border border-fluux-hover">
            <p className="text-xs text-fluux-muted mb-1">
              {t('settings.encryption.identityChoice.publishedFingerprintLabel')}
            </p>
            <p className="font-mono text-xs text-fluux-text break-all">
              {publishedFingerprints[0]}
              {publishedFingerprints.length > 1 &&
                ` (+${publishedFingerprints.length - 1})`}
            </p>
          </div>
        )}

        {phase === 'choose' && (
          <>
            <div className="flex flex-col gap-2 mb-4">
              <ChoiceButton
                icon={<Server className="w-4 h-4" />}
                title={t('settings.encryption.identityChoice.restoreFromServerTitle')}
                description={t(
                  hasServerBackup
                    ? 'settings.encryption.identityChoice.restoreFromServerBody'
                    : 'settings.encryption.identityChoice.restoreFromServerUnavailable',
                )}
                disabled={!hasServerBackup}
                onClick={handleStartRestore}
              />
              <ChoiceButton
                icon={<FileUp className="w-4 h-4" />}
                title={t('settings.encryption.identityChoice.importFromFileTitle')}
                description={t('settings.encryption.identityChoice.importFromFileBody')}
                onClick={handleImportFile}
              />
              <ChoiceButton
                icon={<RotateCcw className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />}
                title={t('settings.encryption.identityChoice.replaceTitle')}
                description={t('settings.encryption.identityChoice.replaceBody')}
                onClick={handleStartReplace}
                danger
              />
            </div>
            {error && (
              <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
                {error}
              </p>
            )}
            <div className="flex justify-end">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}

        {phase === 'restoring' && (
          <>
            <label className="block text-sm text-fluux-text mb-1">
              {t('settings.encryption.identityChoice.restorePassphraseLabel')}
            </label>
            <input
              ref={passphraseInputRef}
              type="password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && passphrase.trim()) {
                  void handleConfirmRestore()
                }
              }}
              placeholder={t('settings.encryption.identityChoice.restorePassphrasePlaceholder')}
              className="w-full px-3 py-2 mb-4 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand"
            />
            {error && (
              <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                onClick={() => {
                  setPhase('choose')
                  setPassphrase('')
                  setError(null)
                }}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
              >
                {t('common.back')}
              </button>
              <button
                onClick={handleConfirmRestore}
                disabled={!passphrase.trim()}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('settings.encryption.identityChoice.restoreAction')}
              </button>
            </div>
          </>
        )}

        {phase === 'confirm-replace' && (
          <>
            <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
              <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
              <p className="font-medium text-fluux-text">
                {t('settings.encryption.identityChoice.replaceWarning')}
              </p>
            </div>
            {error && (
              <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                onClick={() => {
                  setPhase('choose')
                  setError(null)
                }}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
              >
                {t('common.back')}
              </button>
              <button
                onClick={handleConfirmReplace}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
              >
                {t('settings.encryption.identityChoice.replaceConfirmAction')}
              </button>
            </div>
          </>
        )}

        {(phase === 'importing' || phase === 'replacing') && (
          <div className="flex items-center justify-center py-6 text-sm text-fluux-muted gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {phase === 'importing'
              ? t('settings.encryption.identityChoice.importingProgress')
              : t('settings.encryption.identityChoice.replacingProgress')}
          </div>
        )}
      </div>
    </div>
  )
}

interface ChoiceButtonProps {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

function ChoiceButton({ icon, title, description, onClick, disabled, danger }: ChoiceButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-start gap-3 text-left px-3 py-3 rounded-lg border transition-colors ${
        disabled
          ? 'opacity-50 cursor-not-allowed border-fluux-hover'
          : danger
          ? 'border-yellow-500/30 hover:bg-yellow-500/5'
          : 'border-fluux-hover hover:bg-fluux-hover/50'
      }`}
    >
      <span className="flex-shrink-0 mt-0.5 text-fluux-text">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-fluux-text">{title}</span>
        <span className="block text-xs text-fluux-muted mt-0.5">{description}</span>
      </span>
    </button>
  )
}
