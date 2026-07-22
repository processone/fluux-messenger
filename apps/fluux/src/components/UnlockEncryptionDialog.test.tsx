import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UnlockEncryptionDialog } from './UnlockEncryptionDialog'

const cachePassphrase = vi.fn()
const clearCachedPassphrase = vi.fn()
vi.mock('@/e2ee/webPassphraseCache', () => ({
  cachePassphrase: (...a: unknown[]) => cachePassphrase(...a),
  clearCachedPassphrase: (...a: unknown[]) => clearCachedPassphrase(...a),
  getRememberPassphrasePreference: () => false,
  setRememberPassphrasePreference: vi.fn(),
}))

// i18n: return the key so we can assert by stable text fragments. `i18n` must
// be present too — BackupPassphraseDialog-style components that read
// `i18n.language` on mount would otherwise throw, silently defusing every
// assertion downstream of the render (the hollow-test pattern found in #1064).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

function makeClient(unlock: ReturnType<typeof vi.fn>) {
  return {
    getJid: () => 'alice@example.com/web',
    e2ee: {
      getPlugin: () => ({
        // no hasNoLocalKey => dialog resolves to 'unlock' mode
        unlock,
      }),
    },
  } as unknown as Parameters<typeof UnlockEncryptionDialog>[0]['client']
}

beforeEach(() => {
  cachePassphrase.mockReset()
  clearCachedPassphrase.mockReset()
})

describe('UnlockEncryptionDialog remember checkbox', () => {
  it('shows the checkbox in unlock mode', async () => {
    render(<UnlockEncryptionDialog client={makeClient(vi.fn())} onClose={vi.fn()} />)
    expect(await screen.findByText('settings.encryption.rememberPassphrase')).toBeTruthy()
  })

  it('caches the passphrase when the box is checked on confirm', async () => {
    const unlock = vi.fn().mockResolvedValue({ recovered: false })
    const onClose = vi.fn()
    render(<UnlockEncryptionDialog client={makeClient(unlock)} onClose={onClose} />)

    fireEvent.change(await screen.findByPlaceholderText('settings.encryption.restorePassphrasePlaceholder'), {
      target: { value: 'my-passphrase' },
    })
    fireEvent.click(screen.getByLabelText('settings.encryption.rememberPassphrase'))
    fireEvent.click(screen.getByText('settings.encryption.unlockAction'))

    await waitFor(() => expect(unlock).toHaveBeenCalledWith('my-passphrase'))
    expect(cachePassphrase).toHaveBeenCalledWith('alice@example.com', 'my-passphrase')
    expect(clearCachedPassphrase).not.toHaveBeenCalled()
  })

  it('clears any prior cache when confirming with the box unchecked', async () => {
    const unlock = vi.fn().mockResolvedValue({ recovered: false })
    render(<UnlockEncryptionDialog client={makeClient(unlock)} onClose={vi.fn()} />)

    fireEvent.change(await screen.findByPlaceholderText('settings.encryption.restorePassphrasePlaceholder'), {
      target: { value: 'my-passphrase' },
    })
    fireEvent.click(screen.getByText('settings.encryption.unlockAction'))

    await waitFor(() => expect(clearCachedPassphrase).toHaveBeenCalledWith('alice@example.com'))
    expect(cachePassphrase).not.toHaveBeenCalled()
  })
})

// A failed probe used to select `setup` — inviting a user whose local key
// is gone to generate a NEW key while a backup may sit on the server. A
// wrong `restore` guess only degrades to NoRecoveryAvailableError, which
// this dialog already handles; a wrong `setup` guess risks forking the
// identity. The asymmetry is why `unknown` must mean restore.
describe('inconclusive backup probe', () => {
  function clientWith(probe: 'present' | 'absent' | 'unknown') {
    return {
      e2ee: {
        getPlugin: (name: string) =>
          name === 'openpgp'
            ? { hasNoLocalKey: async () => true, probeSecretKeyBackup: async () => probe }
            : null,
      },
    } as unknown as Parameters<typeof UnlockEncryptionDialog>[0]['client']
  }

  it('offers restore, not setup, when the probe is inconclusive', async () => {
    render(<UnlockEncryptionDialog client={clientWith('unknown')} onClose={() => {}} />)

    expect(
      await screen.findByText('settings.encryption.unlockDialogRestoreTitle'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('settings.encryption.unlockDialogSetupTitle'),
    ).not.toBeInTheDocument()
  })

  it('offers setup when the server confirms there is no backup', async () => {
    // Control test: proves the fixture can reach setup mode, so the
    // assertions above discriminate between two live outcomes rather than
    // asserting a constant.
    render(<UnlockEncryptionDialog client={clientWith('absent')} onClose={() => {}} />)

    expect(
      await screen.findByText('settings.encryption.unlockDialogSetupTitle'),
    ).toBeInTheDocument()
  })
})
