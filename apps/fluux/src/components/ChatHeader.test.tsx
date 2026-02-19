import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatHeader } from './ChatHeader'
import type { Contact } from '@fluux/sdk'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

// Mock useWindowDrag hook
vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({
    titleBarClass: 'mt-5',
    dragRegionProps: { 'data-tauri-drag-region': true },
  }),
}))

// Mock @fluux/sdk/react store hooks
// Track contacts so tests can control what useRosterStore returns
const mockRosterContacts = new Map<string, Contact>()

vi.mock('@fluux/sdk/react', () => ({
  useRosterStore: (selector: (state: { contacts: Map<string, Contact> }) => unknown) => {
    return selector({ contacts: mockRosterContacts })
  },
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
}))

// Mock Avatar component
vi.mock('./Avatar', () => ({
  Avatar: ({ name, presence }: { name: string; presence?: string }) => (
    <div data-testid="avatar" data-name={name} data-presence={presence}>
      Avatar: {name}
    </div>
  ),
}))

// Mock statusText utility
vi.mock('@/utils/statusText', () => ({
  getTranslatedStatusText: (contact: Contact) => contact.statusMessage || 'Online',
}))

// Helper to create a test contact
const createContact = (overrides: Partial<Contact> = {}): Contact => ({
  jid: 'alice@example.com',
  name: 'Alice Smith',
  presence: 'online',
  subscription: 'both',
  ...overrides,
})

describe('ChatHeader', () => {
  beforeEach(() => {
    mockRosterContacts.clear()
  })

  // Helper to set up a contact in both the prop and the roster store
  function setupContact(overrides: Partial<Contact> = {}): Contact {
    const contact = createContact(overrides)
    mockRosterContacts.set(contact.jid, contact)
    return contact
  }

  describe('1:1 Chat Mode', () => {
    it('renders contact name', () => {
      const contact = setupContact()
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid="alice@example.com"
        />
      )

      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    })

    it('renders contact avatar with presence', () => {
      const contact = setupContact({ presence: 'away' })
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid="alice@example.com"
        />
      )

      const avatar = screen.getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-name', 'Alice Smith')
      expect(avatar).toHaveAttribute('data-presence', 'away')
    })

    it('renders status text for contact', () => {
      const contact = setupContact({ statusMessage: 'Working from home' })
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid="alice@example.com"
        />
      )

      expect(screen.getByText('Working from home')).toBeInTheDocument()
    })

    it('shows JID when no contact provided', () => {
      render(
        <ChatHeader
          name="alice@example.com"
          type="chat"
          jid="alice@example.com"
        />
      )

      // JID appears in both name (h2) and status (p) elements
      const jidElements = screen.getAllByText('alice@example.com')
      expect(jidElements.length).toBeGreaterThanOrEqual(1)
      // Status line should show JID
      const statusElement = jidElements.find(el => el.tagName === 'P')
      expect(statusElement).toBeInTheDocument()
    })

    it('shows offline presence when no contact', () => {
      render(
        <ChatHeader
          name="Unknown"
          type="chat"
          jid="unknown@example.com"
        />
      )

      const avatar = screen.getByTestId('avatar')
      expect(avatar).toHaveAttribute('data-presence', 'offline')
    })
  })

  describe('Group Chat Mode', () => {
    it('renders hash icon instead of avatar for group chat', () => {
      render(
        <ChatHeader
          name="Team Chat"
          type="groupchat"
          jid="team@conference.example.com"
        />
      )

      // Should not render Avatar component
      expect(screen.queryByTestId('avatar')).not.toBeInTheDocument()
      // Should render room name
      expect(screen.getByText('Team Chat')).toBeInTheDocument()
    })

    it('does not show status text for group chat', () => {
      const contact = setupContact({ statusMessage: 'Should not show' })
      render(
        <ChatHeader
          name="Team Chat"
          type="groupchat"
          contact={contact}
          jid="team@conference.example.com"
        />
      )

      expect(screen.queryByText('Should not show')).not.toBeInTheDocument()
    })
  })

  describe('Back Button', () => {
    it('shows back button when onBack is provided', () => {
      render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
          onBack={() => {}}
        />
      )

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
    })

    it('does not show back button when onBack is not provided', () => {
      render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
        />
      )

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument()
    })

    it('calls onBack when back button is clicked', () => {
      const onBack = vi.fn()
      render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
          onBack={onBack}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /back/i }))
      expect(onBack).toHaveBeenCalledTimes(1)
    })
  })

  describe('Title Bar', () => {
    it('applies title bar class from useWindowDrag', () => {
      const { container } = render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
        />
      )

      const header = container.querySelector('header')
      expect(header).toHaveClass('mt-5')
    })

    it('applies drag region props for Tauri', () => {
      const { container } = render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
        />
      )

      const header = container.querySelector('header')
      expect(header).toHaveAttribute('data-tauri-drag-region', 'true')
    })
  })
})
