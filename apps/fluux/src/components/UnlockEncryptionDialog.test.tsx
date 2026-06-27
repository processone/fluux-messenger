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

// i18n: return the key so we can assert by stable text fragments.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
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
