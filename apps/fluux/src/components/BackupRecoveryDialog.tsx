import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnection, type E2EEManager } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import type { OpenPGPPluginBase, RestoreResult } from '@/e2ee/OpenPGPPluginBase'
import { parseArmorPassphraseFormat } from '@/e2ee/passphraseFormatHeader'
import { ModalOverlay } from './ModalOverlay'
import { RestorePassphraseDialog } from './RestorePassphraseDialog'
import { KeyPickerDialog } from './KeyPickerDialog'

/** FLM-343: one account-bound flow for startup and Settings. Preview never installs;
 * even a single automatically selected key is confirmed with its fingerprint. */
export function BackupRecoveryDialog({ client, manager, onClose, onRestored }: {
  client: XMPPClient
  manager: E2EEManager
  onClose: () => void
  onRestored: (fingerprint: string) => void
}) {
  const { t } = useTranslation()
  const { jid } = useConnection()
  const [plugin] = useState(() => manager.getPlugin('openpgp') as OpenPGPPluginBase | null)
  const accountJid = manager.getAccountJid()
  const current = () => client.e2ee === manager && manager.getPlugin('openpgp') === plugin
    && manager.getAccountJid() === accountJid && jid?.split('/')[0] === accountJid
  const [source, setSource] = useState<'choose' | 'server' | 'file'>('choose')
  const [file, setFile] = useState<string | null>(null)
  const [preview, setPreview] = useState<Extract<RestoreResult, { needsPicker: true }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!current()) onClose() })
  const assertCurrent = () => {
    if (!mounted.current || !current() || !plugin || !accountJid) throw new Error(t('settings.encryption.recoveryAccountChanged'))
  }
  const pickFile = async () => {
    if (running.current) return
    running.current = true
    setBusy(true)
    try {
      assertCurrent()
      const content = await plugin!.pickKeyFile()
      assertCurrent()
      if (content) { setFile(content); setSource('file') }
    } catch (e) { if (mounted.current) setError(String(e)) }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  const readBackup = async (passphrase: string) => {
    assertCurrent()
    const mode = { accountJid: accountJid! }
    const result = source === 'file'
      ? await plugin!.importKeyFromFile(file!, passphrase, mode)
      : await plugin!.restoreSecretKey(passphrase, mode)
    assertCurrent()
    if (!('needsPicker' in result)) throw new Error(t('settings.encryption.recoveryPreviewInvalid'))
    setPreview(result)
  }
  const install = async (fingerprint: string) => {
    if (running.current || !preview) return
    running.current = true
    try {
      assertCurrent()
      const result = await plugin!.installSelectedKey(preview.backupContext.message,
        preview.backupContext.passphrase, fingerprint, { accountJid: accountJid! })
      assertCurrent()
      onRestored(result.fingerprint)
    } finally { running.current = false }
  }
  if (!current()) return null
  if (preview) return <KeyPickerDialog candidates={preview.candidates} recommendedFingerprint={preview.recommendedFingerprint} onConfirm={install} onCancel={onClose}
    restoreBlocked={plugin?.isBackupRestoreUncertain?.()} warning={t('settings.encryption.recoveryWarning', { account: accountJid })} />
  if (source !== 'choose') return <RestorePassphraseDialog title={t('settings.encryption.recoveryTitle')}
    body={t('settings.encryption.recoveryCodeBody', { account: accountJid })}
    confirmLabel={t('settings.encryption.recoveryPreview')} mode={source === 'file' ? 'import' : 'restore'} isBackupCode={source === 'file' ? parseArmorPassphraseFormat(file!) === 'xep0373' : undefined}
    onConfirm={readBackup} onCancel={onClose} />
  return <ModalOverlay onClose={onClose} dismissable={!busy} width="max-w-lg">
    <div className="p-5 space-y-4">
      <h3 className="text-lg font-semibold text-fluux-text">{t('settings.encryption.recoveryTitle')}</h3>
      <p className="text-sm text-fluux-muted">{t(plugin?.isKeyRecoveryNeeded?.() ? 'settings.encryption.recoveryFailedBody' : 'settings.encryption.recoveryBody', { account: accountJid })}</p>
      <div className="flex flex-col gap-2">
        <button className="px-4 py-2 rounded-lg bg-fluux-brand text-white" disabled={busy} onClick={() => setSource('server')}>{t('settings.encryption.identityChoice.restoreFromServerTitle')}</button>
        <button className="px-4 py-2 rounded-lg bg-fluux-hover text-fluux-text" disabled={busy} onClick={() => void pickFile()}>{t('settings.encryption.identityChoice.importFromFileTitle')}</button>
      </div>
      {error && <p role="alert" className="text-sm text-fluux-error">{error}</p>}
      <button className="px-4 py-2 rounded-lg bg-fluux-hover text-fluux-text" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
    </div>
  </ModalOverlay>
}
