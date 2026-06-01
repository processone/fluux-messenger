import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CloudUpload, CloudDownload } from 'lucide-react'
import { useXMPPContext } from '@fluux/sdk'
import { useOwnKeyConflictStore } from '@/stores/ownKeyConflictStore'
import { useToastStore } from '@/stores/toastStore'
import { RestorePassphraseDialog } from './RestorePassphraseDialog'

type ResolvingPlugin = {
  resolveOwnKeyConflict_overwriteServer?: () => Promise<void>
  resolveOwnKeyConflict_importFromServer?: (passphrase: string) => Promise<unknown>
}

function formatFingerprintShort(fp: string): string {
  if (fp.length <= 16) return fp
  return `${fp.slice(0, 8)}…${fp.slice(-8)}`
}

/**
 * Persistent alert rendered inside the Encryption settings panel when a
 * mismatch is detected between the locally-held OpenPGP key and what the
 * XMPP server currently publishes under this account's JID.
 *
 * Two kinds handled:
 *
 * - **primary-mismatch**: the server advertises a completely different
 *   primary fingerprint. Either the server was tampered with, or another
 *   device generated a fresh key.
 *
 * - **subkey-mismatch**: same primary fingerprint in the metadata, but
 *   the published key data differs. Typical cause: another device ran
 *   `rotateEncryptionKey()` and published a new encryption subkey.
 *
 * Two resolution paths:
 *
 * - **Keep this device's key**: re-publishes the local key to PEP,
 *   overwriting the server's version.
 * - **Import from server**: opens the passphrase dialog and restores
 *   the secret-key backup from the server, adopting the server's key.
 *
 * Encryption stays blocked (the plugin throws `own-key-conflict`) until
 * the user picks one of the two paths. Renders null when there is no
 * active conflict.
 */
export function OwnKeyConflictBanner() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const conflict = useOwnKeyConflictStore((s) => s.conflict)
  const addToast = useToastStore((s) => s.addToast)

  const [busy, setBusy] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)

  const getPlugin = useCallback(
    (): ResolvingPlugin | null =>
      (client.e2ee?.getPlugin('openpgp') as ResolvingPlugin | null) ?? null,
    [client],
  )

  const handleOverwrite = useCallback(async () => {
    setBusy(true)
    try {
      await getPlugin()?.resolveOwnKeyConflict_overwriteServer?.()
      addToast('success', t('settings.encryption.ownKeyConflict.overwriteSuccess'))
    } catch {
      addToast('error', t('settings.encryption.ownKeyConflict.overwriteFailed'))
    } finally {
      setBusy(false)
    }
  }, [getPlugin, addToast, t])

  const handleImport = useCallback(
    async (passphrase: string) => {
      await getPlugin()?.resolveOwnKeyConflict_importFromServer?.(passphrase)
      setShowImportDialog(false)
      addToast('success', t('settings.encryption.ownKeyConflict.importSuccess'))
    },
    [getPlugin, addToast, t],
  )

  if (!conflict) return null

  const isPrimaryMismatch = conflict.kind === 'primary-mismatch'

  return (
    <>
      <div
        role="alert"
        className="flex items-start gap-2 px-3 py-3 rounded-lg border border-red-500/30 bg-red-500/10"
      >
        <AlertTriangle className="size-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-sm font-medium text-fluux-text leading-snug">
            {isPrimaryMismatch
              ? t('settings.encryption.ownKeyConflict.primaryMismatchTitle')
              : t('settings.encryption.ownKeyConflict.subkeyMismatchTitle')}
          </p>
          <p className="text-xs text-fluux-muted leading-snug">
            {isPrimaryMismatch
              ? t('settings.encryption.ownKeyConflict.primaryMismatchBody')
              : t('settings.encryption.ownKeyConflict.subkeyMismatchBody')}
          </p>

          <div className="text-xs text-fluux-muted space-y-1 py-1">
            <div className="flex gap-2 items-baseline">
              <span className="shrink-0 text-fluux-muted">
                {t('settings.encryption.ownKeyConflict.localFingerprintLabel')}:
              </span>
              <code className="font-mono text-fluux-text break-all">
                {formatFingerprintShort(conflict.localFingerprint)}
              </code>
            </div>
            {conflict.publishedFingerprint !== conflict.localFingerprint && (
              <div className="flex gap-2 items-baseline">
                <span className="shrink-0 text-fluux-muted">
                  {t('settings.encryption.ownKeyConflict.serverFingerprintLabel')}:
                </span>
                <code className="font-mono text-fluux-text break-all">
                  {formatFingerprintShort(conflict.publishedFingerprint)}
                </code>
              </div>
            )}
            {conflict.publishedDate && (
              <div className="flex gap-2 items-baseline">
                <span className="shrink-0 text-fluux-muted">
                  {t('settings.encryption.ownKeyConflict.publishedDateLabel')}:
                </span>
                <span className="text-fluux-muted">{conflict.publishedDate}</span>
              </div>
            )}
          </div>

          <p className="text-xs font-medium text-red-600 dark:text-red-400 leading-snug">
            {t('settings.encryption.ownKeyConflict.encryptionBlocked')}
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={() => void handleOverwrite()}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-fluux-brand text-white hover:opacity-90 rounded transition-colors disabled:opacity-50"
            >
              <CloudUpload className="size-3.5" />
              {t('settings.encryption.ownKeyConflict.overwriteServer')}
            </button>
            <button
              onClick={() => setShowImportDialog(true)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1 text-xs text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded transition-colors disabled:opacity-50"
            >
              <CloudDownload className="size-3.5" />
              {t('settings.encryption.ownKeyConflict.importFromServer')}
            </button>
          </div>
        </div>
      </div>

      {showImportDialog && (
        <RestorePassphraseDialog
          onConfirm={handleImport}
          onCancel={() => setShowImportDialog(false)}
        />
      )}
    </>
  )
}
