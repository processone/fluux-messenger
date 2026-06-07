import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'
import { markLoggedOut, markConnectActive } from '@/utils/reconnectIntent'

const mockConnect = vi.fn().mockResolvedValue(undefined)

// Tauri + saved keychain credentials => the keychain auto-connect effect arms.
vi.mock('@fluux/sdk', () => ({
  useConnectionStatus: () => ({ status: 'offline', error: null }),
  useConnectionActions: () => ({ connect: mockConnect }),
  deleteFastToken: vi.fn(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks', () => ({ useWindowDrag: () => ({ dragRegionProps: {} }) }))
vi.mock('@/hooks/useSessionPersistence', () => ({ saveSession: vi.fn() }))
vi.mock('@/utils/xmppResource', () => ({ getResource: () => 'test-resource' }))
vi.mock('@/utils/tauri', () => ({ isTauri: () => true }))
vi.mock('@/utils/keychain', () => ({
  hasSavedCredentials: () => true,
  getCredentials: vi.fn().mockResolvedValue({
    jid: 'user@example.com',
    password: 'secret',
    server: 'wss://example.com/ws',
  }),
  saveCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
}))
vi.mock('@/config/wellKnownServers', () => ({
  getDomainFromJid: () => null,
  getWebsocketUrlForDomain: () => null,
}))
vi.mock('@/stores/encryptionSettingsStore', () => ({ isOpenpgpEnabled: () => false }))

describe('LoginScreen — keychain auto-connect respects reconnect intent', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockConnect.mockClear()
  })

  // Positive control: proves the keychain auto-connect path actually fires here,
  // so the "not called" assertion below is meaningful.
  it('auto-connects from the keychain when intent is active', async () => {
    markConnectActive()

    render(<LoginScreen />)

    await waitFor(() => expect(mockConnect).toHaveBeenCalled())
  })

  // ★ After an explicit logout, the keychain must not silently log the user back
  // in — even if keychain credential deletion lost its race and creds remain.
  it('does NOT auto-connect from the keychain after logout (intent = logged-out)', async () => {
    markLoggedOut()

    render(<LoginScreen />)

    // Give the credential-load + auto-connect effects time to run.
    await new Promise((r) => setTimeout(r, 50))

    expect(mockConnect).not.toHaveBeenCalled()
  })
})
