/**
 * BackupPassphraseDialog: the acknowledgment gate must survive the
 * password-manager <form> wrapper.
 *
 * Every control in this dialog sits inside a <form> that exists only so
 * password managers detect the generated passphrase. An untyped <button>
 * inside a form defaults to type="submit", so Copy and Regenerate used to
 * submit it — publishing the backup (or starting a key rotation) on the
 * first click, with the "I saved this passphrase" checkbox never ticked.
 * Disabling the confirm button does not help: `disabled` on one submit
 * button has no effect on another one in the same form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BackupPassphraseDialog } from './BackupPassphraseDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

const PASSPHRASE = 'alpha bravo charlie delta echo foxtrot golf hotel'

vi.mock('@/e2ee/passphraseGenerator', () => ({
  USE_V6_KEYS: true,
  generateBackupPassphrase: vi.fn(() => Promise.resolve(PASSPHRASE)),
  generateBackupCode: vi.fn(() => 'AAAA-BBBB-CCCC'),
}))

const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
})

const noop = () => {}

/** Render and wait for the async passphrase draw to land. */
async function renderDialog(onConfirm: () => Promise<void>) {
  const view = render(<BackupPassphraseDialog onConfirm={onConfirm} onCancel={noop} />)
  await screen.findByText('alpha')
  return view
}

const copyButton = () => screen.getByRole('button', { name: 'settings.encryption.backupCopy' })
const regenButton = () => screen.getByRole('button', { name: 'settings.encryption.backupRegenerate' })

describe('BackupPassphraseDialog acknowledgment gate', () => {
  it('copies without confirming: the passphrase reaches the clipboard and onConfirm does not fire', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await renderDialog(onConfirm)

    fireEvent.click(copyButton())

    // The click really landed and the handler really ran — without this the
    // onConfirm assertion below would pass even if the button were missing.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PASSPHRASE))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('leaves the acknowledgment checkbox unticked and the confirm button disabled after a copy', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const { container } = await renderDialog(onConfirm)

    fireEvent.click(copyButton())
    await waitFor(() => expect(writeText).toHaveBeenCalled())

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(
      screen.getByRole('button', { name: 'settings.encryption.backupPublish' }),
    ).toBeDisabled()
  })

  it('regenerates without confirming: a fresh passphrase is drawn and onConfirm does not fire', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await renderDialog(onConfirm)

    // Tick the box first: this is the state in which an accidental submit
    // would sail straight through the gate and publish the STALE passphrase.
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(regenButton())

    // Regenerating clears the acknowledgment, which is the observable proof
    // that handleRegenerate ran.
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms only through the explicit confirm button (control: onConfirm is reachable)', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await renderDialog(onConfirm)

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.backupPublish' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(PASSPHRASE))
  })
})
