import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RoomHeader } from './RoomHeader'
import type { Room, RoomOccupant } from '@fluux/sdk'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'rooms.notificationSettings': 'Notification settings',
        'rooms.mentionsOnly': 'Mentions only',
        'rooms.defaultBehavior': 'Default behavior',
        'rooms.allMessages': 'All messages',
        'rooms.thisSessionOnly': 'This session only',
        'rooms.alwaysSavedToBookmark': 'Always (saved to bookmark)',
        'rooms.manageRoom': 'Manage room',
        'rooms.roomSettings': 'Room settings',
        'rooms.configureRoom': 'Configure room',
        'rooms.changeSubject': 'Change subject',
        'rooms.changeAvatar': 'Change avatar',
        'rooms.removeAvatar': 'Remove avatar',
        'rooms.inviteMember': 'Invite member',
        'rooms.manageMembership': 'Manage membership',
        'rooms.kickBanMembers': 'Kick/ban members',
        'rooms.hideMembers': 'Hide members',
        'rooms.showMembers': 'Show members',
        'rooms.avatarClearFailed': 'Failed to clear avatar',
        'rooms.avatarChangeFailed': 'Failed to change avatar',
        'common.comingSoon': 'Coming soon',
      }
      return translations[key] || key
    },
    i18n: { language: 'en' },
  }),
}))

// Mock useWindowDrag hook
vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({
    titleBarClass: 'mt-5',
    dragRegionProps: { 'data-tauri-drag-region': true },
  }),
  useClickOutside: vi.fn(),
}))

// Mock Avatar component
vi.mock('./Avatar', () => ({
  Avatar: ({ name, avatarUrl }: { name: string; avatarUrl?: string }) => (
    <div data-testid="avatar" data-name={name} data-avatar-url={avatarUrl || ''}>
      Avatar: {name}
    </div>
  ),
}))

// Mock AvatarCropModal
vi.mock('./AvatarCropModal', () => ({
  AvatarCropModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
    isOpen ? <div data-testid="avatar-crop-modal"><button onClick={onClose}>Close</button></div> : null
  ),
}))

// Mock InviteToRoomModal
vi.mock('./InviteToRoomModal', () => ({
  InviteToRoomModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
    isOpen ? <div data-testid="invite-modal"><button onClick={onClose}>Close</button></div> : null
  ),
}))

// Mock messageStyles utility
vi.mock('@/utils/messageStyles', () => ({
  renderTextWithLinks: (text: string) => text,
}))

// Mock SDK
vi.mock('@fluux/sdk', () => ({
  generateConsistentColorHexSync: () => '#4a90d9',
}))

// Helper to create a test room
const createRoom = (overrides: Partial<Room> & { occupantsList?: RoomOccupant[] } = {}): Room => {
  const { occupantsList = [], ...rest } = overrides
  const occupantsMap = new Map<string, RoomOccupant>()
  occupantsList.forEach(occ => occupantsMap.set(occ.nick, occ))

  return {
    jid: 'room@conference.example.com',
    name: 'Test Room',
    joined: true,
    nickname: 'Me',
    messages: [],
    occupants: occupantsMap,
    typingUsers: new Set<string>(),
    unreadCount: 0,
    mentionsCount: 0,
    isBookmarked: true,
    ...rest,
  }
}

// Helper to create a test occupant
const createOccupant = (overrides: Partial<RoomOccupant> = {}): RoomOccupant => ({
  nick: 'Me',
  jid: 'me@example.com',
  affiliation: 'member',
  role: 'participant',
  ...overrides,
})

// Mock functions
const mockSetRoomNotifyAll = vi.fn().mockResolvedValue(undefined)
const mockSetRoomAvatar = vi.fn().mockResolvedValue(undefined)
const mockClearRoomAvatar = vi.fn().mockResolvedValue(undefined)
const mockOnToggleOccupants = vi.fn()
const mockOnBack = vi.fn()

describe('RoomHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Basic Rendering', () => {
    it('renders room name', () => {
      render(
        <RoomHeader
          room={createRoom({ name: 'My Room' })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByText('My Room')).toBeInTheDocument()
    })

    it('renders room subject when available', () => {
      render(
        <RoomHeader
          room={createRoom({ subject: 'Welcome to our room!' })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByText('Welcome to our room!')).toBeInTheDocument()
    })

    it('renders room JID when no subject', () => {
      render(
        <RoomHeader
          room={createRoom({ jid: 'room@conference.example.com', subject: undefined })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByText('room@conference.example.com')).toBeInTheDocument()
    })

    it('renders room avatar when available', () => {
      render(
        <RoomHeader
          room={createRoom({ avatar: 'https://example.com/avatar.png' })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      const avatar = screen.getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-avatar-url', 'https://example.com/avatar.png')
    })

    it('renders colored hash icon when no avatar', () => {
      const { container } = render(
        <RoomHeader
          room={createRoom({ avatar: undefined })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      // Hash icon is rendered in a colored div
      expect(container.querySelector('.rounded-full')).toBeInTheDocument()
      expect(screen.queryByTestId('avatar')).not.toBeInTheDocument()
    })
  })

  describe('Back Button', () => {
    it('shows back button when onBack is provided', () => {
      render(
        <RoomHeader
          room={createRoom()}
          onBack={mockOnBack}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
    })

    it('calls onBack when clicked', () => {
      render(
        <RoomHeader
          room={createRoom()}
          onBack={mockOnBack}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /back/i }))
      expect(mockOnBack).toHaveBeenCalledTimes(1)
    })
  })

  describe('Occupant Toggle', () => {
    it('shows occupant count', () => {
      const room = createRoom({
        occupantsList: [
          createOccupant({ nick: 'Alice' }),
          createOccupant({ nick: 'Bob' }),
          createOccupant({ nick: 'Me' }),
        ],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByText('3')).toBeInTheDocument()
    })

    it('calls onToggleOccupants when clicked', () => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      // Find button by aria-label
      fireEvent.click(screen.getByLabelText('Show members'))
      expect(mockOnToggleOccupants).toHaveBeenCalledTimes(1)
    })

    it('shows "Hide members" aria-label when occupants are shown', () => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={true}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByLabelText('Hide members')).toBeInTheDocument()
    })
  })

  describe('Notification Dropdown', () => {
    it('opens notification menu when clicked', () => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Notification settings'))

      expect(screen.getByText('Mentions only')).toBeInTheDocument()
      // "All messages" appears twice (session-only and always options)
      expect(screen.getAllByText('All messages').length).toBeGreaterThanOrEqual(1)
    })

    it('calls setRoomNotifyAll when selecting all-session mode', async () => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Notification settings'))

      // Click the "All messages" option with "This session only" subtitle
      const allMessagesButtons = screen.getAllByText('All messages')
      fireEvent.click(allMessagesButtons[0])

      expect(mockSetRoomNotifyAll).toHaveBeenCalledWith(
        'room@conference.example.com',
        true,
        false
      )
    })

    it('shows "always" option only for bookmarked rooms', () => {
      render(
        <RoomHeader
          room={createRoom({ isBookmarked: true, isQuickChat: false })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Notification settings'))

      expect(screen.getByText('Always (saved to bookmark)')).toBeInTheDocument()
    })

    it('hides "always" option for quick chat rooms', () => {
      render(
        <RoomHeader
          room={createRoom({ isQuickChat: true })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Notification settings'))

      expect(screen.queryByText('Always (saved to bookmark)')).not.toBeInTheDocument()
    })
  })

  describe('Room Management (Owner/Admin)', () => {
    it('shows management menu for room owners', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByLabelText('Manage room')).toBeInTheDocument()
    })

    it('shows management menu for room admins', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'admin' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.getByLabelText('Manage room')).toBeInTheDocument()
    })

    it('hides management menu for regular members', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'member' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      expect(screen.queryByLabelText('Manage room')).not.toBeInTheDocument()
    })

    it('opens management dropdown when clicked', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))

      expect(screen.getByText('Room settings')).toBeInTheDocument()
      expect(screen.getByText('Change subject')).toBeInTheDocument()
      expect(screen.getByText('Change avatar')).toBeInTheDocument()
      expect(screen.getByText('Invite member')).toBeInTheDocument()
    })

    it('shows "Remove avatar" only when room has avatar', () => {
      const room = createRoom({
        avatar: 'https://example.com/avatar.png',
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))
      expect(screen.getByText('Remove avatar')).toBeInTheDocument()
    })

    it('hides "Remove avatar" when room has no avatar', () => {
      const room = createRoom({
        avatar: undefined,
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))
      expect(screen.queryByText('Remove avatar')).not.toBeInTheDocument()
    })

    it('shows "Manage membership" only for owners', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))
      expect(screen.getByText('Manage membership')).toBeInTheDocument()
    })

    it('hides "Manage membership" for admins', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'admin' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))
      expect(screen.queryByText('Manage membership')).not.toBeInTheDocument()
    })
  })

  describe('Invite Modal', () => {
    it('opens invite modal when clicking Invite member', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))
      fireEvent.click(screen.getByText('Invite member'))

      expect(screen.getByTestId('invite-modal')).toBeInTheDocument()
    })
  })

  describe('Avatar Modal', () => {
    it('opens avatar modal when clicking Change avatar', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))
      fireEvent.click(screen.getByText('Change avatar'))

      expect(screen.getByTestId('avatar-crop-modal')).toBeInTheDocument()
    })
  })

  describe('Clear Avatar', () => {
    it('calls clearRoomAvatar when clicking Remove avatar', async () => {
      const room = createRoom({
        avatar: 'https://example.com/avatar.png',
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      fireEvent.click(screen.getByLabelText('Manage room'))
      fireEvent.click(screen.getByText('Remove avatar'))

      await waitFor(() => {
        expect(mockClearRoomAvatar).toHaveBeenCalledWith('room@conference.example.com')
      })
    })
  })

  describe('Title Bar', () => {
    it('applies title bar class from useWindowDrag', () => {
      const { container } = render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyAll={mockSetRoomNotifyAll}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
        />
      )

      const header = container.querySelector('header')
      expect(header).toHaveClass('mt-5')
    })
  })
})
