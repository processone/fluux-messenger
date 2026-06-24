/**
 * Tests for App routing configuration.
 *
 * Phase 1: Verifies that routes are set up correctly and render ChatLayout.
 * Phase 2+ will test actual route-based view selection.
 */
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

// Mock SDK hooks
vi.mock('@fluux/sdk', () => ({
  useConnectionStatus: vi.fn(() => ({
    status: 'online',
  })),
  useXMPPContext: vi.fn(() => ({
    client: {
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
  })),
  // Consumed at module load by e2ee/verificationSync.ts (VERIFICATIONS_NODE).
  NS_FLUUX_VERIFICATIONS: 'urn:xmpp:fluux:verifications:0',
}))

// Mock session persistence
vi.mock('./hooks/useSessionPersistence', () => ({
  useSessionPersistence: vi.fn(),
  getSession: vi.fn(() => null),
}))

// Mock auto-update hook
vi.mock('./hooks', () => ({
  useAutoUpdate: vi.fn(() => ({
    available: false,
    downloadAndInstall: vi.fn(),
    relaunchApp: vi.fn(),
    dismissUpdate: vi.fn(),
  })),
}))

// Mock fullscreen hook
vi.mock('./hooks/useFullscreen', () => ({
  useFullscreen: vi.fn(() => false),
}))

vi.mock('./hooks/usePlatformState', () => ({
  // App destructures `{ displayActive }`; default true so the mock never
  // returns undefined (which would throw on destructure).
  usePlatformState: vi.fn(() => ({ displayActive: true })),
}))

// Mock Tauri close handler (no-op in tests)
vi.mock('./hooks/useTauriCloseHandler', () => ({
  useTauriCloseHandler: vi.fn(),
}))

// Mock ignore sync hook (no-op in tests)
vi.mock('./hooks/useIgnoreSync', () => ({
  useIgnoreSync: vi.fn(),
}))

// Mock ChatLayout to verify it renders
vi.mock('./components/ChatLayout', () => ({
  ChatLayout: () => <div data-testid="chat-layout">ChatLayout</div>,
}))

// Mock LoginScreen
vi.mock('./components/LoginScreen', () => ({
  LoginScreen: () => <div data-testid="login-screen">LoginScreen</div>,
}))

// Helper to render App with specific initial route
function renderAppWithRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>
  )
}

describe('App Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('when user is online', () => {
    it('renders ChatLayout at /messages', () => {
      renderAppWithRoute('/messages')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /messages/:jid', () => {
      renderAppWithRoute('/messages/user@example.com')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /rooms', () => {
      renderAppWithRoute('/rooms')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /rooms/:jid', () => {
      renderAppWithRoute('/rooms/room@conference.example.com')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /contacts', () => {
      renderAppWithRoute('/contacts')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /contacts/:jid', () => {
      renderAppWithRoute('/contacts/contact@example.com')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /archive', () => {
      renderAppWithRoute('/archive')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /events', () => {
      renderAppWithRoute('/events')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /admin', () => {
      renderAppWithRoute('/admin')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /admin/:category', () => {
      renderAppWithRoute('/admin/users')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /settings', () => {
      renderAppWithRoute('/settings')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('renders ChatLayout at /profile', () => {
      renderAppWithRoute('/profile')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('redirects / to /messages', () => {
      renderAppWithRoute('/')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('redirects unknown routes to /messages', () => {
      renderAppWithRoute('/unknown/route')
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })
  })
})
