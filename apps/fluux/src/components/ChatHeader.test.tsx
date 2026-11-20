import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react'
import { ChatHeader } from './ChatHeader'
import type { Contact } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

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
      ({ kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555', trust }) as const

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

  describe('Keys that wait', () => {
    const renderHeader = (encryptionState: ConversationEncryptionState, onReviewKeysClick?: () => void) => {
      const contact = setupContact()
      return render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid={contact.jid}
          encryptionState={encryptionState}
          onReviewKeysClick={onReviewKeysClick}
        />
      )
    }

    it('shows a waiting shield that opens the keys when every key waits for a decision', () => {
      const onReviewKeysClick = vi.fn()
      renderHeader({ kind: 'unsupported', needsDecision: true, waiting: 1 }, onReviewKeysClick)

      fireEvent.click(screen.getByRole('button', { name: 'contacts.encryption.needsDecisionTitle' }))

      expect(onReviewKeysClick).toHaveBeenCalledTimes(1)
    })

    it('names the wait for earlier trust decisions when every key waits for trust data', () => {
      renderHeader({ kind: 'unsupported', needsDecision: true, waiting: 1, pending: 1 }, vi.fn())

      expect(screen.getByRole('button', { name: 'contacts.encryption.trustPendingTitle' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'contacts.encryption.needsDecisionTitle' })).not.toBeInTheDocument()
    })

    it('shows no encryption icon for a contact without keys', () => {
      const { container } = renderHeader({ kind: 'unsupported' }, vi.fn())

      expect(container.querySelector('svg[class*="lucide-shield"], svg[class*="lucide-lock"]')).toBeNull()
    })
  })

  describe('Encryption tooltip', () => {
    const hoverShield = (name: string) => {
      vi.useFakeTimers()
      try {
        fireEvent.mouseEnter(screen.getByRole('button', { name }).parentElement!)
        act(() => { vi.advanceTimersByTime(1000) })
      } finally {
        vi.useRealTimers()
      }
    }

    it('explains an unverified keyset instead of the generic OpenPGP label', () => {
      const contact = setupContact()
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid={contact.jid}
          encryptionState={{ kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', fingerprint: 'AAAA1111', trust: 'tofu', partlyVerified: true }}
          onEncryptionClick={vi.fn()}
          onDisableEncryptionClick={vi.fn()}
        />
      )
      hoverShield('chat.verifyPeer.chipAriaLabel')

      expect(screen.getByText('chat.encryption.unverifiedKeysetTooltip')).toBeInTheDocument()
      expect(screen.queryByText('chat.encryption.openpgpTooltip')).not.toBeInTheDocument()
    })

    it('keeps the generic OpenPGP label for a single-key unverified contact', () => {
      const contact = setupContact()
      render(
        <ChatHeader
          name="Alice Smith"
          type="chat"
          contact={contact}
          jid={contact.jid}
          encryptionState={{ kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', fingerprint: 'AAAA1111', trust: 'tofu', canVerify: true }}
          onEncryptionClick={vi.fn()}
          onDisableEncryptionClick={vi.fn()}
        />
      )
      hoverShield('chat.verifyPeer.chipAriaLabel')

      expect(screen.getByText('chat.encryption.openpgpTooltip')).toBeInTheDocument()
      expect(screen.queryByText('chat.encryption.unverifiedKeysetTooltip')).not.toBeInTheDocument()
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
  // Right-click on the contact opens Fluux's contact menu (same entries as the ⋯ menu).
  describe('Contact context menu', () => {
    const full = () => ({
      onShowProfile: vi.fn(),
      onSearchInConversation: vi.fn(),
      onArchive: vi.fn(),
      onUnarchive: vi.fn(),
      onRenameContact: vi.fn().mockResolvedValue(undefined),
      onBlock: vi.fn(),
      onUnblock: vi.fn(),
      onRemoveContact: vi.fn(),
      onAddContact: vi.fn(),
    })
    const renderHeader = (extra: Record<string, unknown> = {}, type: 'chat' | 'groupchat' = 'chat') => {
      const handlers = full()
      const utils = render(
        <ChatHeader name="Alice" type={type} jid="alice@example.com" isArchived={false} isBlocked={false}
          onShowProfile={handlers.onShowProfile} onSearchInConversation={handlers.onSearchInConversation}
          onArchive={handlers.onArchive} onUnarchive={handlers.onUnarchive}
          onRenameContact={handlers.onRenameContact} onBlock={handlers.onBlock} onUnblock={handlers.onUnblock}
          onRemoveContact={handlers.onRemoveContact} {...extra} />
      )
      return { ...utils, handlers }
    }
    const rows = () => within(screen.getByRole('menu')).getAllByRole('button').map((b) => b.textContent)
    const rightClick = (el: Element, init: Record<string, unknown> = {}) => fireEvent.contextMenu(el, { clientX: 40, clientY: 30, ...init })

    it('opens at the pointer, cancels the system menu and lists every entry in order', () => {
      renderHeader()
      const notPrevented = rightClick(screen.getByRole('heading', { name: 'Alice' }))
      expect(notPrevented).toBe(false) // default prevented
      expect(rows()).toEqual([
        'sidebar.viewProfile', 'contacts.copyAddress', 'chat.searchInConversation', 'contacts.rename',
        'conversations.archive', 'contacts.blockUser', 'contacts.removeFromRoster',
      ])
    })

    it('shows the same entries as the ⋯ menu apart from the container-query hidden search', () => {
      renderHeader()
      fireEvent.click(screen.getByRole('button', { name: 'contacts.actionsMenu' }))
      const kebab = within(screen.getByRole('menu')).getAllByRole('menuitem').map((b) => b.textContent)
      fireEvent.keyDown(document, { key: 'Escape' })
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      expect(rows()).toEqual(kebab)
    })

    it('offers Add to contacts instead of Rename and Remove for a peer outside the contact list', () => {
      renderHeader({ onRenameContact: undefined, onRemoveContact: undefined, onAddContact: vi.fn() })
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      expect(rows()).toEqual([
        'sidebar.viewProfile', 'contacts.copyAddress', 'chat.searchInConversation', 'contacts.addToContacts',
        'conversations.archive', 'contacts.blockUser',
      ])
    })

    it('offers Unblock and Unarchive for a blocked, archived contact', () => {
      renderHeader({ isBlocked: true, isArchived: true })
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      expect(rows()).toContain('contacts.unblockUser')
      expect(rows()).toContain('conversations.unarchive')
      expect(rows()).not.toContain('contacts.blockUser')
    })

    it('opens from the avatar and the status line too', () => {
      renderHeader()
      rightClick(screen.getByTestId('avatar'))
      expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('leaves the system menu alone on Shift + right-click and on the header buttons', () => {
      renderHeader()
      expect(rightClick(screen.getByRole('heading', { name: 'Alice' }), { shiftKey: true })).toBe(true)
      expect(rightClick(screen.getByRole('button', { name: 'contacts.actionsMenu' }))).toBe(true)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('opens no contact menu in a group chat header', () => {
      renderHeader({}, 'groupchat')
      expect(rightClick(screen.getByRole('heading', { name: 'Alice' }))).toBe(true)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('Copy address copies the bare address and closes the menu', () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      renderHeader()
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      fireEvent.click(screen.getByText('contacts.copyAddress'))
      expect(writeText).toHaveBeenCalledWith('alice@example.com')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('Escape closes the menu', () => {
      renderHeader()
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('Block asks first and acts only on confirm; cancelling changes nothing', async () => {
      const { handlers } = renderHeader()
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      fireEvent.click(screen.getByText('contacts.blockUser'))
      expect(screen.getByText('contacts.blockConfirm')).toBeInTheDocument()
      expect(handlers.onBlock).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText('common.cancel'))
      await waitFor(() => expect(screen.queryByText('contacts.blockConfirm')).not.toBeInTheDocument())
      expect(handlers.onBlock).not.toHaveBeenCalled()
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      fireEvent.click(screen.getByText('contacts.blockUser'))
      fireEvent.click(screen.getByText('contacts.block'))
      expect(handlers.onBlock).toHaveBeenCalledTimes(1)
    })

    it('Remove asks first and acts only on confirm', () => {
      const { handlers } = renderHeader()
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      fireEvent.click(screen.getByText('contacts.removeFromRoster'))
      expect(handlers.onRemoveContact).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText('contacts.remove'))
      expect(handlers.onRemoveContact).toHaveBeenCalledTimes(1)
    })

    it('Unblock acts at once', () => {
      const { handlers } = renderHeader({ isBlocked: true })
      rightClick(screen.getByRole('heading', { name: 'Alice' }))
      fireEvent.click(screen.getByText('contacts.unblockUser'))
      expect(handlers.onUnblock).toHaveBeenCalledTimes(1)
    })

    describe('selection', () => {
      beforeEach(() => window.getSelection()?.removeAllRanges())
      const select = (el: Element, text: string) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        sel.addRange(range)
        expect(sel.toString()).toBe(text)
      }

      it('adds Copy on top when words were selected before the click', () => {
        renderHeader()
        const name = screen.getByRole('heading', { name: 'Alice' })
        select(name, 'Alice')
        fireEvent.mouseDown(name, { button: 2 })
        rightClick(name)
        expect(rows()[0]).toBe('chat.selection.copy')
      })

      it('ignores and clears a word that only the right-click selected', () => {
        renderHeader()
        const name = screen.getByRole('heading', { name: 'Alice' })
        fireEvent.mouseDown(name, { button: 2 }) // nothing selected as the button goes down
        select(name, 'Alice') // the engine then selects the word under the pointer
        rightClick(name)
        expect(rows()[0]).toBe('sidebar.viewProfile')
        expect(window.getSelection()!.toString()).toBe('')
      })
    })
  })
})
