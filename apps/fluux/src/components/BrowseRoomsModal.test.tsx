import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { BrowseRoomsModal } from './BrowseRoomsModal'

// Mock the SDK hooks
const mockBrowsePublicRooms = vi.fn()
const mockJoinRoom = vi.fn()
const mockJoinResult = vi.fn()
const mockSetActiveRoom = vi.fn()
const mockSetActiveConversation = vi.fn()

const { RoomJoinError } = vi.hoisted(() => {
  class RoomJoinError extends Error {
    constructor(
      public roomJid: string,
      public condition: string,
      public errorType?: string,
      public text?: string,
    ) {
      super(text || `Room join failed: ${condition}`)
      this.name = 'RoomJoinError'
    }
  }
  return { RoomJoinError }
})

vi.mock('@fluux/sdk', () => ({
  useConnection: () => ({
    jid: 'testuser@example.com',
  }),
  useRoom: () => ({
    browsePublicRooms: mockBrowsePublicRooms,
    joinRoom: mockJoinRoom,
    joinResult: mockJoinResult,
    getRoom: () => undefined,
    setActiveRoom: mockSetActiveRoom,
    mucServiceJid: 'conference.example.com',
  }),
  useRoomActions: () => ({
    getRoomInfo: vi.fn().mockResolvedValue(null),
    acknowledgeNonAnonymousRoom: vi.fn(),
    isNonAnonymousRoomAcknowledged: () => false,
  }),
  WELL_KNOWN_MUC_SERVERS: ['conference.process-one.net', 'muc.xmpp.org'],
  getLocalPart: (jid: string) => jid.split('@')[0],
  resolveDefaultMucNick: (nick: string | null | undefined, jid: string | null | undefined) =>
    (nick?.trim() || (jid ? jid.split('@')[0] : '')),
  generateConsistentColorHexSync: () => '#5588aa',
  RoomJoinError,
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  // useChatStore is callable (hook-style) for selector subscriptions
  useChatStore: (selector: (state: { setActiveConversation: typeof mockSetActiveConversation }) => unknown) =>
    selector({ setActiveConversation: mockSetActiveConversation }),
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useContactTime: () => null, useLastActivity: vi.fn(),
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
    mockJoinResult.mockResolvedValue(undefined)
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
      document.documentElement.setAttribute('data-motion', 'reduced')
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      const closeButton = screen.getByLabelText('common.close')
      fireEvent.click(closeButton)

      expect(mockOnClose).toHaveBeenCalled()
      document.documentElement.removeAttribute('data-motion')
    })

    it('should call onClose when clicking backdrop', async () => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      render(<BrowseRoomsModal onClose={mockOnClose} />)
      await act(async () => {})

      // Click the backdrop (the outermost div)
      const backdrop = screen.getByText('rooms.browseRoomsTitle').closest('.fixed')!
      // The dismiss affordance is now a full-overlay backdrop <button> (first child)
      fireEvent.click(backdrop.querySelector('button')!)

      expect(mockOnClose).toHaveBeenCalled()
      document.documentElement.removeAttribute('data-motion')
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
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('conference.example.com', { max: 50 })
      })

      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'muc.xmpp.org' } })

      await waitFor(() => {
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('muc.xmpp.org', { max: 50 })
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
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('custom.server.com', { max: 50 })
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
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('custom.server.com', { max: 50 })
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

    it('shows a mapped inline error when joinResult rejects with a RoomJoinError', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      mockJoinResult.mockRejectedValue(
        new RoomJoinError('general@conference.example.com', 'registration-required'),
      )

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      fireEvent.click(screen.getAllByText('rooms.join')[0])

      await waitFor(() => {
        expect(screen.getByText('rooms.membersOnly')).toBeInTheDocument()
      })
      expect(mockOnClose).not.toHaveBeenCalled()
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
        joinResult: mockJoinResult,
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

  describe('pagination', () => {
    // Mirror of PAGE_SIZE in BrowseRoomsModal — a "full" page signals more pages.
    const PAGE_SIZE = 50

    // Install an IntersectionObserver whose callback we can fire on demand to
    // trigger load-more. Returns a trigger fn and a restore fn.
    const installCapturingObserver = () => {
      let observerCallback: IntersectionObserverCallback | null = null
      const originalIO = globalThis.IntersectionObserver
      class CapturingIO {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
        constructor(cb: IntersectionObserverCallback) {
          observerCallback = cb
        }
      }
      globalThis.IntersectionObserver = CapturingIO as unknown as typeof IntersectionObserver
      return {
        trigger: () =>
          act(async () => {
            observerCallback?.(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              {} as IntersectionObserver
            )
          }),
        restore: () => {
          globalThis.IntersectionObserver = originalIO
        },
      }
    }

    const makeFullPage = (prefix: string) =>
      Array.from({ length: PAGE_SIZE }, (_, i) => ({
        jid: `${prefix}${i}@conference.example.com`,
        name: `${prefix} Room ${i}`,
      }))

    it('should pass RSM max parameter on initial fetch', async () => {
      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(mockBrowsePublicRooms).toHaveBeenCalledWith('conference.example.com', { max: 50 })
      })
    })

    it('should show total count in footer while more pages remain', async () => {
      // Full page + cursor → more pages available, so the "/ N" progress hint
      // is meaningful.
      mockBrowsePublicRooms.mockResolvedValue({
        rooms: makeFullPage('p1'),
        pagination: { first: 'p10', last: 'p1last', count: 150 },
      })

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText(/\/ 150/)).toBeInTheDocument()
      })
    })

    it('should drop the total-count hint once the last page is reached (issue #1010)', async () => {
      const observer = installCapturingObserver()
      try {
        // Page 1: full page, more available. count is inflated (150).
        mockBrowsePublicRooms.mockResolvedValueOnce({
          rooms: makeFullPage('p1'),
          pagination: { first: 'p10', last: 'p1last', count: 150 },
        })
        // Page 2: short page → authoritative end, but count still says 150.
        mockBrowsePublicRooms.mockResolvedValueOnce({
          rooms: [{ jid: 'tail@conference.example.com', name: 'Tail Room' }],
          pagination: { first: 'tail', last: 'tail', count: 150 },
        })

        render(<BrowseRoomsModal onClose={mockOnClose} />)

        await waitFor(() => {
          expect(screen.getByText(/\/ 150/)).toBeInTheDocument()
        })

        await observer.trigger()

        await waitFor(() => {
          expect(screen.getByText('Tail Room')).toBeInTheDocument()
        })

        // We've loaded everything listable; the inflated "/ 150" must be gone.
        expect(screen.queryByText(/\/ 150/)).not.toBeInTheDocument()
      } finally {
        observer.restore()
      }
    })

    it('should not show total count when rooms are fully loaded', async () => {
      mockBrowsePublicRooms.mockResolvedValue({
        rooms: sampleRooms,
        pagination: { first: 'first-id', last: 'last-id', count: 3 },
      })

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      // Should NOT show "/ 3" since all rooms are loaded
      expect(screen.queryByText(/\/ 3/)).not.toBeInTheDocument()
    })

    it('should not duplicate a room repeated across pages (issue #1010)', async () => {
      const observer = installCapturingObserver()
      try {
        // Page 1: a full page whose last room is B (a page boundary).
        const page1 = makeFullPage('p1')
        const roomB = { jid: 'b@conference.example.com', name: 'Room B' }
        page1[PAGE_SIZE - 1] = roomB
        mockBrowsePublicRooms.mockResolvedValueOnce({
          rooms: page1,
          pagination: { first: 'p10', last: 'b', count: 100 },
        })
        // Page 2: repeats boundary room B, then adds C.
        mockBrowsePublicRooms.mockResolvedValueOnce({
          rooms: [roomB, { jid: 'c@conference.example.com', name: 'Room C' }],
          pagination: { first: 'b', last: 'c', count: 100 },
        })

        render(<BrowseRoomsModal onClose={mockOnClose} />)

        await waitFor(() => {
          expect(screen.getByText('Room B')).toBeInTheDocument()
        })

        await observer.trigger()

        await waitFor(() => {
          expect(screen.getByText('Room C')).toBeInTheDocument()
        })

        // Room B must appear exactly once despite being returned on both pages.
        expect(screen.getAllByText('Room B')).toHaveLength(1)
      } finally {
        observer.restore()
      }
    })

    it('should stop paging on a short page even when count stays high (issue #1010)', async () => {
      const observer = installCapturingObserver()
      try {
        // Page 1: a full page — more pages available. count is inflated (e.g.
        // ejabberd reports total online rooms, including empty ones it filters
        // out of the listing), so it must NOT drive the stop decision.
        mockBrowsePublicRooms.mockResolvedValueOnce({
          rooms: makeFullPage('p1'),
          pagination: { first: 'p10', last: 'p1last', count: 150 },
        })
        // Page 2: a SHORT page — the server's ordered walk reached the end,
        // even though count (150) still exceeds the rooms loaded so far (60).
        mockBrowsePublicRooms.mockResolvedValueOnce({
          rooms: Array.from({ length: 10 }, (_, i) => ({
            jid: `p2${i}@conference.example.com`,
            name: `p2 Room ${i}`,
          })),
          pagination: { first: 'p20', last: 'p2last', count: 150 },
        })

        render(<BrowseRoomsModal onClose={mockOnClose} />)

        await waitFor(() => {
          expect(screen.getByText('p1 Room 0')).toBeInTheDocument()
        })

        // First load-more fetches the short page 2.
        await observer.trigger()
        await waitFor(() => {
          expect(screen.getByText('p2 Room 0')).toBeInTheDocument()
        })
        expect(mockBrowsePublicRooms).toHaveBeenCalledTimes(2)

        // Firing again must NOT fetch a third page: the short page 2 is the
        // authoritative end signal, regardless of the still-high count.
        await observer.trigger()
        expect(mockBrowsePublicRooms).toHaveBeenCalledTimes(2)
      } finally {
        observer.restore()
      }
    })

    it('should reset pagination when switching MUC service', async () => {
      // First call returns paginated results
      mockBrowsePublicRooms.mockResolvedValueOnce({
        rooms: sampleRooms,
        pagination: { first: 'first-id', last: 'last-id', count: 150 },
      })

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      // Second call returns different rooms with no pagination
      mockBrowsePublicRooms.mockResolvedValueOnce({
        rooms: [{ jid: 'test@muc.xmpp.org', name: 'Test Room' }],
        pagination: {},
      })

      // Switch service
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'muc.xmpp.org' } })

      await waitFor(() => {
        expect(screen.getByText('Test Room')).toBeInTheDocument()
      })

      // Old rooms should be gone
      expect(screen.queryByText('General Chat')).not.toBeInTheDocument()
    })
  })
})
