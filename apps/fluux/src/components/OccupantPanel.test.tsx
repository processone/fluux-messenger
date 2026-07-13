import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { OccupantPanel } from './OccupantPanel'
import type { Room, RoomOccupant, Contact } from '@fluux/sdk'
import { useIgnoreStore } from '@fluux/sdk/react'
import { ignoreStore, type IgnoreState } from '@fluux/sdk/stores'
import { auroraSenderColor } from '@/utils/senderColor'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

// Mock hooks
const contextMenuMock = vi.hoisted(() => ({
  handleContextMenu: vi.fn((e: { preventDefault: () => void }) => e.preventDefault()),
  handleTouchStart: vi.fn(),
  handleTouchEnd: vi.fn(),
}))
vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({
    dragRegionProps: { 'data-tauri-drag-region': true },
  }),
  useContextMenu: () => ({
    isOpen: false,
    position: { x: 0, y: 0 },
    open: vi.fn(),
    close: vi.fn(),
    menuRef: { current: null },
    triggerHandlers: {},
    ...contextMenuMock,
  }),
  useTheme: () => ({
    isDark: true,
    mode: 'dark',
    resolvedMode: 'dark',
    setMode: vi.fn(),
    activeThemeId: 'aurora',
  }),
}))

// Mock Avatar component — exposes fallbackColor and fallbackTextColor as data attrs for assertions
vi.mock('./Avatar', () => ({
  Avatar: ({ name, presence, fallbackColor, fallbackTextColor }: { name: string; presence?: string; fallbackColor?: string; fallbackTextColor?: string }) => (
    <div data-testid="avatar" data-name={name} data-presence={presence} data-fallback-color={fallbackColor} data-fallback-text-color={fallbackTextColor}>
      Avatar: {name}
    </div>
  ),
}))

// Mock UserInfoPopover to avoid XMPPProvider dependency
vi.mock('./conversation/UserInfoPopover', () => ({
  UserInfoPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock @fluux/sdk functions
vi.mock('@fluux/sdk', async () => {
  const actual = await vi.importActual('@fluux/sdk')
  return {
    ...actual,
    getPresenceFromShow: (show: string | undefined) => show || 'online',
    getBareJid: (jid: string) => jid.split('/')[0],
    getBestPresenceShow: (shows: (string | undefined)[]) => shows[0],
    generateConsistentColorHexSync: () => '#abc123',
    useBlocking: () => ({
      blockedJids: [],
      fetchBlocklist: vi.fn(),
      blockJid: vi.fn(),
      unblockJid: vi.fn(),
      unblockAll: vi.fn(),
      isBlocked: () => false,
    }),
    useRoomActions: () => ({
      setAffiliation: vi.fn(),
      setRole: vi.fn(),
      queryAffiliationList: vi.fn(),
    }),
  }
})

// Mock @fluux/sdk/stores
vi.mock('@fluux/sdk/stores', () => ({
  ignoreStore: {
    getState: () => ({
      ignoredUsers: {},
      addIgnored: vi.fn(),
      removeIgnored: vi.fn(),
      isIgnored: () => false,
      getIgnoredForRoom: () => [],
    }),
    subscribe: vi.fn(() => vi.fn()),
  },
}))

// Mock presence utility
vi.mock('@/utils/presence', () => ({
  getTranslatedShowText: (show: string | undefined) => show || 'online',
}))

// Render ALL items: jsdom gives the scroll container 0 height and the test-setup
// ResizeObserver is a no-op, so the real virtualizer would window down to overscan and
// these "is X present?" assertions would break. The mock returns every item.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 44,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({ index, key: index, start: index * 44, size: 44 })),
    measureElement: () => {},
  }),
}))

// Helper to create a test room
const createRoom = (overrides: Partial<Room> = {}): Room => ({
  jid: 'room@conference.example.com',
  name: 'Test Room',
  nickname: 'Me',
  occupants: new Map(),
  messages: [],
  joined: true,
  unreadCount: 0,
  mentionsCount: 0,
  typingUsers: new Set(),
  isBookmarked: false,
  ...overrides,
})

// Helper to create an occupant
const createOccupant = (overrides: Partial<RoomOccupant> = {}): RoomOccupant => ({
  nick: 'User',
  role: 'participant',
  affiliation: 'none',
  ...overrides,
})

// Helper to create a contact
const createContact = (overrides: Partial<Contact> = {}): Contact => ({
  jid: 'user@example.com',
  name: 'User Name',
  presence: 'online',
  subscription: 'both',
  ...overrides,
})

describe('OccupantPanel', () => {
  describe('Basic Rendering', () => {
    it('renders panel header with members title', () => {
      const room = createRoom()
      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('rooms.members')).toBeInTheDocument()
    })

    it('renders close button', () => {
      const room = createRoom()
      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Close button is in the header, find by the X icon
      const closeButton = container.querySelector('.h-14 button')
      expect(closeButton).toBeInTheDocument()
    })

    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn()
      const room = createRoom()
      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={onClose}
        />
      )

      const closeButton = container.querySelector('.h-14 button')
      fireEvent.click(closeButton!)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('shows empty state when no occupants', () => {
      const room = createRoom({ occupants: new Map() })
      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('rooms.noMembersInRoom')).toBeInTheDocument()
    })
  })

  describe('Role Grouping', () => {
    it('groups occupants by role', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['mod@room', createOccupant({ nick: 'Moderator', role: 'moderator' })],
        ['part@room', createOccupant({ nick: 'Participant', role: 'participant' })],
        ['vis@room', createOccupant({ nick: 'Visitor', role: 'visitor' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('rooms.moderators')).toBeInTheDocument()
      expect(screen.getByText('rooms.participants')).toBeInTheDocument()
      expect(screen.getByText('rooms.visitors')).toBeInTheDocument()
    })

    it('shows occupant count per role', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['mod1@room', createOccupant({ nick: 'Mod1', role: 'moderator' })],
        ['mod2@room', createOccupant({ nick: 'Mod2', role: 'moderator' })],
        ['part@room', createOccupant({ nick: 'Part', role: 'participant' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Check count displays as standalone accent spans (no em-dash)
      expect(screen.getByText('2')).toBeInTheDocument()
      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('sorts occupants by role priority then alphabetically', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['z@room', createOccupant({ nick: 'Zara', role: 'participant' })],
        ['a@room', createOccupant({ nick: 'Alice', role: 'moderator' })],
        ['b@room', createOccupant({ nick: 'Bob', role: 'participant' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const nicks = screen.getAllByTestId('avatar').map(el => el.getAttribute('data-name'))
      // Moderator first (Alice), then participants alphabetically (Bob, Zara)
      expect(nicks).toEqual(['Alice', 'Bob', 'Zara'])
    })
  })

  describe('Occupant Display', () => {
    it('renders occupant nick', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'TestUser' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('TestUser')).toBeInTheDocument()
    })

    it('renders avatar with presence', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'User', show: 'away' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const avatar = screen.getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-name', 'User')
      expect(avatar).toHaveAttribute('data-presence', 'away')
    })

    it('highlights current user with "(you)" label', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['me@room', createOccupant({ nick: 'Me' })],
        ['other@room', createOccupant({ nick: 'Other' })],
      ])
      const room = createRoom({ occupants, nickname: 'Me' })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('rooms.you')).toBeInTheDocument()
    })

    it('suppresses the native context menu on own row without opening the occupant menu', () => {
      contextMenuMock.handleContextMenu.mockClear()
      const occupants = new Map<string, RoomOccupant>([
        ['me@room', createOccupant({ nick: 'Me' })],
      ])
      const room = createRoom({ occupants, nickname: 'Me' })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // fireEvent returns false when preventDefault() was called
      const notCancelled = fireEvent.contextMenu(screen.getByText('rooms.you'))
      expect(notCancelled).toBe(false)
      expect(contextMenuMock.handleContextMenu).not.toHaveBeenCalled()
    })

    it('opens the occupant context menu on another occupant row', () => {
      contextMenuMock.handleContextMenu.mockClear()
      const occupants = new Map<string, RoomOccupant>([
        ['other@room', createOccupant({ nick: 'Other' })],
      ])
      const room = createRoom({ occupants, nickname: 'Me' })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      fireEvent.contextMenu(screen.getByText('Other'))
      expect(contextMenuMock.handleContextMenu).toHaveBeenCalledTimes(1)
    })

    it('shows bare JID when available', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'User', jid: 'user@example.com/resource' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('user@example.com')).toBeInTheDocument()
    })

    it('colors a non-self occupant name with its Aurora sender color', () => {
      // Use the real auroraSenderColor (not mocked) so the assertion proves byte-for-byte parity
      // with the message list. useTheme mock returns isDark: true.
      const expected = auroraSenderColor('Alice', true)
      const occupants = new Map<string, RoomOccupant>([
        ['alice@room', createOccupant({ nick: 'Alice' })],
      ])
      // room.nickname is 'Me' so Alice is non-self
      const room = createRoom({ occupants, nickname: 'Me' })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const name = screen.getByText('Alice')
      expect(name).toHaveStyle({ color: expected })
    })

    it('colors the Avatar fallbackColor of a non-self occupant with its Aurora sender color', () => {
      const expected = auroraSenderColor('Alice', true)
      const occupants = new Map<string, RoomOccupant>([
        ['alice@room', createOccupant({ nick: 'Alice' })],
      ])
      const room = createRoom({ occupants, nickname: 'Me' })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const avatar = screen.getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-fallback-color', expected)
    })
  })

  describe('Affiliation Badges', () => {
    it('shows owner badge', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['owner@room', createOccupant({ nick: 'Owner', affiliation: 'owner' })],
      ])
      const room = createRoom({ occupants })

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Owner badge has Crown icon with Aurora yellow token
      const ownerBadge = container.querySelector('.text-fluux-yellow')
      expect(ownerBadge).toBeInTheDocument()
    })

    it('shows admin badge', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['admin@room', createOccupant({ nick: 'Admin', affiliation: 'admin' })],
      ])
      const room = createRoom({ occupants })

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Admin badge has Shield icon with brand color
      const adminBadge = container.querySelector('.text-fluux-brand .lucide-shield')
      expect(adminBadge).toBeInTheDocument()
    })

    it('shows member badge', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['member@room', createOccupant({ nick: 'Member', affiliation: 'member' })],
      ])
      const room = createRoom({ occupants })

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Member badge has UserCheck icon with muted color (title disambiguates from role-header icon).
      // The i18n mock returns the key verbatim, so the title is the translation key.
      const memberBadge = container.querySelector('[title="rooms.affiliationMember"] .lucide-user-check')
      expect(memberBadge).toBeInTheDocument()
    })

    it('does not show badge for none affiliation', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'User', affiliation: 'none' })],
      ])
      const room = createRoom({ occupants })

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // No affiliation badges should be present within occupant rows
      // (user-check icon may appear in role header for 'participant' role)
      expect(container.querySelector('.lucide-crown')).not.toBeInTheDocument()
      expect(container.querySelector('.text-fluux-brand .lucide-shield')).not.toBeInTheDocument()
      // Check for member badge specifically: badge spans carry the affiliation title (headers don't)
      expect(container.querySelector('[title="rooms.affiliationMember"] .lucide-user-check')).not.toBeInTheDocument()
    })
  })

  describe('JID Grouping (Multiple Connections)', () => {
    it('groups multiple connections from same bare JID', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1@room', createOccupant({ nick: 'UserDesktop', jid: 'user@example.com/desktop' })],
        ['user2@room', createOccupant({ nick: 'UserMobile', jid: 'user@example.com/mobile' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Should show only one avatar (grouped)
      const avatars = screen.getAllByTestId('avatar')
      expect(avatars).toHaveLength(1)
    })

    it('shows connection count badge for multiple connections', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1@room', createOccupant({ nick: 'UserDesktop', jid: 'user@example.com/desktop' })],
        ['user2@room', createOccupant({ nick: 'UserMobile', jid: 'user@example.com/mobile' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('×2')).toBeInTheDocument()
    })

    it('uses best affiliation from all connections', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1@room', createOccupant({ nick: 'UserDesktop', jid: 'user@example.com/desktop', affiliation: 'none' })],
        ['user2@room', createOccupant({ nick: 'UserMobile', jid: 'user@example.com/mobile', affiliation: 'admin' })],
      ])
      const room = createRoom({ occupants })

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Should show admin badge (best affiliation) - Shield icon with brand color
      const adminBadge = container.querySelector('.text-fluux-brand .lucide-shield')
      expect(adminBadge).toBeInTheDocument()
    })

    it('keeps occupants without JID as separate entries', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1@room', createOccupant({ nick: 'Anonymous1' })],
        ['user2@room', createOccupant({ nick: 'Anonymous2' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Should show both avatars (not grouped)
      const avatars = screen.getAllByTestId('avatar')
      expect(avatars).toHaveLength(2)
    })
  })

  describe('XEP-0317 Hats', () => {
    it('renders hat badges with titles', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({
          nick: 'User',
          hats: [{ uri: 'xmpp:ejabberd@conference.process-one.net#Staff', title: 'Staff' }],
        })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('Staff')).toBeInTheDocument()
    })

    it('renders hat badge without individual tooltip (info in row tooltip)', () => {
      const hatUri = 'xmpp:ejabberd@conference.process-one.net#Staff'
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({
          nick: 'User',
          hats: [{ uri: hatUri, title: 'Staff' }],
        })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Hat badge renders text, tooltip info is now in unified row tooltip (via Tooltip component)
      expect(screen.getByText('Staff')).toBeInTheDocument()
    })

    it('collects unique hats from all connections', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1@room', createOccupant({
          nick: 'UserDesktop',
          jid: 'user@example.com/desktop',
          hats: [{ uri: 'urn:hat:staff', title: 'Staff' }],
        })],
        ['user2@room', createOccupant({
          nick: 'UserMobile',
          jid: 'user@example.com/mobile',
          hats: [{ uri: 'urn:hat:moderator', title: 'Moderator' }],
        })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(screen.getByText('Staff')).toBeInTheDocument()
      expect(screen.getByText('Moderator')).toBeInTheDocument()
    })

    it('uses server-provided hue for hat color when available', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({
          nick: 'User',
          hats: [{ uri: 'urn:hat:staff', title: 'Staff', hue: 200 }],
        })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const hatBadge = screen.getByText('Staff')
      expect(hatBadge).toHaveStyle({ backgroundColor: 'hsl(200, 50%, 85%)' })
    })
  })

  describe('Contact Avatars', () => {
    it('uses contact avatar when occupant JID is in roster', () => {
      const bareJid = 'user@example.com'
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'User', jid: `${bareJid}/resource` })],
      ])
      const room = createRoom({ occupants })

      const contactsByJid = new Map<string, Contact>([
        [bareJid, createContact({ jid: bareJid, avatar: 'https://example.com/avatar.png' })],
      ])

      render(
        <OccupantPanel
          room={room}
          contactsByJid={contactsByJid}
          onClose={() => {}}
        />
      )

      // The Avatar mock receives avatarUrl prop - verify occupant is rendered
      expect(screen.getByTestId('avatar')).toBeInTheDocument()
    })
  })

  describe('Tooltips', () => {
    it('renders occupant with role and presence info (uses custom Tooltip)', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['mod@room', createOccupant({ nick: 'Mod', role: 'moderator', show: 'away' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Verify the occupant row renders (tooltip content is portal-based)
      expect(screen.getByText('Mod')).toBeInTheDocument()
      expect(screen.getByTestId('avatar')).toBeInTheDocument()
    })

    it('renders grouped occupants with connection count (uses custom Tooltip)', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['user1@room', createOccupant({ nick: 'UserDesktop', jid: 'user@example.com/desktop' })],
        ['user2@room', createOccupant({ nick: 'UserMobile', jid: 'user@example.com/mobile' })],
      ])
      const room = createRoom({ occupants })

      render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Verify the grouped occupant renders with connection count badge
      expect(screen.getByText('UserDesktop')).toBeInTheDocument()
      expect(screen.getByText('×2')).toBeInTheDocument()
    })
  })

  describe('Ignored Users', () => {
    // Store original mock implementations to restore after each test
    let originalUseIgnoreStore: ((...args: any[]) => any) | undefined
    let originalIgnoreStoreGetState: typeof ignoreStore.getState

    beforeEach(() => {
      originalUseIgnoreStore = vi.mocked(useIgnoreStore).getMockImplementation()
      originalIgnoreStoreGetState = ignoreStore.getState
    })

    afterEach(() => {
      // Restore original mock implementations
      if (originalUseIgnoreStore) {
        vi.mocked(useIgnoreStore).mockImplementation(originalUseIgnoreStore)
      }
      ;(ignoreStore as { getState: typeof ignoreStore.getState }).getState = originalIgnoreStoreGetState
    })

    /** Helper: configure mocks so a specific occupant is ignored in the room */
    const setupIgnoredUser = (roomJid: string, identifier: string, displayName: string, jid?: string) => {
      const ignoredUser = { identifier, displayName, jid }
      const ignoredUsers = { [roomJid]: [ignoredUser] }

      // Override useIgnoreStore to return our ignored users
      vi.mocked(useIgnoreStore).mockImplementation(((selector?: (state: IgnoreState) => unknown) => {
        const state = {
          ignoredUsers,
          addIgnored: vi.fn(),
          removeIgnored: vi.fn(),
          setIgnoredForRoom: vi.fn(),
          isIgnored: (rjid: string, id: string) => rjid === roomJid && id === identifier,
          getIgnoredForRoom: (rjid: string) => rjid === roomJid ? [ignoredUser] : [],
          rehydrate: vi.fn(),
          reset: vi.fn(),
        } as IgnoreState
        return selector ? selector(state) : state
      }) as unknown as typeof useIgnoreStore)

      // Override ignoreStore.getState for the imperative calls in handleToggleIgnore
      ;(ignoreStore as { getState: typeof ignoreStore.getState }).getState = () => ({
        ignoredUsers,
        addIgnored: vi.fn(),
        removeIgnored: vi.fn(),
        setIgnoredForRoom: vi.fn(),
        isIgnored: (rjid: string, id: string) => rjid === roomJid && id === identifier,
        getIgnoredForRoom: (rjid: string) => rjid === roomJid ? [ignoredUser] : [],
        rehydrate: vi.fn(),
        reset: vi.fn(),
      })
    }

    it('applies opacity class to ignored occupant', () => {
      const roomJid = 'room@conference.example.com'
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'IgnoredUser', occupantId: 'occ-id-123' })],
        ['other@room', createOccupant({ nick: 'NormalUser', occupantId: 'occ-id-456' })],
      ])
      const room = createRoom({ jid: roomJid, occupants })

      setupIgnoredUser(roomJid, 'occ-id-123', 'IgnoredUser')

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // Find occupant rows by their text content
      const rows = container.querySelectorAll('.px-4.py-1\\.5')
      const ignoredRow = Array.from(rows).find(row => row.textContent?.includes('IgnoredUser'))
      const normalRow = Array.from(rows).find(row => row.textContent?.includes('NormalUser'))

      expect(ignoredRow).toHaveClass('opacity-40')
      expect(normalRow).not.toHaveClass('opacity-40')
    })

    it('shows EyeOff icon for ignored occupant', () => {
      const roomJid = 'room@conference.example.com'
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'IgnoredUser', occupantId: 'occ-id-123' })],
      ])
      const room = createRoom({ jid: roomJid, occupants })

      setupIgnoredUser(roomJid, 'occ-id-123', 'IgnoredUser')

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      // EyeOff icon should be rendered (lucide renders as svg with class lucide-eye-off)
      const eyeOffIcon = container.querySelector('.lucide-eye-off')
      expect(eyeOffIcon).toBeInTheDocument()
    })

    it('does not show EyeOff icon for non-ignored occupant', () => {
      // Default mock returns empty ignoredUsers, so no one is ignored
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'NormalUser', occupantId: 'occ-id-456' })],
      ])
      const room = createRoom({ occupants })

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const eyeOffIcon = container.querySelector('.lucide-eye-off')
      expect(eyeOffIcon).not.toBeInTheDocument()
    })

    it('matches ignored user by bare JID when no occupantId', () => {
      const roomJid = 'room@conference.example.com'
      const occupants = new Map<string, RoomOccupant>([
        ['user@room', createOccupant({ nick: 'Alice', jid: 'alice@example.com/desktop' })],
      ])
      const room = createRoom({ jid: roomJid, occupants })

      // Ignore by bare JID (occupant has no occupantId)
      setupIgnoredUser(roomJid, 'alice@example.com', 'Alice', 'alice@example.com')

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const rows = container.querySelectorAll('.px-4.py-1\\.5')
      const aliceRow = Array.from(rows).find(row => row.textContent?.includes('Alice'))
      expect(aliceRow).toHaveClass('opacity-40')
    })

    it('matches ignored user by nick when no occupantId or JID', () => {
      const roomJid = 'room@conference.example.com'
      const occupants = new Map<string, RoomOccupant>([
        ['anon@room', createOccupant({ nick: 'AnonUser' })],
      ])
      const room = createRoom({ jid: roomJid, occupants })

      // Ignore by nick (no occupantId, no JID)
      setupIgnoredUser(roomJid, 'AnonUser', 'AnonUser')

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const rows = container.querySelectorAll('.px-4.py-1\\.5')
      const anonRow = Array.from(rows).find(row => row.textContent?.includes('AnonUser'))
      expect(anonRow).toHaveClass('opacity-40')
    })
  })

  describe('Section Header Chrome', () => {
    it('renders a hairline section header with the count in the accent and no em-dash', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['mod@room', createOccupant({ nick: 'Moderator', role: 'moderator' })],
      ])
      const room = createRoom({ occupants })

      const { getByText } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      const header = getByText('rooms.moderators').closest('div')!
      expect(header.className).toMatch(/border-t/)        // hairline rule
      expect(header.textContent).not.toContain('—')        // no em-dash
    })

    it('does not use hardcoded amber for the owner affiliation badge', () => {
      const occupants = new Map<string, RoomOccupant>([
        ['owner@room', createOccupant({ nick: 'Owner', affiliation: 'owner' })],
      ])
      const room = createRoom({ occupants })

      const { container } = render(
        <OccupantPanel
          room={room}
          contactsByJid={new Map()}
          onClose={() => {}}
        />
      )

      expect(container.innerHTML).not.toContain('text-amber-600')
    })
  })
})
