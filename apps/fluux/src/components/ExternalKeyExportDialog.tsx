import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, ShieldCheck, ShieldOff } from 'lucide-react'

interface ExternalKeyExportDialogProps {
  /**
   * Called when the user confirms the export. `passphrase` is `null`
   * when the user explicitly chose the unprotected variant and ticked
   * the acknowledgment checkbox; otherwise it's the (already-validated)
   * passphrase string.
   */
  onConfirm: (passphrase: string | null) => Promise<void>
  onCancel: () => void
}

type Mode = 'protected' | 'unprotected'

/**
 * Modal for exporting the account's OpenPGP private key to a file
 * consumable by external OpenPGP tools (gpg, OpenKeychain, Kleopatra).
 *
 * Distinct from {@link BackupPassphraseDialog} (XEP-0373 §5 wire format)
 * which targets other XMPP clients only. This dialog produces a
 * standard ASCII-armored PRIVATE KEY BLOCK.
 *
 * Two modes, mutually exclusive:
 *   - **protected**: user picks a passphrase, secret packets get S2K-
 *     wrapped. The default, the safe choice on disk.
 *   - **unprotected**: secret packets are written in clear. Gated
 *     behind an acknowledgment checkbox and a prominent warning.
 */
export function ExternalKeyExportDialog({
  onConfirm,
  onCancel,
}: ExternalKeyExportDialogProps) {
  const { t } = useTranslation()
  const passphraseRef = useRef<HTMLInputElement | null>(null)

  const [mode, setMode] = useState<Mode>('protected')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mode === 'protected') passphraseRef.current?.focus()
  }, [mode])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExporting) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, isExporting])

  const passphrasesMatch = passphrase === confirmPassphrase
  const canConfirm =
    mode === 'protected'
      ? passphrase.length > 0 && passphrasesMatch && !isExporting
      : acknowledged && !isExporting

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return
    setIsExporting(true)
    setError(null)
    try {
      await onConfirm(mode === 'protected' ? passphrase : null)
      // Parent closes the dialog on success.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsExporting(false)
    }
  }, [canConfirm, onConfirm, mode, passphrase])

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={isExporting}
        onClick={onCancel}
        className="absolute inset-0 cursor-default"
      />
      <div className="relative z-10 bg-fluux-sidebar rounded-lg max-w-md w-full mx-4 shadow-xl max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden">
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-lg font-semibold text-fluux-text mb-1">
            {t('settings.encryption.externalExportDialogTitle')}
          </h3>
          <p className="text-sm text-fluux-muted">
            {t('settings.encryption.externalExportDialogBody')}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5">
          {/* Mode selector */}
          <div className="space-y-2 mb-4">
            <button
              type="button"
              onClick={() => setMode('protected')}
              disabled={isExporting}
              className={`w-full flex items-start gap-2 p-3 rounded-lg border transition-colors text-left disabled:opacity-50 ${
                mode === 'protected'
                  ? 'border-fluux-brand bg-fluux-brand/10'
                  : 'border-fluux-hover bg-fluux-bg hover:bg-fluux-hover'
              }`}
            >
              <ShieldCheck className="size-4 text-fluux-brand flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-fluux-text">
                  {t('settings.encryption.externalExportProtectedLabel')}
                </div>
                <div className="text-xs text-fluux-muted leading-snug mt-0.5">
                  {t('settings.encryption.externalExportProtectedDescription')}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setMode('unprotected')}
              disabled={isExporting}
              className={`w-full flex items-start gap-2 p-3 rounded-lg border transition-colors text-left disabled:opacity-50 ${
                mode === 'unprotected'
                  ? 'border-red-500 bg-red-500/10'
                  : 'border-fluux-hover bg-fluux-bg hover:bg-fluux-hover'
              }`}
            >
              <ShieldOff className="size-4 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-fluux-text">
                  {t('settings.encryption.externalExportUnprotectedLabel')}
                </div>
                <div className="text-xs text-fluux-muted leading-snug mt-0.5">
                  {t('settings.encryption.externalExportUnprotectedDescription')}
                </div>
              </div>
            </button>
          </div>

          {mode === 'protected' && (
            <div className="space-y-3 mb-3">
              <div>
                <label className="block text-sm text-fluux-text mb-1">
                  {t('settings.encryption.externalExportPassphraseLabel')}
                </label>
                <input
                  ref={passphraseRef}
                  type="password"
                  value={passphrase}
                  disabled={isExporting}
                  onChange={(e) => {
                    setPassphrase(e.target.value)
                    if (error) setError(null)
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-sm text-fluux-text mb-1">
                  {t('settings.encryption.externalExportConfirmPassphraseLabel')}
                </label>
                <input
                  type="password"
                  value={confirmPassphrase}
                  disabled={isExporting}
                  onChange={(e) => {
                    setConfirmPassphrase(e.target.value)
                    if (error) setError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canConfirm) void handleConfirm()
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand disabled:opacity-50"
                />
                {passphrase && confirmPassphrase && !passphrasesMatch && (
                  <p className="mt-1 text-xs text-red-500 dark:text-red-400">
                    {t('settings.encryption.externalExportPassphraseMismatch')}
                  </p>
                )}
              </div>
            </div>
          )}

          {mode === 'unprotected' && (
            <>
              <div className="flex gap-2 p-3 mb-3 rounded-lg bg-red-500/10 text-xs text-fluux-text leading-snug">
                <AlertTriangle className="size-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="font-medium">
                  {t('settings.encryption.externalExportUnprotectedWarning')}
                </p>
              </div>
              <label className="flex items-start gap-2 mb-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={isExporting}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 flex-shrink-0 cursor-pointer"
                />
                <span className="text-sm text-fluux-text leading-snug">
                  {t('settings.encryption.externalExportUnprotectedAcknowledgment')}
                </span>
              </label>
            </>
          )}

          {error && (
            <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">
              {error}
            </p>
          )}
        </div>

        <div className="px-5 pb-5 pt-3 flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={isExporting}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting && <Loader2 className="size-3.5 animate-spin" />}
            {t('settings.encryption.externalExportAction')}
          </button>
        </div>
      </div>
    </div>
  )
}
