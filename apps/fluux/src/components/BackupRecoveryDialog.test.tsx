/** Intent FLM-343: both recovery entries share read-only preview, explicit
 * fingerprint confirmation and account freshness; cancel never changes identity. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { E2EEPluginError, type E2EEManager } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { BackupRecoveryDialog } from './BackupRecoveryDialog'

const meta = JSON.parse(readFileSync(resolve(__dirname, '../e2ee/fixtures/sequoia_meta.json'), 'utf8'))
const backup = readFileSync(resolve(__dirname, '../e2ee/fixtures/sequoia_alice_backup.asc'), 'utf8')
const publicArmored = readFileSync(resolve(__dirname, '../e2ee/fixtures/sequoia_alice_public.asc'), 'utf8')
let jid = 'alice@example.com/laptop'
vi.mock('@fluux/sdk', async importOriginal => ({ ...await importOriginal<typeof import('@fluux/sdk')>(), useConnection: () => ({ jid }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

function setup() {
  const preview = { needsPicker: true, candidates: [{ fingerprint: meta.aliceFingerprint, publicArmored, keychainBacked: true }], backupContext: { message: backup, passphrase: meta.backupPassphrase } }
  const plugin = {
    isBackupRestoreUncertain: vi.fn(() => false),
    restoreSecretKey: vi.fn().mockResolvedValue(preview), importKeyFromFile: vi.fn().mockResolvedValue(preview),
    pickKeyFile: vi.fn().mockResolvedValue(backup), installSelectedKey: vi.fn().mockResolvedValue({ fingerprint: meta.aliceFingerprint }),
  }
  const manager = { getPlugin: () => plugin, getAccountJid: () => 'alice@example.com' } as unknown as E2EEManager
  const client = { e2ee: manager } as XMPPClient
  const onClose = vi.fn(), onRestored = vi.fn()
  const props = { client, manager, onClose, onRestored }
  return { ...props, plugin, preview, props }
}
async function enterCode() {
  const input = document.querySelector('input[name="backup-code"], input[name="passphrase"]')!
  fireEvent.change(input, { target: { value: `  ${meta.backupPassphrase}  ` } })
  fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.recoveryPreview' }))
  await screen.findByText(meta.aliceFingerprint)
}
beforeEach(() => { jid = 'alice@example.com/laptop' })
describe('BackupRecoveryDialog', () => {
  it.each(['server', 'file'])('%s previews before confirming a fingerprint and uses ordinary backup-code formatting and import trimming', async source => {
    const f = setup(); render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: source === 'server' ? 'settings.encryption.identityChoice.restoreFromServerTitle' : 'settings.encryption.identityChoice.importFromFileTitle' }))
    await screen.findByText('settings.encryption.recoveryCodeBody')
    await enterCode()
    const method = source === 'server' ? f.plugin.restoreSecretKey : f.plugin.importKeyFromFile
    expect(method).toHaveBeenCalledWith(...(source === 'server' ? [] : [backup]), meta.backupPassphrase, { accountJid: 'alice@example.com' })
    expect(f.plugin.installSelectedKey).not.toHaveBeenCalled()
    expect(f.onRestored).not.toHaveBeenCalled()
    expect(screen.getByText('settings.encryption.recoveryWarning')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' }))
    await waitFor(() => expect(f.onRestored).toHaveBeenCalledWith(meta.aliceFingerprint))
    expect(f.plugin.installSelectedKey).toHaveBeenCalledExactlyOnceWith(backup, meta.backupPassphrase, meta.aliceFingerprint, { accountJid: 'alice@example.com' })
  })
  it('keeps the advertised fingerprint recommendation when confirming a multi-key preview', async () => {
    const f = setup()
    const bob = JSON.parse(readFileSync(resolve(__dirname, '../e2ee/fixtures/web_meta.json'), 'utf8')).bobFingerprint.toUpperCase()
    f.plugin.restoreSecretKey.mockResolvedValue({ ...f.preview, recommendedFingerprint: bob, candidates: [...f.preview.candidates, {
      fingerprint: bob, publicArmored: readFileSync(resolve(__dirname, '../e2ee/fixtures/web_bob_public.asc'), 'utf8'), keychainBacked: true,
    }] })
    render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' }))
    await enterCode()
    expect(screen.getByRole('radio', { name: new RegExp(bob) })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' }))
    await waitFor(() => expect(f.plugin.installSelectedKey).toHaveBeenCalledWith(backup, meta.backupPassphrase, bob, { accountJid: 'alice@example.com' }))
  })
  it('cancels preview without installing, and cancelling the file picker remains usable', async () => {
    const f = setup(); f.plugin.pickKeyFile.mockResolvedValueOnce(null)
    render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.importFromFileTitle' }))
    await waitFor(() => expect(f.plugin.pickKeyFile).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' }))
    await enterCode()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(f.onClose).toHaveBeenCalled()
    expect(f.plugin.installSelectedKey).not.toHaveBeenCalled()
  })
  it('does not install or announce success after the account changes during preview', async () => {
    const f = setup(); let finish!: (value: unknown) => void
    f.plugin.restoreSecretKey.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' }))
    fireEvent.change(document.querySelector('input[name="backup-code"], input[name="passphrase"]')!, { target: { value: meta.backupPassphrase } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.recoveryPreview' }))
    jid = 'bob@example.com/laptop'; f.client.e2ee = null
    view.rerender(<BackupRecoveryDialog {...f.props} />)
    finish(f.preview)
    await waitFor(() => expect(f.onClose).toHaveBeenCalled())
    expect(f.plugin.installSelectedKey).not.toHaveBeenCalled()
    expect(f.onRestored).not.toHaveBeenCalled()
  })
  it('keeps a failed save visible and never reports completion', async () => {
    const f = setup(); f.plugin.installSelectedKey.mockRejectedValue(new Error('durable save failed; previous key restored'))
    render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' }))
    await enterCode()
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' }))
    await screen.findByText('settings.encryption.recoveryFailed')
    fireEvent.click(screen.getByText('settings.encryption.recoveryErrorDetails'))
    expect(screen.getByText('durable save failed; previous key restored')).toBeVisible()
    expect(f.onRestored).not.toHaveBeenCalled()
    expect(f.plugin.installSelectedKey).toHaveBeenCalledTimes(1)
  })
  it('FLM-365 F4 immediately localizes an uncertain save, preserves its details and prevents a second confirmation', async () => {
    const f = setup()
    f.plugin.installSelectedKey.mockRejectedValue(new E2EEPluginError('permanent', 'restore-outcome-uncertain', 'native rollback: prior key retained; saved identity uncertain'))
    render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' }))
    await enterCode()
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.recoveryRestartRequired')
    const confirm = screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(f.plugin.installSelectedKey).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('settings.encryption.recoveryErrorDetails'))
    expect(screen.getByText('native rollback: prior key retained; saved identity uncertain')).toBeVisible()
    expect(f.onRestored).not.toHaveBeenCalled()
  })

  it('FLM-365 N1 snapshots the pre-existing guard, not the current pending install, across parent renders and ordinary failure', async () => {
    const f = setup()
    let guard = false
    let rejectSave!: (error: Error) => void
    f.plugin.isBackupRestoreUncertain.mockImplementation(() => guard)
    f.plugin.installSelectedKey.mockImplementationOnce(() => {
      guard = true
      return new Promise((_, reject) => { rejectSave = reject })
    })
    const view = render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' }))
    await enterCode()
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' }))
    await waitFor(() => expect(f.plugin.installSelectedKey).toHaveBeenCalledOnce())
    view.rerender(<BackupRecoveryDialog {...f.props} />)
    expect(screen.queryByText('settings.encryption.recoveryRestartRequired')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' })).toBeDisabled()
    guard = false
    await act(async () => { rejectSave(new Error('known save failure; previous key restored')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.recoveryFailed')
    const confirm = screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(f.onRestored).toHaveBeenCalledWith(meta.aliceFingerprint))
    expect(f.plugin.installSelectedKey).toHaveBeenCalledTimes(2)
  })
  it('FLM-365 N1 still blocks a restore already unsettled before the preview opens', async () => {
    const f = setup()
    f.plugin.isBackupRestoreUncertain.mockReturnValue(true)
    render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' }))
    await enterCode()
    expect(screen.getByRole('alert')).toHaveTextContent('settings.encryption.recoveryRestartRequired')
    expect(screen.getByRole('button', { name: 'settings.encryption.keyPicker.confirm' })).toBeDisabled()
    expect(f.plugin.installSelectedKey).not.toHaveBeenCalled()
  })
  it('FLM-365 N2 localizes a file-picker failure and keeps its diagnostic details separate', async () => {
    const f = setup()
    f.plugin.pickKeyFile.mockRejectedValue(new Error('file could not be read'))
    render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.importFromFileTitle' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.recoveryFailed')
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error:')
    fireEvent.click(screen.getByText('settings.encryption.recoveryErrorDetails'))
    expect(screen.getByText('file could not be read')).toBeVisible()
    expect(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreFromServerTitle' })).toBeEnabled()
    expect(f.plugin.installSelectedKey).not.toHaveBeenCalled()
    expect(f.onRestored).not.toHaveBeenCalled()
  })

})
