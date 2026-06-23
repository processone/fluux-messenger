import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IdentityChoiceDialog } from './IdentityChoiceDialog'

// Surface i18n keys verbatim so assertions can target them without
// committing to specific translated copy. The real translations live
// in the locale JSON files.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const baseProps = {
  hasServerBackup: true,
  publishedFingerprints: ['aabbccdd1122334455667788'],
  onRestoreFromServer: vi.fn(),
  onImportFromFile: vi.fn(),
  onReplaceIdentity: vi.fn(),
  onCancel: vi.fn(),
}

describe('IdentityChoiceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the three choice buttons and a cancel control on first paint', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    expect(
      screen.getByText('settings.encryption.identityChoice.restoreFromServerTitle'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('settings.encryption.identityChoice.importFromFileTitle'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('settings.encryption.identityChoice.replaceTitle'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument()
  })

  it('shows the no-local-key body by default', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    expect(
      screen.getByText('settings.encryption.identityChoice.body'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('settings.encryption.identityChoice.bodyKeyUnrecoverable'),
    ).not.toBeInTheDocument()
  })

  it('shows the dedicated body when the local key is unrecoverable', () => {
    render(<IdentityChoiceDialog {...baseProps} reason="local-key-unrecoverable" />)
    expect(
      screen.getByText('settings.encryption.identityChoice.bodyKeyUnrecoverable'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('settings.encryption.identityChoice.body'),
    ).not.toBeInTheDocument()
  })

  it('disables the server-restore choice when no backup is available', () => {
    render(<IdentityChoiceDialog {...baseProps} hasServerBackup={false} />)
    // The container button hosting the title text is the disable target.
    // Querying by the title element and walking up to the button is the
    // most resilient locator — the title sits inside a styled <span>.
    const restoreButton = screen
      .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
      .closest('button')
    expect(restoreButton).toBeDisabled()
    // Body copy switches to the "unavailable" variant so the user knows
    // why the action is greyed out.
    expect(
      screen.getByText('settings.encryption.identityChoice.restoreFromServerUnavailable'),
    ).toBeInTheDocument()
  })

  it('surfaces the first published fingerprint in the header band', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    expect(screen.getByText('aabbccdd1122334455667788')).toBeInTheDocument()
  })

  it('adds a "+N" suffix when multiple fingerprints are published', () => {
    render(
      <IdentityChoiceDialog
        {...baseProps}
        publishedFingerprints={['aa11', 'bb22', 'cc33']}
      />,
    )
    // The header shows the first fingerprint and a "+2" suffix to hint
    // at the extras without dumping the whole list. The exact spacing
    // is part of the formatted string; match loosely.
    expect(screen.getByText(/aa11.*\+2/)).toBeInTheDocument()
  })

  it('moves into the restore phase and shows the passphrase input when restore is picked', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    expect(
      screen.getByPlaceholderText('settings.encryption.identityChoice.restorePassphrasePlaceholder'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreAction' }),
    ).toBeInTheDocument()
  })

  it('disables the restore submit button until a non-empty passphrase is typed', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    const submit = screen.getByRole('button', {
      name: 'settings.encryption.identityChoice.restoreAction',
    })
    expect(submit).toBeDisabled()
    const input = screen.getByPlaceholderText(
      'settings.encryption.identityChoice.restorePassphrasePlaceholder',
    )
    fireEvent.change(input, { target: { value: 'my-backup-passphrase' } })
    expect(submit).not.toBeDisabled()
  })

  it('calls onRestoreFromServer with the typed passphrase on submit', async () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    const input = screen.getByPlaceholderText(
      'settings.encryption.identityChoice.restorePassphrasePlaceholder',
    )
    fireEvent.change(input, { target: { value: 'my-backup-passphrase' } })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.encryption.identityChoice.restoreAction',
      }),
    )
    await waitFor(() => {
      expect(baseProps.onRestoreFromServer).toHaveBeenCalledWith('my-backup-passphrase')
    })
  })

  it('keeps the dialog open with an inline error when restore handler rejects', async () => {
    const failing = {
      ...baseProps,
      onRestoreFromServer: vi.fn().mockRejectedValue(new Error('wrong-passphrase')),
    }
    render(<IdentityChoiceDialog {...failing} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    const input = screen.getByPlaceholderText(
      'settings.encryption.identityChoice.restorePassphrasePlaceholder',
    )
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.encryption.identityChoice.restoreAction',
      }),
    )
    await waitFor(() => {
      expect(screen.getByText('wrong-passphrase')).toBeInTheDocument()
    })
    // The user must be able to retry without closing the modal.
    expect(input).toBeInTheDocument()
  })

  it('calls onImportFromFile when the file option is picked', async () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.importFromFileTitle')
        .closest('button')!,
    )
    await waitFor(() => {
      expect(baseProps.onImportFromFile).toHaveBeenCalledTimes(1)
    })
  })

  it('requires confirmation before triggering replace', async () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    // First click: enters the "confirm-replace" phase but does NOT call
    // the handler — the user must explicitly acknowledge the warning.
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.replaceTitle')
        .closest('button')!,
    )
    expect(
      screen.getByText('settings.encryption.identityChoice.replaceWarning'),
    ).toBeInTheDocument()
    expect(baseProps.onReplaceIdentity).not.toHaveBeenCalled()
    // Second click on the explicit confirm: now the handler runs.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.encryption.identityChoice.replaceConfirmAction',
      }),
    )
    await waitFor(() => {
      expect(baseProps.onReplaceIdentity).toHaveBeenCalledTimes(1)
    })
  })

  it('returns to the chooser when Back is pressed during the restore phase', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    fireEvent.click(screen.getByRole('button', { name: 'common.back' }))
    // The choice list is back — restore, import, replace titles all visible.
    expect(
      screen.getByText('settings.encryption.identityChoice.importFromFileTitle'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('settings.encryption.identityChoice.replaceTitle'),
    ).toBeInTheDocument()
  })

  it('escape during sub-phase returns to chooser without dismissing the dialog', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    // Cancel is NOT called — escape only backs out of the sub-phase
    // when there's a phase to back out from.
    expect(baseProps.onCancel).not.toHaveBeenCalled()
    // Chooser is back.
    expect(
      screen.getByText('settings.encryption.identityChoice.importFromFileTitle'),
    ).toBeInTheDocument()
  })

  it('escape on the chooser dismisses the dialog via onCancel', () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
  })
})
