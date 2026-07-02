import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AdminUserView } from './AdminUserView'
import type { AdminUser } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'common.close': 'Close',
        'admin.userView.manageUser': 'Manage user account',
        'admin.userView.actions': 'Actions',
        'admin.userView.account': 'Account',
        'admin.userView.lastLogin': 'Last login',
        'admin.users.changePassword': 'Change password',
        'admin.users.endSessions': 'End sessions',
        'admin.users.delete': 'Delete user',
        'admin.users.banAccount': 'Ban account',
        'admin.users.online': 'Online',
        'admin.users.offline': 'Offline',
        'admin.userView.confirmDelete': 'Delete User',
        'admin.userView.confirmDeleteMessage': `Are you sure you want to delete ${params?.jid}? This action cannot be undone.`,
        'admin.userView.confirmEndSessions': 'End Sessions',
        'admin.userView.confirmEndSessionsMessage': `Are you sure you want to end all sessions for ${params?.jid}? The user will be disconnected immediately.`,
        'admin.userView.confirmBan': 'Ban Account',
        'admin.userView.confirmBanMessage': `Are you sure you want to ban ${params?.jid}? This will disconnect the user and prevent them from logging in again.`,
        'common.cancel': 'Cancel',
      }
      return translations[key] || key
    },
    i18n: { language: 'en' },
  }),
}))

describe('AdminUserView', () => {
  const mockUser: AdminUser = {
    jid: 'testuser@example.com',
    username: 'testuser',
  }

  const mockOnBack = vi.fn()
  const mockOnDeleteUser = vi.fn()
  const mockOnEndSessions = vi.fn()
  const mockOnChangePassword = vi.fn()
  const mockOnBanAccount = vi.fn()
  const mockFetchLastLogin = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchLastLogin.mockResolvedValue(null)
    document.documentElement.setAttribute('data-motion', 'reduced')
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-motion')
  })

  const renderView = (overrides: Partial<React.ComponentProps<typeof AdminUserView>> = {}) =>
    render(
      <AdminUserView
        user={mockUser}
        onBack={mockOnBack}
        onDeleteUser={mockOnDeleteUser}
        onEndSessions={mockOnEndSessions}
        onChangePassword={mockOnChangePassword}
        onBanAccount={mockOnBanAccount}
        canBanAccount={true}
        isExecuting={false}
        fetchLastLogin={mockFetchLastLogin}
        hasLastLoginCommand={true}
        {...overrides}
      />
    )

  describe('status indicator', () => {
    it('shows Online with a dot when isOnline is true', () => {
      renderView({ user: { ...mockUser, isOnline: true } })
      expect(screen.getByText('Online')).toBeInTheDocument()
      expect(screen.queryByText('Manage user account')).not.toBeInTheDocument()
    })

    it('shows Offline with a dot when isOnline is false', () => {
      renderView({ user: { ...mockUser, isOnline: false } })
      expect(screen.getByText('Offline')).toBeInTheDocument()
      expect(screen.queryByText('Manage user account')).not.toBeInTheDocument()
    })

    it('falls back to the generic caption when isOnline is undefined', () => {
      renderView({ user: { ...mockUser, isOnline: undefined } })
      expect(screen.getByText('Manage user account')).toBeInTheDocument()
      expect(screen.queryByText('Online')).not.toBeInTheDocument()
      expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    })
  })

  describe('actions', () => {
    it('centers the whole view at the same width as the user/room lists, not left-aligned', () => {
      const { container } = renderView()
      expect(container.firstElementChild).toHaveClass('w-full', 'max-w-2xl', 'mx-auto')
    })

    it('renders all four action rows when canBanAccount is true', () => {
      renderView()
      expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /end sessions/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /ban account/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete user/i })).toBeInTheDocument()
    })

    it('omits the ban row when canBanAccount is false', () => {
      renderView({ canBanAccount: false })
      expect(screen.queryByText('Ban account')).not.toBeInTheDocument()
    })

    it('calls onChangePassword directly with the JID, no confirmation', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /change password/i }))
      expect(mockOnChangePassword).toHaveBeenCalledWith('testuser@example.com')
    })

    it('disables all action rows while isExecuting', () => {
      renderView({ isExecuting: true })
      expect(screen.getByRole('button', { name: /change password/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /end sessions/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /ban account/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /delete user/i })).toBeDisabled()
    })
  })

  describe('end sessions', () => {
    it('shows a confirmation dialog when clicked', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /end sessions/i }))
      expect(
        screen.getByText(
          'Are you sure you want to end all sessions for testuser@example.com? The user will be disconnected immediately.'
        )
      ).toBeInTheDocument()
    })

    it('calls onEndSessions with the JID when confirmed', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /end sessions/i }))
      const confirmButton = screen
        .getAllByRole('button')
        .find(btn => btn.textContent === 'End sessions' && btn.className.includes('bg-orange-500'))
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)
      expect(mockOnEndSessions).toHaveBeenCalledWith('testuser@example.com')
    })
  })

  describe('delete user', () => {
    it('shows a confirmation dialog when clicked', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /delete user/i }))
      expect(
        screen.getByText('Are you sure you want to delete testuser@example.com? This action cannot be undone.')
      ).toBeInTheDocument()
    })

    it('calls onDeleteUser with the JID when confirmed', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /delete user/i }))
      const confirmButton = screen
        .getAllByRole('button')
        .find(btn => btn.textContent === 'Delete user' && btn.className.includes('bg-red-500'))
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)
      expect(mockOnDeleteUser).toHaveBeenCalledWith('testuser@example.com')
    })
  })

  describe('ban account', () => {
    it('shows a confirmation dialog when clicked', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /ban account/i }))
      expect(
        screen.getByText(
          'Are you sure you want to ban testuser@example.com? This will disconnect the user and prevent them from logging in again.'
        )
      ).toBeInTheDocument()
    })

    it('calls onBanAccount with the JID when confirmed', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /ban account/i }))
      const confirmButton = screen
        .getAllByRole('button')
        .find(btn => btn.textContent === 'Ban Account' && btn.className.includes('bg-red-500'))
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)
      expect(mockOnBanAccount).toHaveBeenCalledWith('testuser@example.com')
    })

    it('closes the dialog on cancel without calling onBanAccount', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /ban account/i }))
      fireEvent.click(screen.getByText('Cancel'))
      expect(
        screen.queryByText(
          'Are you sure you want to ban testuser@example.com? This will disconnect the user and prevent them from logging in again.'
        )
      ).not.toBeInTheDocument()
      expect(mockOnBanAccount).not.toHaveBeenCalled()
    })
  })

  describe('last login', () => {
    it('does not fetch or render when hasLastLoginCommand is false', () => {
      renderView({ hasLastLoginCommand: false, user: { ...mockUser, isOnline: false } })
      expect(mockFetchLastLogin).not.toHaveBeenCalled()
      expect(screen.queryByText('Last login')).not.toBeInTheDocument()
    })

    it('does not fetch or render when the user is online', () => {
      renderView({ user: { ...mockUser, isOnline: true } })
      expect(mockFetchLastLogin).not.toHaveBeenCalled()
      expect(screen.queryByText('Last login')).not.toBeInTheDocument()
    })

    it('fetches and shows the raw value for an offline user', async () => {
      mockFetchLastLogin.mockResolvedValue('2026-06-30 11:45:28')
      renderView({ user: { ...mockUser, isOnline: false } })

      expect(mockFetchLastLogin).toHaveBeenCalledWith('testuser@example.com', 'en')
      await waitFor(() => {
        expect(screen.getByText('2026-06-30 11:45:28')).toBeInTheDocument()
      })
      expect(screen.getByText('Last login')).toBeInTheDocument()
    })

    it('fetches when isOnline is undefined (unknown)', async () => {
      mockFetchLastLogin.mockResolvedValue('En ligne')
      renderView({ user: { ...mockUser, isOnline: undefined } })

      await waitFor(() => {
        expect(screen.getByText('En ligne')).toBeInTheDocument()
      })
    })

    it('renders nothing once loaded when the value is unavailable', async () => {
      mockFetchLastLogin.mockResolvedValue(null)
      renderView({ user: { ...mockUser, isOnline: false } })

      await waitFor(() => {
        expect(mockFetchLastLogin).toHaveBeenCalled()
      })
      expect(screen.queryByText('Last login')).not.toBeInTheDocument()
    })
  })
})
