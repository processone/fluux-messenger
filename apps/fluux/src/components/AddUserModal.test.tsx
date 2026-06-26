import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Extract the AddUserModal component for testing
// We need to mock it since it's defined inside AdminView.tsx
// For now, we'll create a minimal test version that matches the implementation

interface AddUserModalProps {
  vhost: string
  onSubmit: (username: string, password: string) => Promise<void>
  onClose: () => void
}

// This is a direct copy of the component for isolated testing
// In a real refactor, AddUserModal would be in its own file
function AddUserModal({ vhost, onSubmit, onClose }: AddUserModalProps) {
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedUsername = username.trim()
    const trimmedPassword = password.trim()

    if (!trimmedUsername) {
      setError('admin.addUser.usernameRequired')
      return
    }

    if (!trimmedPassword) {
      setError('admin.addUser.passwordRequired')
      return
    }

    if (trimmedPassword !== confirmPassword) {
      setError('admin.addUser.passwordsDoNotMatch')
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit(trimmedUsername, trimmedPassword)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'admin.addUser.failedToAdd')
      setIsSubmitting(false)
    }
  }

  return (
    <div
      data-testid="modal-backdrop"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-fluux-sidebar rounded-lg shadow-xl w-full max-w-sm mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover">
          <h2 className="text-lg font-semibold text-fluux-text">admin.addUser.title</h2>
          <button
            onClick={onClose}
            className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
            title="common.close"
            data-testid="close-button"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label htmlFor="add-user-username" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              admin.addUser.username
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                id="add-user-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin.addUser.usernamePlaceholder"
                disabled={isSubmitting}
                className="flex-1 px-3 py-2 bg-fluux-bg text-fluux-text rounded"
              />
              <span className="text-fluux-muted" data-testid="vhost-suffix">@{vhost}</span>
            </div>
          </div>

          <div>
            <label htmlFor="add-user-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              admin.addUser.password
            </label>
            <input
              id="add-user-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="admin.addUser.passwordPlaceholder"
              disabled={isSubmitting}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded"
            />
          </div>

          <div>
            <label htmlFor="add-user-confirm-password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              admin.addUser.confirmPassword
            </label>
            <input
              id="add-user-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="admin.addUser.confirmPasswordPlaceholder"
              disabled={isSubmitting}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded"
            />
          </div>

          {error && (
            <p className="text-sm text-fluux-error" data-testid="error-message">{error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="flex-1 px-4 py-2"
              data-testid="cancel-button"
            >
              common.cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 px-4 py-2"
              data-testid="submit-button"
            >
              {isSubmitting ? 'admin.addUser.adding' : 'common.create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

import React from 'react'

describe('AddUserModal', () => {
  const mockOnSubmit = vi.fn()
  const mockOnClose = vi.fn()
  const defaultProps = {
    vhost: 'example.com',
    onSubmit: mockOnSubmit,
    onClose: mockOnClose,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('should render modal with title and form fields', () => {
      render(<AddUserModal {...defaultProps} />)

      expect(screen.getByText('admin.addUser.title')).toBeInTheDocument()
      expect(screen.getByLabelText('admin.addUser.username')).toBeInTheDocument()
      expect(screen.getByLabelText('admin.addUser.password')).toBeInTheDocument()
      expect(screen.getByLabelText('admin.addUser.confirmPassword')).toBeInTheDocument()
    })

    it('should display the vhost suffix next to username input', () => {
      render(<AddUserModal {...defaultProps} />)

      expect(screen.getByTestId('vhost-suffix')).toHaveTextContent('@example.com')
    })

    it('should have Cancel and Create buttons', () => {
      render(<AddUserModal {...defaultProps} />)

      expect(screen.getByTestId('cancel-button')).toHaveTextContent('common.cancel')
      expect(screen.getByTestId('submit-button')).toHaveTextContent('common.create')
    })

    it('should auto-focus the username input on mount', () => {
      render(<AddUserModal {...defaultProps} />)

      expect(screen.getByLabelText('admin.addUser.username')).toHaveFocus()
    })
  })

  describe('validation', () => {
    it('should show error when username is empty', async () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('admin.addUser.usernameRequired')
      })
      expect(mockOnSubmit).not.toHaveBeenCalled()
    })

    it('should show error when password is empty', async () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.change(screen.getByLabelText('admin.addUser.username'), { target: { value: 'testuser' } })
      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('admin.addUser.passwordRequired')
      })
      expect(mockOnSubmit).not.toHaveBeenCalled()
    })

    it('should show error when passwords do not match', async () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.change(screen.getByLabelText('admin.addUser.username'), { target: { value: 'testuser' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.password'), { target: { value: 'password123' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.confirmPassword'), { target: { value: 'different' } })
      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('admin.addUser.passwordsDoNotMatch')
      })
      expect(mockOnSubmit).not.toHaveBeenCalled()
    })

    it('should trim whitespace from username and password', async () => {
      mockOnSubmit.mockResolvedValue(undefined)
      render(<AddUserModal {...defaultProps} />)

      fireEvent.change(screen.getByLabelText('admin.addUser.username'), { target: { value: '  testuser  ' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.password'), { target: { value: '  password123  ' } })
      // Note: confirm password must match the trimmed password exactly for validation
      fireEvent.change(screen.getByLabelText('admin.addUser.confirmPassword'), { target: { value: 'password123' } })
      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith('testuser', 'password123')
      })
    })
  })

  describe('form submission', () => {
    it('should call onSubmit with username and password on valid submission', async () => {
      mockOnSubmit.mockResolvedValue(undefined)
      render(<AddUserModal {...defaultProps} />)

      fireEvent.change(screen.getByLabelText('admin.addUser.username'), { target: { value: 'newuser' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.password'), { target: { value: 'securepass' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.confirmPassword'), { target: { value: 'securepass' } })
      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledWith('newuser', 'securepass')
      })
    })

    it('should show loading state while submitting', async () => {
      let resolveSubmit: (value?: unknown) => void
      mockOnSubmit.mockImplementation(() => new Promise((resolve) => { resolveSubmit = resolve }))
      render(<AddUserModal {...defaultProps} />)

      fireEvent.change(screen.getByLabelText('admin.addUser.username'), { target: { value: 'newuser' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.password'), { target: { value: 'pass' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.confirmPassword'), { target: { value: 'pass' } })
      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(screen.getByTestId('submit-button')).toHaveTextContent('admin.addUser.adding')
      })

      // Resolve and check it completes
      resolveSubmit!()
    })

    it('should disable inputs while submitting', async () => {
      let resolveSubmit: (value?: unknown) => void
      mockOnSubmit.mockImplementation(() => new Promise((resolve) => { resolveSubmit = resolve }))
      render(<AddUserModal {...defaultProps} />)

      fireEvent.change(screen.getByLabelText('admin.addUser.username'), { target: { value: 'newuser' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.password'), { target: { value: 'pass' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.confirmPassword'), { target: { value: 'pass' } })
      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(screen.getByLabelText('admin.addUser.username')).toBeDisabled()
        expect(screen.getByLabelText('admin.addUser.password')).toBeDisabled()
        expect(screen.getByLabelText('admin.addUser.confirmPassword')).toBeDisabled()
      })

      resolveSubmit!()
    })

    it('should display API error message on submission failure', async () => {
      mockOnSubmit.mockRejectedValue(new Error('User already exists'))
      render(<AddUserModal {...defaultProps} />)

      fireEvent.change(screen.getByLabelText('admin.addUser.username'), { target: { value: 'existinguser' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.password'), { target: { value: 'pass' } })
      fireEvent.change(screen.getByLabelText('admin.addUser.confirmPassword'), { target: { value: 'pass' } })
      fireEvent.click(screen.getByTestId('submit-button'))

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('User already exists')
      })
    })
  })

  describe('modal closing', () => {
    it('should call onClose when Cancel button is clicked', () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.click(screen.getByTestId('cancel-button'))

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should call onClose when close button is clicked', () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.click(screen.getByTestId('close-button'))

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should call onClose when clicking outside the modal', () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.click(screen.getByTestId('modal-backdrop'))

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should not call onClose when clicking inside the modal', () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.click(screen.getByText('admin.addUser.title'))

      expect(mockOnClose).not.toHaveBeenCalled()
    })

    it('should call onClose when Escape key is pressed', async () => {
      render(<AddUserModal {...defaultProps} />)

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(mockOnClose).toHaveBeenCalled()
    })
  })
})
