import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { JoinRoomModal } from './JoinRoomModal'

// Hoisted so these are available inside vi.mock factories (which are hoisted to
// the top of the file before any other variable declarations).
const { mockJoinRoom, mockJoinResult, mockSetActiveRoom, mockSetActiveConversation, RoomJoinError } = vi.hoisted(() => {
  const mockJoinRoom = vi.fn()
  const mockJoinResult = vi.fn()
  const mockSetActiveRoom = vi.fn()
  const mockSetActiveConversation = vi.fn()

  // Minimal stand-in for the SDK's RoomJoinError so `instanceof` works in the
  // component (which imports it from the mocked '@fluux/sdk').
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

  return { mockJoinRoom, mockJoinResult, mockSetActiveRoom, mockSetActiveConversation, RoomJoinError }
})

let mockUserJid = 'testuser@example.com'
let mockOwnNickname: string | null = null

vi.mock('@fluux/sdk', () => ({
  useConnection: () => ({
    jid: mockUserJid,
    ownNickname: mockOwnNickname,
  }),
  useRoomActions: () => ({
    joinRoom: mockJoinRoom,
    joinResult: mockJoinResult,
    setActiveRoom: mockSetActiveRoom,
    getRoomInfo: vi.fn().mockResolvedValue(null),
    acknowledgeNonAnonymousRoom: vi.fn(),
    isNonAnonymousRoomAcknowledged: () => false,
  }),
  RoomJoinError,
}))

vi.mock('@fluux/sdk/react', () => ({
  useChatStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) => {
    const state = { setActiveConversation: mockSetActiveConversation }
    return selector ? selector(state) : state
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

describe('JoinRoomModal', () => {
  const mockOnClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockUserJid = 'testuser@example.com'
    mockOwnNickname = null
    mockJoinRoom.mockResolvedValue(undefined)
    mockJoinResult.mockResolvedValue(undefined)
  })

  describe('rendering', () => {
    it('should render modal with title and form fields', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      expect(screen.getByText('rooms.joinRoomTitle')).toBeInTheDocument()
      expect(screen.getByLabelText('rooms.roomAddress')).toBeInTheDocument()
      expect(screen.getByLabelText('rooms.nickname')).toBeInTheDocument()
    })

    it('should have Cancel and Join Room buttons', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      expect(screen.getByText('common.cancel')).toBeInTheDocument()
      expect(screen.getByText('rooms.joinRoom')).toBeInTheDocument()
    })

    it('should show join room hint', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      expect(screen.getByText('rooms.joinRoomHint')).toBeInTheDocument()
    })

    it('should have submit button disabled when room JID is empty', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      const submitButton = screen.getByRole('button', { name: 'rooms.joinRoom' })
      expect(submitButton).toBeDisabled()
    })
  })

  describe('nickname defaulting', () => {
    it('should default nickname from user JID local part', () => {
      mockUserJid = 'alice@chat.example.com'
      render(<JoinRoomModal onClose={mockOnClose} />)

      const nicknameInput = screen.getByLabelText('rooms.nickname')
      expect(nicknameInput).toHaveValue('alice')
    })

    it('should extract local part correctly from full JID', () => {
      mockUserJid = 'bob.smith@xmpp.server.org/resource'
      render(<JoinRoomModal onClose={mockOnClose} />)

      const nicknameInput = screen.getByLabelText('rooms.nickname')
      // split('@')[0] gives 'bob.smith'
      expect(nicknameInput).toHaveValue('bob.smith')
    })

    it('should prefer PEP nickname over JID local part', () => {
      mockUserJid = 'alice@chat.example.com'
      mockOwnNickname = 'Alice Wonder'
      render(<JoinRoomModal onClose={mockOnClose} />)

      const nicknameInput = screen.getByLabelText('rooms.nickname')
      expect(nicknameInput).toHaveValue('Alice Wonder')
    })

    it('should allow user to change the default nickname', () => {
      mockUserJid = 'testuser@example.com'
      render(<JoinRoomModal onClose={mockOnClose} />)

      const nicknameInput = screen.getByLabelText('rooms.nickname')
      expect(nicknameInput).toHaveValue('testuser')

      fireEvent.change(nicknameInput, { target: { value: 'MyNickname' } })
      expect(nicknameInput).toHaveValue('MyNickname')
    })
  })

  describe('validation', () => {
    it('should show error when room JID is empty on submit', async () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      // Type in room JID then clear it
      const roomInput = screen.getByLabelText('rooms.roomAddress')
      fireEvent.change(roomInput, { target: { value: 'test' } })
      fireEvent.change(roomInput, { target: { value: '' } })

      // Submit via form
      const form = roomInput.closest('form')!
      fireEvent.submit(form)

      await waitFor(() => {
        expect(screen.getByText('rooms.pleaseEnterRoomAddress')).toBeInTheDocument()
      })
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    it('should show error when room JID does not contain @', async () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'invalidroom' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.invalidRoomAddress')).toBeInTheDocument()
      })
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    it('should show error when nickname is empty', async () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@conference.example.com' } })
      fireEvent.change(screen.getByLabelText('rooms.nickname'), { target: { value: '' } })

      // Need to enable submit button by having both fields, then clear nickname
      const form = screen.getByLabelText('rooms.roomAddress').closest('form')!
      fireEvent.submit(form)

      await waitFor(() => {
        expect(screen.getByText('rooms.pleaseEnterNickname')).toBeInTheDocument()
      })
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    it('should accept valid room JID with @', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'myroom@conference.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(mockJoinRoom).toHaveBeenCalledWith('myroom@conference.example.com', 'testuser', undefined)
      })
    })

    it('should trim whitespace from room JID and nickname', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: '  room@conference.example.com  ' } })
      fireEvent.change(screen.getByLabelText('rooms.nickname'), { target: { value: '  MyNick  ' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(mockJoinRoom).toHaveBeenCalledWith('room@conference.example.com', 'MyNick', undefined)
      })
    })
  })

  describe('form submission', () => {
    it('should call joinRoom with room JID and nickname', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'chatroom@muc.example.com' } })
      fireEvent.change(screen.getByLabelText('rooms.nickname'), { target: { value: 'Alice' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(mockJoinRoom).toHaveBeenCalledWith('chatroom@muc.example.com', 'Alice', undefined)
      })
    })

    it('should call onClose after successful submission', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@conference.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled()
      })
    })

    it('should show loading state while joining', async () => {
      let resolveJoin: (value?: unknown) => void
      mockJoinRoom.mockImplementation(() => new Promise((resolve) => { resolveJoin = resolve }))
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@conference.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.joining')).toBeInTheDocument()
      })

      await act(async () => {
        resolveJoin!()
      })
    })

    it('should disable inputs while joining', async () => {
      let resolveJoin: (value?: unknown) => void
      mockJoinRoom.mockImplementation(() => new Promise((resolve) => { resolveJoin = resolve }))
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@conference.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByLabelText('rooms.roomAddress')).toBeDisabled()
        expect(screen.getByLabelText('rooms.nickname')).toBeDisabled()
      })

      await act(async () => {
        resolveJoin!()
      })
    })

    it('should display error message on join failure', async () => {
      mockJoinRoom.mockRejectedValue(new Error('Room does not exist'))
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@conference.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('Room does not exist')).toBeInTheDocument()
      })
      expect(mockOnClose).not.toHaveBeenCalled()
    })

    it('should display generic error message when error is not an Error instance', async () => {
      mockJoinRoom.mockRejectedValue('Unknown error')
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@conference.example.com' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.failedToJoinRoom')).toBeInTheDocument()
      })
    })
  })

  describe('join error handling', () => {
    const fillRoom = () => {
      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), {
        target: { value: 'room@conference.example.com' },
      })
    }

    it('reveals and focuses the password field on not-authorized (password required)', async () => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', 'not-authorized', 'auth'))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.passwordRequired')).toBeInTheDocument()
      })
      const passwordInput = screen.getByLabelText('rooms.roomPassword')
      expect(passwordInput).toBeInTheDocument()
      await waitFor(() => expect(passwordInput).toHaveFocus())
      expect(mockOnClose).not.toHaveBeenCalled()
    })

    it('shows "incorrect password" when a password was already supplied', async () => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', 'not-authorized', 'auth'))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()

      // Reveal the password field via the toggle, type a password, submit.
      fireEvent.click(screen.getByText('rooms.passwordProtected'))
      fireEvent.change(screen.getByLabelText('rooms.roomPassword'), { target: { value: 'wrongpass' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.incorrectPassword')).toBeInTheDocument()
      })
    })

    it('passes the password to joinRoom when supplied', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByText('rooms.passwordProtected'))
      fireEvent.change(screen.getByLabelText('rooms.roomPassword'), { target: { value: 's3cret' } })
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(mockJoinRoom).toHaveBeenCalledWith('room@conference.example.com', 'testuser', { password: 's3cret' })
      })
    })

    it('shows a nickname-conflict message and focuses the nickname field on conflict', async () => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', 'conflict', 'cancel'))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('rooms.nicknameInUse')).toBeInTheDocument()
      })
      await waitFor(() => expect(screen.getByLabelText('rooms.nickname')).toHaveFocus())
    })

    it.each([
      ['registration-required', 'rooms.membersOnly'],
      ['forbidden', 'rooms.bannedFromRoom'],
      ['service-unavailable', 'rooms.roomFull'],
      ['not-acceptable', 'rooms.registeredNicknameRequired'],
      ['item-not-found', 'rooms.roomNotFound'],
    ])('maps condition %s to message %s', async (condition, messageKey) => {
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.com', condition))
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText(messageKey)).toBeInTheDocument()
      })
      expect(mockOnClose).not.toHaveBeenCalled()
    })

    it('falls back to the server text for an unmapped condition', async () => {
      mockJoinResult.mockRejectedValue(
        new RoomJoinError('room@conference.example.com', 'resource-constraint', 'wait', 'Try later'),
      )
      render(<JoinRoomModal onClose={mockOnClose} />)
      fillRoom()
      fireEvent.click(screen.getByRole('button', { name: 'rooms.joinRoom' }))

      await waitFor(() => {
        expect(screen.getByText('Try later')).toBeInTheDocument()
      })
    })
  })

  describe('modal closing', () => {
    beforeEach(() => {
      document.documentElement.setAttribute('data-motion', 'reduced')
    })
    afterEach(() => {
      document.documentElement.removeAttribute('data-motion')
    })

    it('should call onClose when Cancel button is clicked', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.click(screen.getByText('common.cancel'))

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should call onClose when close button (X) is clicked', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      const closeButton = screen.getByLabelText('common.close')
      fireEvent.click(closeButton)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should call onClose when clicking outside the modal (backdrop)', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      // The backdrop is the outermost div with the click handler
      const backdrop = screen.getByText('rooms.joinRoomTitle').closest('.fixed')!
      // The dismiss affordance is now a full-overlay backdrop <button> (first child)
      fireEvent.click(backdrop.querySelector('button')!)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should not call onClose when clicking inside the modal', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.click(screen.getByText('rooms.joinRoomHint'))

      expect(mockOnClose).not.toHaveBeenCalled()
    })
  })

  describe('button states', () => {
    it('should enable submit button when both room JID and nickname are filled', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      // Initially disabled because room JID is empty (nickname has default)
      expect(screen.getByRole('button', { name: 'rooms.joinRoom' })).toBeDisabled()

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@example.com' } })

      expect(screen.getByRole('button', { name: 'rooms.joinRoom' })).not.toBeDisabled()
    })

    it('should disable submit button when nickname is cleared', () => {
      render(<JoinRoomModal onClose={mockOnClose} />)

      fireEvent.change(screen.getByLabelText('rooms.roomAddress'), { target: { value: 'room@example.com' } })
      fireEvent.change(screen.getByLabelText('rooms.nickname'), { target: { value: '' } })

      expect(screen.getByRole('button', { name: 'rooms.joinRoom' })).toBeDisabled()
    })
  })
})
