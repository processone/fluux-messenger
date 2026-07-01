import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'

// Stub the Tauri IPC modules so the real `@tauri-apps/api/{core,event}` are
// never instantiated in this worker. `usePlatformState` is mocked away below,
// so nothing here calls them — but a sibling file (usePlatformState.test.tsx)
// drives the real production listener and can leave a pending async
// `listen()` resolution in flight. Without these stubs that resolution hits
// the real `transformCallback`, which reads `window.__TAURI_INTERNALS__` and
// throws an unhandled rejection when the global is absent. Mocking both
// modules here keeps the worker isolation-safe regardless of test ordering.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve(0)),
  transformCallback: vi.fn((cb: (raw: unknown) => void) => cb),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

const {
  mockUseConnectionStatus,
  mockUsePlatformState,
  mockGetSession,
  mockPlatformDisplayActive,
} = vi.hoisted(() => ({
  mockUseConnectionStatus: vi.fn(),
  mockUsePlatformState: vi.fn(),
  mockGetSession: vi.fn(),
  // App destructures `{ displayActive }` from usePlatformState(); default true
  // so the mock never returns undefined (which would throw on destructure).
  mockPlatformDisplayActive: { current: true },
}))

vi.mock('@fluux/sdk', () => ({
  useConnectionStatus: () => mockUseConnectionStatus(),
  useXMPPContext: () => ({
    client: {
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
  }),
  hasFastToken: vi.fn(() => false),
  // App mounts startSystemNotificationEffect(), which reads eventsStore.
  eventsStore: {
    getState: () => ({ systemNotifications: [], removeSystemNotification: vi.fn() }),
    subscribe: () => () => {},
  },
}))

vi.mock('./hooks/useSessionPersistence', () => ({
  useSessionPersistence: vi.fn(),
  getSession: () => mockGetSession(),
}))

vi.mock('./hooks/usePlatformState', () => ({
  usePlatformState: () => {
    mockUsePlatformState()
    return { displayActive: mockPlatformDisplayActive.current }
  },
}))

vi.mock('./hooks', () => ({
  useAutoUpdate: vi.fn(() => ({
    available: false,
    downloadAndInstall: vi.fn(),
    relaunchApp: vi.fn(),
    dismissUpdate: vi.fn(),
  })),
}))

vi.mock('./hooks/useFullscreen', () => ({
  useFullscreen: vi.fn(() => false),
}))

vi.mock('./hooks/useTauriCloseHandler', () => ({
  useTauriCloseHandler: vi.fn(),
}))

vi.mock('./hooks/useTauriFocusRestore', () => ({
  useTauriFocusRestore: vi.fn(),
}))

vi.mock('./hooks/useIgnoreSync', () => ({
  useIgnoreSync: vi.fn(),
}))

vi.mock('./hooks/useExternalLinkHandler', () => ({
  useExternalLinkHandler: vi.fn(),
}))

vi.mock('./hooks/useTabCoordination', () => ({
  useTabCoordination: vi.fn(() => ({
    blocked: false,
    takenOver: false,
    claimConnection: vi.fn(),
    takeOver: vi.fn(),
  })),
}))

// The online transition fires App's E2EE bootstrap effect; keep it inert so the
// routing assertions don't depend on crypto/storage side effects.
vi.mock('./e2ee/registerPlugins', () => ({
  registerE2EEPlugins: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./hooks/useAccountScopeRehydration', () => ({
  useAccountScopeRehydration: vi.fn(),
}))

vi.mock('./components/ChatLayout', () => ({
  ChatLayout: () => <div data-testid="chat-layout">ChatLayout</div>,
}))

vi.mock('./components/LoginScreen', () => ({
  LoginScreen: () => <div data-testid="login-screen">LoginScreen</div>,
}))

vi.mock('./components/TabBlockedScreen', () => ({
  TabBlockedScreen: () => <div data-testid="tab-blocked-screen">TabBlockedScreen</div>,
}))

vi.mock('./components/UpdateModal', () => ({
  UpdateModal: () => <div data-testid="update-modal">UpdateModal</div>,
}))

describe('App reconnect recovery hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPlatformDisplayActive.current = true
    mockUseConnectionStatus.mockReturnValue({ status: 'connecting' })
    mockGetSession.mockReturnValue({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
    })
  })

  it('keeps platform-state listeners mounted during the initial auto-reconnect spinner', () => {
    render(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByText('Reconnecting...')).toBeInTheDocument()
    expect(mockUsePlatformState).toHaveBeenCalledTimes(1)
  })
})

describe('App connection-state routing (after the user has been online)', () => {
  const renderApp = () =>
    render(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

  beforeEach(() => {
    vi.clearAllMocks()
    mockPlatformDisplayActive.current = true
    // A stored session persists throughout: logout-keep-data and
    // cancel-reconnect both leave credentials behind while the connection
    // is no longer online. The gate must not key its login/chat decision on
    // the (non-reactive) presence of that session alone.
    mockGetSession.mockReturnValue({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
    })
  })

  it('returns to LoginScreen after a disconnect even when a session is still stored', () => {
    mockUseConnectionStatus.mockReturnValue({ status: 'online', jid: 'user@example.com' })
    const { rerender } = renderApp()
    expect(screen.getByTestId('chat-layout')).toBeInTheDocument()

    // User picks "Disconnect" from the menu without clearing data → SDK
    // transitions to 'disconnected'. The stored session must not pin them to a
    // stale ChatLayout.
    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected', jid: null })
    rerender(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByTestId('login-screen')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-layout')).not.toBeInTheDocument()
  })

  it('returns to LoginScreen on a terminal connection error with a stored session', () => {
    mockUseConnectionStatus.mockReturnValue({ status: 'online', jid: 'user@example.com' })
    const { rerender } = renderApp()
    expect(screen.getByTestId('chat-layout')).toBeInTheDocument()

    mockUseConnectionStatus.mockReturnValue({
      status: 'error',
      jid: null,
      error: 'Authentication failed',
    })
    rerender(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByTestId('login-screen')).toBeInTheDocument()
  })

  it('stays on ChatLayout during a transient reconnect (does not flash login)', () => {
    mockUseConnectionStatus.mockReturnValue({ status: 'online', jid: 'user@example.com' })
    const { rerender } = renderApp()
    expect(screen.getByTestId('chat-layout')).toBeInTheDocument()

    mockUseConnectionStatus.mockReturnValue({ status: 'reconnecting', jid: 'user@example.com' })
    rerender(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    expect(screen.queryByTestId('login-screen')).not.toBeInTheDocument()
  })

  it('routes to LoginScreen on a disconnect driven only by the status change (session still present)', () => {
    // Regression guard for the core mechanism: the gate must react to `status`
    // alone. Here the stored session is NEVER cleared (mockGetSession keeps
    // returning it), so a gate that depended on `!hasSession` would stay on
    // ChatLayout — exactly the original bug, where connectionStore.reset() left
    // status/jid/error unchanged and App never re-rendered to notice the cleared
    // session. Flipping only `status` must be enough to reach login.
    mockUseConnectionStatus.mockReturnValue({ status: 'online', jid: 'user@example.com' })
    const { rerender } = renderApp()
    expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    expect(mockGetSession()).not.toBeNull()

    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected', jid: null })
    rerender(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(mockGetSession()).not.toBeNull() // session deliberately still present
    expect(screen.getByTestId('login-screen')).toBeInTheDocument()
  })
})

describe('App connection gate — initial load and fresh login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPlatformDisplayActive.current = true
  })

  it('shows the auto-reconnect spinner (not LoginScreen) for a disconnected status during the initial reconnect', () => {
    // Stored session → isAutoReconnecting initialises true; never been online.
    // The spinner gate runs BEFORE the disconnected/error → login gate, so a
    // 'disconnected' status here must show the spinner, not flash login.
    mockGetSession.mockReturnValue({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
    })
    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected', jid: null })

    render(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByText('Reconnecting...')).toBeInTheDocument()
    expect(screen.queryByTestId('login-screen')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chat-layout')).not.toBeInTheDocument()
  })

  it('stays on LoginScreen while a fresh login is connecting (no stored session)', () => {
    // No session → not auto-reconnecting; the login form owns the 'connecting'
    // state and shows its own spinner, so the gate must keep LoginScreen rather
    // than fall through to an empty ChatLayout.
    mockGetSession.mockReturnValue(null)
    mockUseConnectionStatus.mockReturnValue({ status: 'connecting', jid: null })

    render(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByTestId('login-screen')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-layout')).not.toBeInTheDocument()
  })

  it('shows LoginScreen on a cold start with no session (disconnected)', () => {
    mockGetSession.mockReturnValue(null)
    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected', jid: null })

    render(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByTestId('login-screen')).toBeInTheDocument()
  })

  it('drops the full-screen spinner and shows ChatLayout when reconnecting while display is asleep (B2)', () => {
    // Initial auto-reconnect (stored session, never been online) holds in
    // reconnecting.paused: status stays 'reconnecting' forever. The spinner
    // must NOT strand — render ChatLayout (paused chrome) instead.
    mockPlatformDisplayActive.current = false
    mockGetSession.mockReturnValue({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
    })
    mockUseConnectionStatus.mockReturnValue({ status: 'reconnecting', jid: 'user@example.com' })

    render(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.queryByText('Reconnecting...')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
  })

  it('still shows the spinner when reconnecting with display active (normal initial reconnect)', () => {
    mockPlatformDisplayActive.current = true
    mockGetSession.mockReturnValue({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
    })
    mockUseConnectionStatus.mockReturnValue({ status: 'reconnecting', jid: 'user@example.com' })

    render(
      <MemoryRouter initialEntries={['/messages']}>
        <App />
      </MemoryRouter>
    )

    expect(screen.getByText('Reconnecting...')).toBeInTheDocument()
  })
})
