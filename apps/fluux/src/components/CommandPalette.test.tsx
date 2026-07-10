import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

// Mock scrollIntoView which is not implemented in jsdom
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// Mock data
const mockConversations: Array<{ id: string; name: string; unreadCount: number; type: 'chat'; lastMessage?: { body: string; timestamp: Date } }> = [
  { id: 'alice@example.com', name: 'Alice Smith', unreadCount: 0, type: 'chat', lastMessage: { body: 'Can we discuss the deployment?', timestamp: new Date('2026-07-07T09:00:00Z') } },
  { id: 'bob@example.com', name: 'Bob Jones', unreadCount: 2, type: 'chat', lastMessage: { body: 'The exponential backoff is working now', timestamp: new Date('2026-07-07T10:00:00Z') } },
]

const mockRooms: Array<{ jid: string; name: string; joined: boolean; unreadCount?: number; mentionsCount?: number; lastMessage?: { body: string; timestamp?: Date } }> = [
  { jid: 'dev@conference.example.com', name: 'Development', joined: true, unreadCount: 0, mentionsCount: 0, lastMessage: { body: 'PR merged successfully', timestamp: new Date('2026-07-07T08:00:00Z') } },
  { jid: 'general@conference.example.com', name: 'General Chat', joined: true, unreadCount: 3, mentionsCount: 0 },
  { jid: 'announce@conference.example.com', name: 'Announcements', joined: true, unreadCount: 1, mentionsCount: 1, lastMessage: { body: 'Release is out', timestamp: new Date('2026-07-07T11:00:00Z') } },
]

const mockBookmarkedRooms = [
  { jid: 'archived@conference.example.com', name: 'Archived Room', joined: false },
]

const mockContacts = [
  { jid: 'charlie@example.com', name: 'Charlie Brown' },
  { jid: 'diana@example.com', name: 'Diana Prince' },
]

const mockSetActiveConversation = vi.fn()
const mockSetActiveRoom = vi.fn()
const mockIsArchived = vi.fn((_jid: string) => false)
let mockArchivedConversations: typeof mockConversations = []
let mockActiveConversationId: string | null = null
let mockActiveRoomJid: string | null = null

// Mock SDK hooks
const mockSearchFn = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useChat: () => ({
    conversations: mockConversations,
    archivedConversations: mockArchivedConversations,
    isArchived: (jid: string) => mockIsArchived(jid),
  }),
  useRoom: () => ({
    joinedRooms: mockRooms,
    bookmarkedRooms: mockBookmarkedRooms,
    setActiveRoom: mockSetActiveRoom,
  }),
  useRoster: () => ({
    contacts: mockContacts,
  }),
  // JID utilities moved from app to SDK
  getLocalPart: (jid: string) => jid.split('@')[0],
  matchNameOrJid: (name: string, jid: string, query: string) => {
    const lowerQuery = query.toLowerCase()
    const nameMatch = name.toLowerCase().includes(lowerQuery)
    const usernameMatch = jid.split('@')[0].toLowerCase().includes(lowerQuery)
    return nameMatch || usernameMatch
  },
  formatMessagePreview: (msg: { body?: string }) => msg?.body || '',
  searchStore: { getState: () => ({ search: mockSearchFn }) },
  // Entity rows now render <Avatar>, which derives its fallback color from this.
  generateConsistentColorHexSync: () => '#888888',
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => {
  // Selector-aware: called bare (`useChatStore()`) returns the state object;
  // called with a selector returns the selected slice.
  const chatState = () => ({
    setActiveConversation: mockSetActiveConversation,
    activeConversationId: mockActiveConversationId,
  })
  const roomState = () => ({ activeRoomJid: mockActiveRoomJid })
  return {
    useChatStore: (selector?: (s: ReturnType<typeof chatState>) => unknown) =>
      selector ? selector(chatState()) : chatState(),
    useRoomStore: (selector?: (s: ReturnType<typeof roomState>) => unknown) =>
      selector ? selector(roomState()) : roomState(),
    useConnectionStore: (selector: (state: { status: string }) => unknown) =>
      selector({ status: 'online' }),
    useContactTime: () => null, useLastActivity: vi.fn(),
  }
})

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'commandPalette.placeholder': 'Go to...',
        'commandPalette.noResults': 'No results found',
        'commandPalette.views': 'Views',
        'commandPalette.actions': 'Actions',
        'commandPalette.navigate': 'to navigate',
        'commandPalette.select': 'to select',
        'commandPalette.filterContacts': 'contacts',
        'commandPalette.filterRooms': 'rooms',
        'commandPalette.filterCommands': 'commands',
        'commandPalette.filteringContacts': 'Filtering contacts...',
        'commandPalette.filteringRooms': 'Filtering rooms...',
        'commandPalette.filteringCommands': 'Filtering commands...',
        'commandPalette.searchMessages': 'Search messages for "{{query}}"',
        'commandPalette.attention': 'Needs attention',
        'sidebar.messages': 'Messages',
        'sidebar.rooms': 'Rooms',
        'sidebar.connections': 'Connections',
        'sidebar.contacts': 'Contacts',
        'sidebar.archive': 'Archive',
        'sidebar.events': 'Events',
        'sidebar.settings': 'Settings',
        'rooms.bookmarked': 'Bookmarked',
        'rooms.createQuickChat': 'Create Quick Chat',
        'rooms.joinRoom': 'Join Room',
        'contacts.addContact': 'Add Contact',
        'shortcuts.title': 'Keyboard Shortcuts',
        'console.title': 'XMPP Console',
      }
      let result = translations[key] || key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          result = result.replace(`{{${k}}}`, v)
        }
      }
      return result
    },
  }),
}))

describe('CommandPalette', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSidebarViewChange: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleConsole: vi.fn(),
    onToggleShortcutHelp: vi.fn(),
    onCreateQuickChat: vi.fn(),
    onAddContact: vi.fn(),
    onStartConversation: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsArchived.mockReturnValue(false)
    mockArchivedConversations = []
    mockActiveConversationId = null
    mockActiveRoomJid = null
    useAdvancedModeStore.setState({ advancedMode: false })
  })

  describe('Rendering', () => {
    it('should not render when closed', () => {
      render(<CommandPalette {...defaultProps} isOpen={false} />)
      expect(screen.queryByPlaceholderText('Go to...')).not.toBeInTheDocument()
    })

    it('should render when open', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByPlaceholderText('Go to...')).toBeInTheDocument()
    })

    it('should show search input with placeholder', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByPlaceholderText('Go to...')).toBeInTheDocument()
    })

    it('should show navigation hints in footer', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('to navigate')).toBeInTheDocument()
      expect(screen.getByText('to select')).toBeInTheDocument()
    })

    it('should show esc key hint', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('esc')).toBeInTheDocument()
    })
  })

  describe('Item Display', () => {
    it('should display conversations', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
    })

    it('should display joined rooms', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('Development')).toBeInTheDocument()
      expect(screen.getByText('General Chat')).toBeInTheDocument()
    })

    it('renders room rows with a rounded-square avatar, never a circle', () => {
      render(<CommandPalette {...defaultProps} />)
      // "Development" has unreadCount 0 and mentionsCount 0, so its row has no
      // unread badge (badges are rounded-full) — the only shaped element is its avatar.
      const row = screen.getByText('Development').closest('button')!
      // Room avatars use a proportional rounded-square radius (rounded-[28%]), never a circle.
      expect(row.querySelector('[class*="rounded-[28%]"]')).not.toBeNull()
      expect(row.querySelector('.rounded-full')).toBeNull()
    })

    it('should NOT display contacts without a conversation in the default view', () => {
      render(<CommandPalette {...defaultProps} />)
      // The empty-query view surfaces threads/views/actions only, not roster padding.
      expect(screen.queryByText('Charlie Brown')).not.toBeInTheDocument()
      expect(screen.queryByText('Diana Prince')).not.toBeInTheDocument()
    })

    it('should surface a contact without a conversation once the user types', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')
      fireEvent.change(input, { target: { value: 'charlie' } })
      expect(screen.getByText('Charlie Brown')).toBeInTheDocument()
    })

    it('should display view options', () => {
      render(<CommandPalette {...defaultProps} />)
      // Views group label
      expect(screen.getByText('Views')).toBeInTheDocument()
    })

    it('should display action options', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('Actions')).toBeInTheDocument()
      expect(screen.getByText('Create Quick Chat')).toBeInTheDocument()
    })

    it('should show group labels', () => {
      render(<CommandPalette {...defaultProps} />)
      // Group labels are uppercase with specific styling
      const groupLabels = document.querySelectorAll('.uppercase.tracking-wide')
      const labelTexts = Array.from(groupLabels).map(el => el.textContent)
      expect(labelTexts).toContain('Messages')
      expect(labelTexts).toContain('Rooms')
      // Contacts group is no longer part of the default view.
      expect(labelTexts).not.toContain('Contacts')
    })

    it('should show last message preview for conversations', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('Can we discuss the deployment?')).toBeInTheDocument()
      expect(screen.getByText('The exponential backoff is working now')).toBeInTheDocument()
    })

    it('should show last message preview for rooms', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('PR merged successfully')).toBeInTheDocument()
    })

    it('should not show preview when conversation has no lastMessage', () => {
      render(<CommandPalette {...defaultProps} />)
      // General Chat room has no lastMessage — should only show JID, not a preview
      const generalChatJid = screen.getByText('general@conference.example.com')
      // The next sibling should not be a preview line
      const parentDiv = generalChatJid.closest('.min-w-0')
      const italicElements = parentDiv?.querySelectorAll('.italic')
      expect(italicElements?.length ?? 0).toBe(0)
    })

    it('renders an entity avatar (consistent-color initial) for conversation rows, not a generic icon', () => {
      render(<CommandPalette {...defaultProps} />)
      const aliceRow = screen.getByText('Alice Smith').closest('button')!
      // Mock data has no avatar image, so the Avatar shows its colored-letter fallback.
      // There must be no <img> and no lucide icon <svg> — the old generic icon is gone.
      expect(aliceRow.querySelector('img')).toBeFalsy()
      expect(aliceRow.querySelector('svg')).toBeFalsy()
      const avatarBg = aliceRow.querySelector('[style*="background"]')
      expect(avatarBg?.textContent).toBe('A')
    })

    it('renders a Hash-glyph avatar fallback for rooms without an avatar image', () => {
      render(<CommandPalette {...defaultProps} />)
      const devRoom = screen.getByText('Development').closest('button')!
      // Rooms render the Avatar with a Hash fallbackIcon (an <svg>) on a colored circle.
      const avatarBg = devRoom.querySelector('[style*="background"]')
      expect(avatarBg?.querySelector('svg')).toBeTruthy()
    })
  })

  describe('Search Filtering', () => {
    it('should filter items by label', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'alice' } })

      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument()
    })

    it('should filter items by JID username (not domain)', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // Search by username part of JID only (bob), not the full JID with domain
      fireEvent.change(input, { target: { value: 'bob' } })

      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
      expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
    })

    it('should not match on JID domain', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // Searching for domain should not match conversations/contacts
      fireEvent.change(input, { target: { value: 'example.com' } })

      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument()
      expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
    })

    it('should filter items by keywords', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // 'muc' is a keyword for rooms
      fireEvent.change(input, { target: { value: 'muc' } })

      expect(screen.getByText('Development')).toBeInTheDocument()
      expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
    })

    it('should show search gateway when nothing matches by name', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'xyznonexistent' } })

      // No name/JID matches, but the search gateway item should appear
      expect(screen.queryByText('No results found')).not.toBeInTheDocument()
      expect(screen.getByText(/Search messages for/)).toBeInTheDocument()
    })

    it('should be case insensitive', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'ALICE' } })

      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    })

    it('should filter by action keywords', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'settings' } })

      expect(screen.getByText('Settings')).toBeInTheDocument()
    })

    it('should match conversations by last message body', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // 'backoff' is in Bob's last message, not in his name or JID
      fireEvent.change(input, { target: { value: 'backoff' } })

      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
      expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
    })

    it('should match rooms by last message body', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // 'merged' is in Development room's last message
      fireEvent.change(input, { target: { value: 'merged' } })

      expect(screen.getByText('Development')).toBeInTheDocument()
      expect(screen.queryByText('General Chat')).not.toBeInTheDocument()
    })

    it('should show search gateway with interpolated query', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'hello world' } })

      expect(screen.getByText('Search messages for "hello world"')).toBeInTheDocument()
    })

    it('should not show search gateway when using > prefix', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: '>nonexistent' } })

      expect(screen.queryByText(/Search messages for/)).not.toBeInTheDocument()
    })

    it('should show search gateway alongside name matches', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'alice' } })

      // Both the name match and the gateway should appear
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.getByText('Search messages for "alice"')).toBeInTheDocument()
    })
  })

  describe('Keyboard Navigation', () => {
    it('should select first item by default', () => {
      render(<CommandPalette {...defaultProps} />)

      // Announcements (mention, 11:00) leads the Needs attention group, ahead of
      // Bob's DM (10:00) — interleaved by recency.
      const firstItem = screen.getByText('Announcements').closest('button')
      expect(firstItem).toHaveAttribute('data-selected', 'true')
    })

    it('should move selection down with ArrowDown', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Second item is Bob (still in the Needs attention group, after Announcements)
      const secondItem = screen.getByText('Bob Jones').closest('button')
      expect(secondItem).toHaveAttribute('data-selected', 'true')
    })

    it('should move selection up with ArrowUp', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Move down first (index 0 -> 1 -> 2, i.e. Announcements -> Bob -> Alice)
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Then move up
      fireEvent.keyDown(container!, { key: 'ArrowUp' })

      // Back to index 1 = Bob (Needs attention group)
      const secondItem = screen.getByText('Bob Jones').closest('button')
      expect(secondItem).toHaveAttribute('data-selected', 'true')
    })

    it('should not go below the last item', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Press down many times
      for (let i = 0; i < 50; i++) {
        fireEvent.keyDown(container!, { key: 'ArrowDown' })
      }

      // Should still have a selected item (not crash)
      const selectedItems = document.querySelectorAll('[data-selected="true"]')
      expect(selectedItems.length).toBe(1)
    })

    it('should not go above the first item', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Press up many times
      for (let i = 0; i < 10; i++) {
        fireEvent.keyDown(container!, { key: 'ArrowUp' })
      }

      // First item should still be selected (Announcements, leading the Needs attention group)
      const firstItem = screen.getByText('Announcements').closest('button')
      expect(firstItem).toHaveAttribute('data-selected', 'true')
    })

    it('should close on Escape', () => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      fireEvent.keyDown(container!, { key: 'Escape' })

      expect(defaultProps.onClose).toHaveBeenCalled()
      document.documentElement.removeAttribute('data-motion')
    })

    it('should close on Cmd+K (toggle)', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      fireEvent.keyDown(container!, { key: 'k', metaKey: true })

      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should close on Ctrl+K (toggle)', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      fireEvent.keyDown(container!, { key: 'k', ctrlKey: true })

      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should execute action on Enter', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      fireEvent.keyDown(container!, { key: 'Enter' })

      // First item is Announcements (mention room, leading the Needs attention group),
      // should set active room
      expect(mockSetActiveRoom).toHaveBeenCalledWith('announce@conference.example.com')
      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should reset selection when query changes', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')
      const container = input.closest('div')?.parentElement

      // Move selection down
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Type to filter
      fireEvent.change(input, { target: { value: 'dev' } })

      // First matching item should be selected
      const devRoom = screen.getByText('Development').closest('button')
      expect(devRoom).toHaveAttribute('data-selected', 'true')
    })
  })

  describe('Mouse Interaction', () => {
    it('should select item on hover', async () => {
      render(<CommandPalette {...defaultProps} />)

      // Wait for the mouse guard to be cleared (requestAnimationFrame)
      await act(async () => {
        await new Promise(r => requestAnimationFrame(r))
      })

      const bobItem = screen.getByText('Bob Jones').closest('button')
      fireEvent.mouseEnter(bobItem!)

      expect(bobItem).toHaveAttribute('data-selected', 'true')
    })

    it('should execute action on click', () => {
      render(<CommandPalette {...defaultProps} />)

      const bobItem = screen.getByText('Bob Jones').closest('button')
      fireEvent.click(bobItem!)

      expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should close on backdrop click', () => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      render(<CommandPalette {...defaultProps} />)

      // Click on the backdrop (the outer div)
      const backdrop = screen.getByPlaceholderText('Go to...').closest('.fixed')!
      // The dismiss affordance is now a full-overlay backdrop <button> (first child)
      fireEvent.click(backdrop.querySelector('button')!)

      expect(defaultProps.onClose).toHaveBeenCalled()
      document.documentElement.removeAttribute('data-motion')
    })

    it('should not close when clicking inside the palette', () => {
      render(<CommandPalette {...defaultProps} />)

      const input = screen.getByPlaceholderText('Go to...')
      fireEvent.click(input)

      expect(defaultProps.onClose).not.toHaveBeenCalled()
    })
  })

  describe('Action Execution', () => {
    it('should open room when room item is selected', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // Filter to rooms
      fireEvent.change(input, { target: { value: 'Development' } })

      const devRoom = screen.getByText('Development').closest('button')
      fireEvent.click(devRoom!)

      expect(mockSetActiveRoom).toHaveBeenCalledWith('dev@conference.example.com')
      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      expect(defaultProps.onSidebarViewChange).toHaveBeenCalledWith('rooms')
      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should start conversation with contact', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'Charlie' } })

      const charlieItem = screen.getByText('Charlie Brown').closest('button')
      fireEvent.click(charlieItem!)

      expect(defaultProps.onStartConversation).toHaveBeenCalledWith('charlie@example.com')
      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should open settings when settings action is selected', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'settings' } })

      const settingsItem = screen.getByText('Settings').closest('button')
      fireEvent.click(settingsItem!)

      expect(defaultProps.onOpenSettings).toHaveBeenCalled()
      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should toggle console when console action is selected', () => {
      useAdvancedModeStore.setState({ advancedMode: true })
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'console' } })

      const consoleItem = screen.getByText('XMPP Console').closest('button')
      fireEvent.click(consoleItem!)

      expect(defaultProps.onToggleConsole).toHaveBeenCalled()
      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should create quick chat when action is selected', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'quick chat' } })

      const quickChatItem = screen.getByText('Create Quick Chat').closest('button')
      fireEvent.click(quickChatItem!)

      expect(defaultProps.onCreateQuickChat).toHaveBeenCalled()
      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('should change sidebar view when view is selected', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'rooms' } })

      const roomsItem = screen.getByText('Rooms').closest('button')
      fireEvent.click(roomsItem!)

      expect(defaultProps.onSidebarViewChange).toHaveBeenCalledWith('rooms')
      expect(defaultProps.onClose).toHaveBeenCalled()
    })
  })

  describe('Focus Management', () => {
    it('should clear query when reopened', () => {
      const { rerender } = render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // Type something
      fireEvent.change(input, { target: { value: 'test query' } })
      expect(input).toHaveValue('test query')

      // Close and reopen
      rerender(<CommandPalette {...defaultProps} isOpen={false} />)
      rerender(<CommandPalette {...defaultProps} isOpen={true} />)

      const newInput = screen.getByPlaceholderText('Go to...')
      expect(newInput).toHaveValue('')
    })

    it('should reset selection when reopened', () => {
      const { rerender } = render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Move selection down
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Close and reopen
      rerender(<CommandPalette {...defaultProps} isOpen={false} />)
      rerender(<CommandPalette {...defaultProps} isOpen={true} />)

      // First item should be selected again (Announcements, leading the Needs attention group)
      const firstItem = screen.getByText('Announcements').closest('button')
      expect(firstItem).toHaveAttribute('data-selected', 'true')
    })
  })

  describe('Bookmarked Rooms', () => {
    it('should display bookmarked but not joined rooms', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'archived room' } })

      expect(screen.getByText('Archived Room')).toBeInTheDocument()
    })

    it('should show bookmarked indicator in sublabel', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'archived room' } })

      expect(screen.getByText(/Bookmarked/)).toBeInTheDocument()
    })
  })

  describe('Selection Consistency (regression tests)', () => {
    it('should select the correct item after navigating down and pressing Enter', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Navigate to Alice Smith (third item — Announcements then Bob lead the
      // Needs attention group, ahead of Alice in the Messages section)
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Verify Alice is selected
      const aliceItem = screen.getByText('Alice Smith').closest('button')
      expect(aliceItem).toHaveAttribute('data-selected', 'true')

      // Press Enter - should select Alice, not Bob
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.com')
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith('bob@example.com')
    })

    it('should work correctly on consecutive selections after reopening', () => {
      const { rerender } = render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // First selection: Announcements (first item, leading the Needs attention group)
      fireEvent.keyDown(container!, { key: 'Enter' })
      expect(mockSetActiveRoom).toHaveBeenLastCalledWith('announce@conference.example.com')

      vi.clearAllMocks()

      // Close and reopen
      rerender(<CommandPalette {...defaultProps} isOpen={false} />)
      rerender(<CommandPalette {...defaultProps} isOpen={true} />)

      const container2 = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Navigate to Bob (index 1) and select
      fireEvent.keyDown(container2!, { key: 'ArrowDown' })
      fireEvent.keyDown(container2!, { key: 'Enter' })

      expect(mockSetActiveConversation).toHaveBeenLastCalledWith('bob@example.com')
    })

    it('should select correct item after filtering and navigating', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')
      const container = input.closest('div')?.parentElement

      // Filter to show rooms
      fireEvent.change(input, { target: { value: 'dev' } })

      // First item after filter should be Development room
      const devRoom = screen.getByText('Development').closest('button')
      expect(devRoom).toHaveAttribute('data-selected', 'true')

      // Press Enter
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveRoom).toHaveBeenCalledWith('dev@conference.example.com')
    })

    it('should select correct item after multiple filter changes', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')
      const container = input.closest('div')?.parentElement

      // First filter
      fireEvent.change(input, { target: { value: 'alice' } })
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()

      // Change filter
      fireEvent.change(input, { target: { value: 'bob' } })
      expect(screen.getByText('Bob Jones')).toBeInTheDocument()

      // Bob should be selected (first in filtered list)
      const bobItem = screen.getByText('Bob Jones').closest('button')
      expect(bobItem).toHaveAttribute('data-selected', 'true')

      // Press Enter
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
    })

    it('should maintain correct selection after multiple arrow key presses', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Navigate down 3 times, up 1 time (should be at index 2)
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowUp' })

      // Third item in the list should be Alice (read DM, in the Messages section)
      // Order: Announcements + Bob (Needs attention), Alice (Messages), General Chat (Rooms tier 1), Development (tier 2)...
      const aliceItem = screen.getByText('Alice Smith').closest('button')
      expect(aliceItem).toHaveAttribute('data-selected', 'true')

      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should work correctly with rapid consecutive selections', () => {
      const { rerender } = render(<CommandPalette {...defaultProps} />)

      // Perform multiple selections in quick succession
      for (let i = 0; i < 3; i++) {
        vi.clearAllMocks()

        const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

        // Navigate down to the second item (Bob, still in the Needs attention group)
        // then select — exercises index-tracking under rapid reopen, not just Enter-on-first.
        fireEvent.keyDown(container!, { key: 'ArrowDown' })
        fireEvent.keyDown(container!, { key: 'Enter' })

        expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')

        // Close and reopen
        rerender(<CommandPalette {...defaultProps} isOpen={false} />)
        rerender(<CommandPalette {...defaultProps} isOpen={true} />)
      }
    })

    it('should select highlighted item correctly when using mouse then keyboard', async () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Wait for the mouse guard to be cleared (requestAnimationFrame)
      await act(async () => {
        await new Promise(r => requestAnimationFrame(r))
      })

      // Hover over Bob to select it
      const bobItem = screen.getByText('Bob Jones').closest('button')
      fireEvent.mouseEnter(bobItem!)

      expect(bobItem).toHaveAttribute('data-selected', 'true')

      // Press Enter - should select Bob (the hovered item)
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
    })
  })

  describe('Balanced Default View', () => {
    it('should show a mix of item types when no query is entered', () => {
      render(<CommandPalette {...defaultProps} />)

      // Should show conversations
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.getByText('Bob Jones')).toBeInTheDocument()

      // Should NOT show contacts without a conversation (roster padding removed)
      expect(screen.queryByText('Charlie Brown')).not.toBeInTheDocument()

      // Should show rooms
      expect(screen.getByText('Development')).toBeInTheDocument()

      // Should show views
      expect(screen.getByText('Views')).toBeInTheDocument()

      // Should show actions
      expect(screen.getByText('Actions')).toBeInTheDocument()
    })

    it('should limit items per category in default view', () => {
      render(<CommandPalette {...defaultProps} />)

      // With mock data: 2 conversations, 2 contacts, 3 rooms total
      // All should be visible since they're under the limits
      const allButtons = document.querySelectorAll('button[data-selected]')
      expect(allButtons.length).toBeGreaterThan(5) // Mix of types
      expect(allButtons.length).toBeLessThanOrEqual(18) // 5+3+4+3+3 max
    })
  })

  describe('Edge Cases', () => {
    it('should not crash when pressing Enter with no results', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')
      const container = input.closest('div')?.parentElement

      // Use commands filter prefix to get truly no results (no search gateway)
      fireEvent.change(input, { target: { value: '>xyznonexistent123' } })
      expect(screen.getByText('No results found')).toBeInTheDocument()

      // Should not crash or call any action
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveConversation).not.toHaveBeenCalled()
      expect(mockSetActiveRoom).not.toHaveBeenCalled()
      expect(defaultProps.onClose).not.toHaveBeenCalled()
    })

    it('should handle ArrowDown with no results gracefully', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')
      const container = input.closest('div')?.parentElement

      // Use commands filter prefix to get truly no results (no search gateway)
      fireEvent.change(input, { target: { value: '>xyznonexistent123' } })

      // Should not crash
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowUp' })

      expect(screen.getByText('No results found')).toBeInTheDocument()
    })

    it('should handle switching between filter modes correctly', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')
      const container = input.closest('div')?.parentElement

      // Start with @ filter
      fireEvent.change(input, { target: { value: '@' } })
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.queryByText('Development')).not.toBeInTheDocument()

      // Switch to # filter
      fireEvent.change(input, { target: { value: '#' } })
      expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
      expect(screen.getByText('Development')).toBeInTheDocument()

      // First item should be selected
      const devRoom = screen.getByText('Development').closest('button')
      expect(devRoom).toHaveAttribute('data-selected', 'true')

      // Select it
      fireEvent.keyDown(container!, { key: 'Enter' })
      expect(mockSetActiveRoom).toHaveBeenCalledWith('dev@conference.example.com')
    })

    it('should clear filter mode indicator when clearing query', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      // Enter filter mode
      fireEvent.change(input, { target: { value: '@alice' } })
      expect(screen.getByText('Filtering contacts...')).toBeInTheDocument()

      // Clear query - should show prefix hints again
      fireEvent.change(input, { target: { value: '' } })
      expect(screen.queryByText('Filtering contacts...')).not.toBeInTheDocument()
      expect(screen.getByText('contacts')).toBeInTheDocument() // prefix hint
    })
  })

  describe('Prefix Filtering', () => {
    describe('> prefix (commands)', () => {
      it('should show only commands and views when using > prefix', () => {
        useAdvancedModeStore.setState({ advancedMode: true })
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '>' } })

        // Should show commands/views
        expect(screen.getByText('Settings')).toBeInTheDocument()
        expect(screen.getByText('Create Quick Chat')).toBeInTheDocument()
        expect(screen.getByText('XMPP Console')).toBeInTheDocument()

        // Should NOT show contacts or rooms
        expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
        expect(screen.queryByText('Development')).not.toBeInTheDocument()
      })

      it('should filter commands by search term after > prefix', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '>settings' } })

        expect(screen.getByText('Settings')).toBeInTheDocument()
        expect(screen.queryByText('Create Quick Chat')).not.toBeInTheDocument()
      })

      it('should handle spaces after > prefix', () => {
        useAdvancedModeStore.setState({ advancedMode: true })
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '> console' } })

        expect(screen.getByText('XMPP Console')).toBeInTheDocument()
      })

      it('should NOT show console entry when advanced mode is OFF', () => {
        // advancedMode defaults to false (reset in outer beforeEach)
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '>' } })

        // Non-gated commands still visible
        expect(screen.getByText('Settings')).toBeInTheDocument()
        // Console entry must be absent
        expect(screen.queryByText('XMPP Console')).not.toBeInTheDocument()
      })
    })

    describe('@ prefix (contacts)', () => {
      it('should show only contacts and conversations when using @ prefix', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '@' } })

        // Should show contacts/conversations
        expect(screen.getByText('Alice Smith')).toBeInTheDocument()
        expect(screen.getByText('Bob Jones')).toBeInTheDocument()
        expect(screen.getByText('Charlie Brown')).toBeInTheDocument()
        expect(screen.getByText('Diana Prince')).toBeInTheDocument()

        // Should NOT show rooms or commands
        expect(screen.queryByText('Development')).not.toBeInTheDocument()
        expect(screen.queryByText('Settings')).not.toBeInTheDocument()
      })

      it('should filter contacts by search term after @ prefix', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '@charlie' } })

        expect(screen.getByText('Charlie Brown')).toBeInTheDocument()
        expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
        expect(screen.queryByText('Diana Prince')).not.toBeInTheDocument()
      })
    })

    describe('# prefix (rooms)', () => {
      it('should show only rooms when using # prefix', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '#' } })

        // Should show rooms
        expect(screen.getByText('Development')).toBeInTheDocument()
        expect(screen.getByText('General Chat')).toBeInTheDocument()
        expect(screen.getByText('Archived Room')).toBeInTheDocument()

        // Should NOT show contacts or commands
        expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
        expect(screen.queryByText('Settings')).not.toBeInTheDocument()
      })

      it('should filter rooms by search term after # prefix', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '#dev' } })

        expect(screen.getByText('Development')).toBeInTheDocument()
        expect(screen.queryByText('General Chat')).not.toBeInTheDocument()
      })

      it('should include bookmarked rooms in # filter', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '#archived' } })

        expect(screen.getByText('Archived Room')).toBeInTheDocument()
      })
    })

    describe('no prefix (default)', () => {
      it('should search all item types without prefix', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        // 'dev' matches Development room
        fireEvent.change(input, { target: { value: 'dev' } })

        expect(screen.getByText('Development')).toBeInTheDocument()
      })

      it('should limit results to 15 items when no prefix and no query', () => {
        render(<CommandPalette {...defaultProps} />)

        // Count all visible items (buttons with data-selected attribute)
        const allItems = document.querySelectorAll('button[data-selected]')
        expect(allItems.length).toBeLessThanOrEqual(15)
      })
    })

    describe('prefix with selection', () => {
      it('should allow selecting filtered items with Enter', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')
        const container = input.closest('div')?.parentElement

        fireEvent.change(input, { target: { value: '@bob' } })

        // First (and only) result should be selected
        const bobItem = screen.getByText('Bob Jones').closest('button')
        expect(bobItem).toHaveAttribute('data-selected', 'true')

        fireEvent.keyDown(container!, { key: 'Enter' })

        expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
      })

      it('should allow navigating filtered results with arrow keys', () => {
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')
        const container = input.closest('div')?.parentElement

        fireEvent.change(input, { target: { value: '#' } })

        // First room should be selected
        expect(screen.getByText('Development').closest('button')).toHaveAttribute('data-selected', 'true')

        // Navigate down
        fireEvent.keyDown(container!, { key: 'ArrowDown' })

        // Second room should be selected
        expect(screen.getByText('General Chat').closest('button')).toHaveAttribute('data-selected', 'true')
      })
    })
  })

  describe('Call Order (regression tests for view restore bug)', () => {
    // These tests ensure that onSidebarViewChange is called BEFORE setActiveConversation/setActiveRoom.
    // Previously, the order was reversed which caused handleSidebarViewChange's "restore last content"
    // logic to overwrite the user's selection from the command palette.

    it('should call onSidebarViewChange before setActiveConversation when selecting a conversation', () => {
      const callOrder: string[] = []

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(() => callOrder.push('onSidebarViewChange')),
        onClose: vi.fn(() => callOrder.push('onClose')),
      }

      // Override the mock to track call order
      mockSetActiveConversation.mockImplementation(() => callOrder.push('setActiveConversation'))

      render(<CommandPalette {...trackingProps} />)

      // Click on a conversation (Alice)
      const aliceItem = screen.getByText('Alice Smith').closest('button')
      fireEvent.click(aliceItem!)

      // Verify the order: navigate first, then set conversation
      expect(callOrder).toEqual(['onSidebarViewChange', 'onClose', 'setActiveConversation'])
      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('messages')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should call onSidebarViewChange before setActiveRoom when selecting a room', () => {
      const callOrder: string[] = []

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(() => callOrder.push('onSidebarViewChange')),
        onClose: vi.fn(() => callOrder.push('onClose')),
      }

      // Override mocks to track call order
      mockSetActiveRoom.mockImplementation(() => callOrder.push('setActiveRoom'))
      mockSetActiveConversation.mockImplementation(() => callOrder.push('setActiveConversation'))

      render(<CommandPalette {...trackingProps} />)

      // Click on a room (Development)
      const devRoom = screen.getByText('Development').closest('button')
      fireEvent.click(devRoom!)

      // Verify the order: navigate first, then set room, then clear conversation
      expect(callOrder).toEqual(['onSidebarViewChange', 'onClose', 'setActiveRoom', 'setActiveConversation'])
      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('rooms')
      expect(mockSetActiveRoom).toHaveBeenCalledWith('dev@conference.example.com')
      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
    })

    it('should select the correct conversation after navigating with arrow keys', () => {
      const callOrder: string[] = []

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(() => callOrder.push('onSidebarViewChange')),
        onClose: vi.fn(() => callOrder.push('onClose')),
      }

      mockSetActiveConversation.mockImplementation(() => callOrder.push('setActiveConversation'))

      render(<CommandPalette {...trackingProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Filter to just conversations
      const input = screen.getByPlaceholderText('Go to...')
      fireEvent.change(input, { target: { value: '@' } })

      // Navigate to second conversation (Bob)
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Verify Bob is selected
      expect(screen.getByText('Bob Jones').closest('button')).toHaveAttribute('data-selected', 'true')

      // Press Enter
      fireEvent.keyDown(container!, { key: 'Enter' })

      // Should select Bob, not Alice
      expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
      expect(callOrder).toEqual(['onSidebarViewChange', 'onClose', 'setActiveConversation'])
    })

    it('should select the correct room after navigating with arrow keys', () => {
      const callOrder: string[] = []

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(() => callOrder.push('onSidebarViewChange')),
        onClose: vi.fn(() => callOrder.push('onClose')),
      }

      mockSetActiveRoom.mockImplementation(() => callOrder.push('setActiveRoom'))
      mockSetActiveConversation.mockImplementation(() => callOrder.push('setActiveConversation'))

      render(<CommandPalette {...trackingProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Filter to just rooms
      const input = screen.getByPlaceholderText('Go to...')
      fireEvent.change(input, { target: { value: '#' } })

      // Navigate to second room (General Chat)
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Verify General Chat is selected
      expect(screen.getByText('General Chat').closest('button')).toHaveAttribute('data-selected', 'true')

      // Press Enter
      fireEvent.keyDown(container!, { key: 'Enter' })

      // Should select General Chat, not Development
      expect(mockSetActiveRoom).toHaveBeenCalledWith('general@conference.example.com')
      expect(callOrder).toEqual(['onSidebarViewChange', 'onClose', 'setActiveRoom', 'setActiveConversation'])
    })
  })

  describe('Unread section', () => {
    it('shows unread DMs under a Needs attention header, read DMs under Messages, no duplication', () => {
      render(<CommandPalette {...defaultProps} />)

      // The section header is now "Needs attention" (merges unread DMs + mention rooms)
      expect(screen.getByText('Needs attention')).toBeInTheDocument()

      // Bob (unreadCount 2) appears exactly once, Alice (unreadCount 0) appears exactly once
      expect(screen.getAllByText('Bob Jones')).toHaveLength(1)
      expect(screen.getAllByText('Alice Smith')).toHaveLength(1)

      // Bob's row is above Alice's row (Needs attention section precedes Messages section)
      const bob = screen.getByText('Bob Jones')
      const alice = screen.getByText('Alice Smith')
      expect(bob.compareDocumentPosition(alice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  describe('Needs attention group', () => {
    // Groups render as `<div key={group.key}><div class="command-group-label">{label}</div>{...items}</div>`
    // (see CommandPalette.tsx render section) — there is no role="group" wrapper. The label text node's
    // own element IS the label div, so scoping to the group's subtree means walking up to its parentElement
    // (the shared wrapper `<div>` for the label + all item rows), not `.closest('div')` (which would just
    // resolve back to the label div itself, since a div matches `closest` on itself).
    function getGroupContainer(labelText: string): HTMLElement {
      const label = screen.getByText(labelText)
      return label.parentElement as HTMLElement
    }

    it('promotes a room with a mention into the attention group', () => {
      render(<CommandPalette {...defaultProps} />)
      const attention = getGroupContainer('Needs attention')
      // Announcements has mentionsCount 1 -> belongs to the attention group
      expect(within(attention).getByText('Announcements')).toBeInTheDocument()
    })

    it('does not promote an unread room without a mention', () => {
      render(<CommandPalette {...defaultProps} />)
      const attention = getGroupContainer('Needs attention')
      // General Chat has unreadCount 3 but mentionsCount 0 -> stays in the rooms group
      expect(within(attention).queryByText('General Chat')).not.toBeInTheDocument()
    })

    it('does not duplicate a promoted room in the rooms group', () => {
      render(<CommandPalette {...defaultProps} />)
      // Announcements appears exactly once across the whole default view
      expect(screen.getAllByText('Announcements')).toHaveLength(1)
    })

    it('orders the attention group by most-recent activity', () => {
      render(<CommandPalette {...defaultProps} />)
      const attention = getGroupContainer('Needs attention')
      // Announcements (11:00) is newer than Bob Jones' DM (10:00) -> appears first within the group
      const announce = within(attention).getByText('Announcements')
      const bob = within(attention).getByText('Bob Jones')
      expect(announce.compareDocumentPosition(bob) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  describe('Unread badge', () => {
    it('shows a count badge for unread DMs in the default view', () => {
      render(<CommandPalette {...defaultProps} />)
      // Bob Jones has unreadCount 2 — scope to his row so the assertion can't
      // accidentally match a "2" elsewhere if the fixture changes.
      const bobRow = screen.getByText('Bob Jones').closest('button')
      expect(within(bobRow!).getByText('2')).toBeInTheDocument()
    })

    it('does not show unread badges once the user types a query', () => {
      render(<CommandPalette {...defaultProps} />)
      fireEvent.change(screen.getByPlaceholderText('Go to...'), { target: { value: 'Bob' } })
      // Bob still listed, but no "2" badge in search results
      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
      expect(screen.queryByText('2')).not.toBeInTheDocument()
    })
  })

  describe('Room ordering', () => {
    it('orders rooms mentions-first, then unread, then read', () => {
      render(<CommandPalette {...defaultProps} />)

      const announce = screen.getByText('Announcements') // mention (tier 0)
      const general = screen.getByText('General Chat')    // unread (tier 1)
      const dev = screen.getByText('Development')          // read (tier 2)

      // Announcements before General Chat
      expect(announce.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // General Chat before Development
      expect(general.compareDocumentPosition(dev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  describe('Active entity hidden', () => {
    it('does not propose the currently-open conversation', () => {
      mockActiveConversationId = 'bob@example.com'
      render(<CommandPalette {...defaultProps} />)
      // Bob is the open conversation — hidden everywhere, including the Unread section
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument()
      // Other conversations still listed
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    })

    it('does not propose the open conversation even when the user searches for it', () => {
      mockActiveConversationId = 'bob@example.com'
      render(<CommandPalette {...defaultProps} />)
      fireEvent.change(screen.getByPlaceholderText('Go to...'), { target: { value: 'Bob' } })
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument()
    })

    it('does not propose the currently-open room', () => {
      mockActiveRoomJid = 'dev@conference.example.com'
      render(<CommandPalette {...defaultProps} />)
      // Development is the open room — hidden; other joined rooms still listed
      expect(screen.queryByText('Development')).not.toBeInTheDocument()
      expect(screen.getByText('General Chat')).toBeInTheDocument()
    })
  })

  describe('Archived conversations', () => {
    it('should navigate to messages view when selecting an archived conversation', () => {
      // Make Bob's conversation archived — now always opens in messages view
      mockIsArchived.mockImplementation(jid => jid === 'bob@example.com')

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(),
      }

      render(<CommandPalette {...trackingProps} />)

      // Click on Bob (archived)
      const bobItem = screen.getByText('Bob Jones').closest('button')
      fireEvent.click(bobItem!)

      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('messages')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
    })

    it('should navigate to messages view when selecting a non-archived conversation', () => {
      // All conversations are non-archived (default mock behavior)
      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(),
      }

      render(<CommandPalette {...trackingProps} />)

      // Click on Alice (not archived)
      const aliceItem = screen.getByText('Alice Smith').closest('button')
      fireEvent.click(aliceItem!)

      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('messages')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should navigate to messages view when pressing Enter on an archived conversation', () => {
      // Make Alice's conversation archived — now always opens in messages view
      mockIsArchived.mockImplementation(jid => jid === 'alice@example.com')

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(),
      }

      render(<CommandPalette {...trackingProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Announcements and Bob lead the Needs attention group; Alice is third (Messages section).
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('messages')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should open archived conversation in messages view when selecting a contact with archived history', () => {
      // Charlie has an archived conversation (not in mockConversations but in archivedConversations)
      mockArchivedConversations = [
        { id: 'charlie@example.com', name: 'Charlie Brown', unreadCount: 0, type: 'chat' as const },
      ]
      mockIsArchived.mockImplementation(jid => jid === 'charlie@example.com')

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(),
      }

      render(<CommandPalette {...trackingProps} />)

      // Search for Charlie (appears as a contact since conversation is archived)
      const input = screen.getByPlaceholderText('Go to...')
      fireEvent.change(input, { target: { value: 'charlie' } })

      // Click on Charlie
      const charlieItem = screen.getByText('Charlie Brown').closest('button')
      fireEvent.click(charlieItem!)

      // Should navigate to messages view (archive rail is gone) and open the archived conversation
      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('messages')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('charlie@example.com')
      // Should NOT call onStartConversation (no new conversation created)
      expect(trackingProps.onStartConversation).not.toHaveBeenCalled()
    })

    it('should start new conversation for contact without archived history', () => {
      // Diana has no conversation history (not in conversations or archivedConversations)
      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(),
        onStartConversation: vi.fn(),
      }

      render(<CommandPalette {...trackingProps} />)

      // Search for Diana
      const input = screen.getByPlaceholderText('Go to...')
      fireEvent.change(input, { target: { value: 'diana' } })

      // Click on Diana
      const dianaItem = screen.getByText('Diana Prince').closest('button')
      fireEvent.click(dianaItem!)

      // Should start a new conversation, not navigate to archive
      expect(trackingProps.onStartConversation).toHaveBeenCalledWith('diana@example.com')
      expect(trackingProps.onSidebarViewChange).not.toHaveBeenCalledWith('archive')
    })
  })
})
