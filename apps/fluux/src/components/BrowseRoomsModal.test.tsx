import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { BrowseRoomsModal } from './BrowseRoomsModal'

// Mock the SDK hooks
const mockBrowsePublicRooms = vi.fn()
const mockJoinRoom = vi.fn()
const mockSetActiveRoom = vi.fn()
const mockSetActiveConversation = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useConnection: () => ({
    jid: 'testuser@example.com',
  }),
  useRoom: () => ({
    browsePublicRooms: mockBrowsePublicRooms,
    joinRoom: mockJoinRoom,
    getRoom: () => undefined,
    setActiveRoom: mockSetActiveRoom,
    mucServiceJid: 'conference.example.com',
  }),
  WELL_KNOWN_MUC_SERVERS: ['conference.process-one.net', 'muc.xmpp.org'],
  getLocalPart: (jid: string) => jid.split('@')[0],
  generateConsistentColorHexSync: () => '#5588aa',
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  // useChatStore is callable (hook-style) for selector subscriptions
  useChatStore: (selector: (state: { setActiveConversation: typeof mockSetActiveConversation }) => unknown) =>
    selector({ setActiveConversation: mockSetActiveConversation }),
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
}))

// Mock hooks
vi.mock('@/hooks', () => ({
  useModalInput: () => ({ current: null }),
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    setSelectedIndex: vi.fn(),
    getItemProps: () => ({ 'data-selected': false, onMouseEnter: vi.fn() }),
    getItemAttribute: () => ({}),
  }),
}))

describe('BrowseRoomsModal', () => {
  const mockOnClose = vi.fn()

  const sampleRooms = [
    { jid: 'general@conference.example.com', name: 'General Chat', occupants: 10 },
    { jid: 'developers@conference.example.com', name: 'Developers', occupants: 5 },
    { jid: 'random@conference.example.com', name: 'Random Talk', occupants: 3 },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockBrowsePublicRooms.mockResolvedValue({ rooms: sampleRooms, pagination: {} })
  })

  describe('rendering', () => {
    it('should render modal with title', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      // Wait for async state updates to complete
      await act(async () => {})

      expect(screen.getByText('rooms.browseRoomsTitle')).toBeInTheDocument()
    })

    it('should render MUC service selector', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      expect(screen.getByText('rooms.mucService')).toBeInTheDocument()
      expect(screen.getByRole('combobox')).toBeInTheDocument()
    })

    it('should render nickname input with default value from user JID', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      const nicknameInput = screen.getByPlaceholderText('rooms.nicknamePlaceholder')
      expect(nicknameInput).toBeInTheDocument()
      expect(nicknameInput).toHaveValue('testuser')
    })

    it('should prefer PEP nickname over JID local part when available', async () => {
      // Override mock to include ownNickname
      const sdkModule = await import('@fluux/sdk')
      const originalUseConnection = sdkModule.useConnection
      vi.mocked(sdkModule).useConnection = () => ({
        ...originalUseConnection(),
        jid: 'testuser@example.com',
        ownNickname: 'My Display Name',
      })

      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      const nicknameInput = screen.getByPlaceholderText('rooms.nicknamePlaceholder')
      expect(nicknameInput).toHaveValue('My Display Name')

      // Restore original mock
      vi.mocked(sdkModule).useConnection = originalUseConnection
    })

    it('should render search input', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      expect(screen.getByPlaceholderText('rooms.searchRooms')).toBeInTheDocument()
    })

    it('should call onClose when close button is clicked', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      const closeButton = screen.getByLabelText('common.close')
      fireEvent.click(closeButton)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should call onClose when clicking backdrop', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      // Click the backdrop (the outermost div)
      const backdrop = screen.getByText('rooms.browseRoomsTitle').closest('.fixed')!
      fireEvent.click(backdrop)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should show loading spinner while fetching rooms', async () => {
      // Make browsePublicRooms hang indefinitely
      mockBrowsePublicRooms.mockImplementation(() => new Promise(() => {}))

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      // Look for the spinner (Loader2 component renders an SVG with animate-spin class)
      const spinner = document.querySelector('.animate-spin')
      expect(spinner).toBeInTheDocument()
    })

    it('should display rooms after loading', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
        expect(screen.getByText('Developers')).toBeInTheDocument()
        expect(screen.getByText('Random Talk')).toBeInTheDocument()
      })
    })

    it('should display room JID and occupant count', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText(/general@conference\.example\.com/)).toBeInTheDocument()
        expect(screen.getByText(/10 rooms\.occupants/)).toBeInTheDocument()
      })
    })

    it('should show empty state when no rooms available', async () => {
      mockBrowsePublicRooms.mockResolvedValue({ rooms: [], pagination: {} })

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('rooms.noPublicRooms')).toBeInTheDocument()
      })
    })

    it('should show footer with room count', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('rooms.browseRoomsHint')).toBeInTheDocument()
      })
    })
  })

  describe('room filtering', () => {
    it('should filter rooms by name', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('rooms.searchRooms')
      fireEvent.change(searchInput, { target: { value: 'developer' } })

      expect(screen.getByText('Developers')).toBeInTheDocument()
      expect(screen.queryByText('General Chat')).not.toBeInTheDocument()
      expect(screen.queryByText('Random Talk')).not.toBeInTheDocument()
    })

    it('should filter rooms by local part of JID', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('rooms.searchRooms')
      fireEvent.change(searchInput, { target: { value: 'random' } })

      expect(screen.getByText('Random Talk')).toBeInTheDocument()
      expect(screen.queryByText('General Chat')).not.toBeInTheDocument()
      expect(screen.queryByText('Developers')).not.toBeInTheDocument()
    })

    it('should NOT filter by domain part of JID', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('rooms.searchRooms')
      fireEvent.change(searchInput, { target: { value: 'conference' } })

      // Should show "no rooms found" since domain filtering is disabled
      expect(screen.getByText('rooms.noRoomsFound')).toBeInTheDocument()
    })

    it('should show "no rooms found" when filter has no matches', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('rooms.searchRooms')
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } })

      expect(screen.getByText('rooms.noRoomsFound')).toBeInTheDocument()
    })

    it('should be case-insensitive when filtering', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('rooms.searchRooms')
      fireEvent.change(searchInput, { target: { value: 'GENERAL' } })

      expect(screen.getByText('General Chat')).toBeInTheDocument()
    })
  })

  describe('MUC service selection', () => {
    it('should show auto-discovered service with "(your server)" label', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      const select = screen.getByRole('combobox')
      expect(select).toHaveValue('conference.example.com')

      // Check for the "(your server)" suffix
      const option = screen.getByText(/conference\.example\.com.*rooms\.yourServer/)
      expect(option).toBeInTheDocument()
    })

    it('should show well-known MUC servers in dropdown', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      expect(screen.getByText('conference.process-one.net')).toBeInTheDocument()
      expect(screen.getByText('muc.xmpp.org')).toBeInTheDocument()
    })

    it('should show custom server option', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      expect(screen.getByText('rooms.customMucServer')).toBeInTheDocument()
    })

    it('should fetch rooms when service is changed', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('conference.example.com')
      })

      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'muc.xmpp.org' } })

      await waitFor(() => {
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('muc.xmpp.org')
      })
    })

    it('should show custom input when custom option is selected', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: '__custom__' } })

      expect(screen.getByPlaceholderText('rooms.customMucPlaceholder')).toBeInTheDocument()
    })

    it('should fetch rooms from custom service when submitted', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      // Select custom option
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: '__custom__' } })

      // Enter custom service and press Enter to submit
      const customInput = screen.getByPlaceholderText('rooms.customMucPlaceholder')
      fireEvent.change(customInput, { target: { value: 'custom.server.com' } })
      fireEvent.keyDown(customInput, { key: 'Enter' })

      await waitFor(() => {
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('custom.server.com')
      })
    })

    it('should fetch rooms from custom service when discover button clicked', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      // Select custom option
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: '__custom__' } })

      // Enter custom service
      const customInput = screen.getByPlaceholderText('rooms.customMucPlaceholder')
      fireEvent.change(customInput, { target: { value: 'custom.server.com' } })

      // Click discover button
      const discoverButton = screen.getByLabelText('rooms.discover')
      fireEvent.click(discoverButton)

      await waitFor(() => {
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('custom.server.com')
      })
    })

    it('should not fetch rooms while typing in custom input (only on submit)', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      // Clear initial calls
      mockBrowsePublicRooms.mockClear()

      // Select custom option
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: '__custom__' } })

      // Type in custom service without submitting
      const customInput = screen.getByPlaceholderText('rooms.customMucPlaceholder')
      fireEvent.change(customInput, { target: { value: 'custom' } })
      fireEvent.change(customInput, { target: { value: 'custom.server' } })
      fireEvent.change(customInput, { target: { value: 'custom.server.com' } })

      // Should not have called browsePublicRooms for partial values
      expect(mockBrowsePublicRooms).not.toHaveBeenCalledWith('custom')
      expect(mockBrowsePublicRooms).not.toHaveBeenCalledWith('custom.server')
      expect(mockBrowsePublicRooms).not.toHaveBeenCalledWith('custom.server.com')
    })

    it('should validate custom service on Enter key', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      // Select custom option
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: '__custom__' } })

      // Enter invalid service (no dot)
      const customInput = screen.getByPlaceholderText('rooms.customMucPlaceholder')
      fireEvent.change(customInput, { target: { value: 'invalidservice' } })
      fireEvent.keyDown(customInput, { key: 'Enter' })

      expect(screen.getByText('rooms.invalidMucService')).toBeInTheDocument()
    })

    it('should cancel custom input and return to dropdown', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      // Select custom option
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: '__custom__' } })

      // Click cancel button (X icon next to custom input)
      const cancelButton = screen.getByLabelText('common.cancel')
      await act(async () => {
        fireEvent.click(cancelButton)
      })

      // Should show dropdown again
      expect(screen.getByRole('combobox')).toBeInTheDocument()
    })
  })

  describe('join room functionality', () => {
    it('should join room when Join button is clicked', async () => {
      mockJoinRoom.mockResolvedValue(undefined)

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      // Find and click the Join button for the first room
      const joinButtons = screen.getAllByText('rooms.join')
      fireEvent.click(joinButtons[0])

      await waitFor(() => {
        expect(mockJoinRoom).toHaveBeenCalledWith('general@conference.example.com', 'testuser')
      })
    })

    it('should set active room and close modal after successful join', async () => {
      mockJoinRoom.mockResolvedValue(undefined)

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      const joinButtons = screen.getAllByText('rooms.join')
      fireEvent.click(joinButtons[0])

      await waitFor(() => {
        expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
        expect(mockSetActiveRoom).toHaveBeenCalledWith('general@conference.example.com')
        expect(mockOnClose).toHaveBeenCalled()
      })
    })

    it('should show error when join fails', async () => {
      mockJoinRoom.mockRejectedValue(new Error('Room is members-only'))

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      const joinButtons = screen.getAllByText('rooms.join')
      fireEvent.click(joinButtons[0])

      await waitFor(() => {
        expect(screen.getByText('Room is members-only')).toBeInTheDocument()
      })
    })

    it('should show error when trying to join with whitespace-only nickname', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      // Set nickname to whitespace only (button won't be disabled but trim will fail)
      const nicknameInput = screen.getByPlaceholderText('rooms.nicknamePlaceholder')
      fireEvent.change(nicknameInput, { target: { value: '   ' } })

      // Button should be disabled because whitespace-only trims to empty
      const joinButtons = screen.getAllByText('rooms.join')
      expect(joinButtons[0]).toBeDisabled()
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    it('should disable join button when nickname is empty', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      // Clear the nickname
      const nicknameInput = screen.getByPlaceholderText('rooms.nicknamePlaceholder')
      fireEvent.change(nicknameInput, { target: { value: '' } })

      const joinButtons = screen.getAllByText('rooms.join')
      expect(joinButtons[0]).toBeDisabled()
    })

    it('should use trimmed nickname when joining', async () => {
      mockJoinRoom.mockResolvedValue(undefined)

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      // Set nickname with whitespace
      const nicknameInput = screen.getByPlaceholderText('rooms.nicknamePlaceholder')
      fireEvent.change(nicknameInput, { target: { value: '  mynick  ' } })

      const joinButtons = screen.getAllByText('rooms.join')
      fireEvent.click(joinButtons[0])

      await waitFor(() => {
        expect(mockJoinRoom).toHaveBeenCalledWith('general@conference.example.com', 'mynick')
      })
    })
  })

  describe('already joined rooms', () => {
    it('should show "Joined" badge for rooms already joined', async () => {
      // Mock useRoom to return a room that's already joined
      const mockRoomsMap = new Map([
        ['general@conference.example.com', { jid: 'general@conference.example.com', joined: true }],
      ])

      vi.mocked(await import('@fluux/sdk')).useRoom = () => ({
        browsePublicRooms: mockBrowsePublicRooms,
        joinRoom: mockJoinRoom,
        getRoom: (jid: string) => mockRoomsMap.get(jid),
        setActiveRoom: mockSetActiveRoom,
        mucServiceJid: 'conference.example.com',
      })

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      expect(screen.getByText('rooms.joined')).toBeInTheDocument()
    })
  })

  describe('error handling', () => {
    it('should display error when browsePublicRooms fails', async () => {
      mockBrowsePublicRooms.mockRejectedValue(new Error('Network error'))

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument()
      })
    })

    it('should display fallback error message for non-Error throws', async () => {
      mockBrowsePublicRooms.mockRejectedValue('Unknown error')

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('rooms.failedToLoadRooms')).toBeInTheDocument()
      })
    })
  })
})
