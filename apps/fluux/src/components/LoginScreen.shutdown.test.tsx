import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'
import { markConnectActive } from '@/utils/reconnectIntent'
import { markShuttingDown, resetShutdownStateForTests } from '@/utils/appShutdown'
import { installStartupCleanup } from '@/utils/startupRecovery'
import { getCredentials } from '@/utils/keychain'

const native = vi.hoisted(() => ({ listen: vi.fn(), invoke: vi.fn(), remove: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))

const mockConnect = vi.fn().mockResolvedValue(undefined)
const savedCredentials = vi.hoisted(() => ({ jid: 'user@example.com', password: 'secret', server: 'wss://example.com/ws' }))

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
// This suite owns relogin effects, not native deep-link startup.
vi.mock('@/utils/deepLinkRouter', () => ({ ensureDeepLinkRouter: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/utils/sessionStorage', () => ({ saveSession: vi.fn() }))
vi.mock('@/utils/xmppResource', () => ({ getResource: () => 'test-resource' }))
import { setPlatformForTesting } from '@/platform'

// These suites describe the desktop app: keychain auto-connect and the
// webview reload before a second login are both desktop-only behaviours.
let restorePlatform: (() => void) | undefined
beforeEach(() => {
  restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
})
afterEach(() => {
  restorePlatform?.()
  vi.unstubAllGlobals()
})
vi.mock('@/utils/keychain', () => ({
  hasSavedCredentials: () => true,
  getCredentials: vi.fn().mockResolvedValue(savedCredentials),
  saveCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
}))
vi.mock('@/config/wellKnownServers', () => ({
  getConnectionServerOptions: (jid: string, server: string) => ({
    server: server || jid.split('@')[1] || '',
    fallbackWebSocketUrl: undefined,
  }),
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
    vi.mocked(getCredentials).mockClear()
    native.listen.mockReset().mockResolvedValue(native.remove)
    native.invoke.mockReset().mockImplementation(async (command: string) => command === 'startup_attempt' ? 1 : undefined)
    // Dynamic imports inside the event callback can use the real core module.
    // Stub the actual IPC boundary, as the native push lifecycle tests do.
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: native.invoke, transformCallback: () => 1, unregisterCallback: vi.fn() })
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

    const view = render(<LoginScreen />)

    await waitFor(() => expect(reloadSpy).toHaveBeenCalled())
    // The mocked reload does not unload this component. Await its remaining
    // credential work so it cannot leak into the next scenario's mocks.
    await waitFor(() => expect(view.getByDisplayValue(savedCredentials.jid)).toBeInTheDocument())
  })

  // FLM-403 F2: the real LoginScreen effects must not race the native reset
  // acknowledgement when startup recovery retires an already-online client.
  it('keeps LoginScreen from reloading or reconnecting before the startup cleanup ack', async () => {
    markConnectActive()
    sessionStorage.setItem('__wry_was_online', '1')
    let finish!: () => void
    const disconnect = vi.fn(() => {
      render(<LoginScreen />) // Same fresh mount caused by App's disconnected route.
      return new Promise<void>((resolve) => { finish = resolve })
    })
    const dispose = installStartupCleanup(disconnect)
    try {
      await waitFor(() => expect(native.listen).toHaveBeenCalledWith('startup-recovery-cleanup', expect.any(Function)))
      const listener = native.listen.mock.calls.find(([name]) => name === 'startup-recovery-cleanup')![1] as (event: { payload: number }) => Promise<void>
      let acknowledgement!: Promise<void>
      act(() => { acknowledgement = listener({ payload: 2 }) })
      expect(disconnect).toHaveBeenCalledOnce()
      expect(sessionStorage.getItem('__wry_was_online')).toBeNull()
      expect(reloadSpy).not.toHaveBeenCalled()
      expect(mockConnect).not.toHaveBeenCalled()
      expect(getCredentials).not.toHaveBeenCalled()
      expect(native.invoke.mock.calls.some(([command]) => command === 'startup_cleanup_complete')).toBe(false)
      finish()
      await act(async () => { await acknowledgement })
      // The real core forwards an optional third IPC-options argument; this
      // boundary owns the command payload, not that unused argument's arity.
      expect(native.invoke.mock.calls.find(([command]) => command === 'startup_cleanup_complete')?.[1])
        .toEqual({ generation: 2, succeeded: true })
      expect(reloadSpy).not.toHaveBeenCalled()
      expect(mockConnect).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  // ── The regression ─────────────────────────────────────────────────────────

  // ★ Quitting must not open a fresh XMPP session that the exit kills seconds
  // later, stranding a ghost session on the server.
  it('does NOT auto-connect from the keychain while shutting down', async () => {
    markConnectActive()
    markShuttingDown()

    const view = render(<LoginScreen />)

    await waitFor(() => expect(view.getByDisplayValue(savedCredentials.jid)).toBeInTheDocument())
    expect(mockConnect).not.toHaveBeenCalled()
  })

  // ★ Reloading here would destroy the JS context that still owes the shutdown
  // handler its `stop_xmpp_proxy` / `exit_app` invokes, so the app could only
  // die via Rust's 2s force-exit fallback.
  it('does NOT reload the webview while shutting down', async () => {
    markConnectActive()
    sessionStorage.setItem('__wry_was_online', '1')
    markShuttingDown()

    const view = render(<LoginScreen />)

    await waitFor(() => expect(view.getByDisplayValue(savedCredentials.jid)).toBeInTheDocument())
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})
