import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ChatHeader } from './ChatHeader'
import type { Contact } from '@fluux/sdk'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

// Mock useWindowDrag hook and other hooks used by ChatHeader and HeaderOverflowKebab
vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({
    dragRegionProps: { 'data-tauri-drag-region': true },
  }),
  useAnchoredMenu: () => ({
    triggerRef: { current: null },
    menuRef: { current: null },
    position: { x: 0, y: 0 },
  }),
  useClickOutside: () => {},
}))

// Mock useHasHover (used by HeaderOverflowKebab — separate import path)
vi.mock('@/hooks/useHasHover', () => ({
  useHasHover: () => true,
  hasHover: () => true,
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
  useContactTime: () => null, useLastActivity: vi.fn(),
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

  describe('Encryption menu', () => {
    const encrypted = (trust: 'verified' | 'tofu') =>
      ({ kind: 'encrypted', fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555', trust }) as const

    it('labels the verify item "Verify ... key" when the key is not yet verified', () => {
      const contact = setupContact()
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid={contact.jid}
          encryptionState={encrypted('tofu')}
          onEncryptionClick={vi.fn()}
          onDisableEncryptionClick={vi.fn()}
        />
      )

      // Open the menu (button aria-label for the unverified chip).
      fireEvent.click(screen.getByRole('button', { name: 'chat.verifyPeer.chipAriaLabel' }))

      expect(screen.getByText('chat.verifyPeer.dialogTitle')).toBeInTheDocument()
      expect(screen.queryByText('chat.verifyPeer.menuViewVerified')).not.toBeInTheDocument()
    })

    it('labels the verify item "View verified key" when the key is already verified', () => {
      const contact = setupContact()
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid={contact.jid}
          encryptionState={encrypted('verified')}
          onEncryptionClick={vi.fn()}
          onDisableEncryptionClick={vi.fn()}
        />
      )

      // Open the menu (button aria-label switches to "encrypted to" when verified).
      fireEvent.click(screen.getByRole('button', { name: 'chat.encryption.encryptedTo' }))

      expect(screen.getByText('chat.verifyPeer.menuViewVerified')).toBeInTheDocument()
      expect(screen.queryByText('chat.verifyPeer.dialogTitle')).not.toBeInTheDocument()
    })

    it('still invokes onVerifyClick when the verified "view" item is clicked', () => {
      const contact = setupContact()
      const onEncryptionClick = vi.fn()
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid={contact.jid}
          encryptionState={encrypted('verified')}
          onEncryptionClick={onEncryptionClick}
          onDisableEncryptionClick={vi.fn()}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'chat.encryption.encryptedTo' }))
      fireEvent.click(screen.getByText('chat.verifyPeer.menuViewVerified'))

      expect(onEncryptionClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('Encryption menu — OMEMO protocol label (Task 13 / G-1)', () => {
    it('OMEMO encrypted state: tooltip reads OMEMO (not OpenPGP) and shows no empty fingerprint block', async () => {
      vi.useFakeTimers()
      try {
        const contact = setupContact()
        const { container } = render(
          <ChatHeader
            name="Alice Smith"
            type="chat"
            contact={contact}
            jid={contact.jid}
            encryptionState={{ kind: 'encrypted', protocolId: 'omemo:2', fingerprint: '', trust: 'tofu' }}
          />
        )

        // No actions wired up, so this hits the non-interactive `role="status"` chip.
        const trigger = container.querySelector('[role="status"]') as HTMLElement
        expect(trigger).not.toBeNull()
        fireEvent.mouseEnter(trigger)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(700)
        })

        // `t()` is mocked to identity, so the OMEMO protocol key surfaces
        // verbatim — the point is that it is NOT the OpenPGP tooltip key.
        expect(document.body.textContent).toContain('chat.encryption.tooltip.protocol.omemo:2')
        expect(document.body.textContent).not.toContain('chat.encryption.openpgpTooltip')
        // OMEMO has no single fingerprint (trust is per-device — see the
        // contact profile's Security tab), so the empty `.font-mono` block
        // that would otherwise render `formatFingerprint('')` must be absent.
        expect(document.querySelector('.font-mono')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Encryption menu — OMEMO trust-state danger cue (Task 13)', () => {
    // No onVerifyClick/onDisableClick wired up, so each of these hits the
    // non-interactive `role="status"` chip (same harness as the OMEMO
    // protocol-label test above).
    function renderOmemo(trust: 'untrusted' | 'verified' | 'tofu') {
      return render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          jid="alice@example.com"
          encryptionState={{ kind: 'encrypted', protocolId: 'omemo:2', fingerprint: '', trust }}
        />
      )
    }

    it('OMEMO untrusted → ShieldAlert + danger color (text-fluux-error), matching SecurityTab/MessageBubble', () => {
      const { container } = renderOmemo('untrusted')
      const shieldAlert = container.querySelector('.lucide-shield-alert')
      expect(shieldAlert).not.toBeNull()
      const status = shieldAlert!.closest('[role="status"]')!
      expect(status.getAttribute('class')).toContain('text-fluux-error')
    })

    it('OMEMO verified → ShieldCheck + verified color, not the danger color', () => {
      const { container } = renderOmemo('verified')
      const shieldCheck = container.querySelector('.lucide-shield-check')
      expect(shieldCheck).not.toBeNull()
      expect(container.querySelector('.lucide-shield-alert')).toBeNull()
      const status = shieldCheck!.closest('[role="status"]')!
      expect(status.getAttribute('class')).toContain('text-fluux-encryption')
      expect(status.getAttribute('class')).not.toContain('text-fluux-error')
    })

    it('OMEMO tofu → plain Shield + calm color, not the danger color', () => {
      const { container } = renderOmemo('tofu')
      const shield = container.querySelector('.lucide-shield')
      expect(shield).not.toBeNull()
      expect(container.querySelector('.lucide-shield-alert')).toBeNull()
      expect(container.querySelector('.lucide-shield-check')).toBeNull()
      const status = shield!.closest('[role="status"]')!
      expect(status.getAttribute('class')).toContain('text-fluux-muted')
      expect(status.getAttribute('class')).not.toContain('text-fluux-error')
    })
  })

  describe('Title Bar', () => {
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

    it('carries the aurora horizon hairline', () => {
      const { container } = render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
        />
      )

      const header = container.querySelector('header')
      expect(header).not.toBeNull()
      expect(header!.className).toContain('aurora-horizon')
      expect(header!.className).toContain('relative')
    })
  })

  describe('Conversation menu (kebab)', () => {
    const openMenu = () =>
      fireEvent.click(screen.getByRole('button', { name: 'contacts.actionsMenu' }))

    it('renders a conversation menu for a 1:1 chat', () => {
      render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
          onShowProfile={vi.fn()}
          isArchived={false}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
        />
      )

      expect(screen.getByRole('button', { name: 'contacts.actionsMenu' })).toBeInTheDocument()
    })

    it('opens a Contact info item that calls onShowProfile', () => {
      const onShowProfile = vi.fn()
      render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
          onShowProfile={onShowProfile}
          isArchived={false}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
        />
      )

      openMenu()
      fireEvent.click(screen.getByText('sidebar.viewProfile'))
      expect(onShowProfile).toHaveBeenCalledTimes(1)
    })

    it('shows Archive (not Unarchive) for an unarchived chat and calls onArchive', () => {
      const onArchive = vi.fn()
      render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
          onShowProfile={vi.fn()}
          isArchived={false}
          onArchive={onArchive}
          onUnarchive={vi.fn()}
        />
      )

      openMenu()
      expect(screen.queryByText('conversations.unarchive')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('conversations.archive'))
      expect(onArchive).toHaveBeenCalledTimes(1)
    })

    it('shows Unarchive (not Archive) for an archived chat and calls onUnarchive', () => {
      const onUnarchive = vi.fn()
      render(
        <ChatHeader
          name="Alice"
          type="chat"
          jid="alice@example.com"
          onShowProfile={vi.fn()}
          isArchived={true}
          onArchive={vi.fn()}
          onUnarchive={onUnarchive}
        />
      )

      openMenu()
      expect(screen.queryByText('conversations.archive')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('conversations.unarchive'))
      expect(onUnarchive).toHaveBeenCalledTimes(1)
    })

    it('does not render the conversation menu in group chat mode', () => {
      render(
        <ChatHeader
          name="Room"
          type="groupchat"
          jid="room@conf.example.com"
          isArchived={false}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
        />
      )

      expect(
        screen.queryByRole('button', { name: 'contacts.actionsMenu' })
      ).not.toBeInTheDocument()
    })
  })
})
