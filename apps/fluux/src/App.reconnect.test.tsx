import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'

const {
  mockUseConnectionStatus,
  mockUsePlatformState,
  mockGetSession,
} = vi.hoisted(() => ({
  mockUseConnectionStatus: vi.fn(),
  mockUsePlatformState: vi.fn(),
  mockGetSession: vi.fn(),
}))

vi.mock('@fluux/sdk', () => ({
  useConnectionStatus: () => mockUseConnectionStatus(),
  useXMPPContext: () => ({
    client: {
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
  }),
  hasFastToken: vi.fn(() => false),
}))

vi.mock('./hooks/useSessionPersistence', () => ({
  useSessionPersistence: vi.fn(),
  getSession: () => mockGetSession(),
}))

vi.mock('./hooks/usePlatformState', () => ({
  usePlatformState: () => mockUsePlatformState(),
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

vi.mock('./hooks/useTauriTrayRestore', () => ({
  useTauriTrayRestore: vi.fn(),
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
