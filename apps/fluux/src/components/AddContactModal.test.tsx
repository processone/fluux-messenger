import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { AddContactModal } from './AddContactModal'

// Mock the SDK hooks
const mockAddContact = vi.fn()
vi.mock('@fluux/sdk', () => ({
  useRoster: () => ({
    addContact: mockAddContact,
  }),
}))

// Mock the useModalInput hook
vi.mock('@/hooks', () => ({
  useModalInput: () => vi.fn(),
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('AddContactModal', () => {
  const mockOnClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('should render modal with title and form fields', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      expect(screen.getByRole('heading', { name: 'contacts.addContact' })).toBeInTheDocument()
      expect(screen.getByLabelText('contacts.jidLabel')).toBeInTheDocument()
      expect(screen.getByLabelText(/contacts.nicknameLabel/)).toBeInTheDocument()
    })

    it('should have Cancel and Add Contact buttons', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      expect(screen.getByText('common.cancel')).toBeInTheDocument()
      // Submit button shows "contacts.addContact" when not sending
      expect(screen.getAllByText('contacts.addContact')).toHaveLength(2) // title + button
    })

    it('should show subscription note', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      expect(screen.getByText('contacts.subscriptionNote')).toBeInTheDocument()
    })

    it('should have submit button disabled when JID is empty', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      const submitButton = screen.getByRole('button', { name: 'contacts.addContact' })
      expect(submitButton).toBeDisabled()
    })
  })

  describe('validation', () => {
    it('should show error when JID is empty on submit', async () => {
      render(<AddContactModal onClose={mockOnClose} />)

      // Type something and then clear it to enable submit button check
      const jidInput = screen.getByLabelText(/contacts.jidLabel/)
      fireEvent.change(jidInput, { target: { value: 'test' } })
      fireEvent.change(jidInput, { target: { value: '' } })

      // Submit via form (button is disabled when empty, so submit directly)
      const form = jidInput.closest('form')!
      fireEvent.submit(form)

      await waitFor(() => {
        expect(screen.getByText('contacts.pleaseEnterJid')).toBeInTheDocument()
      })
      expect(mockAddContact).not.toHaveBeenCalled()
    })

    it('should show error when JID does not contain @', async () => {
      render(<AddContactModal onClose={mockOnClose} />)

      const jidInput = screen.getByLabelText(/contacts.jidLabel/)
      fireEvent.change(jidInput, { target: { value: 'invalidjid' } })

      const submitButton = screen.getByRole('button', { name: 'contacts.addContact' })
      fireEvent.click(submitButton)

      await waitFor(() => {
        expect(screen.getByText('contacts.invalidJidFormat')).toBeInTheDocument()
      })
      expect(mockAddContact).not.toHaveBeenCalled()
    })

    it('should accept valid JID with @', async () => {
      mockAddContact.mockResolvedValue(undefined)
      render(<AddContactModal onClose={mockOnClose} />)

      const jidInput = screen.getByLabelText(/contacts.jidLabel/)
      fireEvent.change(jidInput, { target: { value: 'user@example.com' } })

      const submitButton = screen.getByRole('button', { name: 'contacts.addContact' })
      fireEvent.click(submitButton)

      await waitFor(() => {
        expect(mockAddContact).toHaveBeenCalledWith('user@example.com', undefined)
      })
    })

    it('should trim whitespace from JID', async () => {
      mockAddContact.mockResolvedValue(undefined)
      render(<AddContactModal onClose={mockOnClose} />)

      const jidInput = screen.getByLabelText(/contacts.jidLabel/)
      fireEvent.change(jidInput, { target: { value: '  user@example.com  ' } })

      const submitButton = screen.getByRole('button', { name: 'contacts.addContact' })
      fireEvent.click(submitButton)

      await waitFor(() => {
        expect(mockAddContact).toHaveBeenCalledWith('user@example.com', undefined)
      })
    })
  })

  describe('form submission', () => {
    it('should call addContact with JID only when nickname is empty', async () => {
      mockAddContact.mockResolvedValue(undefined)
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'alice@example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(mockAddContact).toHaveBeenCalledWith('alice@example.com', undefined)
      })
    })

    it('should call addContact with JID and nickname when provided', async () => {
      mockAddContact.mockResolvedValue(undefined)
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'bob@example.com' } })
      fireEvent.change(screen.getByLabelText(/contacts.nicknameLabel/), { target: { value: 'Bobby' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(mockAddContact).toHaveBeenCalledWith('bob@example.com', 'Bobby')
      })
    })

    it('should trim whitespace from nickname', async () => {
      mockAddContact.mockResolvedValue(undefined)
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'user@example.com' } })
      fireEvent.change(screen.getByLabelText(/contacts.nicknameLabel/), { target: { value: '  My Friend  ' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(mockAddContact).toHaveBeenCalledWith('user@example.com', 'My Friend')
      })
    })

    it('should call onClose after successful submission', async () => {
      mockAddContact.mockResolvedValue(undefined)
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'user@example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled()
      })
    })

    it('should show loading state while submitting', async () => {
      let resolveSubmit: (value?: unknown) => void
      mockAddContact.mockImplementation(() => new Promise((resolve) => { resolveSubmit = resolve }))
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'user@example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(screen.getByText('contacts.sending')).toBeInTheDocument()
      })

      // Resolve the promise and wait for state updates to complete
      await act(async () => {
        resolveSubmit!()
      })
    })

    it('should disable inputs while submitting', async () => {
      let resolveSubmit: (value?: unknown) => void
      mockAddContact.mockImplementation(() => new Promise((resolve) => { resolveSubmit = resolve }))
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'user@example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(screen.getByLabelText(/contacts.jidLabel/)).toBeDisabled()
        expect(screen.getByLabelText(/contacts.nicknameLabel/)).toBeDisabled()
      })

      // Resolve the promise and wait for state updates to complete
      await act(async () => {
        resolveSubmit!()
      })
    })

    it('should display error message on submission failure', async () => {
      mockAddContact.mockRejectedValue(new Error('Contact already exists'))
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'user@example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(screen.getByText('Contact already exists')).toBeInTheDocument()
      })
      expect(mockOnClose).not.toHaveBeenCalled()
    })

    it('should display generic error message when error is not an Error instance', async () => {
      mockAddContact.mockRejectedValue('Unknown error')
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText(/contacts.jidLabel/), { target: { value: 'user@example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'contacts.addContact' }))

      await waitFor(() => {
        expect(screen.getByText('contacts.failedToSendRequest')).toBeInTheDocument()
      })
    })
  })

  describe('modal closing', () => {
    it('should call onClose when Cancel button is clicked', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.click(screen.getByText('common.cancel'))

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should call onClose when close button (X) is clicked', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      const closeButton = screen.getByLabelText('common.close')
      fireEvent.click(closeButton)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should call onClose when clicking outside the modal (backdrop)', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      // The backdrop is the outermost div with the click handler
      const backdrop = screen.getByRole('heading', { name: 'contacts.addContact' }).closest('.fixed')!
      fireEvent.mouseDown(backdrop)
      fireEvent.click(backdrop)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should not call onClose when clicking inside the modal', () => {
      render(<AddContactModal onClose={mockOnClose} />)

      fireEvent.click(screen.getByText('contacts.subscriptionNote'))

      expect(mockOnClose).not.toHaveBeenCalled()
    })
  })
})
