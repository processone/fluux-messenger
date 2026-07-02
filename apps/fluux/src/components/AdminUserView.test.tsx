import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AdminUserView } from './AdminUserView'
import type { AdminUser } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'common.close': 'Close',
        'admin.userView.manageUser': 'Manage user account',
        'admin.userView.actions': 'Actions',
        'admin.users.changePassword': 'Change password',
        'admin.users.endSessions': 'End sessions',
        'admin.users.delete': 'Delete user',
        'admin.users.banAccount': 'Ban account',
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

  beforeEach(() => {
    vi.clearAllMocks()
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
        {...overrides}
      />
    )

  describe('ban account', () => {
    it('does not render the ban action when the command is not available', () => {
      renderView({ canBanAccount: false })
      expect(screen.queryByText('Ban account')).not.toBeInTheDocument()
    })

    it('renders the ban action when the command is available', () => {
      renderView()
      expect(screen.getByText('Ban account')).toBeInTheDocument()
    })

    it('shows a confirmation dialog when clicked', () => {
      renderView()
      fireEvent.click(screen.getByText('Ban account'))
      expect(
        screen.getByText(
          'Are you sure you want to ban testuser@example.com? This will disconnect the user and prevent them from logging in again.'
        )
      ).toBeInTheDocument()
    })

    it('calls onBanAccount with the JID when confirmed', () => {
      renderView()
      fireEvent.click(screen.getByText('Ban account'))

      const allButtons = screen.getAllByRole('button')
      const confirmButton = allButtons.find(
        btn => btn.textContent === 'Ban Account' && btn.className.includes('bg-red-500 ')
      )
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)

      expect(mockOnBanAccount).toHaveBeenCalledWith('testuser@example.com')
    })

    it('closes the dialog on cancel without calling onBanAccount', () => {
      renderView()
      fireEvent.click(screen.getByText('Ban account'))
      fireEvent.click(screen.getByText('Cancel'))

      expect(
        screen.queryByText(
          'Are you sure you want to ban testuser@example.com? This will disconnect the user and prevent them from logging in again.'
        )
      ).not.toBeInTheDocument()
      expect(mockOnBanAccount).not.toHaveBeenCalled()
    })

    it('disables the ban button while isExecuting', () => {
      renderView({ isExecuting: true })
      const banButton = screen.getByText('Ban account').closest('button')
      expect(banButton).toBeDisabled()
    })
  })
})
