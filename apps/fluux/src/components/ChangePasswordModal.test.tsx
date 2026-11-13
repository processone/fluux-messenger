import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChangePasswordModal } from './ChangePasswordModal'
import { useToastStore } from '@/stores/toastStore'
import { setPlatformForTesting } from '@/platform'
import { hasSavedCredentials, resetKeychainLaunchStateForTesting } from '@/utils/keychain'
import { standaloneStartupReconnect } from '@/utils/startupReconnect'

const { mockChangePassword, mockInvoke } = vi.hoisted(() => ({
  mockChangePassword: vi.fn(),
  mockInvoke: vi.fn(),
}))

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useConnection: () => ({ changePassword: mockChangePassword, jid: 'fixture@example.invalid' }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// The keychain helpers run for real; only the native credential command is replaced.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// What the Linux keyring command answers when the login keyring is locked and
// its unlock prompt is dismissed during the save.
const LOCKED_KEYRING_SAVE_ERROR = 'keychain-unavailable: Keychain locked or inaccessible during save: '
  + "Couldn't access platform secure storage: Secret Service: unlock prompt was dismissed"

let restorePlatform: (() => void) | undefined

function submitNewPassword(onClose: () => void) {
  const { container } = render(<ChangePasswordModal onClose={onClose} />)
  fireEvent.change(container.querySelector('#new-password')!, { target: { value: 'new-local-secret' } })
  fireEvent.change(container.querySelector('#confirm-password')!, { target: { value: 'new-local-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
}

describe('ChangePasswordModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetKeychainLaunchStateForTesting()
    useToastStore.setState({ toasts: [] })
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'linux' })
    // Signed in earlier with Remember me: the keychain holds the current password.
    localStorage.setItem('xmpp-has-saved-credentials', 'true')
  })

  afterEach(() => {
    restorePlatform?.()
    localStorage.clear()
    useToastStore.setState({ toasts: [] })
  })

  it('keeps the dialog open and says the change failed when the server refuses it', async () => {
    mockChangePassword.mockRejectedValueOnce(new Error('not-acceptable'))
    const onClose = vi.fn()

    submitNewPassword(onClose)

    expect(await screen.findByText('profile.failedToChangePassword')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(hasSavedCredentials()).toBe(true)
  })

  // The server took the new password, so the change succeeded; only the
  // keychain kept the old one, which would fail at the next start.
  it('closes, says the new password was not saved and stops using the old one when only the keychain update fails', async () => {
    mockChangePassword.mockResolvedValueOnce(undefined)
    mockInvoke.mockRejectedValueOnce(LOCKED_KEYRING_SAVE_ERROR)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onClose = vi.fn()

    submitNewPassword(onClose)

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(mockInvoke).toHaveBeenCalledWith('save_credentials', { jid: 'fixture@example.invalid', password: 'new-local-secret', server: null })
    expect(screen.queryByText('profile.failedToChangePassword')).toBeNull()
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', message: 'profile.newPasswordNotSaved' }),
    ])
    // The next start neither reads the keychain nor signs in with the old password.
    expect(hasSavedCredentials()).toBe(false)
    expect(standaloneStartupReconnect()).toBeNull()
    errors.mockRestore()
  })

  it('saves the new password and closes without a message when the keychain update works', async () => {
    mockChangePassword.mockResolvedValueOnce(undefined)
    mockInvoke.mockResolvedValueOnce(undefined)
    const onClose = vi.fn()

    submitNewPassword(onClose)

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(mockInvoke).toHaveBeenCalledWith('save_credentials', { jid: 'fixture@example.invalid', password: 'new-local-secret', server: null })
    expect(useToastStore.getState().toasts).toEqual([])
    expect(standaloneStartupReconnect()).toEqual({ kind: 'keychain' })
  })
})
