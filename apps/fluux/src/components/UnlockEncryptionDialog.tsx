import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { XMPPClient } from '@fluux/sdk/core'

interface UnlockEncryptionDialogProps {
  client: XMPPClient
  onClose: (unlocked: boolean) => void
}

/**
 * Passphrase dialog for the web OpenPGP plugin.
 *
 * Auto-detects whether this is a first-time setup (no local key in
 * IndexedDB) or a returning-user unlock, and adjusts title, body, and
 * button label accordingly. On first-time setup, a confirm field is
 * shown to catch typos.
 *
 * On confirm: calls `plugin.unlock(passphrase)`, which sets the session
 * passphrase, decrypts (or generates) the key, publishes to PEP, and
 * activates verification-sync subscriptions.
 */
export function UnlockEncryptionDialog({ client, onClose }: UnlockEncryptionDialogProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [isFirstTime, setIsFirstTime] = useState<boolean | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { hasNoLocalKey?: () => Promise<boolean> }
      | null
      | undefined
    if (!plugin?.hasNoLocalKey) {
      setIsFirstTime(false)
      return
    }
    plugin
      .hasNoLocalKey()
      .then(setIsFirstTime)
      .catch(() => setIsFirstTime(false))
  }, [client])

  useEffect(() => {
    inputRef.current?.focus()
  }, [isFirstTime])

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
    if (isFirstTime && passphrase !== confirmPassphrase) {
      setError(t('settings.encryption.unlockPassphraseMismatch'))
      return
    }

    setIsWorking(true)
    setError(null)
    try {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { unlock?: (pp: string) => Promise<void> }
        | null
        | undefined
      if (!plugin?.unlock) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      await plugin.unlock(passphrase)
      // Trigger deferred decryption of messages that arrived while the
      // key was locked (e.g. MAM catch-up messages fetched before the
      // user entered the passphrase).
      client.notifyE2EEKeyUnlocked()
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsWorking(false)
    }
  }, [passphrase, confirmPassphrase, isFirstTime, client, onClose, t])

  const title = isFirstTime
    ? t('settings.encryption.unlockDialogSetupTitle')
    : t('settings.encryption.unlockDialogTitle')

  const body = isFirstTime
    ? t('settings.encryption.unlockDialogSetupBody')
    : t('settings.encryption.unlockDialogBody')

  const confirmLabel = isFirstTime
    ? t('settings.encryption.unlockSetupAction')
    : t('settings.encryption.unlockAction')

  const loading = isFirstTime === null

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
            autoComplete={isFirstTime ? 'section-openpgp new-password' : 'section-openpgp current-password'}
            value={passphrase}
            disabled={isWorking || loading}
            onChange={(e) => {
              setPassphrase(e.target.value)
              if (error) setError(null)
            }}
            placeholder={t('settings.encryption.restorePassphrasePlaceholder')}
            className="w-full px-3 py-2 mb-3 rounded-lg bg-fluux-bg border border-fluux-hover text-fluux-text focus:outline-none focus:border-fluux-brand disabled:opacity-50"
          />

          {isFirstTime && (
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
    </div>
  )
}
