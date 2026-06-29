import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AdminRoomView } from './AdminRoomView'
import type { AdminRoom } from '@fluux/sdk'

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'common.close': 'Close',
        'admin.roomView.options': 'Room Options',
        'admin.roomView.noOptions': 'No options available',
        'admin.roomView.actions': 'Actions',
        'admin.roomView.destroy': 'Destroy Room',
        'admin.roomView.confirmDestroy': 'Destroy Room',
        'admin.roomView.confirmDestroyMessage': `Are you sure you want to destroy "${params?.room}"?`,
        'common.cancel': 'Cancel',
      }
      return translations[key] || key
    },
  }),
}))

describe('AdminRoomView', () => {
  const mockRoom: AdminRoom = {
    jid: 'testroom@conference.example.com',
    name: 'Test Room',
  }

  const mockOnBack = vi.fn()
  const mockOnDestroyRoom = vi.fn()
  const mockGetRoomOptions = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('should render room name and JID', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      expect(screen.getByText('Test Room')).toBeInTheDocument()
      expect(screen.getByText('testroom@conference.example.com')).toBeInTheDocument()
    })

    it('should render back button', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      const backButton = screen.getByLabelText('Close')
      expect(backButton).toBeInTheDocument()
    })

    it('should render destroy room button', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      expect(screen.getByText('Destroy Room')).toBeInTheDocument()
    })

    it('should not render room options section when command not available', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      expect(screen.queryByText('Room Options')).not.toBeInTheDocument()
    })

    it('should render room options section when command is available', async () => {
      mockGetRoomOptions.mockResolvedValue({
        type: 'result',
        fields: [
          { var: 'public', type: 'boolean', value: 'true' },
          { var: 'persistent', type: 'boolean', value: 'true' },
        ],
      })

      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={true}
        />
      )

      expect(screen.getByText('Room Options')).toBeInTheDocument()

      // Wait for async state update to complete to avoid act() warning
      await waitFor(() => {
        expect(mockGetRoomOptions).toHaveBeenCalled()
      })
    })
  })

  describe('back button', () => {
    it('should call onBack when clicked', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      fireEvent.click(screen.getByLabelText('Close'))
      expect(mockOnBack).toHaveBeenCalledTimes(1)
    })
  })

  describe('destroy room', () => {
    beforeEach(() => {
      document.documentElement.setAttribute('data-motion', 'reduced')
    })
    afterEach(() => {
      document.documentElement.removeAttribute('data-motion')
    })

    it('should show confirmation dialog when destroy button clicked', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      fireEvent.click(screen.getByText('Destroy Room'))

      // Confirmation dialog should appear
      expect(screen.getByText('Are you sure you want to destroy "Test Room"?')).toBeInTheDocument()
      expect(screen.getByText('Cancel')).toBeInTheDocument()
    })

    it('should call onDestroyRoom when confirmed', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      // Open confirmation
      fireEvent.click(screen.getByText('Destroy Room'))

      // Find and click the confirm button in the dialog
      // The dialog button has bg-red-500 class (solid red), the main one has bg-red-500/10 (light red)
      const allButtons = screen.getAllByRole('button')
      const confirmButton = allButtons.find(btn =>
        btn.textContent === 'Destroy Room' &&
        btn.className.includes('bg-red-500 ')
      )
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)

      expect(mockOnDestroyRoom).toHaveBeenCalledWith('testroom@conference.example.com')
    })

    it('should close confirmation dialog when cancel clicked', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      // Open confirmation
      fireEvent.click(screen.getByText('Destroy Room'))
      expect(screen.getByText('Are you sure you want to destroy "Test Room"?')).toBeInTheDocument()

      // Cancel
      fireEvent.click(screen.getByText('Cancel'))

      // Dialog should be closed
      expect(screen.queryByText('Are you sure you want to destroy "Test Room"?')).not.toBeInTheDocument()
    })

    it('should disable destroy button when isExecuting is true', () => {
      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={true}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={false}
        />
      )

      // Find the button element (parent of the text span)
      const destroyButton = screen.getByText('Destroy Room').closest('button')
      expect(destroyButton).toBeDisabled()
    })
  })

  describe('room options loading', () => {
    it('should show loading state while fetching options', async () => {
      // Never resolve to keep loading state
      mockGetRoomOptions.mockImplementation(() => new Promise(() => {}))

      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={true}
        />
      )

      // Loading spinner should be visible (Loader2 icon has animate-spin class)
      const optionsSection = screen.getByText('Room Options').closest('div')
      expect(optionsSection).toBeInTheDocument()
    })

    it('should display room options after loading', async () => {
      mockGetRoomOptions.mockResolvedValue({
        type: 'result',
        fields: [
          { var: 'public', type: 'boolean', value: 'true' },
          { var: 'persistent', type: 'boolean', value: 'false' },
          { var: 'title', type: 'text-single', value: 'My Room Title' },
        ],
      })

      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Public')).toBeInTheDocument()
      })

      expect(screen.getByText('Yes')).toBeInTheDocument() // 'true' -> 'Yes'
      expect(screen.getByText('Persistent')).toBeInTheDocument()
      expect(screen.getByText('No')).toBeInTheDocument() // 'false' -> 'No'
      expect(screen.getByText('Title')).toBeInTheDocument()
      expect(screen.getByText('My Room Title')).toBeInTheDocument()
    })

    it('should show error message when loading fails', async () => {
      mockGetRoomOptions.mockRejectedValue(new Error('Failed to fetch'))

      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
      })
    })

    it('should show no options message when result is empty', async () => {
      mockGetRoomOptions.mockResolvedValue({
        type: 'result',
        fields: [],
      })

      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('No options available')).toBeInTheDocument()
      })
    })

    it('should format multi-value options as comma-separated list', async () => {
      mockGetRoomOptions.mockResolvedValue({
        type: 'result',
        fields: [
          { var: 'admins', type: 'jid-multi', value: ['admin1@example.com', 'admin2@example.com'] },
        ],
      })

      render(
        <AdminRoomView
          room={mockRoom}
          onBack={mockOnBack}
          onDestroyRoom={mockOnDestroyRoom}
          isExecuting={false}
          getRoomOptions={mockGetRoomOptions}
          hasGetRoomOptionsCommand={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Admins')).toBeInTheDocument()
      })

      expect(screen.getByText('admin1@example.com, admin2@example.com')).toBeInTheDocument()
    })
  })
})
