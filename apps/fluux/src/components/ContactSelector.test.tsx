import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactSelector } from './ContactSelector'
import type { Contact, PresenceStatus } from '@fluux/sdk'

// Mock contacts data
const mockContacts: Contact[] = [
  { jid: 'alice@example.com', name: 'Alice Smith', presence: 'online' as PresenceStatus, subscription: 'both' },
  { jid: 'bob@example.com', name: 'Bob Jones', presence: 'away' as PresenceStatus, subscription: 'both' },
  { jid: 'charlie@example.com', name: 'Charlie Brown', presence: 'offline' as PresenceStatus, subscription: 'both' },
  { jid: 'diana@example.com', name: 'Diana Prince', presence: 'dnd' as PresenceStatus, subscription: 'both' },
]

// Mock conversations for recent activity sorting
const mockConversations = [
  { id: 'charlie@example.com', lastMessage: { timestamp: new Date('2024-01-03') } },
  { id: 'alice@example.com', lastMessage: { timestamp: new Date('2024-01-01') } },
  // bob and diana have no recent conversations
]

// Mock SDK hooks
vi.mock('@fluux/sdk', () => ({
  useRoster: () => ({
    contacts: mockContacts,
  }),
  useChat: () => ({
    conversations: mockConversations,
  }),
  // JID utilities moved from app to SDK
  matchNameOrJid: (name: string, jid: string, query: string) => {
    const lowerQuery = query.toLowerCase()
    const nameMatch = name.toLowerCase().includes(lowerQuery)
    const usernameMatch = jid.split('@')[0].toLowerCase().includes(lowerQuery)
    return nameMatch || usernameMatch
  },
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'contacts.searchContacts': 'Search contacts...',
        'contacts.addMoreContacts': 'Add more contacts...',
        'contacts.keyboardHint': 'Tab/↑↓ to navigate, Enter to select',
      }
      return translations[key] || key
    },
  }),
}))

describe('ContactSelector', () => {
  const mockOnSelectionChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('should render search input with placeholder', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      expect(screen.getByPlaceholderText('Search contacts...')).toBeInTheDocument()
    })

    it('should use custom placeholder when provided', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          placeholder="Find someone..."
        />
      )

      expect(screen.getByPlaceholderText('Find someone...')).toBeInTheDocument()
    })

    it('should show addMorePlaceholder when contacts are selected', () => {
      render(
        <ContactSelector
          selectedContacts={['alice@example.com']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      expect(screen.getByPlaceholderText('Add more contacts...')).toBeInTheDocument()
    })

    it('should show all contacts sorted by recent activity on focus', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)

      // All contacts should be visible
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
      expect(screen.getByText('Charlie Brown')).toBeInTheDocument()
      expect(screen.getByText('Diana Prince')).toBeInTheDocument()
    })

    it('should not show dropdown when not focused', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      // Without focus, no contacts should be visible
      expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
    })

    it('should sort contacts by recent conversation activity', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      // Charlie has most recent activity (Jan 3), then Alice (Jan 1)
      // Bob and Diana have no activity, sorted alphabetically
      // Focus and press Enter to select the first one (Charlie - most recent)
      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['charlie@example.com'])
    })

    it('should be disabled when disabled prop is true', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          disabled={true}
        />
      )

      expect(screen.getByPlaceholderText('Search contacts...')).toBeDisabled()
    })
  })

  describe('filtering', () => {
    it('should show matching contacts when typing', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })

      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument()
    })

    it('should match by username part of JID', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'bob' } })

      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
    })

    it('should not match by domain part of JID', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'example.com' } })

      // No contacts should match domain-only search
      expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument()
    })

    it('should be case insensitive', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'ALICE' } })

      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    })

    it('should exclude already selected contacts from dropdown', () => {
      render(
        <ContactSelector
          selectedContacts={['alice@example.com']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Add more contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'ali' } })

      // Alice appears in chips but should NOT appear in dropdown
      // Only Alice matches 'ali' and she's excluded, so no dropdown items
      expect(screen.queryByText('Charlie Brown')).not.toBeInTheDocument()
    })

    it('should exclude contacts in excludeJids', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          excludeJids={['bob@example.com']}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'bob' } })

      // Bob should be excluded - no results for 'bob' search
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument()
    })

    it('should show multiple matching contacts', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      // Search for 'a' which matches Alice, Charlie, Diana
      fireEvent.change(input, { target: { value: 'a' } })

      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.getByText('Charlie Brown')).toBeInTheDocument()
      expect(screen.getByText('Diana Prince')).toBeInTheDocument()
    })
  })

  describe('selection', () => {
    it('should call onSelectionChange when clicking a contact', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })
      fireEvent.click(screen.getByText('Alice Smith'))

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['alice@example.com'])
    })

    it('should clear search after selection', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })
      fireEvent.click(screen.getByText('Alice Smith'))

      expect(input).toHaveValue('')
    })

    it('should show selected contacts as chips', () => {
      render(
        <ContactSelector
          selectedContacts={['alice@example.com', 'bob@example.com']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      // Chips should show contact names
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.getByText('Bob Jones')).toBeInTheDocument()
    })

    it('should remove contact when clicking X on chip', () => {
      render(
        <ContactSelector
          selectedContacts={['alice@example.com', 'bob@example.com']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      // Find the X button for Alice's chip
      const aliceChip = screen.getByText('Alice Smith').closest('span')!
      const removeButton = aliceChip.querySelector('button')!
      fireEvent.click(removeButton)

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['bob@example.com'])
    })

    it('should show full JID if contact name not found', () => {
      render(
        <ContactSelector
          selectedContacts={['unknown@example.com']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      expect(screen.getByText('unknown@example.com')).toBeInTheDocument()
    })
  })

  describe('keyboard navigation', () => {
    it('should select contact with Enter key', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['alice@example.com'])
    })

    it('should navigate down with ArrowDown', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'a' } }) // Matches Alice, Charlie, Diana (names contain 'a')

      // First item is highlighted by default (Charlie - most recent)
      // Press down to highlight next item
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['alice@example.com'])
    })

    it('should navigate up with ArrowUp', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'a' } })

      // Press up to wrap to last item
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['diana@example.com'])
    })

    it('should cycle forward with Tab', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'a' } }) // Matches Alice, Charlie, Diana

      fireEvent.keyDown(input, { key: 'Tab' })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['alice@example.com'])
    })

    it('should cycle backward with Shift+Tab', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'a' } })

      fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['diana@example.com'])
    })

    it('should wrap around when navigating past end', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'a' } }) // 3 matches: Charlie, Alice, Diana (sorted by activity)

      // Navigate past the end (3 times down should wrap to first)
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['charlie@example.com'])
    })

    it('should clear search with Escape', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })

      expect(screen.getByText('Alice Smith')).toBeInTheDocument()

      fireEvent.keyDown(input, { key: 'Escape' })

      expect(input).toHaveValue('')
      // After escape, dropdown is still open (focused) but with all contacts
      // Alice should still be visible in the full list
    })

    it('should remove last selected contact with Backspace on empty input', () => {
      render(
        <ContactSelector
          selectedContacts={['alice@example.com', 'bob@example.com']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Add more contacts...')
      fireEvent.focus(input)
      fireEvent.keyDown(input, { key: 'Backspace' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['alice@example.com'])
    })

    it('should not remove contact with Backspace when input has text', () => {
      render(
        <ContactSelector
          selectedContacts={['alice@example.com']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Add more contacts...')
      fireEvent.change(input, { target: { value: 'test' } })
      fireEvent.keyDown(input, { key: 'Backspace' })

      expect(mockOnSelectionChange).not.toHaveBeenCalled()
    })
  })

  describe('presence status', () => {
    it('should show presence indicator for each contact', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'a' } })

      // Check that presence dots are rendered (they have specific bg classes)
      const dropdown = screen.getByText('Alice Smith').closest('div')!.parentElement!
      const presenceDots = dropdown.querySelectorAll('[class*="rounded-full"]')
      expect(presenceDots.length).toBeGreaterThan(0)
    })
  })

  describe('keyboard hint', () => {
    it('should show keyboard hint in dropdown', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })

      expect(screen.getByText('Tab/↑↓ to navigate, Enter to select')).toBeInTheDocument()
    })
  })

  describe('arbitrary JID input', () => {
    it('should allow adding a valid JID not in roster', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'stranger@other.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['stranger@other.com'])
    })

    it('should show hint for valid JID', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'new@example.org' } })

      expect(screen.getByText('contacts.pressEnterToAdd')).toBeInTheDocument()
    })

    it('should not show hint for invalid JID (no domain)', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'nodomain@' } })

      expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()
    })

    it('should not show hint for invalid JID (no local part)', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: '@example.com' } })

      expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()
    })

    it('should not show hint for invalid JID (no dot in domain)', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'user@localhost' } })

      expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()
    })

    it('should normalize JID to lowercase', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'User@Example.ORG' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['user@example.org'])
    })

    it('should not add JID that is already selected', () => {
      render(
        <ContactSelector
          selectedContacts={['existing@example.org']}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Add more contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'existing@example.org' } })

      // Should not show the "press enter to add" hint
      expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()
    })

    it('should not add JID that is in excludeJids', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          excludeJids={['excluded@example.org']}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'excluded@example.org' } })

      // Should not show the "press enter to add" hint
      expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()
    })

    it('should allow clicking to add arbitrary JID', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'clickable@new.org' } })

      // Click on the JID in dropdown
      fireEvent.click(screen.getByText('clickable@new.org'))

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['clickable@new.org'])
    })
  })
})
