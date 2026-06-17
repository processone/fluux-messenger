/**
 * RestorePassphraseDialog: the import-mode form treatment.
 *
 * `mode="import"` is for entering a FOREIGN key's passphrase (GnuPG /
 * OpenKeychain), which differs from the server-restore default in three ways:
 *  - a reveal toggle (the passphrase is often a long transcribed code),
 *  - no password-manager autofill (it is never the saved Fluux passphrase),
 *  - the value is trimmed (pasted codes carry stray whitespace).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { RestorePassphraseDialog } from './RestorePassphraseDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const noop = () => {}

describe('RestorePassphraseDialog import mode', () => {
  it('renders a free-text passphrase field with autofill disabled and no hidden username', () => {
    const { container } = render(
      <RestorePassphraseDialog mode="import" onConfirm={async () => {}} onCancel={noop} />,
    )
    const input = container.querySelector('input[name="passphrase"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(input!.getAttribute('autocomplete')).toBe('off')
    // The password-manager hint username must NOT be present in import mode.
    expect(container.querySelector('input[name="username"]')).toBeNull()
  })

  it('reveals and re-hides the passphrase via the toggle', () => {
    const { container } = render(
      <RestorePassphraseDialog mode="import" onConfirm={async () => {}} onCancel={noop} />,
    )
    const input = container.querySelector('input[name="passphrase"]') as HTMLInputElement
    expect(input.type).toBe('password')

    fireEvent.click(screen.getByRole('button', { name: 'login.showPassword' }))
    expect(input.type).toBe('text')

    fireEvent.click(screen.getByRole('button', { name: 'login.hidePassword' }))
    expect(input.type).toBe('password')
  })

  it('trims surrounding whitespace before calling onConfirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <RestorePassphraseDialog mode="import" onConfirm={onConfirm} onCancel={noop} />,
    )
    const input = container.querySelector('input[name="passphrase"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  0228-6308-1219  ' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    expect(onConfirm).toHaveBeenCalledWith('0228-6308-1219')
  })
})

describe('RestorePassphraseDialog restore mode (default, unchanged)', () => {
  it('keeps the masked backup-code input and the password-manager username hint', () => {
    const { container } = render(
      <RestorePassphraseDialog onConfirm={async () => {}} onCancel={noop} />,
    )
    // Default restore mode renders the XEP-0373 backup-code field + PM hint.
    expect(container.querySelector('input[name="backup-code"]')).not.toBeNull()
    expect(container.querySelector('input[name="username"]')).not.toBeNull()
    // No reveal toggle in restore mode (the code is already visible).
    expect(screen.queryByRole('button', { name: 'login.showPassword' })).toBeNull()
  })
})
