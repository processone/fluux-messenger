import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'
import { markConnectActive } from '@/utils/reconnectIntent'
import { markShuttingDown, resetShutdownStateForTests } from '@/utils/appShutdown'

const mockConnect = vi.fn().mockResolvedValue(undefined)

// Tauri + saved keychain credentials => the keychain auto-connect effect arms.
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
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

/**
 * Quitting the app (tray "Quit", Cmd+Q, close) makes `client.disconnect()` flip
 * the store to 'disconnected', which routes App to a FRESH LoginScreen mount.
 * Both of that mount's start-up effects used to fight the shutdown: the WRY
 * reload workaround tore down the JS context before `exit_app` could run, and
 * the keychain auto-connect opened a new XMPP session that the exit then killed.
 */
describe('LoginScreen — start-up effects during app shutdown', () => {
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockConnect.mockClear()
    resetShutdownStateForTests()

    // jsdom's window.location.reload is not writable; replace the accessor.
    reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    })
  })

  // ── Positive controls ──────────────────────────────────────────────────────
  // These prove both effects genuinely fire on a normal (non-shutdown) mount,
  // so the "does NOT" assertions below are capable of failing.

  it('auto-connects from the keychain on a normal disconnect (control)', async () => {
    markConnectActive()

    render(<LoginScreen />)

    await waitFor(() => expect(mockConnect).toHaveBeenCalled())
  })

  it('reloads the webview on a normal post-online disconnect (control)', async () => {
    markConnectActive()
    sessionStorage.setItem('__wry_was_online', '1')

    render(<LoginScreen />)

    await waitFor(() => expect(reloadSpy).toHaveBeenCalled())
  })

  // ── The regression ─────────────────────────────────────────────────────────

  // ★ Quitting must not open a fresh XMPP session that the exit kills seconds
  // later, stranding a ghost session on the server.
  it('does NOT auto-connect from the keychain while shutting down', async () => {
    markConnectActive()
    markShuttingDown()

    render(<LoginScreen />)

    // Give the credential-load + auto-connect effects time to run.
    await new Promise((r) => setTimeout(r, 50))

    expect(mockConnect).not.toHaveBeenCalled()
  })

  // ★ Reloading here would destroy the JS context that still owes the shutdown
  // handler its `stop_xmpp_proxy` / `exit_app` invokes, so the app could only
  // die via Rust's 2s force-exit fallback.
  it('does NOT reload the webview while shutting down', async () => {
    markConnectActive()
    sessionStorage.setItem('__wry_was_online', '1')
    markShuttingDown()

    render(<LoginScreen />)

    await new Promise((r) => setTimeout(r, 50))

    expect(reloadSpy).not.toHaveBeenCalled()
  })
})
