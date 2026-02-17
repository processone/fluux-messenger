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

// Mock SDK hooks
vi.mock('@fluux/sdk', () => ({
  useConnection: vi.fn(() => ({
    status: 'online',
  })),
  useXMPPContext: vi.fn(() => ({
    client: {
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
  })),
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

// Mock Tauri close handler (no-op in tests)
vi.mock('./hooks/useTauriCloseHandler', () => ({
  useTauriCloseHandler: vi.fn(),
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
