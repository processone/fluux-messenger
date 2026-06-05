import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { XMPPClient } from '@fluux/sdk/core'
import { KeyPickerDialog } from './KeyPickerDialog'
import { KeyPickerRequiredError, NoRecoveryAvailableError } from '@/e2ee/recoveryErrors'
import type { KeyBundle } from '@/e2ee/OpenPGPPluginBase'

interface UnlockEncryptionDialogProps {
  client: XMPPClient
  onClose: (unlocked: boolean) => void
}

/**
 * Passphrase dialog for the web OpenPGP plugin.
 *
 * Auto-detects the right mode:
 * - "unlock"  — local key exists, prompt for passphrase to decrypt it
 * - "restore" — no local key but a server backup exists, offer recovery
 * - "setup"   — no local key and no backup, first-time key generation
 *
 * The plugin's `unlock(passphrase)` handles all three flows and returns
 * `{ recovered: boolean }`. It may throw `KeyPickerRequiredError` (multiple
 * backup keys found) or `NoRecoveryAvailableError` (nothing to recover from).
 *
 * Encryption is opt-in — the skip button is always visible so the user can
 * send without encryption if they choose.
 */
export function UnlockEncryptionDialog({ client, onClose }: UnlockEncryptionDialogProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  type DialogMode = 'unlock' | 'restore' | 'setup'
  const [mode, setMode] = useState<DialogMode | null>(null)
  const [recovered, setRecovered] = useState(false)
  const [noRecovery, setNoRecovery] = useState<{ hadLocalKey: boolean } | null>(null)
  const [picker, setPicker] = useState<{
    candidates: KeyBundle[]
    backupContext: { message: string; passphrase: string }
  } | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { hasNoLocalKey?: () => Promise<boolean>; hasSecretKeyBackup?: () => Promise<boolean> }
      | null
      | undefined
    if (!plugin?.hasNoLocalKey) {
      setMode('unlock')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const noLocal = await plugin.hasNoLocalKey!()
        if (!noLocal) {
          if (!cancelled) setMode('unlock')
          return
        }
        const hasBackup = plugin.hasSecretKeyBackup ? await plugin.hasSecretKeyBackup() : false
        if (!cancelled) setMode(hasBackup ? 'restore' : 'setup')
      } catch {
        if (!cancelled) setMode('unlock')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    inputRef.current?.focus()
  }, [mode])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isWorking) onClose(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isWorking])

  const handleConfirm = useCallback(async () => {
    if (!passphrase.trim()) return
    if (passphrase.length < 8) {
      setError(t('settings.encryption.unlockPassphraseTooShort'))
      return
    }
    if (mode === 'setup' && passphrase !== confirmPassphrase) {
      setError(t('settings.encryption.unlockPassphraseMismatch'))
      return
    }

    setIsWorking(true)
    setError(null)
    try {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { unlock?: (pp: string) => Promise<{ recovered: boolean }> }
        | null
        | undefined
      if (!plugin?.unlock) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      const result = await plugin.unlock(passphrase)
      client.notifyE2EEKeyUnlocked()
      if (result?.recovered) {
        setRecovered(true)
        setTimeout(() => onClose(true), 1500)
        return
      }
      onClose(true)
    } catch (err) {
      if (err instanceof KeyPickerRequiredError) {
        setPicker({ candidates: err.candidates, backupContext: err.backupContext })
        setIsWorking(false)
        return
      }
      if (err instanceof NoRecoveryAvailableError) {
        setNoRecovery({ hadLocalKey: err.hadLocalKey })
        setIsWorking(false)
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setIsWorking(false)
    }
  }, [passphrase, confirmPassphrase, mode, client, onClose, t])

  const handleImportKeyFile = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | {
          pickKeyFile?: () => Promise<string | null>
          importKeyFromFile?: (armored: string, pp: string) => Promise<
            | { fingerprint: string }
            | { needsPicker: true; candidates: KeyBundle[]; backupContext: { message: string; passphrase: string } }
          >
        }
      | null
      | undefined
    if (!plugin?.pickKeyFile || !plugin.importKeyFromFile) return
    const content = await plugin.pickKeyFile()
    if (!content) return
    try {
      const result = await plugin.importKeyFromFile(content, passphrase)
      if ('needsPicker' in result) {
        setPicker({ candidates: result.candidates, backupContext: result.backupContext })
        setNoRecovery(null)
        return
      }
      client.notifyE2EEKeyUnlocked()
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [client, passphrase, onClose])

  const title =
    mode === 'setup'
      ? t('settings.encryption.unlockDialogSetupTitle')
      : mode === 'restore'
        ? t('settings.encryption.unlockDialogRestoreTitle')
        : t('settings.encryption.unlockDialogTitle')

  const body =
    mode === 'setup'
      ? t('settings.encryption.unlockDialogSetupBody')
      : mode === 'restore'
        ? t('settings.encryption.unlockDialogRestoreBody')
        : t('settings.encryption.unlockDialogBody')

  const confirmLabel =
    mode === 'setup'
      ? t('settings.encryption.unlockSetupAction')
      : mode === 'restore'
        ? t('settings.encryption.restoreAction')
        : t('settings.encryption.unlockAction')

  const loading = mode === null

  return (
    <div
      data-modal="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unlock-encryption-dialog-title"
      aria-describedby="unlock-encryption-dialog-body"
      aria-busy={loading || isWorking || undefined}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={isWorking}
        onClick={() => onClose(false)}
        className="absolute inset-0 cursor-default"
      />
      <div className="relative z-10 bg-fluux-sidebar rounded-lg max-w-md w-full mx-4 shadow-xl max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden">
        <form
          onSubmit={(e) => { e.preventDefault(); void handleConfirm() }}
          className="contents"
        >
        {/* Hidden username distinguishes this entry from the XMPP login in password managers. */}
        <input type="text" name="username" autoComplete="section-openpgp username" value="openpgp-passphrase" readOnly aria-hidden="true" className="hidden" />
        <div className="px-5 pt-5 pb-3">
          <h3 id="unlock-encryption-dialog-title" className="text-lg font-semibold text-fluux-text mb-1">
            {loading ? ' ' : title}
          </h3>
          <p id="unlock-encryption-dialog-body" className="text-sm text-fluux-muted">{loading ? ' ' : body}</p>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-5">
          <label className="block text-sm text-fluux-text mb-1">
            {t('settings.encryption.restorePassphraseLabel')}
          </label>
          <input
            ref={inputRef}
            type="password"
            name="passphrase"
            autoComplete={mode === 'setup' ? 'section-openpgp new-password' : 'section-openpgp current-password'}
            value={passphrase}
            disabled={isWorking || loading}
            onChange={(e) => {
              setPassphrase(e.target.value)
              if (error) setError(null)
            }}
            placeholder={t('settings.encryption.restorePassphrasePlaceholder')}
            className="w-full px-3 py-2 mb-3 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand disabled:opacity-50"
          />

          {mode === 'setup' && (
            <>
              <label className="block text-sm text-fluux-text mb-1">
                {t('settings.encryption.restorePassphraseLabel')} (confirm)
              </label>
              <input
                type="password"
                name="confirm-passphrase"
                autoComplete="section-openpgp new-password"
                value={confirmPassphrase}
                disabled={isWorking}
                onChange={(e) => {
                  setConfirmPassphrase(e.target.value)
                  if (error) setError(null)
                }}
                placeholder={t('settings.encryption.restorePassphrasePlaceholder')}
                className="w-full px-3 py-2 mb-3 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand disabled:opacity-50"
              />
            </>
          )}

          {recovered && (
            <p className="text-xs text-green-600 dark:text-green-400 mb-3">
              {t('settings.encryption.unlockRecoveredNote')}
            </p>
          )}
          {noRecovery && (
            <div className="mb-3 space-y-2">
              <p className="text-xs text-fluux-text">
                {noRecovery.hadLocalKey
                  ? t('settings.encryption.unlockNoRecoveryBody')
                  : t('settings.encryption.unlockNoKeyNoBackupBody')}
              </p>
              <button
                type="button"
                onClick={() => { void handleImportKeyFile() }}
                className="px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
              >
                {t('settings.encryption.importFileAction')}
              </button>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">{error}</p>
          )}
        </div>

        <div className="px-5 pb-5 pt-3 flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => onClose(false)}
            disabled={isWorking}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors disabled:opacity-50"
          >
            {t('settings.encryption.unlockSkip')}
          </button>
          <button
            type="submit"
            disabled={!passphrase.trim() || isWorking || loading}
            className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isWorking && <Loader2 className="size-3.5 animate-spin" />}
            {loading ? '    ' : confirmLabel}
          </button>
        </div>
        </form>
      </div>

      {picker && (
        <KeyPickerDialog
          candidates={picker.candidates}
          onConfirm={async (selectedFingerprint) => {
            const plugin = client.e2ee?.getPlugin('openpgp') as
              | { installSelectedKey?: (msg: string, pp: string, fp: string) => Promise<{ fingerprint: string }> }
              | null
              | undefined
            if (!plugin?.installSelectedKey) return
            await plugin.installSelectedKey(
              picker.backupContext.message,
              picker.backupContext.passphrase,
              selectedFingerprint,
            )
            setPicker(null)
            client.notifyE2EEKeyUnlocked()
            onClose(true)
          }}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>
  )
}
