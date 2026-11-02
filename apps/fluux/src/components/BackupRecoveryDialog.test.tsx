/** Intent FLM-343: both recovery entries share read-only preview, explicit
 * fingerprint confirmation and account freshness; cancel never changes identity. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { E2EEManager } from '@fluux/sdk'
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
  const input = document.querySelector('input[type="password"]')!
  fireEvent.change(input, { target: { value: `  ${meta.backupPassphrase}  ` } })
  fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.recoveryPreview' }))
  await screen.findByText(meta.aliceFingerprint)
}
beforeEach(() => { jid = 'alice@example.com/laptop' })
describe('BackupRecoveryDialog', () => {
  it.each(['server', 'file'])('%s previews before confirming a fingerprint and preserves the backup code verbatim', async source => {
    const f = setup(); render(<BackupRecoveryDialog {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: source === 'server' ? 'settings.encryption.identityChoice.restoreFromServerTitle' : 'settings.encryption.identityChoice.importFromFileTitle' }))
    await screen.findByText('settings.encryption.recoveryCodeBody')
    await enterCode()
    const method = source === 'server' ? f.plugin.restoreSecretKey : f.plugin.importKeyFromFile
    expect(method).toHaveBeenCalledWith(...(source === 'server' ? [] : [backup]), `  ${meta.backupPassphrase}  `, { accountJid: 'alice@example.com' })
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
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: meta.backupPassphrase } })
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
    await screen.findByText('durable save failed; previous key restored')
    expect(f.onRestored).not.toHaveBeenCalled()
    expect(f.plugin.installSelectedKey).toHaveBeenCalledTimes(1)
  })
})
