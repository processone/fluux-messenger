import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'

// Mock scrollIntoView which is not implemented in jsdom
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// Mock data
const mockConversations = [
  { id: 'alice@example.com', name: 'Alice Smith', unreadCount: 0, type: 'chat' as const },
  { id: 'bob@example.com', name: 'Bob Jones', unreadCount: 2, type: 'chat' as const },
]

const mockRooms = [
  { jid: 'dev@conference.example.com', name: 'Development', joined: true },
  { jid: 'general@conference.example.com', name: 'General Chat', joined: true },
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

// Mock SDK hooks
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
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: () => ({
    setActiveConversation: mockSetActiveConversation,
  }),
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
}))

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
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
        'sidebar.messages': 'Messages',
        'sidebar.rooms': 'Rooms',
        'sidebar.connections': 'Connections',
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
      return translations[key] || key
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

    it('should display contacts not in conversations', () => {
      render(<CommandPalette {...defaultProps} />)
      expect(screen.getByText('Charlie Brown')).toBeInTheDocument()
      expect(screen.getByText('Diana Prince')).toBeInTheDocument()
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
      expect(labelTexts).toContain('Connections')
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

    it('should show no results message when nothing matches', () => {
      render(<CommandPalette {...defaultProps} />)
      const input = screen.getByPlaceholderText('Go to...')

      fireEvent.change(input, { target: { value: 'xyznonexistent' } })

      expect(screen.getByText('No results found')).toBeInTheDocument()
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
  })

  describe('Keyboard Navigation', () => {
    it('should select first item by default', () => {
      render(<CommandPalette {...defaultProps} />)

      // First item should have data-selected="true"
      const firstItem = screen.getByText('Alice Smith').closest('button')
      expect(firstItem).toHaveAttribute('data-selected', 'true')
    })

    it('should move selection down with ArrowDown', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Second item should now be selected
      const secondItem = screen.getByText('Bob Jones').closest('button')
      expect(secondItem).toHaveAttribute('data-selected', 'true')
    })

    it('should move selection up with ArrowUp', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Move down first
      fireEvent.keyDown(container!, { key: 'ArrowDown' })
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Then move up
      fireEvent.keyDown(container!, { key: 'ArrowUp' })

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

      // First item should still be selected
      const firstItem = screen.getByText('Alice Smith').closest('button')
      expect(firstItem).toHaveAttribute('data-selected', 'true')
    })

    it('should close on Escape', () => {
      render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      fireEvent.keyDown(container!, { key: 'Escape' })

      expect(defaultProps.onClose).toHaveBeenCalled()
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

      // First item is a conversation, should set active conversation
      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.com')
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
      render(<CommandPalette {...defaultProps} />)

      // Click on the backdrop (the outer div)
      const backdrop = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement?.parentElement
      fireEvent.click(backdrop!)

      expect(defaultProps.onClose).toHaveBeenCalled()
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

      fireEvent.change(input, { target: { value: 'archive' } })

      const archiveItem = screen.getByText('Archive').closest('button')
      fireEvent.click(archiveItem!)

      expect(defaultProps.onSidebarViewChange).toHaveBeenCalledWith('archive')
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

      // First item should be selected again
      const firstItem = screen.getByText('Alice Smith').closest('button')
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

      // Navigate to Bob Jones (second item)
      fireEvent.keyDown(container!, { key: 'ArrowDown' })

      // Verify Bob is selected
      const bobItem = screen.getByText('Bob Jones').closest('button')
      expect(bobItem).toHaveAttribute('data-selected', 'true')

      // Press Enter - should select Bob, not Alice
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith('alice@example.com')
    })

    it('should work correctly on consecutive selections after reopening', () => {
      const { rerender } = render(<CommandPalette {...defaultProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // First selection: Alice (first item)
      fireEvent.keyDown(container!, { key: 'Enter' })
      expect(mockSetActiveConversation).toHaveBeenLastCalledWith('alice@example.com')

      vi.clearAllMocks()

      // Close and reopen
      rerender(<CommandPalette {...defaultProps} isOpen={false} />)
      rerender(<CommandPalette {...defaultProps} isOpen={true} />)

      const container2 = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Navigate to Bob and select
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

      // Third item in the list should be a room (Development)
      // Order: Alice, Bob, Development, General Chat...
      const devRoom = screen.getByText('Development').closest('button')
      expect(devRoom).toHaveAttribute('data-selected', 'true')

      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(mockSetActiveRoom).toHaveBeenCalledWith('dev@conference.example.com')
    })

    it('should work correctly with rapid consecutive selections', () => {
      const { rerender } = render(<CommandPalette {...defaultProps} />)

      // Perform multiple selections in quick succession
      for (let i = 0; i < 3; i++) {
        vi.clearAllMocks()

        const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

        // Navigate to second item and select
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

      // Should show contacts (those without conversations)
      expect(screen.getByText('Charlie Brown')).toBeInTheDocument()

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

      // Filter to get no results
      fireEvent.change(input, { target: { value: 'xyznonexistent123' } })
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

      fireEvent.change(input, { target: { value: 'xyznonexistent123' } })

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
        render(<CommandPalette {...defaultProps} />)
        const input = screen.getByPlaceholderText('Go to...')

        fireEvent.change(input, { target: { value: '> console' } })

        expect(screen.getByText('XMPP Console')).toBeInTheDocument()
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

  describe('Archived conversations', () => {
    it('should navigate to archive view when selecting an archived conversation', () => {
      // Make Bob's conversation archived
      mockIsArchived.mockImplementation(jid => jid === 'bob@example.com')

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(),
      }

      render(<CommandPalette {...trackingProps} />)

      // Click on Bob (archived)
      const bobItem = screen.getByText('Bob Jones').closest('button')
      fireEvent.click(bobItem!)

      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('archive')
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

    it('should navigate to archive view when pressing Enter on an archived conversation', () => {
      // Make Alice's conversation archived
      mockIsArchived.mockImplementation(jid => jid === 'alice@example.com')

      const trackingProps = {
        ...defaultProps,
        onSidebarViewChange: vi.fn(),
      }

      render(<CommandPalette {...trackingProps} />)
      const container = screen.getByPlaceholderText('Go to...').closest('div')?.parentElement

      // Alice is first in the list, press Enter
      fireEvent.keyDown(container!, { key: 'Enter' })

      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('archive')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should open archived conversation when selecting a contact with archived history', () => {
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

      // Should navigate to archive view and open the archived conversation
      expect(trackingProps.onSidebarViewChange).toHaveBeenCalledWith('archive')
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
