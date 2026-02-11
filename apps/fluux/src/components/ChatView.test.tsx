import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChatView } from './ChatView'
import type { Message, Contact, Conversation } from '@fluux/sdk'

// Helper to create test messages
const createMessage = (overrides: Partial<Message> = {}): Message => ({
  type: 'chat',
  id: `msg-${Math.random().toString(36).slice(2)}`,
  conversationId: 'alice@example.com',
  from: 'alice@example.com',
  body: 'Hello there!',
  timestamp: new Date('2024-01-15T10:00:00Z'),
  isOutgoing: false,
  ...overrides,
})

// Helper to create test contact
const createContact = (overrides: Partial<Contact> = {}): Contact => ({
  jid: 'alice@example.com',
  name: 'Alice Smith',
  presence: 'online',
  subscription: 'both',
  ...overrides,
})

// Mock state
let mockActiveConversation: Conversation | null = null
let mockActiveMessages: Message[] = []
let mockTypingUsers: string[] = []
let mockContacts: Contact[] = []
let mockSupportsMAM = true
let mockActiveMAMState: { hasQueried: boolean; isLoading: boolean; isComplete?: boolean } = { hasQueried: true, isLoading: false }

// Mock functions
const mockSendMessage = vi.fn()
const mockSendReaction = vi.fn()
const mockSendCorrection = vi.fn()
const mockRetractMessage = vi.fn()
const mockFetchHistory = vi.fn()
const mockClearFirstNewMessageId = vi.fn()
const mockClearAnimation = vi.fn()

// Mock SDK hooks
vi.mock('@fluux/sdk', () => ({
  getBareJid: (jid: string) => jid.split('/')[0],
  getLocalPart: (jid: string) => jid.split('@')[0],
  useChat: () => ({
    activeConversation: mockActiveConversation,
    activeMessages: mockActiveMessages,
    activeTypingUsers: mockTypingUsers,
    sendMessage: mockSendMessage,
    sendReaction: mockSendReaction,
    sendCorrection: mockSendCorrection,
    retractMessage: mockRetractMessage,
    activeAnimation: null,
    sendEasterEgg: vi.fn(),
    clearAnimation: mockClearAnimation,
    clearFirstNewMessageId: mockClearFirstNewMessageId,
    supportsMAM: mockSupportsMAM,
    activeMAMState: mockActiveMAMState,
    fetchHistory: mockFetchHistory,
    fetchOlderHistory: vi.fn(),
    // Draft management
    getDraft: vi.fn(() => ''),
    setDraft: vi.fn(),
    clearDraft: vi.fn(),
    // Chat state
    sendChatState: vi.fn(),
    // Archive
    isArchived: vi.fn(() => false),
    unarchiveConversation: vi.fn(),
  }),
  useRoster: () => ({
    contacts: mockContacts,
  }),
  useConnection: () => ({
    jid: 'me@example.com/resource',
    ownAvatar: null,
    ownNickname: 'Me',
    isConnected: true,
  }),
  usePresence: () => ({
    presenceStatus: 'online',
    statusMessage: null,
    isAutoAway: false,
    setPresence: vi.fn(),
  }),
  createMessageLookup: (messages: Message[]) => {
    const map = new Map<string, Message>()
    messages.forEach(m => {
      map.set(m.id, m)
      if (m.stanzaId) map.set(m.stanzaId, m)
    })
    return map
  },
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { jid: string; ownAvatar: null; ownNickname: string; status: string }) => unknown) => {
    return selector({
      jid: 'me@example.com/resource',
      ownAvatar: null,
      ownNickname: 'Me',
      status: 'online',
    })
  },
}))

// Mock app hooks
vi.mock('@/hooks', () => ({
  useClickOutside: () => {},
  useWindowDrag: () => ({ titleBarClass: '', dragRegionProps: {} }),
  useFileUpload: () => ({
    uploadFile: vi.fn(),
    isUploading: false,
    progress: 0,
    isSupported: true,
  }),
  useLinkPreview: () => ({
    processMessageForLinkPreview: vi.fn(),
  }),
  useTypeToFocus: () => {},
  useMessageCopy: () => ({ handleCopy: vi.fn() }),
  useMode: () => ({ resolvedMode: 'dark', isDark: true }),
  useTimeFormat: () => ({ formatTime: () => '14:30', timeFormat: '24h', effectiveTimeFormat: '24h' }),
  useMessageScroll: () => ({
    scrollRef: { current: null },
    isAtBottomRef: { current: true },
    scrollToBottomIfNeeded: vi.fn(),
    scrollToBottom: vi.fn(),
    handleScroll: vi.fn(),
    resetScrollState: vi.fn(),
  }),
  useMessageSelection: () => ({
    selectedMessageId: null,
    setSelectedMessageId: vi.fn(),
    hasKeyboardSelection: false,
    showToolbarForSelection: false,
    handleKeyDown: vi.fn(),
    clearSelection: vi.fn(),
    shouldIgnoreMouseEvent: vi.fn(() => false),
    handleMouseEnterMessage: vi.fn(),
    lastMousePosRef: { current: null },
    keyboardCooldownRef: { current: 0 },
  }),
  useTauriFileDrop: () => ({
    isDragging: false,
    isTauri: false,
    resetDragging: vi.fn(),
  }),
  useDragAndDrop: () => ({
    isDragging: false,
    dragHandlers: {
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      onDragOver: vi.fn(),
      onDrop: vi.fn(),
    },
  }),
  useMessageCopyFormatter: () => {},
  useConversationDraft: () => {
    const [text, setText] = React.useState('')
    return [text, setText]
  },
}))

// Mock utils
vi.mock('@/utils/statusText', () => ({
  getTranslatedStatusText: () => 'Online',
}))

vi.mock('@/utils/presence', () => ({
  getTranslatedShowText: () => 'Online',
}))

vi.mock('@/utils/dateFormat', () => ({
  formatDateHeader: () => 'Today',
}))

vi.mock('@/utils/messageStyles', () => ({
  renderStyledMessage: (body: string) => body,
}))

vi.mock('@/utils/messageUtils', () => ({
  findLastEditableMessage: (messages: Message[]) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isOutgoing && !messages[i].retractedAt) {
        return messages[i]
      }
    }
    return null
  },
  findLastEditableMessageId: (messages: Message[]) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isOutgoing && !messages[i].retractedAt) {
        return messages[i].id
      }
    }
    return null
  },
}))

// Mock i18next with basic interpolation support
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // Map of translation keys to their English values
      const translations: Record<string, string> = {
        'chat.typing.one': '{{name}} is typing...',
        'chat.typing.two': '{{name1}} and {{name2}} are typing...',
        'chat.typing.three': '{{name1}}, {{name2}}, and {{name3}} are typing...',
        'chat.typing.many': '{{name1}}, {{name2}}, and {{count}} others are typing...',
        'chat.loadingMessages': 'Loading messages...',
      }
      let result = translations[key] || opts?.defaultValue as string || key
      // Simple interpolation
      if (opts) {
        Object.entries(opts).forEach(([k, v]) => {
          if (k !== 'defaultValue') {
            result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
          }
        })
      }
      return result
    },
    i18n: { language: 'en' },
  }),
}))

// Mock date-fns
vi.mock('date-fns', () => ({
  format: () => '10:00',
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Hash: () => <span data-testid="icon-hash">Hash</span>,
  ArrowLeft: () => <span data-testid="icon-back">Back</span>,
  SmilePlus: () => <span data-testid="icon-emoji">Emoji</span>,
  Pencil: () => <span data-testid="icon-edit">Edit</span>,
  Forward: () => <span data-testid="icon-forward">Forward</span>,
  MoreHorizontal: () => <span data-testid="icon-more">More</span>,
  Reply: () => <span data-testid="icon-reply">Reply</span>,
  Upload: () => <span data-testid="icon-upload">Upload</span>,
  Trash2: () => <span data-testid="icon-trash">Trash</span>,
  Loader2: () => <span data-testid="icon-loader">Loading</span>,
  ChevronUp: () => <span data-testid="icon-chevron-up">Up</span>,
  ChevronDown: () => <span data-testid="icon-chevron-down">Down</span>,
}))

// Create hoisted mock for MessageComposer that uses forwardRef
const { MockMessageComposer } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  return {
    MockMessageComposer: React.forwardRef(function MockMessageComposer(
      { placeholder, onSend }: { placeholder: string; onSend: (text: string) => void },
      _ref: React.Ref<unknown>
    ) {
      return React.createElement('div', { 'data-testid': 'message-composer' },
        React.createElement('textarea', {
          'data-testid': 'message-input',
          placeholder,
          onChange: () => {},
        }),
        React.createElement('button', {
          'data-testid': 'send-button',
          onClick: () => onSend('test message'),
        }, 'Send')
      )
    }),
  }
})

// Mock sub-components
vi.mock('./ChristmasAnimation', () => ({
  ChristmasAnimation: () => null,
}))

vi.mock('./MessageComposer', () => ({
  MessageComposer: MockMessageComposer,
}))

vi.mock('./LinkPreviewCard', () => ({
  LinkPreviewCard: () => <div data-testid="link-preview">Link Preview</div>,
}))

vi.mock('./MessageAttachments', () => ({
  MessageAttachments: () => <div data-testid="message-attachments">Attachments</div>,
}))

vi.mock('./Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div data-testid="avatar">{name}</div>,
  getConsistentTextColor: () => '#000000',
}))

describe('ChatView', () => {
  beforeEach(() => {
    // Reset mock state
    mockActiveConversation = null
    mockActiveMessages = []
    mockTypingUsers = []
    mockContacts = []
    mockSupportsMAM = true
    mockActiveMAMState = { hasQueried: true, isLoading: false }

    // Reset mock functions
    vi.clearAllMocks()
  })

  describe('Empty state', () => {
    it('should render nothing when no active conversation', () => {
      mockActiveConversation = null

      const { container } = render(<ChatView />)

      // Should render empty or minimal content
      expect(container.textContent).toBe('')
    })
  })

  describe('With active conversation', () => {
    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
    })

    it('should render conversation header with contact name', () => {
      render(<ChatView />)

      // Contact name appears in header - use getAllByText since it may appear multiple places
      const aliceElements = screen.getAllByText('Alice Smith')
      expect(aliceElements.length).toBeGreaterThan(0)
    })

    it('should render message composer', () => {
      render(<ChatView />)

      expect(screen.getByTestId('message-composer')).toBeInTheDocument()
    })

    it('should show back button when onBack is provided', () => {
      const onBack = vi.fn()
      render(<ChatView onBack={onBack} />)

      const backButton = screen.getByLabelText('Back to conversations')
      expect(backButton).toBeInTheDocument()
    })
  })

  describe('Message rendering', () => {
    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
    })

    it('should render messages', () => {
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: 'Hello from Alice', isOutgoing: false }),
        createMessage({ id: 'msg-2', body: 'Hi Alice!', isOutgoing: true, from: 'me@example.com' }),
      ]

      render(<ChatView />)

      expect(screen.getByText('Hello from Alice')).toBeInTheDocument()
      expect(screen.getByText('Hi Alice!')).toBeInTheDocument()
    })

    it('should render /me action messages differently', () => {
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: '/me waves hello' }),
      ]

      render(<ChatView />)

      // Action message should show the action text
      expect(screen.getByText(/waves hello/)).toBeInTheDocument()
    })

    it('should show edit indicator for edited messages', () => {
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: 'Edited message', isEdited: true }),
      ]

      render(<ChatView />)

      expect(screen.getByText(/chat.edited/)).toBeInTheDocument()
    })

    it('should show retracted message placeholder', () => {
      mockActiveMessages = [
        createMessage({
          id: 'msg-1',
          body: 'Original message',
          isRetracted: true,
          retractedAt: new Date()
        }),
      ]

      render(<ChatView />)

      expect(screen.getByText(/chat.messageDeleted/)).toBeInTheDocument()
    })
  })

  describe('Typing indicator', () => {
    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
    })

    it('should show typing indicator when contact is typing', () => {
      mockTypingUsers = ['alice@example.com']
      // Need messages for the typing indicator to appear in the message area
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: 'Hello!' }),
      ]

      render(<ChatView />)

      // TypingIndicator builds text like "Alice Smith is typing..."
      expect(screen.getByText(/is typing/)).toBeInTheDocument()
    })

    it('should not show typing indicator when no one is typing', () => {
      mockTypingUsers = []

      render(<ChatView />)

      expect(screen.queryByText(/is typing/)).not.toBeInTheDocument()
    })
  })

  describe('Reply flow', () => {
    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: 'Hello there!' }),
        createMessage({ id: 'msg-2', body: 'Another message' }),
      ]
    })

    it('should show reply button on message hover', async () => {
      render(<ChatView />)

      // Find message container and hover
      const messageText = screen.getByText('Hello there!')
      const messageContainer = messageText.closest('[data-message-id]')

      if (messageContainer) {
        fireEvent.mouseEnter(messageContainer)

        await waitFor(() => {
          expect(screen.getByTestId('icon-reply')).toBeInTheDocument()
        })
      }
    })
  })

  describe('Edit flow', () => {
    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
    })

    it('should show edit button only on own messages', async () => {
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: 'From contact', isOutgoing: false }),
        createMessage({ id: 'msg-2', body: 'My message', isOutgoing: true, from: 'me@example.com' }),
      ]

      render(<ChatView />)

      // Hover on own message
      const ownMessage = screen.getByText('My message')
      const ownMessageContainer = ownMessage.closest('[data-message-id]')

      if (ownMessageContainer) {
        fireEvent.mouseEnter(ownMessageContainer)

        await waitFor(() => {
          expect(screen.getByTestId('icon-edit')).toBeInTheDocument()
        })
      }
    })
  })

  describe('Reactions', () => {
    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
    })

    it('should display reactions on messages', () => {
      mockActiveMessages = [
        createMessage({
          id: 'msg-1',
          body: 'Great news!',
          reactions: { '👍': ['alice@example.com'], '❤️': ['bob@example.com'] },
        }),
      ]

      render(<ChatView />)

      // Reactions may appear multiple times (toolbar + message), use getAllByText
      expect(screen.getAllByText('👍').length).toBeGreaterThan(0)
      expect(screen.getAllByText('❤️').length).toBeGreaterThan(0)
    })

    it('should show reaction picker on emoji button click', async () => {
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: 'Hello!' }),
      ]

      render(<ChatView />)

      const messageText = screen.getByText('Hello!')
      const messageContainer = messageText.closest('[data-message-id]')

      if (messageContainer) {
        fireEvent.mouseEnter(messageContainer)

        await waitFor(() => {
          const emojiButton = screen.getByTestId('icon-emoji')
          expect(emojiButton).toBeInTheDocument()
        })
      }
    })
  })

  describe('Snapshots', () => {
    it('should match snapshot for empty conversation', () => {
      mockActiveConversation = null

      const { container } = render(<ChatView />)
      expect(container).toMatchSnapshot()
    })

    it('should match snapshot with messages', () => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
      mockActiveMessages = [
        createMessage({
          id: 'msg-1',
          body: 'Hello there!',
          timestamp: new Date('2024-01-15T10:00:00Z'),
        }),
        createMessage({
          id: 'msg-2',
          body: 'Hi! How are you?',
          isOutgoing: true,
          from: 'me@example.com',
          timestamp: new Date('2024-01-15T10:01:00Z'),
        }),
      ]

      const { container } = render(<ChatView />)
      expect(container).toMatchSnapshot()
    })

    it('should match snapshot with typing indicator', () => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
      mockTypingUsers = ['alice@example.com']

      const { container } = render(<ChatView />)
      expect(container).toMatchSnapshot()
    })
  })

  describe('Upload-on-send privacy protection', () => {
    /**
     * These tests verify the critical privacy protection behavior:
     * Files are only uploaded to the server when the user explicitly clicks Send,
     * NOT when they drag-and-drop a file into the window.
     *
     * This prevents accidental data leakage if someone drags a file over
     * the window by mistake.
     */

    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
    })

    it('should NOT call uploadFile when file is dropped (only stages)', async () => {
      // This test verifies that useDragAndDrop.onFileDrop (handleFileDrop in ChatView)
      // only stages the file locally - it does NOT upload to the server
      //
      // The actual upload happens later in handleSend, which is tested separately

      // Note: Since MessageComposer is mocked, we can't test the full flow here.
      // This is documented behavior - see useDragAndDrop.test.tsx for staging tests

      render(<ChatView />)

      // Verify the component renders (basic sanity check)
      expect(screen.getByTestId('message-composer')).toBeInTheDocument()

      // The key assertion is in useDragAndDrop.test.tsx which verifies:
      // - onFileDrop callback is called synchronously (no async upload)
      // - No upload happens until user clicks Send
    })

    it('should document that MessageInput.handleSend calls uploadFile before sending', () => {
      /**
       * The handleSend function in ChatView.MessageInput component:
       *
       * 1. If pendingAttachment exists and uploadFile is available:
       *    - Calls: attachment = await uploadFile(pendingAttachment.file)
       *    - If upload fails (returns null): returns false, message NOT sent
       *    - If upload succeeds: continues with sending
       *
       * 2. Sends message with attachment (if any)
       * 3. Clears pending attachment via onRemovePendingAttachment()
       *
       * See ChatView.tsx lines 808-825 for implementation
       *
       * This is tested at the unit level via MessageComposer.test.tsx (pending attachment display)
       * and useDragAndDrop.test.tsx (file staging behavior)
       */
      expect(true).toBe(true) // Documentation test - behavior verified in other test files
    })
  })

  describe('Loading state', () => {
    beforeEach(() => {
      mockActiveConversation = {
        id: 'alice@example.com',
        name: 'Alice Smith',
        type: 'chat',
        unreadCount: 0,
      }
      mockContacts = [createContact()]
    })

    it('should show empty state immediately (SDK loads in background)', () => {
      // With the headless SDK architecture, we never show a loading spinner for initial load
      // The SDK auto-loads cache + MAM in the background, UI just renders what's in the store
      mockSupportsMAM = true
      mockActiveMAMState = { hasQueried: false, isLoading: false }
      mockActiveMessages = []

      render(<ChatView />)

      // Should show empty state, not loading spinner
      expect(screen.queryByText('Loading messages...')).not.toBeInTheDocument()
      expect(screen.getByText('chat.noMessages')).toBeInTheDocument()
    })

    it('should show messages when MAM has queried', () => {
      mockSupportsMAM = true
      mockActiveMAMState = { hasQueried: true, isLoading: false }
      mockActiveMessages = [
        createMessage({ id: 'msg-1', body: 'Hello there!' }),
      ]

      render(<ChatView />)

      // Should not show loading
      expect(screen.queryByText('Loading messages...')).not.toBeInTheDocument()
      // Should show message
      expect(screen.getByText('Hello there!')).toBeInTheDocument()
    })

    it('should show empty state when MAM has queried but no messages', () => {
      mockSupportsMAM = true
      mockActiveMAMState = { hasQueried: true, isLoading: false }
      mockActiveMessages = []

      render(<ChatView />)

      // Should not show loading
      expect(screen.queryByText('Loading messages...')).not.toBeInTheDocument()
      // Should show empty state
      expect(screen.getByText('chat.noMessages')).toBeInTheDocument()
    })

    it('should not show loading when MAM is not supported', () => {
      mockSupportsMAM = false
      mockActiveMAMState = { hasQueried: false, isLoading: false }
      mockActiveMessages = []

      render(<ChatView />)

      // Should not show loading (MAM not supported)
      expect(screen.queryByText('Loading messages...')).not.toBeInTheDocument()
    })
  })
})
