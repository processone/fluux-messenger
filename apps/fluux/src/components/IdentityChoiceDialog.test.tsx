import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import recoveryMeta from '../e2ee/fixtures/sequoia_meta.json'
import { IdentityChoiceDialog } from './IdentityChoiceDialog'
import { EscapeModal } from '@/test-utils/escapeModal'

// Surface i18n keys verbatim so assertions can target them without
// committing to specific translated copy. The real translations live
// in the locale JSON files.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const baseProps = {
  serverBackup: 'present' as const,
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

  it('disables the server-restore choice when the server confirmed there is no backup', () => {
    render(<IdentityChoiceDialog {...baseProps} serverBackup="absent" />)
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

  it('keeps the server-restore choice reachable when the probe was inconclusive', () => {
    // A probe that timed out tells us nothing about whether a backup
    // exists. Greying out restore here would steer the user toward
    // "Replace identity", which retracts their published key.
    render(<IdentityChoiceDialog {...baseProps} serverBackup="unknown" />)
    const restoreButton = screen
      .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
      .closest('button')
    expect(restoreButton).not.toBeDisabled()
  })

  it('runs the restore handler when restore is picked under an inconclusive probe', async () => {
    // Control for the test above: an un-greyed button proves nothing on
    // its own, so drive the whole wire. `restoreSecretKey` re-fetches the
    // backup itself, which makes this the retry path for a failed probe.
    render(<IdentityChoiceDialog {...baseProps} serverBackup="unknown" />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    fireEvent.change(
      screen.getByPlaceholderText(
        'settings.encryption.identityChoice.restorePassphrasePlaceholder',
      ),
      { target: { value: 'passphrase-from-other-device' } },
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.encryption.identityChoice.restoreAction',
      }),
    )
    await waitFor(() => {
      expect(baseProps.onRestoreFromServer).toHaveBeenCalledWith(
        'passphrase-from-other-device',
      )
    })
  })

  it.each([
    ['present', 'restoreFromServerBody'],
    ['absent', 'restoreFromServerUnavailable'],
    ['unknown', 'restoreFromServerUnknown'],
  ] as const)(
    'describes the restore choice with its own copy when the probe says %s',
    (serverBackup, key) => {
      render(<IdentityChoiceDialog {...baseProps} serverBackup={serverBackup} />)
      expect(
        screen.getByText(`settings.encryption.identityChoice.${key}`),
      ).toBeInTheDocument()
    },
  )

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

  it('shows the restore in progress and ignores further taps until it settles', async () => {
    let settle!: (outcome: Error | null) => void
    const pending = {
      ...baseProps,
      onRestoreFromServer: vi.fn(
        () => new Promise<void>((resolve, reject) => {
          settle = (outcome) => (outcome ? reject(outcome) : resolve())
        }),
      ),
    }
    render(<IdentityChoiceDialog {...pending} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    const input = screen.getByPlaceholderText(
      'settings.encryption.identityChoice.restorePassphrasePlaceholder',
    )
    fireEvent.change(input, { target: { value: 'my-backup-passphrase' } })
    const restore = screen.getByRole('button', {
      name: 'settings.encryption.identityChoice.restoreAction',
    })

    fireEvent.click(restore)
    fireEvent.click(restore)
    fireEvent.click(restore)

    expect(pending.onRestoreFromServer).toHaveBeenCalledTimes(1)
    expect(restore).toBeDisabled()
    expect(restore).toHaveAttribute('aria-busy', 'true')
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'common.back' })).toBeDisabled()

    settle(new Error('wrong-passphrase'))
    await waitFor(() => expect(restore).not.toBeDisabled())
    expect(restore).toHaveAttribute('aria-busy', 'false')
    expect(input).not.toBeDisabled()
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

  // FLM-343: cancelling a recovery file picker must not strand the chooser.
  it('returns to usable choices when the file picker completes without an import', async () => {
    render(<IdentityChoiceDialog {...baseProps} />)
    fireEvent.click(screen.getByText('settings.encryption.identityChoice.importFromFileTitle').closest('button')!)
    await waitFor(() => expect(screen.getByText('settings.encryption.identityChoice.restoreFromServerTitle')).toBeInTheDocument())
    expect(baseProps.onRestoreFromServer).not.toHaveBeenCalled()
    expect(baseProps.onReplaceIdentity).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
  })

  // FLM-343: a pending native operation cannot be cancelled or submitted again.
  it('does not dismiss the choice dialog while its restore is pending', async () => {
    let finish!: () => void
    const restore = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    render(<IdentityChoiceDialog {...baseProps} onRestoreFromServer={restore} />)
    fireEvent.click(screen.getByText('settings.encryption.identityChoice.restoreFromServerTitle').closest('button')!)
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: recoveryMeta.backupPassphrase } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.identityChoice.restoreAction' }))
    expect(document.querySelector('[data-modal] > button')).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(baseProps.onCancel).not.toHaveBeenCalled()
    await act(async () => { finish() })
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

  // Intent FLM-304: a desynced key's last-resort keychain retry sits with the
  // choices, so it never mixes into a restore or replacement already started.
  it('shows a caller-supplied advanced recovery only while the user is choosing', () => {
    render(
      <IdentityChoiceDialog
        {...baseProps}
        reason="local-key-unrecoverable"
        advanced={() => <button type="button">advanced recovery</button>}
      />,
    )
    expect(screen.getByRole('button', { name: 'advanced recovery' })).toBeInTheDocument()
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    expect(screen.queryByRole('button', { name: 'advanced recovery' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common.back' }))
    expect(screen.getByRole('button', { name: 'advanced recovery' })).toBeInTheDocument()
  })

  // Intent FLM-408 R1: while the advanced recovery asks macOS, no restore,
  // import or replacement may start and nothing may close the choice, or the
  // retry would report a key another flow has since replaced.
  it('holds every choice and its Cancel while the advanced recovery runs', () => {
    let report!: (busy: boolean) => void
    render(
      <IdentityChoiceDialog
        {...baseProps}
        reason="local-key-unrecoverable"
        advanced={({ onBusyChange }) => {
          report = onBusyChange
          return <button type="button">advanced recovery</button>
        }}
      />,
    )
    const choices = ['restoreFromServerTitle', 'importFromFileTitle', 'replaceTitle']
      .map(key => screen.getByText(`settings.encryption.identityChoice.${key}`).closest('button')!)
    const cancel = screen.getByRole('button', { name: 'common.cancel' })
    act(() => report(true))
    for (const choice of choices) expect(choice).toBeDisabled()
    expect(cancel).toBeDisabled()
    expect(document.querySelector('[data-modal] > button')).toBeDisabled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(baseProps.onCancel).not.toHaveBeenCalled()

    act(() => report(false))
    for (const choice of choices) expect(choice).toBeEnabled()
    expect(cancel).toBeEnabled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(baseProps.onCancel).toHaveBeenCalledOnce()
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

  it('consumes Escape so it never reaches the window-level shortcut handler', () => {
    // Regression (image-scroll-position-reset follow-up): this dialog can appear
    // over the live app (App.tsx auto-init). Its Escape handling — backing out a
    // sub-phase or cancelling from the chooser — must not also fire the window
    // shortcut that scrolls the conversation to the bottom and marks it read.
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<IdentityChoiceDialog {...baseProps} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })
})

// The captain's ruling on review R3, applied by review R5: with stacked overlays, Escape
// closes only the one on top, so closing shortcut help never cancels encryption setup.
describe('IdentityChoiceDialog with shortcut help opened over it', () => {
  const closeHelp = vi.fn()
  const Page = ({ help }: { help: boolean }) => (
    <>
      <IdentityChoiceDialog {...baseProps} />
      {help && <EscapeModal onClose={closeHelp} />}
    </>
  )

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('closes help first without cancelling, then cancels from the chooser', () => {
    const { rerender } = render(<Page help={false} />)
    rerender(<Page help />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
    expect(baseProps.onCancel).not.toHaveBeenCalled()
    rerender(<Page help={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
  })

  it('closes help first and stays in the restore step', () => {
    const { rerender } = render(<Page help={false} />)
    fireEvent.click(
      screen
        .getByText('settings.encryption.identityChoice.restoreFromServerTitle')
        .closest('button')!,
    )
    rerender(<Page help />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText('settings.encryption.identityChoice.importFromFileTitle'),
    ).not.toBeInTheDocument()
    rerender(<Page help={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(
      screen.getByText('settings.encryption.identityChoice.importFromFileTitle'),
    ).toBeInTheDocument()
    expect(baseProps.onCancel).not.toHaveBeenCalled()
  })
})

// Review R5: the startup dialog (App.tsx) sits later in the page than shortcut help, so it
// is drawn over help even when help opened after it. Escape goes to the one drawn on top.
describe('IdentityChoiceDialog drawn over shortcut help opened after it', () => {
  const closeHelp = vi.fn()
  const Page = ({ help, dialog }: { help: boolean; dialog: boolean }) => (
    <>
      {help && <EscapeModal onClose={closeHelp} />}
      {dialog && <IdentityChoiceDialog {...baseProps} />}
    </>
  )

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('takes Escape first and cancels from the chooser, then help closes', () => {
    const { rerender } = render(<Page help={false} dialog />)
    rerender(<Page help dialog />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
    expect(closeHelp).not.toHaveBeenCalled()
    rerender(<Page help dialog={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
  })
})
