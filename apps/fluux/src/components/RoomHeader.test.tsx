import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { RoomHeader } from './RoomHeader'
import { savedStore, type Room, type RoomOccupant } from '@fluux/sdk'
import { useToastStore } from '@/stores/toastStore'

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
        'rooms.notificationsOff': 'Off',
        'rooms.failedToSaveBookmark': 'Failed to save bookmark',
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
        'rooms.showRoomInfo': 'Show room info',
        'rooms.avatarClearFailed': 'Failed to clear avatar',
        'rooms.avatarChangeFailed': 'Failed to change avatar',
        'rooms.manageHats': 'Manage Hats',
        'rooms.manageHatsDesc': 'Define and assign hats',
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
    dragRegionProps: { 'data-tauri-drag-region': true },
  }),
  useClickOutside: vi.fn(),
  useAnchoredMenu: () => ({
    triggerRef: { current: null },
    menuRef: { current: null },
    position: { x: 0, y: 0 },
  }),
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
    isOpen ? <div data-testid="avatar-crop-modal"><button type="button" onClick={onClose}>Close</button></div> : null
  ),
}))

// Mock InviteToRoomModal
vi.mock('./InviteToRoomModal', () => ({
  InviteToRoomModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
    isOpen ? <div data-testid="invite-modal"><button type="button" onClick={onClose}>Close</button></div> : null
  ),
}))

// Mock RoomConfigModal
vi.mock('./RoomConfigModal', () => ({
  RoomConfigModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="room-config-modal"><button type="button" onClick={onClose}>Close</button></div>
  ),
}))

// Mock RoomMembersModal
vi.mock('./RoomMembersModal', () => ({
  RoomMembersModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="members-modal"><button type="button" onClick={onClose}>Close</button></div>
  ),
}))

// Mock RoomHatsModal
vi.mock('./RoomHatsModal', () => ({
  RoomHatsModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="hats-modal"><button type="button" onClick={onClose}>Close</button></div>
  ),
}))

// Mock messageStyles utility
vi.mock('@/utils/messageStyles', () => ({
  renderTextWithLinks: (text: string) => text,
}))

// Mock SDK
vi.mock('@fluux/sdk', async (importOriginal) => ({
  // The notification level resolvers are pure; keep the real ones.
  resolveNotifyLevel: (await importOriginal<typeof import('@fluux/sdk')>()).resolveNotifyLevel,
  savedNotifyLevel: (await importOriginal<typeof import('@fluux/sdk')>()).savedNotifyLevel,
  // The saved count reads the real saved store, so the test saves real entries.
  useSavedCountInConversation: (await importOriginal<typeof import('@fluux/sdk')>()).useSavedCountInConversation,
  savedStore: (await importOriginal<typeof import('@fluux/sdk')>()).savedStore,
  generateConsistentColorHexSync: () => '#4a90d9',
  getUniqueOccupantCount: (occupants: Iterable<{ jid?: string }>) => {
    const bareJids = new Set<string>()
    let noJidCount = 0
    for (const occ of occupants) {
      if (occ.jid) {
        bareJids.add(occ.jid.split('/')[0])
      } else {
        noJidCount++
      }
    }
    return bareJids.size + noJidCount
  },
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
const mockSetRoomNotifyLevel = vi.fn().mockResolvedValue(undefined)
const mockSetRoomAvatar = vi.fn().mockResolvedValue(undefined)
const mockClearRoomAvatar = vi.fn().mockResolvedValue(undefined)
const mockSubmitRoomConfig = vi.fn().mockResolvedValue(undefined)
const mockSetSubject = vi.fn().mockResolvedValue(undefined)
const mockDestroyRoom = vi.fn().mockResolvedValue(undefined)
const mockOnToggleOccupants = vi.fn()
const mockOnBack = vi.fn()

/** Opens the room's ⋮ menu and scopes queries to it. */
function openRoomMenu() {
  fireEvent.click(screen.getByLabelText('rooms.roomActions'))
  return within(screen.getByRole('menu'))
}

/** Picks an entry of the room's ⋮ menu; a submenu entry opens its items. */
function pickRoomMenuEntry(label: string) {
  fireEvent.click(openRoomMenu().getByText(label))
}

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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      expect(screen.getByText('My Room')).toBeInTheDocument()
    })

    it('labels the room name button as the room info trigger', () => {
      render(
        <RoomHeader
          room={createRoom({ name: 'My Room' })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      expect(screen.getByLabelText('Show room info: My Room')).toBeInTheDocument()
    })

    it('shows a "Show room info" tooltip when hovering the room name', async () => {
      vi.useFakeTimers()
      try {
        render(
          <RoomHeader
            room={createRoom({ name: 'My Room' })}
            showOccupants={false}
            onToggleOccupants={mockOnToggleOccupants}
            setRoomNotifyLevel={mockSetRoomNotifyLevel}
            setRoomAvatar={mockSetRoomAvatar}
            clearRoomAvatar={mockClearRoomAvatar}
            submitRoomConfig={mockSubmitRoomConfig}
            setSubject={mockSetSubject}
            destroyRoom={mockDestroyRoom}
          />
        )

        // The tooltip listens on the wrapper around the trigger button
        const infoButton = screen.getByLabelText('Show room info: My Room')
        fireEvent.mouseEnter(infoButton.parentElement!)

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })

        expect(screen.getByRole('tooltip')).toHaveTextContent('Show room info')
      } finally {
        vi.useRealTimers()
      }
    })

    it('carries the aurora horizon hairline', () => {
      const { container } = render(
        <RoomHeader
          room={createRoom({ name: 'My Room' })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )
      const header = container.querySelector('header')
      expect(header).not.toBeNull()
      expect(header!.className).toContain('aurora-horizon')
      expect(header!.className).toContain('relative')
    })

    it('renders room subject when available', () => {
      render(
        <RoomHeader
          room={createRoom({ subject: 'Welcome to our room!' })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      const avatar = screen.getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-avatar-url', 'https://example.com/avatar.png')
    })

    it('renders avatar with no avatarUrl when room has no avatar', () => {
      render(
        <RoomHeader
          room={createRoom({ avatar: undefined })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      // Fallback (hash icon vs. letter, square shape) is RoomAvatar/Avatar's own
      // concern, covered by RoomAvatar.test.tsx and Avatar.test.tsx. Here we only
      // verify RoomHeader forwards an empty avatarUrl when the room has none.
      const avatar = screen.getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-avatar-url', '')
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
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
          createOccupant({ nick: 'Alice', jid: 'alice@example.com' }),
          createOccupant({ nick: 'Bob', jid: 'bob@example.com' }),
          createOccupant({ nick: 'Me', jid: 'me@example.com' }),
        ],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      const toggle = screen.getByLabelText('Hide members')
      expect(toggle).toBeInTheDocument()
      expect(toggle.querySelector('.lucide-chevron-right')).not.toHaveClass('rotate-180')
    })

    it('points the chevron toward the closed members panel', () => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      const toggle = screen.getByLabelText('Show members')
      expect(toggle.querySelector('.lucide-chevron-right')).toHaveClass('rotate-180')
    })
  })

  describe('Notification Dropdown', () => {
    it('opens notification menu when clicked', () => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Notification settings')

      expect(screen.getByText('Mentions only')).toBeInTheDocument()
      // "All messages" appears twice (session-only and always options)
      expect(screen.getAllByText('All messages').length).toBeGreaterThanOrEqual(1)
    })

    it('calls setRoomNotifyLevel when selecting all-session mode', async () => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Notification settings')

      // Click the "All messages" option with "This session only" subtitle
      const allMessagesButtons = screen.getAllByText('All messages')
      fireEvent.click(allMessagesButtons[0])

      expect(mockSetRoomNotifyLevel).toHaveBeenCalledWith(
        'room@conference.example.com',
        'all',
        false
      )
    })

    const renderNotifyMenu = (room: Room) => {
      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )
      pickRoomMenuEntry('Notification settings')
    }

    it('saves Off to the bookmark when the Off row is chosen', () => {
      renderNotifyMenu(createRoom({ isBookmarked: true, isQuickChat: false }))

      fireEvent.click(screen.getByText('Off'))

      expect(mockSetRoomNotifyLevel).toHaveBeenCalledWith('room@conference.example.com', 'none', true)
    })

    it('holds Off for the session in a quick chat', () => {
      renderNotifyMenu(createRoom({ isQuickChat: true }))

      fireEvent.click(screen.getByText('Off'))

      expect(mockSetRoomNotifyLevel).toHaveBeenCalledWith('room@conference.example.com', 'none', false)
    })

    it('shows the crossed bell inline for an Off room, and keeps Mentions only in the menu with the @ icon', () => {
      const { unmount } = render(
        <RoomHeader
          room={createRoom({ notifyOffPersistent: true })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )
      // A changed level shows inline as a status icon.
      expect(screen.getByLabelText('Notification settings').querySelector('.lucide-bell-off')).not.toBeNull()
      unmount()

      // The default level keeps the bell in the ⋮ menu only, where its row carries the @ icon.
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )
      expect(screen.queryByLabelText('Notification settings')).toBeNull()
      const row = openRoomMenu().getByText('Notification settings').closest('button')!
      expect(row.querySelector('.lucide-at-sign')).not.toBeNull()
    })

    it('shows "always" option only for bookmarked rooms', () => {
      render(
        <RoomHeader
          room={createRoom({ isBookmarked: true, isQuickChat: false })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Notification settings')

      // All messages · Always and Off · Always
      expect(screen.getAllByText('Always (saved to bookmark)')).toHaveLength(2)
    })

    it('hides "always" option for quick chat rooms', () => {
      render(
        <RoomHeader
          room={createRoom({ isQuickChat: true })}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Notification settings')

      expect(screen.queryByText('Always (saved to bookmark)')).not.toBeInTheDocument()
    })

    // The menu closes on click, so a level the bookmark save refuses must be
    // reported in a toast, not dropped as an unhandled promise rejection.
    describe('when the saved level reaches the bookmark', () => {
      /** The rejection the SDK passes on when the server answers the bookmark publish with an error. */
      const serverRefusal = Object.assign(new Error('conflict'), { name: 'StanzaError', condition: 'conflict' })
      const chooseAllMessagesAlways = () => {
        renderNotifyMenu(createRoom({ isBookmarked: true, isQuickChat: false }))
        fireEvent.click(screen.getByRole('menuitem', { name: /All messages\s*Always \(saved to bookmark\)/ }))
      }
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => { unhandled.push(reason) }

      beforeEach(() => {
        useToastStore.setState({ toasts: [] })
        unhandled.length = 0
        process.on('unhandledRejection', onUnhandled)
      })
      afterEach(() => {
        process.off('unhandledRejection', onUnhandled)
      })

      it('shows an error when the save fails', async () => {
        mockSetRoomNotifyLevel.mockRejectedValueOnce(serverRefusal)

        chooseAllMessagesAlways()

        expect(mockSetRoomNotifyLevel).toHaveBeenCalledWith('room@conference.example.com', 'all', true)
        await waitFor(() => expect(useToastStore.getState().toasts.map((t) => [t.type, t.message]))
          .toEqual([['error', 'Failed to save bookmark']]))
        // Node reports an unhandled rejection once the microtasks after it have run.
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(unhandled).toEqual([])
      })

      it('shows no error when the save succeeds', async () => {
        chooseAllMessagesAlways()
        // The menu's own handler on the save runs before this await resumes.
        await mockSetRoomNotifyLevel.mock.results[0].value

        expect(useToastStore.getState().toasts).toEqual([])
      })
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      expect(openRoomMenu().getByText('Manage room')).toBeInTheDocument()
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      expect(openRoomMenu().getByText('Manage room')).toBeInTheDocument()
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      expect(openRoomMenu().queryByText('Manage room')).not.toBeInTheDocument()
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')

      expect(screen.getByText('Room settings')).toBeInTheDocument()
      expect(screen.getByText('Change subject')).toBeInTheDocument()
      expect(screen.getByText('Change avatar')).toBeInTheDocument()
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
      expect(screen.getByText('Manage membership')).toBeInTheDocument()
    })

    it('shows "Manage membership" for admins', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'admin' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
      expect(screen.getByText('Manage membership')).toBeInTheDocument()
    })
  })

  describe('Invite Modal', () => {
    it('opens invite modal when clicking Invite member', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'member' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Invite member')

      expect(screen.getByTestId('invite-modal')).toBeInTheDocument()
    })

    it('invite button is available to all occupants, not just admins', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'none' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      expect(openRoomMenu().getByText('Invite member')).toBeInTheDocument()
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
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
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
      fireEvent.click(screen.getByText('Remove avatar'))

      await waitFor(() => {
        expect(mockClearRoomAvatar).toHaveBeenCalledWith('room@conference.example.com')
      })
    })
  })


  describe('Manage Hats', () => {
    it('shows "Manage Hats" only for owners', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
      expect(screen.getByText('Manage Hats')).toBeInTheDocument()
    })

    it('hides "Manage Hats" for admins', () => {
      const room = createRoom({
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'admin' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
      expect(screen.queryByText('Manage Hats')).not.toBeInTheDocument()
    })

    it('opens hats modal when clicking "Manage Hats"', () => {
      const room = createRoom({
        supportsHats: true,
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
      fireEvent.click(screen.getByText('Manage Hats'))

      expect(screen.getByTestId('hats-modal')).toBeInTheDocument()
    })

    it('closes the management dropdown when opening hats modal', () => {
      const room = createRoom({
        supportsHats: true,
        occupantsList: [createOccupant({ nick: 'Me', affiliation: 'owner' })],
      })

      render(
        <RoomHeader
          room={room}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
        />
      )

      pickRoomMenuEntry('Manage room')
      expect(screen.getByText('Room settings')).toBeInTheDocument()

      fireEvent.click(screen.getByText('Manage Hats'))

      // Dropdown should close, modal should be open
      expect(screen.queryByText('Room settings')).not.toBeInTheDocument()
      expect(screen.getByTestId('hats-modal')).toBeInTheDocument()
    })
  })

  describe('Saved in this room', () => {
    const saveHere = (jid: string) => savedStore.getState().save({
      id: 'sv1', conversationJid: jid, type: 'groupchat', from: `${jid}/Alice`, text: 'kept', savedAt: 1000, stanzaId: 's1', stanzaIdBy: jid,
    })
    const renderHeader = (onShowSaved = vi.fn()) => {
      render(
        <RoomHeader
          room={createRoom()}
          showOccupants={false}
          onToggleOccupants={mockOnToggleOccupants}
          setRoomNotifyLevel={mockSetRoomNotifyLevel}
          setRoomAvatar={mockSetRoomAvatar}
          clearRoomAvatar={mockClearRoomAvatar}
          submitRoomConfig={mockSubmitRoomConfig}
          setSubject={mockSetSubject}
          destroyRoom={mockDestroyRoom}
          onShowSavedInConversation={onShowSaved}
        />
      )
      return onShowSaved
    }
    beforeEach(() => { savedStore.getState().reset() })

    it('lists no Saved entry where nothing is saved', () => {
      renderHeader()
      expect(openRoomMenu().queryByText(/saved\.title/)).toBeNull()
    })

    it('lists the count in the ⋮ menu where something is saved here, and opens the Saved tab', () => {
      saveHere('room@conference.example.com')
      const onShowSaved = renderHeader()
      fireEvent.click(openRoomMenu().getByText('saved.title (1)'))
      expect(onShowSaved).toHaveBeenCalledTimes(1)
    })

    it('ignores messages saved from another conversation', () => {
      saveHere('other@conference.example.com')
      renderHeader()
      expect(openRoomMenu().queryByText(/saved\.title/)).toBeNull()
    })
  })
})
