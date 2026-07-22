import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { ModalOverlay } from './ModalOverlay'

interface DeleteOpenpgpKeyDialogProps {
  /**
   * Fingerprint of the key about to be destroyed — displayed so the user
   * can double-check they're deleting the one they expected.
   */
  fingerprint: string
  /**
   * Whether a server-side backup currently exists. Controls whether the
   * "also delete my backup" opt-in checkbox is rendered — if no backup
   * is published there's nothing to delete, and showing the checkbox
   * would be confusing.
   */
  backupExists: boolean
  /**
   * Called with the user's final choice. `deleteBackup` is true only when
   * the user explicitly opted in. Parent is expected to run the retract →
   * local delete sequence and close the dialog on success (or keep it
   * open on failure so the user can retry).
   */
  onConfirm: (options: { deleteBackup: boolean }) => Promise<void>
  onCancel: () => void
}

/**
 * Confirmation dialog for the destructive "Delete my OpenPGP key" flow.
 *
 * Two reasons this is its own component rather than a parametrised
 * ConfirmDialog:
 *
 * 1. It owns an opt-in checkbox whose value must travel with the
 *    confirm click (the plain ConfirmDialog's `onConfirm` is arg-less).
 * 2. The copy explains a three-step consequence (peers stop encrypting,
 *    local key wiped, optional backup removed) that deserves more than
 *    a single-line `message` prop.
 *
 * The dialog stays open while the async flow runs and surfaces any
 * thrown error inline — critical for an operation where a partial
 * failure (e.g. retract succeeded but local delete didn't) leaves the
 * user wanting to retry rather than navigate away.
 */
export function DeleteOpenpgpKeyDialog({
  fingerprint,
  backupExists,
  onConfirm,
  onCancel,
}: DeleteOpenpgpKeyDialogProps) {
  const { t } = useTranslation()

  const [deleteBackup, setDeleteBackup] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = useCallback(async () => {
    setIsRunning(true)
    setError(null)
    try {
      await onConfirm({ deleteBackup })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsRunning(false)
    }
  }, [onConfirm, deleteBackup])

  return (
    <ModalOverlay
      onClose={onCancel}
      width="max-w-md"
      panelClassName="max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden"
      dismissable={!isRunning}
    >
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-lg font-semibold text-fluux-text mb-1">
            {t('settings.encryption.deleteKeyConfirmTitle')}
          </h3>
          <p className="text-sm text-fluux-muted">
            {t('settings.encryption.deleteKeyConfirmMessage', {
              fingerprint: formatFingerprint(fingerprint),
            })}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5">
          <div className="flex gap-2 p-3 mb-4 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
            <AlertTriangle className="size-4 text-fluux-yellow flex-shrink-0 mt-0.5" />
            <p className="font-medium text-fluux-text">
              {t('settings.encryption.deleteKeyConsequences')}
            </p>
          </div>

          {backupExists && (
            <label className="flex items-start gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteBackup}
                disabled={isRunning}
                onChange={(e) => setDeleteBackup(e.target.checked)}
                className="mt-0.5 flex-shrink-0 cursor-pointer"
              />
              <span className="text-sm text-fluux-text leading-snug">
                {t('settings.encryption.deleteKeyAlsoBackup')}
                <span className="block text-xs text-fluux-muted mt-0.5">
                  {t('settings.encryption.deleteKeyAlsoBackupHint')}
                </span>
              </span>
            </label>
          )}

          {error && (
            <p className="text-xs text-fluux-error mb-3 break-words">
              {error}
            </p>
          )}
        </div>

        <div className="px-5 pb-5 pt-3 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isRunning}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning && <Loader2 className="size-3.5 animate-spin" />}
            {t('settings.encryption.deleteKeyConfirmAction')}
          </button>
        </div>
    </ModalOverlay>
  )
}

/** Same hex-grouping used elsewhere in EncryptionSettings for readability. */
function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
