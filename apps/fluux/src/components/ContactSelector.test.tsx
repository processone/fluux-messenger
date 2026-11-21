import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ContactSelector } from './ContactSelector'
import { ModalShell } from './ModalShell'
import type { Contact, PresenceStatus } from '@fluux/sdk'
import en from '@/i18n/locales/en.json'

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
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  useRoster: () => ({
    contacts: mockContacts,
  }),
  // Recent-activity ordering is now read non-reactively from the vanilla chatStore.
  chatStore: {
    getState: () => ({
      conversations: new Map(mockConversations.map((c) => [c.id, c])),
    }),
  },
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useChatStore: (selector: (state: { conversations: Map<string, unknown> }) => unknown) =>
    selector({ conversations: new Map(mockConversations.map((c) => [c.id, c])) }),
  useContactTime: () => null, useLastActivity: vi.fn(),
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => {
      if (key === 'contacts.removeFromSelection') {
        return en.contacts.removeFromSelection.replace('{{name}}', options?.name ?? '')
      }
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

  describe('remove buttons on chosen contacts', () => {
    it('names each button after its contact and removes only that contact', () => {
      const typedAddress = 'someone@elsewhere.example'
      const removeName = (name: string) => en.contacts.removeFromSelection.replace('{{name}}', name)
      render(
        <ContactSelector
          selectedContacts={['alice@example.com', typedAddress]}
          onSelectionChange={mockOnSelectionChange}
        />
      )

      expect(screen.getByRole('button', { name: removeName(typedAddress) })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: removeName('Alice Smith') }))

      expect(mockOnSelectionChange).toHaveBeenCalledExactlyOnceWith([typedAddress])
    })
  })

  describe('contacts who cannot be chosen', () => {
    const NOTE = 'Already in the room'
    const noteFor = (jid: string) => (jid.split('/')[0] === 'alice@example.com' ? NOTE : undefined)

    function openSelector(query = '') {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          getUnavailableNote={noteFor}
        />
      )
      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      if (query) fireEvent.change(input, { target: { value: query } })
      return input
    }

    const rows = () => within(screen.getByTestId('contact-suggestions')).getAllByRole('button')

    it('lists them after everyone else with the note and a disabled state', () => {
      openSelector()

      const listed = rows()
      expect(listed).toHaveLength(4)
      expect(listed[3]).toHaveTextContent('Alice Smith')
      expect(listed[3]).toHaveTextContent(NOTE)
      expect(listed[3]).toHaveAttribute('aria-disabled', 'true')
      expect(listed[0]).not.toHaveAttribute('aria-disabled')
    })

    it('keeps them in search results', () => {
      openSelector('ali')

      expect(rows()).toHaveLength(1)
      expect(rows()[0]).toHaveTextContent(NOTE)
    })

    it('does not choose them by click or Enter, and keeps the list open', () => {
      const input = openSelector('ali')

      fireEvent.click(rows()[0])
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).not.toHaveBeenCalled()
      expect(rows()[0]).toHaveTextContent('Alice Smith')
    })

    it('reaches them by keyboard, says why, and can move on to choose someone else', () => {
      const input = openSelector()
      const status = screen.getByRole('status')
      const first = rows()[0].textContent

      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(status).toHaveTextContent(`Alice Smith: ${NOTE}`)
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(mockOnSelectionChange).not.toHaveBeenCalled()

      fireEvent.keyDown(input, { key: 'Tab' })
      expect(status).toBeEmptyDOMElement()
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledTimes(1)
      const chosen = mockOnSelectionChange.mock.calls[0][0][0] as string
      expect(first).toContain(chosen)
    })

    it('keeps the note for a typed address when another contact also matches the search', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          getUnavailableNote={noteFor}
          extraSuggestions={[{ jid: 'fan@example.org', name: 'alice@example.com fan club' }]}
        />
      )
      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice@example.com' } })

      const listed = rows()
      expect(listed).toHaveLength(2)
      expect(listed[0]).toHaveTextContent('alice@example.com fan club')
      expect(listed[0]).not.toHaveTextContent(NOTE)
      expect(listed[1]).toHaveTextContent(NOTE)

      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(screen.getByRole('status')).toHaveTextContent(`alice@example.com: ${NOTE}`)
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(mockOnSelectionChange).not.toHaveBeenCalled()
    })

    it('shows the note instead of offering a typed address', () => {
      const input = openSelector('alice@example.com/tablet')

      expect(screen.getByText(NOTE)).toBeInTheDocument()
      expect(screen.queryByText('contacts.pressEnterToAdd')).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent(`alice@example.com/tablet: ${NOTE}`)

      fireEvent.keyDown(input, { key: 'Enter' })
      expect(mockOnSelectionChange).not.toHaveBeenCalled()
    })
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

    // Real key events reach the picker before React has run the effects of the previous
    // keystroke, so these events are dispatched outside act(), which would flush them.
    const outsideAct = async (dispatch: () => void) => {
      const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      const actEnvironment = scope.IS_REACT_ACT_ENVIRONMENT
      scope.IS_REACT_ACT_ENVIRONMENT = false
      try {
        dispatch()
        // Let the scheduler finish what those events queued, still outside act().
        for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setImmediate(resolve))
      } finally {
        scope.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      }
    }
    const typeValue = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    it.each([
      { situation: 'with the highlight untouched', moves: 0, query: 'bob', picked: 'bob@example.com' },
      { situation: 'after moving the highlight to an entry that still matches', moves: 1, query: 'li', picked: 'charlie@example.com' },
    ])('picks the first narrowed entry when Enter follows the keystroke at once, $situation', async ({ moves, query, picked }) => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )
      const input = screen.getByPlaceholderText('Search contacts...') as HTMLInputElement
      fireEvent.focus(input)
      for (let move = 0; move < moves; move++) fireEvent.keyDown(input, { key: 'ArrowDown' })

      await outsideAct(() => {
        typeValue(input, query)
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(mockOnSelectionChange).toHaveBeenCalledExactlyOnceWith([picked])
    })

    it('keeps the first entry highlighted by address when two keys arrive before it is pinned', async () => {
      const room = { jid: 'team@conference.example.com', name: 'Team Chat' }
      const selector = (extraSuggestions: Array<{ jid: string; name: string }>) => (
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          extraSuggestions={extraSuggestions}
        />
      )
      const { rerender } = render(selector([room]))
      const input = screen.getByPlaceholderText('Search contacts...') as HTMLInputElement
      fireEvent.focus(input)

      await outsideAct(() => {
        typeValue(input, 'te')
        typeValue(input, 'tea')
      })
      // A new chat sorts ahead of the entry the person is looking at.
      rerender(selector([{ jid: 'a-team@example.org', name: 'Tea assembly' }, room]))
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledExactlyOnceWith([room.jid])
    })

    it.each([
      {
        situation: 'deleting the letter that matched nothing',
        query: 'a',
        leave: (input: HTMLElement) => fireEvent.change(input, { target: { value: 'a' } }),
      },
      {
        situation: 'clearing the search with Escape',
        query: '',
        leave: (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Escape' }),
      },
    ])('starts over at the first entry after a search with no matches, by $situation', ({ query, leave }) => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      )
      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      if (query) fireEvent.change(input, { target: { value: query } })
      fireEvent.keyDown(input, { key: 'ArrowDown' })

      fireEvent.change(input, { target: { value: `${query}z` } })
      expect(screen.getByText('contacts.noContactsFound')).toBeInTheDocument()
      leave(input)
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledExactlyOnceWith([query ? 'alice@example.com' : 'charlie@example.com'])
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

      // First item is Alice (prefix match), ahead of the recent substring match Charlie
      // Press down to highlight next item
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['charlie@example.com'])
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

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['charlie@example.com'])
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

    describe('inside a modal', () => {
      const mockOnClose = vi.fn()
      const suggestions = () => screen.queryByTestId('contact-suggestions')

      beforeEach(() => mockOnClose.mockClear())

      function openInModal() {
        render(
          <ModalShell title="Invite" onClose={mockOnClose}>
            <ContactSelector selectedContacts={[]} onSelectionChange={mockOnSelectionChange} />
            <button type="button">Cancel</button>
          </ModalShell>
        )
        const input = screen.getByPlaceholderText('Search contacts...')
        expect(input).toHaveFocus()
        return input
      }

      it('Shift+Tab moves the highlight back, keeps focus, and Enter picks that contact', () => {
        const input = openInModal()

        fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
        expect(input).toHaveFocus()
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(mockOnSelectionChange).toHaveBeenCalledWith(['diana@example.com'])
      })

      it('lets Shift+Tab leave the picker when no contact matches', () => {
        const input = openInModal()
        fireEvent.change(input, { target: { value: 'nobody-matches-this' } })

        fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })

        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
      })

      it('Escape closes only the list, and the next Escape closes the window', async () => {
        const input = openInModal()
        expect(suggestions()).toBeInTheDocument()

        fireEvent.keyDown(input, { key: 'Escape' })
        expect(suggestions()).not.toBeInTheDocument()
        expect(input).toHaveFocus()
        expect(mockOnClose).not.toHaveBeenCalled()

        fireEvent.keyDown(input, { key: 'Escape' })
        // The window closes after its exit animation.
        await waitFor(() => expect(mockOnClose).toHaveBeenCalledTimes(1))
      })

      it('Escape clears typed text first, then closes the list, then the window', async () => {
        const input = openInModal()
        fireEvent.change(input, { target: { value: 'ali' } })

        fireEvent.keyDown(input, { key: 'Escape' })
        expect(input).toHaveValue('')
        expect(suggestions()).toBeInTheDocument()

        fireEvent.keyDown(input, { key: 'Escape' })
        expect(suggestions()).not.toBeInTheDocument()
        expect(mockOnClose).not.toHaveBeenCalled()

        fireEvent.keyDown(input, { key: 'Escape' })
        // The window closes after its exit animation.
        await waitFor(() => expect(mockOnClose).toHaveBeenCalledTimes(1))
      })

      it('leaves Tab and Shift+Tab to the window once Escape closed the list', () => {
        const input = openInModal()
        fireEvent.keyDown(input, { key: 'Escape' })

        fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })

        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
      })

      it('does not move the highlight of a closed list with Tab', () => {
        const input = openInModal()
        fireEvent.keyDown(input, { key: 'Escape' })

        fireEvent.keyDown(input, { key: 'Tab' })
        act(() => input.focus())
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(mockOnSelectionChange).toHaveBeenCalledExactlyOnceWith(['charlie@example.com'])
      })

      it('picks nobody with Enter while the list is closed', () => {
        const input = openInModal()
        fireEvent.keyDown(input, { key: 'Escape' })

        fireEvent.keyDown(input, { key: 'Enter' })

        expect(mockOnSelectionChange).not.toHaveBeenCalled()
        expect(mockOnClose).not.toHaveBeenCalled()
      })

      it.each([
        { way: 'ArrowDown', reopen: (input: HTMLElement) => fireEvent.keyDown(input, { key: 'ArrowDown' }) },
        { way: 'ArrowUp', reopen: (input: HTMLElement) => fireEvent.keyDown(input, { key: 'ArrowUp' }) },
        { way: 'typing', reopen: (input: HTMLElement) => fireEvent.change(input, { target: { value: 'a' } }) },
        { way: 'a click', reopen: (input: HTMLElement) => fireEvent.click(input) },
      ])('shows a closed list again with $way, at its first entry', ({ reopen }) => {
        const input = openInModal()
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        fireEvent.keyDown(input, { key: 'Escape' })

        reopen(input)
        expect(suggestions()).toBeInTheDocument()
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(mockOnSelectionChange).toHaveBeenCalledExactlyOnceWith(['charlie@example.com'])
      })

      it('keeps a closed list closed when focus comes back, so Tab can pass through', () => {
        vi.useFakeTimers()
        try {
          const input = openInModal()
          fireEvent.keyDown(input, { key: 'Escape' })

          act(() => screen.getByRole('button', { name: 'Cancel' }).focus())
          act(() => { vi.advanceTimersByTime(200) })
          act(() => input.focus())

          expect(input).toHaveFocus()
          expect(suggestions()).not.toBeInTheDocument()
          fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
          expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
        } finally {
          vi.useRealTimers()
        }
      })
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
      fireEvent.change(input, { target: { value: 'a' } }) // 3 matches: Alice (prefix), Charlie (recent substring), Diana

      // Navigate past the end (3 times down should wrap to first)
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(mockOnSelectionChange).toHaveBeenCalledWith(['alice@example.com'])
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

  describe('extraSuggestions', () => {
    const extraSuggestions = [
      { jid: 'extra1@example.com', name: 'Extra One' },
      { jid: 'extra2@example.com' }, // no name, should show JID
      { jid: 'alice@example.com', name: 'Alice Duplicate' }, // duplicate of roster contact
    ]

    it('should show extra suggestions in dropdown when typing', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          extraSuggestions={extraSuggestions}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'extra' } })

      expect(screen.getByText('Extra One')).toBeInTheDocument()
      // extra2 has no name, so it shows JID as both name and JID fields
      expect(screen.getAllByText('extra2@example.com').length).toBeGreaterThanOrEqual(1)
    })

    it('should dedupe extra suggestions against roster contacts (roster wins)', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          extraSuggestions={extraSuggestions}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })

      // Should show roster Alice, not the extra duplicate
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      expect(screen.queryByText('Alice Duplicate')).not.toBeInTheDocument()
    })

    it('should filter extra suggestions by excludeJids', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          extraSuggestions={extraSuggestions}
          excludeJids={['extra1@example.com']}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'extra' } })

      expect(screen.queryByText('Extra One')).not.toBeInTheDocument()
      expect(screen.getAllByText('extra2@example.com').length).toBeGreaterThanOrEqual(1)
    })

    it('should filter extra suggestions by selectedContacts', () => {
      render(
        <ContactSelector
          selectedContacts={['extra1@example.com']}
          onSelectionChange={mockOnSelectionChange}
          extraSuggestions={extraSuggestions}
        />
      )

      const input = screen.getByPlaceholderText('Add more contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'extra' } })

      // extra1 is shown in chip (as "Extra One") but should NOT appear in dropdown
      // The dropdown should only have extra2
      const chipArea = screen.getByText('Extra One').closest('.flex.flex-wrap')!
      // Verify Extra One is only in the chip area, not in the dropdown
      const allExtraOnes = screen.getAllByText('Extra One')
      expect(allExtraOnes).toHaveLength(1)
      expect(chipArea.contains(allExtraOnes[0])).toBe(true)
    })

    it('should show extra suggestion display name in chips', () => {
      render(
        <ContactSelector
          selectedContacts={['extra1@example.com']}
          onSelectionChange={mockOnSelectionChange}
          extraSuggestions={extraSuggestions}
        />
      )

      // Chip should show the extra suggestion's name, not the raw JID
      expect(screen.getByText('Extra One')).toBeInTheDocument()
    })

    it('should search extra suggestions by name and JID', () => {
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={mockOnSelectionChange}
          extraSuggestions={extraSuggestions}
        />
      )

      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'one' } })

      expect(screen.getByText('Extra One')).toBeInTheDocument()
      expect(screen.queryByText('extra2@example.com')).not.toBeInTheDocument()
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

  describe('ContactSelector single-pick mode', () => {
    it('calls onPick once with a typed valid JID on Enter and does not add a chip', () => {
      const onPick = vi.fn()
      const onSelectionChange = vi.fn()
      render(
        <ContactSelector selectedContacts={[]} onSelectionChange={onSelectionChange} onPick={onPick} />
      )
      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.change(input, { target: { value: 'bob@example.com' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onPick).toHaveBeenCalledTimes(1)
      expect(onPick).toHaveBeenCalledWith('bob@example.com')
      expect(onSelectionChange).not.toHaveBeenCalled()
    })

    it('calls onPick when a roster suggestion is clicked', () => {
      const onPick = vi.fn()
      render(
        <ContactSelector
          selectedContacts={[]}
          onSelectionChange={vi.fn()}
          onPick={onPick}
          extraSuggestions={[{ jid: 'alice@example.com', name: 'Alice' }]}
        />
      )
      const input = screen.getByPlaceholderText('Search contacts...')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'alice' } })
      // Since there's a mock contact named 'Alice Smith' that matches 'alice', we click on it
      fireEvent.click(screen.getByText('Alice Smith'))
      expect(onPick).toHaveBeenCalledWith('alice@example.com')
    })
  })
})
