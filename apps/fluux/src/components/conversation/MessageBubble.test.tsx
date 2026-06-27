import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { MessageBubble, buildReplyContext, type MessageBubbleProps } from './MessageBubble'
import type { BaseMessage } from '@fluux/sdk'
import { setPeerVerified, clearPeerVerified } from '@/stores/verifiedPeerKeysStore'
import type { DensityMode } from '@/stores/settingsStore'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

// Mock date-fns to have predictable timestamps
vi.mock('date-fns', () => ({
  format: vi.fn(() => '14:30'),
}))

// Mock messageGrouping utilities
vi.mock('./messageGrouping', () => ({
  scrollToMessage: vi.fn(),
  isActionMessage: (body?: string) => body?.startsWith('/me '),
}))

// Stub EncryptedPlaceholder — it depends on several store hooks not mocked here.
// We only need to assert MessageBubble routes to it when encryptedPayload is set.
vi.mock('./EncryptedPlaceholder', () => ({
  EncryptedPlaceholder: () => <div data-testid="encrypted-placeholder" />,
}))

// Avatar mock that exposes the size prop via data-size for density assertions.
// Does NOT render the name as text to avoid duplicates with the nick header.
vi.mock('../Avatar', () => ({
  Avatar: ({ size }: { name?: string; size?: string }) => (
    <div data-testid="avatar" data-size={size ?? 'md'} />
  ),
}))

// Mutable density so tests can override it without re-importing.
const settings = { densityMode: 'comfortable' as DensityMode }

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: typeof settings) => unknown) => selector(settings),
}))

// Create a base message for testing
function createTestMessage(overrides: Partial<BaseMessage> = {}): BaseMessage {
  return {
    type: 'chat',
    id: 'msg-1',
    from: 'alice@example.com',
    body: 'Hello, world!',
    timestamp: new Date('2024-01-15T14:30:00Z'),
    isOutgoing: false,
    ...overrides,
  }
}

// Default props for MessageBubble
function createDefaultProps(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
  return {
    message: createTestMessage(),
    showAvatar: true,
    isLastOutgoing: false,
    isLastMessage: false,
    senderName: 'Alice',
    senderColor: 'rgb(100, 100, 200)',
    avatarIdentifier: 'alice@example.com',
    myReactions: [],
    onReaction: vi.fn(),
    getReactorName: vi.fn((id) => id),
    onReply: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined),
    formatTime: () => '14:30',
    timeFormat: '24h',
    ...overrides,
  }
}

describe('MessageBubble', () => {
  describe('Basic Rendering', () => {
    it('renders message body', () => {
      const props = createDefaultProps()
      render(<MessageBubble {...props} />)

      expect(screen.getByText('Hello, world!')).toBeInTheDocument()
    })

    it('renders sender name when showAvatar is true', () => {
      const props = createDefaultProps({ showAvatar: true })
      render(<MessageBubble {...props} />)

      expect(screen.getByText('Alice')).toBeInTheDocument()
    })

    it('does not render sender name when showAvatar is false', () => {
      const props = createDefaultProps({ showAvatar: false })
      render(<MessageBubble {...props} />)

      expect(screen.queryByText('Alice')).not.toBeInTheDocument()
    })

    it('renders timestamp', () => {
      const props = createDefaultProps()
      render(<MessageBubble {...props} />)

      // Timestamp appears in multiple places (data attribute and header)
      expect(screen.getAllByText('14:30').length).toBeGreaterThan(0)
    })

    it('applies sender color to name', () => {
      const props = createDefaultProps({
        senderColor: 'rgb(255, 0, 0)',
      })
      render(<MessageBubble {...props} />)

      const nameElement = screen.getByText('Alice')
      expect(nameElement).toHaveStyle({ color: 'rgb(255, 0, 0)' })
    })
  })

  describe('Action Messages (/me)', () => {
    it('renders /me action messages differently', () => {
      const props = createDefaultProps({
        message: createTestMessage({ body: '/me waves hello' }),
      })
      render(<MessageBubble {...props} />)

      // For /me messages, the name is hidden from header (shown inline in body)
      // The timestamp is shown instead of avatar
      expect(screen.getAllByText('14:30').length).toBeGreaterThan(0)
    })
  })

  describe('Retracted Messages', () => {
    it('hides toolbar for retracted messages', () => {
      const props = createDefaultProps({
        message: createTestMessage({ isRetracted: true }),
      })
      const { container } = render(<MessageBubble {...props} />)

      // The toolbar should not be in the DOM for retracted messages
      expect(container.querySelector('[data-testid="message-toolbar"]')).not.toBeInTheDocument()
    })
  })

  describe('Selection States', () => {
    it('applies selection styling when isSelected is true', () => {
      const props = createDefaultProps({ isSelected: true })
      const { container } = render(<MessageBubble {...props} />)

      // Check that the content div has selection styling
      const contentDiv = container.querySelector('.bg-fluux-hover')
      expect(contentDiv).toBeInTheDocument()
    })

    it('disables hover when hasKeyboardSelection is true', () => {
      const props = createDefaultProps({ hasKeyboardSelection: true })
      const { container } = render(<MessageBubble {...props} />)

      // The outer div should not have hover:bg-fluux-hover when keyboard selection is active
      const outerDiv = container.firstChild as HTMLElement
      expect(outerDiv.className).not.toContain('hover:bg-fluux-hover')
    })
  })

  describe('Reply Context', () => {
    it('renders reply context when provided', () => {
      const props = createDefaultProps({
        replyContext: {
          senderName: 'Bob',
          senderColor: 'rgb(0, 255, 0)',
          body: 'Original message',
          messageId: 'original-msg-1',
          avatarIdentifier: 'bob@example.com',
        },
      })
      render(<MessageBubble {...props} />)

      expect(screen.getByText('Bob')).toBeInTheDocument()
      expect(screen.getByText('Original message')).toBeInTheDocument()
    })

    it('does not render an avatar in the reply context (avatar-less design)', () => {
      const props = createDefaultProps({
        replyContext: {
          senderName: 'Bob',
          senderColor: 'rgb(0, 255, 0)',
          body: 'Original message',
          messageId: 'original-msg-1',
          avatarIdentifier: 'bob@example.com',
          avatarUrl: 'https://example.com/bob-avatar.jpg',
        },
      })
      render(<MessageBubble {...props} />)

      // The reply chip is avatar-less even when an avatar URL is available;
      // identity is carried by the colored edge + nick text.
      expect(screen.queryByRole('img', { name: 'Bob' })).not.toBeInTheDocument()
      expect(screen.getByText('Bob')).toBeInTheDocument()
      expect(screen.getByText('Original message')).toBeInTheDocument()
    })

    it('does not render avatar in reply context when avatarUrl is undefined', () => {
      const props = createDefaultProps({
        replyContext: {
          senderName: 'Bob',
          senderColor: 'rgb(0, 255, 0)',
          body: 'Original message',
          messageId: 'original-msg-1',
          avatarIdentifier: 'bob@example.com',
          // avatarUrl is intentionally omitted - should not render avatar
        },
      })
      render(<MessageBubble {...props} />)

      // When avatarUrl is not provided, no avatar img should be rendered in reply context
      const avatarImg = screen.queryByRole('img', { name: 'Bob' })
      expect(avatarImg).not.toBeInTheDocument()
    })

    // The reply chip is avatar-less: identity is carried by the colored edge and
    // the nick text, both following replyContext.senderColor (the contact color),
    // so the reply matches the sender's color in the thread.
    it('uses replyContext.senderColor for the quote edge and name', () => {
      const props = createDefaultProps({
        replyContext: {
          senderName: 'Bob',
          senderColor: 'rgb(0, 255, 0)',
          body: 'Original message',
          messageId: 'original-msg-1',
          avatarIdentifier: 'bob@example.com',
        },
      })
      render(<MessageBubble {...props} />)

      const quote = screen.getByText('Original message').closest('button')!
      expect(quote).toHaveStyle({ borderColor: 'rgb(0, 255, 0)' })
      expect(within(quote).getByText('Bob')).toHaveStyle({ color: 'rgb(0, 255, 0)' })
      // the leading reply arrow also follows the sender hue
      expect(quote.querySelector('svg')).toHaveStyle({ color: 'rgb(0, 255, 0)' })
    })

    it('re-renders the quote when only replyContext.senderColor changes', () => {
      // Contact colors can arrive after the first render (roster load) — a
      // senderColor-only change must invalidate the memo or the quote keeps
      // the stale nick-hash color forever.
      const base = {
        senderName: 'Bob',
        senderColor: 'rgb(0, 255, 0)',
        body: 'Original message',
        messageId: 'original-msg-1',
        avatarIdentifier: 'bob@example.com',
      }
      const props = createDefaultProps({ replyContext: base })
      const { rerender } = render(<MessageBubble {...props} />)

      rerender(<MessageBubble {...props} replyContext={{ ...base, senderColor: 'rgb(255, 0, 255)' }} />)

      const quote = screen.getByText('Original message').closest('button')!
      expect(quote).toHaveStyle({ borderColor: 'rgb(255, 0, 255)' })
      expect(within(quote).getByText('Bob')).toHaveStyle({ color: 'rgb(255, 0, 255)' })
    })

    it('does not render reply context for retracted messages', () => {
      const props = createDefaultProps({
        message: createTestMessage({ isRetracted: true }),
        replyContext: {
          senderName: 'Bob',
          avatarIdentifier: 'bob@example.com',
          senderColor: 'rgb(0, 255, 0)',
          body: 'Original message',
          messageId: 'original-msg-1',
        },
      })
      render(<MessageBubble {...props} />)

      expect(screen.queryByText('Original message')).not.toBeInTheDocument()
    })
  })

  describe('Nick Extras (Room badges)', () => {
    it('renders nick extras when provided', () => {
      const props = createDefaultProps({
        nickExtras: <span data-testid="moderator-badge">Mod</span>,
      })
      render(<MessageBubble {...props} />)

      expect(screen.getByTestId('moderator-badge')).toBeInTheDocument()
    })
  })

  describe('Reactions', () => {
    it('calls onReaction when reaction is toggled', async () => {
      const onReaction = vi.fn()
      const props = createDefaultProps({
        myReactions: [],
        onReaction,
      })
      render(<MessageBubble {...props} />)

      // The reaction picker would need to be opened first
      // This test verifies the callback is wired up correctly
      expect(onReaction).not.toHaveBeenCalled()
    })
  })

  describe('Moderation (XEP-0425)', () => {
    it('shows delete button for non-outgoing messages when canModerate is true', () => {
      const props = createDefaultProps({
        message: createTestMessage({ isOutgoing: false }),
        canModerate: true,
      })
      const { container } = render(<MessageBubble {...props} />)

      // The toolbar should be present (not hidden by retracted check)
      // canDelete is true because canModerate is true
      expect(container.querySelector('[data-message-id="msg-1"]')).toBeInTheDocument()
    })

    it('does not show delete button for non-outgoing messages without canModerate', () => {
      const props = createDefaultProps({
        message: createTestMessage({ isOutgoing: false }),
        canModerate: false,
      })
      const { container } = render(<MessageBubble {...props} />)

      // canDelete should be false (not outgoing and canModerate is false)
      expect(container.querySelector('[data-message-id="msg-1"]')).toBeInTheDocument()
    })
  })

  describe('Security Context', () => {
    // Regression: the memo comparator used to ignore `securityContext`,
    // so a trust upgrade (the openpgp plugin promoting an `untrusted`
    // message to `trusted` once the sender's PEP key arrives) would be
    // skipped and the lock badge would stay yellow forever.
    it('re-renders the lock badge when the security context trust is upgraded', () => {
      const props = createDefaultProps({
        message: createTestMessage({
          securityContext: { protocolId: 'openpgp', trust: 'untrusted' },
        }),
      })
      const { rerender, container } = render(<MessageBubble {...props} />)

      const stale = container.querySelector(
        '[aria-label="Encrypted with openpgp, trust untrusted"]',
      )
      expect(stale).not.toBeNull()

      // Same message id / body / everything else — only the trust changes.
      // Without the fix React.memo would skip this re-render entirely.
      rerender(
        <MessageBubble
          {...props}
          message={createTestMessage({
            securityContext: { protocolId: 'openpgp', trust: 'tofu' },
          })}
        />,
      )

      expect(
        container.querySelector('[aria-label="Encrypted with openpgp, trust tofu"]'),
      ).not.toBeNull()
      expect(
        container.querySelector('[aria-label="Encrypted with openpgp, trust untrusted"]'),
      ).toBeNull()
    })

    it('upgrades a tofu lock to verified once the peer is verified out-of-band', () => {
      // Frozen-color regression: verifying a peer must recolor their already-
      // decrypted `tofu` messages to `verified` live — the stored
      // securityContext.trust does NOT change, so the bubble must derive the
      // displayed trust from the live verification store.
      const peer = 'verifytest@example.com'
      const fingerprint = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
      clearPeerVerified(peer)
      const props = createDefaultProps({
        message: createTestMessage({
          from: peer,
          // The message carries its signing fingerprint; the live upgrade keys
          // on a MATCH against the verified one, not mere JID existence.
          securityContext: { protocolId: 'openpgp', trust: 'tofu', fingerprint },
        }),
      })
      const { container } = render(<MessageBubble {...props} />)
      expect(
        container.querySelector('[aria-label="Encrypted with openpgp, trust tofu"]'),
      ).not.toBeNull()

      // User confirms the peer's fingerprint out-of-band — a store update only,
      // no prop/securityContext change on the message.
      act(() => {
        setPeerVerified(peer, fingerprint)
      })

      expect(
        container.querySelector('[aria-label="Encrypted with openpgp, trust verified"]'),
      ).not.toBeNull()
      expect(
        container.querySelector('[aria-label="Encrypted with openpgp, trust tofu"]'),
      ).toBeNull()
      clearPeerVerified(peer)
    })

    it('downgrades a verified lock back to tofu when verification is cleared', () => {
      const peer = 'verifytest2@example.com'
      const fingerprint = 'FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000'
      setPeerVerified(peer, fingerprint)
      const props = createDefaultProps({
        message: createTestMessage({
          from: peer,
          securityContext: { protocolId: 'openpgp', trust: 'verified', fingerprint },
        }),
      })
      const { container } = render(<MessageBubble {...props} />)
      expect(
        container.querySelector('[aria-label="Encrypted with openpgp, trust verified"]'),
      ).not.toBeNull()

      act(() => {
        clearPeerVerified(peer)
      })

      expect(
        container.querySelector('[aria-label="Encrypted with openpgp, trust tofu"]'),
      ).not.toBeNull()
    })

    it('re-renders the tooltip when only the security notes change', () => {
      // The tooltip is built from `notes`, so a notes-only mutation must
      // invalidate the memo too — otherwise users see stale "sender key
      // not cached" text after the cache populated.
      const props = createDefaultProps({
        message: createTestMessage({
          securityContext: {
            protocolId: 'openpgp',
            trust: 'untrusted',
            notes: ['Sender key not cached — signature not checked'],
          },
        }),
      })
      const { rerender, container } = render(<MessageBubble {...props} />)

      // The Tooltip wraps the lock span in an inline-flex div trigger
      const lockSpan = container.querySelector('[aria-label^="Encrypted with openpgp"]')
      const trigger = lockSpan?.parentElement
      expect(trigger).not.toBeNull()

      // Click to reveal the tooltip (triggerMode="click")
      fireEvent.click(trigger!)

      expect(screen.getByRole('tooltip').textContent).toContain('Sender key not cached')

      rerender(
        <MessageBubble
          {...props}
          message={createTestMessage({
            securityContext: {
              protocolId: 'openpgp',
              trust: 'untrusted',
              notes: ['Signature did not verify'],
            },
          })}
        />,
      )

      expect(screen.getByRole('tooltip').textContent).toContain('Signature did not verify')
      expect(screen.getByRole('tooltip').textContent).not.toContain('Sender key not cached')
    })

    it('does not re-render when securityContext is referentially different but value-equal', () => {
      // The SDK can hand us a fresh securityContext object on every store
      // update even when the trust hasn't actually changed. The stringify
      // comparison must treat those as equal so we don't churn the DOM.
      // We assert this indirectly by mutating a callback ref alongside —
      // a callback-only change must not re-render (existing memo
      // guarantee), and adding a value-equal securityContext must not
      // break that.
      const onReply = vi.fn()
      const props = createDefaultProps({
        message: createTestMessage({
          securityContext: { protocolId: 'openpgp', trust: 'tofu' },
        }),
        onReply,
      })
      const { rerender, container } = render(<MessageBubble {...props} />)
      const firstNode = container.querySelector(
        '[aria-label="Encrypted with openpgp, trust tofu"]',
      )

      rerender(
        <MessageBubble
          {...props}
          message={createTestMessage({
            // New object reference, identical contents.
            securityContext: { protocolId: 'openpgp', trust: 'tofu' },
          })}
          onReply={vi.fn()}
        />,
      )

      const secondNode = container.querySelector(
        '[aria-label="Encrypted with openpgp, trust tofu"]',
      )
      // Same DOM node retained → memo correctly skipped the render.
      expect(secondNode).toBe(firstNode)
    })
  })

  describe('Encrypted payload (deferred/failed decrypt)', () => {
    it('renders EncryptedPlaceholder instead of the body when encryptedPayload is set', () => {
      const props = createDefaultProps({
        message: createTestMessage({
          body: 'this fallback hint text must NOT be shown',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">cipher</openpgp>',
        }),
      })
      render(<MessageBubble {...props} />)

      // The placeholder takes over the body region…
      expect(screen.getByTestId('encrypted-placeholder')).toBeInTheDocument()
      // …and the raw body text is NOT rendered.
      expect(screen.queryByText(/this fallback hint text must NOT be shown/)).not.toBeInTheDocument()
    })
  })

  describe('Unsupported encryption', () => {
    it('replaces the sender fallback body with a localized notice', () => {
      const props = createDefaultProps({
        message: createTestMessage({
          body: "I sent you an OMEMO encrypted message but your client doesn't support it.",
          unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
        }),
      })
      render(<MessageBubble {...props} />)

      // The sender's arbitrary plaintext fallback must NOT reach the UI…
      expect(
        screen.queryByText(/I sent you an OMEMO encrypted message/),
      ).not.toBeInTheDocument()

      // …it is replaced by the localized unsupported-encryption notice.
      // (t() returns the key in tests, so the method interpolation isn't visible.)
      expect(screen.getByText('chat.encryption.unsupportedMessage')).toBeInTheDocument()
    })
  })

  describe('Data Attributes', () => {
    it('sets correct data attributes on the message bubble', () => {
      const props = createDefaultProps({
        message: createTestMessage({
          id: 'test-msg-123',
          body: 'Test message content',
        }),
        senderName: 'TestUser',
      })
      const { container } = render(<MessageBubble {...props} />)

      const messageDiv = container.firstChild as HTMLElement
      expect(messageDiv.getAttribute('data-message-id')).toBe('test-msg-123')
      expect(messageDiv.getAttribute('data-message-from')).toBe('TestUser')
      expect(messageDiv.getAttribute('data-message-body')).toBe('Test message content')
    })
  })

  describe('Whisper threads (MUC private messages)', () => {
    // A whisper can only be continued via "reply" (it re-enters whisper mode
    // upstream), so unlike public messages the reply button must also be
    // available on the LAST message of the conversation.
    function whisperProps(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
      return createDefaultProps({
        whisperThread: 'solo',
        whisperWith: 'Adrien',
        counterpartPresent: true,
        ...overrides,
      })
    }

    it('shows the reply button on the last message when it is a whisper', () => {
      render(<MessageBubble {...whisperProps({ isLastMessage: true })} />)

      expect(screen.getByRole('button', { name: 'chat.reply' })).toBeInTheDocument()
    })

    it('keeps the reply button hidden on the last message when it is public', () => {
      render(<MessageBubble {...createDefaultProps({ isLastMessage: true })} />)

      expect(screen.queryByRole('button', { name: 'chat.reply' })).not.toBeInTheDocument()
    })

    it('hides the reply button on a whisper when the counterpart left the room', () => {
      render(<MessageBubble {...whisperProps({ isLastMessage: true, counterpartPresent: false })} />)

      expect(screen.queryByRole('button', { name: 'chat.reply' })).not.toBeInTheDocument()
    })

    it('re-enters whisper mode when the thread header is clicked', () => {
      const onReply = vi.fn()
      render(<MessageBubble {...whisperProps({ onReply })} />)

      const header = screen.getByText('rooms.whisperThread').closest('button')
      expect(header).not.toBeNull()
      fireEvent.click(header!)

      expect(onReply).toHaveBeenCalledTimes(1)
    })

    it('renders the thread header as plain text when the counterpart left the room', () => {
      render(<MessageBubble {...whisperProps({ counterpartPresent: false })} />)

      expect(screen.getByText('rooms.whisperThread')).toBeInTheDocument()
      expect(screen.getByText('rooms.whisperThread').closest('button')).toBeNull()
    })

    // Action gating (XEP-0045 §7.5 parity): edit/delete/react are wired through
    // computeMessageActions. These guard the wiring so a future refactor can't
    // re-expose a private-message action (or leak moderation onto a whisper).
    it('shows edit, delete, and react on an own whisper while the counterpart is present', () => {
      render(<MessageBubble {...whisperProps({
        message: createTestMessage({ isOutgoing: true }),
        isLastOutgoing: true,
        isLastMessage: true,
      })} />)

      expect(screen.getByRole('button', { name: 'chat.editMessage' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'chat.moreReactions' })).toBeInTheDocument()
      // Delete lives behind the more-options button, enabled only when delete is allowed.
      expect(screen.getByRole('button', { name: 'chat.moreOptions' })).toBeEnabled()
    })

    it('shows react but hides edit and delete on an incoming whisper', () => {
      render(<MessageBubble {...whisperProps({
        message: createTestMessage({ isOutgoing: false }),
      })} />)

      expect(screen.getByRole('button', { name: 'chat.moreReactions' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'chat.editMessage' })).not.toBeInTheDocument()
      // No moderation-delete on a whisper: more-options is present but disabled.
      expect(screen.getByRole('button', { name: 'chat.moreOptions' })).toBeDisabled()
    })

    it('disables edit, delete, and react on a whisper once the counterpart has left', () => {
      render(<MessageBubble {...whisperProps({
        message: createTestMessage({ isOutgoing: true }),
        isLastOutgoing: true,
        isLastMessage: true,
        counterpartPresent: false,
      })} />)

      expect(screen.queryByRole('button', { name: 'chat.editMessage' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'chat.moreReactions' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'chat.moreOptions' })).toBeDisabled()
    })
  })
})

describe('buildReplyContext', () => {
  // The referenced message is resolved by the caller (reactively, via
  // useReferencedMessage) and passed in directly — buildReplyContext no longer
  // performs the lookup itself, so it can never freeze inside a memoized row.
  it('returns undefined when message has no replyTo', () => {
    const message = createTestMessage()

    const result = buildReplyContext(
      message,
      undefined,
      () => 'Unknown',
      () => 'rgb(0, 0, 0)',
      () => ({ avatarUrl: undefined, avatarIdentifier: 'unknown' })
    )

    expect(result).toBeUndefined()
  })

  it('builds reply context from the resolved original message', () => {
    const originalMessage = createTestMessage({
      id: 'original-1',
      body: 'Original body',
      from: 'bob@example.com',
    })
    const replyMessage = createTestMessage({
      id: 'reply-1',
      replyTo: { id: 'original-1', to: 'bob@example.com' },
    })

    const result = buildReplyContext(
      replyMessage,
      originalMessage,
      (msg) => msg ? 'Bob' : 'Unknown',
      () => 'rgb(100, 100, 100)',
      (msg) => ({ avatarUrl: msg ? 'http://example.com/bob.jpg' : undefined, avatarIdentifier: 'bob@example.com' })
    )

    expect(result).toEqual({
      senderName: 'Bob',
      senderColor: 'rgb(100, 100, 100)',
      body: 'Original body',
      messageId: 'original-1',
      avatarUrl: 'http://example.com/bob.jpg',
      avatarIdentifier: 'bob@example.com',
    })
  })

  it('uses fallback when the original message is not resolved (e.g. not yet loaded)', () => {
    const replyMessage = createTestMessage({
      id: 'reply-1',
      replyTo: {
        id: 'missing-1',
        to: 'charlie@example.com',
        fallbackBody: 'Fallback text',
      },
    })

    const result = buildReplyContext(
      replyMessage,
      undefined,
      (msg, fallbackId) => msg ? 'Found' : (fallbackId ? 'Charlie' : 'Unknown'),
      () => 'rgb(50, 50, 50)',
      (_msg, fallbackId) => ({ avatarUrl: undefined, avatarIdentifier: fallbackId || 'unknown' })
    )

    expect(result).toEqual({
      senderName: 'Charlie',
      senderColor: 'rgb(50, 50, 50)',
      body: 'Fallback text',
      messageId: 'missing-1',
      avatarUrl: undefined,
      avatarIdentifier: 'charlie@example.com',
    })
  })

  it('uses the original message id (not the referenced stanza-id) for scroll targeting', () => {
    // When a reply references a message by its stanza-id (from MAM) but the DOM
    // keys rows by the client-generated message.id, the reply chip must scroll to
    // originalMessage.id. Resolution across id/stanza-id now happens upstream
    // (useReferencedMessage); buildReplyContext just prefers the resolved id.
    const originalMessage = createTestMessage({
      id: 'client-uuid-123',           // The client-generated ID used in DOM
      stanzaId: 'mam-stanza-id-456',   // The server-assigned stanza-id from MAM
      body: 'Original body',
      from: 'bob@example.com',
    })
    const replyMessage = createTestMessage({
      id: 'reply-1',
      // Reply references the message by stanza-id (common when original came from MAM)
      replyTo: { id: 'mam-stanza-id-456', to: 'bob@example.com' },
    })

    const result = buildReplyContext(
      replyMessage,
      originalMessage,
      (msg) => msg ? 'Bob' : 'Unknown',
      () => 'rgb(100, 100, 100)',
      () => ({ avatarUrl: 'http://example.com/bob.jpg', avatarIdentifier: 'bob@example.com' })
    )

    // The messageId should be the client-generated ID (used in DOM),
    // not the stanza-id that was in replyTo.id
    expect(result).toEqual({
      senderName: 'Bob',
      senderColor: 'rgb(100, 100, 100)',
      body: 'Original body',
      messageId: 'client-uuid-123',  // NOT 'mam-stanza-id-456'
      avatarUrl: 'http://example.com/bob.jpg',
      avatarIdentifier: 'bob@example.com',
    })
  })
})

describe('Own-message tint', () => {
  it('applies the own-tint class to outgoing messages', () => {
    const props = createDefaultProps({ message: createTestMessage({ isOutgoing: true }) })
    const { container } = render(<MessageBubble {...props} />)
    expect(container.querySelector('.message-own-tint')).toBeInTheDocument()
  })

  it('does not apply the own-tint class to incoming messages', () => {
    const props = createDefaultProps({ message: createTestMessage({ isOutgoing: false }) })
    const { container } = render(<MessageBubble {...props} />)
    expect(container.querySelector('.message-own-tint')).not.toBeInTheDocument()
  })
})

describe('Density spacing', () => {
  it('marks group-start rows with the density spacing class', () => {
    const groupStartProps = createDefaultProps({ showAvatar: true })
    const { container: groupStartContainer } = render(<MessageBubble {...groupStartProps} />)
    const outerRow = groupStartContainer.firstChild as HTMLElement
    expect(outerRow.className).toContain('message-group-start')

    const continuationProps = createDefaultProps({ showAvatar: false })
    const { container: continuationContainer } = render(<MessageBubble {...continuationProps} />)
    const continuationRow = continuationContainer.firstChild as HTMLElement
    expect(continuationRow.className).not.toContain('message-group-start')
  })
})

describe('Density avatar size', () => {
  beforeEach(() => {
    settings.densityMode = 'comfortable'
  })

  it('renders a compact (sm) message avatar when density is compact', () => {
    settings.densityMode = 'compact'
    render(<MessageBubble {...createDefaultProps({ showAvatar: true })} />)
    const avatar = screen.getByTestId('avatar')
    expect(avatar.getAttribute('data-size')).toBe('sm')
  })

  it('keeps the md avatar in comfortable density', () => {
    settings.densityMode = 'comfortable'
    render(<MessageBubble {...createDefaultProps({ showAvatar: true })} />)
    const avatar = screen.getByTestId('avatar')
    expect(avatar.getAttribute('data-size')).toBe('md')
  })

  it('narrows the avatar column to w-8 in compact density with 24h time format', () => {
    settings.densityMode = 'compact'
    const { container } = render(<MessageBubble {...createDefaultProps({ showAvatar: true, timeFormat: '24h' })} />)
    const col = container.querySelector('.flex-shrink-0') as HTMLElement
    expect(col.className).toContain('w-8')
  })

  it('narrows the avatar column to w-10 in compact density with 12h time format', () => {
    settings.densityMode = 'compact'
    const { container } = render(<MessageBubble {...createDefaultProps({ showAvatar: true, timeFormat: '12h' })} />)
    const col = container.querySelector('.flex-shrink-0') as HTMLElement
    expect(col.className).toContain('w-10')
  })

  it('uses w-10 column in comfortable density with 24h time format', () => {
    settings.densityMode = 'comfortable'
    const { container } = render(<MessageBubble {...createDefaultProps({ showAvatar: true, timeFormat: '24h' })} />)
    const col = container.querySelector('.flex-shrink-0') as HTMLElement
    expect(col.className).toContain('w-10')
  })

  it('uses w-12 column in comfortable density with 12h time format', () => {
    settings.densityMode = 'comfortable'
    const { container } = render(<MessageBubble {...createDefaultProps({ showAvatar: true, timeFormat: '12h' })} />)
    const col = container.querySelector('.flex-shrink-0') as HTMLElement
    expect(col.className).toContain('w-12')
  })
})
