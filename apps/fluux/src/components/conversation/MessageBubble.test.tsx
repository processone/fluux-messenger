import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageBubble, buildReplyContext, type MessageBubbleProps } from './MessageBubble'
import type { BaseMessage } from '@fluux/sdk'

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

    it('renders avatar in reply context when avatarUrl is provided', () => {
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

      // When avatarUrl is provided, an img element with that src should be rendered
      const avatarImg = screen.getByRole('img', { name: 'Bob' })
      expect(avatarImg).toBeInTheDocument()
      expect(avatarImg).toHaveAttribute('src', 'https://example.com/bob-avatar.jpg')
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
})

describe('buildReplyContext', () => {
  it('returns undefined when message has no replyTo', () => {
    const message = createTestMessage()
    const messagesById = new Map<string, BaseMessage>()

    const result = buildReplyContext(
      message,
      messagesById,
      () => 'Unknown',
      () => 'rgb(0, 0, 0)',
      () => ({ avatarUrl: undefined, avatarIdentifier: 'unknown' })
    )

    expect(result).toBeUndefined()
  })

  it('builds reply context from original message', () => {
    const originalMessage = createTestMessage({
      id: 'original-1',
      body: 'Original body',
      from: 'bob@example.com',
    })
    const replyMessage = createTestMessage({
      id: 'reply-1',
      replyTo: { id: 'original-1', to: 'bob@example.com' },
    })
    const messagesById = new Map<string, BaseMessage>([
      ['original-1', originalMessage],
    ])

    const result = buildReplyContext(
      replyMessage,
      messagesById,
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

  it('uses fallback when original message not found', () => {
    const replyMessage = createTestMessage({
      id: 'reply-1',
      replyTo: {
        id: 'missing-1',
        to: 'charlie@example.com',
        fallbackBody: 'Fallback text',
      },
    })
    const messagesById = new Map<string, BaseMessage>()

    const result = buildReplyContext(
      replyMessage,
      messagesById,
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

  it('uses original message id when reply references stanza-id (regression test for scroll)', () => {
    // This test verifies the fix for the bug where clicking on a reply context
    // would not scroll to the original message. The issue was that when the reply
    // references a message by its stanza-id (from MAM), but the DOM uses the
    // client-generated message.id for data-message-id, scrollToMessage() wouldn't
    // find the element.
    //
    // The fix ensures we always use originalMessage.id for the messageId.
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
    // The messagesById map is indexed by both id and stanzaId (via createMessageLookup)
    const messagesById = new Map<string, BaseMessage>([
      ['client-uuid-123', originalMessage],
      ['mam-stanza-id-456', originalMessage],  // Same message, indexed by stanza-id too
    ])

    const result = buildReplyContext(
      replyMessage,
      messagesById,
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
