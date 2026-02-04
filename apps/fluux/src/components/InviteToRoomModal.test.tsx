import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { InviteToRoomModal } from './InviteToRoomModal'
import { useToastStore } from '@/stores/toastStore'
import type { Room, RoomOccupant } from '@fluux/sdk'

// Mock inviteMultipleToRoom function
const mockInviteMultipleToRoom = vi.fn()

// Track ContactSelector props for testing
let capturedExcludeJids: string[] = []

// Mock ContactSelector component
vi.mock('./ContactSelector', () => ({
  ContactSelector: ({
    selectedContacts,
    onSelectionChange,
    placeholder,
    excludeJids,
  }: {
    selectedContacts: string[]
    onSelectionChange: (selected: string[]) => void
    placeholder?: string
    excludeJids?: string[]
    disabled?: boolean
  }) => {
    // Capture props for assertions
    capturedExcludeJids = excludeJids || []

    return (
      <div data-testid="contact-selector">
        <input
          data-testid="contact-input"
          placeholder={placeholder}
          onChange={() => {}}
        />
        <div data-testid="selected-count">{selectedContacts.length} selected</div>
        {/* Buttons to simulate selection for testing */}
        <button
          data-testid="select-alice"
          onClick={() => onSelectionChange([...selectedContacts, 'alice@example.com'])}
        >
          Select Alice
        </button>
        <button
          data-testid="select-bob"
          onClick={() => onSelectionChange([...selectedContacts, 'bob@example.com'])}
        >
          Select Bob
        </button>
        <button
          data-testid="clear-selection"
          onClick={() => onSelectionChange([])}
        >
          Clear
        </button>
      </div>
    )
  },
}))

// Mock SDK hooks
vi.mock('@fluux/sdk', () => ({
  useRoom: () => ({
    inviteMultipleToRoom: mockInviteMultipleToRoom,
  }),
  // JID utilities used by ContactSelector
  matchNameOrJid: (name: string, jid: string, query: string) => {
    const lowerQuery = query.toLowerCase()
    const nameMatch = name.toLowerCase().includes(lowerQuery)
    const usernameMatch = jid.split('@')[0].toLowerCase().includes(lowerQuery)
    return nameMatch || usernameMatch
  },
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'rooms.inviteToRoom': 'Invite to Room',
        'rooms.invitingTo': `Invite contacts to ${params?.room || 'room'}`,
        'rooms.selectContacts': 'Select contacts',
        'rooms.searchContactsToInvite': 'Search contacts to invite...',
        'rooms.inviteReason': 'Reason (optional)',
        'rooms.inviteReasonPlaceholder': 'Why are you inviting them?',
        'rooms.inviteError': 'Failed to send invitations',
        'rooms.invitationsSent': 'Invitation(s) sent',
        'rooms.inviteRejected': `Invitation rejected: ${params?.error || ''}`,
        'rooms.sendInvitations': `Send ${params?.count || 0} invitation(s)`,
        'common.cancel': 'Cancel',
        'contacts.searchContacts': 'Search contacts...',
        'contacts.addMoreContacts': 'Add more contacts...',
        'contacts.keyboardHint': 'Tab/↑↓ to navigate, Enter to select',
        'contacts.noContactsFound': 'No contacts found',
      }
      return translations[key] || key
    },
  }),
}))

// Create a mock room
function createMockRoom(overrides?: Partial<Room>): Room {
  const occupants = new Map<string, RoomOccupant>()
  occupants.set('existing-user', {
    nick: 'existing-user',
    jid: 'existing@example.com',
    affiliation: 'member',
    role: 'participant',
  })

  return {
    jid: 'testroom@conference.example.com',
    name: 'Test Room',
    nickname: 'testuser',
    joined: true,
    occupants,
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    ...overrides,
  } as Room
}

describe('InviteToRoomModal', () => {
  const mockOnClose = vi.fn()
  let mockRoom: Room

  beforeEach(() => {
    vi.resetAllMocks()
    mockRoom = createMockRoom()
    useToastStore.setState({ toasts: [] })
  })

  describe('rendering', () => {
    it('should not render when closed', () => {
      render(
        <InviteToRoomModal
          isOpen={false}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      expect(screen.queryByText('Invite to Room')).not.toBeInTheDocument()
    })

    it('should render modal when open', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      expect(screen.getByText('Invite to Room')).toBeInTheDocument()
    })

    it('should show room name in invitation message', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      expect(screen.getByText('Invite contacts to Test Room')).toBeInTheDocument()
    })

    it('should show room JID if no name is set', () => {
      const roomWithoutName = createMockRoom({ name: undefined })
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={roomWithoutName}
        />
      )

      expect(screen.getByText('Invite contacts to testroom@conference.example.com')).toBeInTheDocument()
    })

    it('should show contact selector', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      expect(screen.getByText('Select contacts')).toBeInTheDocument()
      expect(screen.getByTestId('contact-selector')).toBeInTheDocument()
    })

    it('should show reason input field', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      expect(screen.getByText('Reason (optional)')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Why are you inviting them?')).toBeInTheDocument()
    })

    it('should show Cancel and Send buttons', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      expect(screen.getByText('Cancel')).toBeInTheDocument()
      expect(screen.getByText('Send 0 invitation(s)')).toBeInTheDocument()
    })
  })

  describe('close behavior', () => {
    it('should call onClose when close button is clicked', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Find the close button (X icon button in header)
      const closeButtons = screen.getAllByRole('button')
      const closeButton = closeButtons.find(btn => btn.querySelector('svg.lucide-x'))
      fireEvent.click(closeButton!)

      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })

    it('should call onClose when Cancel button is clicked', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      fireEvent.click(screen.getByText('Cancel'))

      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })

    it('should call onClose when clicking backdrop', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Click on the backdrop (the outer div)
      const backdrop = screen.getByText('Invite to Room').closest('.fixed')
      fireEvent.click(backdrop!)

      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })

    it('should call onClose when Escape key is pressed', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })

    it('should not call onClose on Escape when modal is closed', () => {
      render(
        <InviteToRoomModal
          isOpen={false}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(mockOnClose).not.toHaveBeenCalled()
    })
  })

  describe('send button state', () => {
    it('should disable send button when no contacts are selected', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      const sendButton = screen.getByText('Send 0 invitation(s)').closest('button')
      expect(sendButton).toBeDisabled()
    })

    it('should enable send button when contacts are selected', async () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Select a contact using mock button
      fireEvent.click(screen.getByTestId('select-alice'))

      // Button should now show count and be enabled
      await waitFor(() => {
        const sendButton = screen.getByText('Send 1 invitation(s)').closest('button')
        expect(sendButton).not.toBeDisabled()
      })
    })
  })

  describe('reason input', () => {
    it('should allow typing a reason', () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      const reasonInput = screen.getByPlaceholderText('Why are you inviting them?')
      fireEvent.change(reasonInput, { target: { value: 'Join our discussion!' } })

      expect(reasonInput).toHaveValue('Join our discussion!')
    })
  })

  describe('invitation flow (fire-and-forget)', () => {
    it('should call inviteMultipleToRoom and close immediately', async () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Select a contact
      fireEvent.click(screen.getByTestId('select-alice'))

      // Click send button
      await waitFor(() => {
        const sendButton = screen.getByText('Send 1 invitation(s)').closest('button')
        expect(sendButton).not.toBeDisabled()
      })
      fireEvent.click(screen.getByText('Send 1 invitation(s)'))

      // Should call inviteMultipleToRoom
      expect(mockInviteMultipleToRoom).toHaveBeenCalledWith(
        'testroom@conference.example.com',
        ['alice@example.com'],
        undefined
      )

      // Should close immediately (no waiting)
      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should show success toast on send', async () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Select a contact
      fireEvent.click(screen.getByTestId('select-alice'))

      await waitFor(() => {
        const sendButton = screen.getByText('Send 1 invitation(s)').closest('button')
        expect(sendButton).not.toBeDisabled()
      })
      fireEvent.click(screen.getByText('Send 1 invitation(s)'))

      // Should add a success toast
      const toasts = useToastStore.getState().toasts
      expect(toasts).toHaveLength(1)
      expect(toasts[0].type).toBe('success')
      expect(toasts[0].message).toBe('Invitation(s) sent')
    })

    it('should include reason when provided', async () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Select a contact using mock button
      fireEvent.click(screen.getByTestId('select-alice'))

      // Enter reason
      const reasonInput = screen.getByPlaceholderText('Why are you inviting them?')
      fireEvent.change(reasonInput, { target: { value: 'Please join!' } })

      // Click send button
      await waitFor(() => {
        const sendButton = screen.getByText('Send 1 invitation(s)').closest('button')
        expect(sendButton).not.toBeDisabled()
      })
      fireEvent.click(screen.getByText('Send 1 invitation(s)'))

      expect(mockInviteMultipleToRoom).toHaveBeenCalledWith(
        'testroom@conference.example.com',
        ['alice@example.com'],
        'Please join!'
      )
    })

    it('should show error toast on synchronous failure', async () => {
      // Suppress expected console.error
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      mockInviteMultipleToRoom.mockImplementation(() => {
        throw new Error('Not connected')
      })

      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Select a contact
      fireEvent.click(screen.getByTestId('select-alice'))

      await waitFor(() => {
        const sendButton = screen.getByText('Send 1 invitation(s)').closest('button')
        expect(sendButton).not.toBeDisabled()
      })
      fireEvent.click(screen.getByText('Send 1 invitation(s)'))

      // Should add an error toast
      const toasts = useToastStore.getState().toasts
      expect(toasts).toHaveLength(1)
      expect(toasts[0].type).toBe('error')
      expect(toasts[0].message).toBe('Failed to send invitations')

      consoleError.mockRestore()
    })
  })

  describe('state reset', () => {
    it('should reset state when modal reopens', async () => {
      const { rerender } = render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Select a contact and enter reason
      fireEvent.click(screen.getByTestId('select-alice'))

      const reasonInput = screen.getByPlaceholderText('Why are you inviting them?')
      fireEvent.change(reasonInput, { target: { value: 'Test reason' } })

      // Verify state is set
      await waitFor(() => {
        expect(screen.getByText('Send 1 invitation(s)')).toBeInTheDocument()
      })
      expect(reasonInput).toHaveValue('Test reason')

      // Close modal
      rerender(
        <InviteToRoomModal
          isOpen={false}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Reopen modal
      rerender(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // State should be reset
      expect(screen.getByPlaceholderText('Why are you inviting them?')).toHaveValue('')
      expect(screen.getByText('Send 0 invitation(s)')).toBeInTheDocument()
    })
  })

  describe('occupant filtering', () => {
    it('should pass occupant JIDs to ContactSelector as excludeJids', () => {
      // Add more occupants to the room
      const roomWithOccupants = createMockRoom()
      roomWithOccupants.occupants.set('alice', {
        nick: 'alice',
        jid: 'alice@example.com',
        affiliation: 'member',
        role: 'participant',
      })

      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={roomWithOccupants}
        />
      )

      // Check that occupant JIDs are passed to ContactSelector
      expect(capturedExcludeJids).toContain('alice@example.com')
      expect(capturedExcludeJids).toContain('existing@example.com')
    })

    it('should filter out occupants without JIDs', () => {
      const roomWithAnonymousOccupant = createMockRoom()
      roomWithAnonymousOccupant.occupants.set('anonymous', {
        nick: 'anonymous',
        // No jid field - anonymous room
        affiliation: 'none',
        role: 'participant',
      })

      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={roomWithAnonymousOccupant}
        />
      )

      // Only existing@example.com should be in excludeJids, not undefined
      expect(capturedExcludeJids).toContain('existing@example.com')
      expect(capturedExcludeJids).not.toContain(undefined)
      expect(capturedExcludeJids.length).toBe(1)
    })
  })

  describe('multiple contact selection', () => {
    it('should allow selecting multiple contacts', async () => {
      render(
        <InviteToRoomModal
          isOpen={true}
          onClose={mockOnClose}
          room={mockRoom}
        />
      )

      // Select first contact
      fireEvent.click(screen.getByTestId('select-alice'))

      // Select second contact
      fireEvent.click(screen.getByTestId('select-bob'))

      // Button should show count of 2
      await waitFor(() => {
        expect(screen.getByText('Send 2 invitation(s)')).toBeInTheDocument()
      })

      // Send invitations
      fireEvent.click(screen.getByText('Send 2 invitation(s)'))

      expect(mockInviteMultipleToRoom).toHaveBeenCalledWith(
        'testroom@conference.example.com',
        expect.arrayContaining(['alice@example.com', 'bob@example.com']),
        undefined
      )
    })
  })
})
