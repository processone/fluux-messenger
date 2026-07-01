import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useReactionNotifications } from './useReactionNotifications'

// --- SDK surface -----------------------------------------------------------
const mockSubscribe = vi.fn()
const chatState = {
  messages: new Map<string, Array<{ id: string; isOutgoing?: boolean; body?: string }>>(),
  activeConversationId: null as string | null,
}
const roomState = { rooms: new Map(), getMessage: vi.fn(), activeRoomJid: null as string | null }
const connectionState = { jid: 'me@example.com' }
const mockGetCachedMessage = vi.fn()
const mockGetCachedMessageByStanzaId = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({ client: { subscribe: mockSubscribe } }),
  chatStore: { getState: () => chatState },
  roomStore: { getState: () => roomState },
  connectionStore: { getState: () => connectionState },
  getBareJid: (jid: string) => jid.split('/')[0],
  findMessageById: (msgs: Array<{ id: string }>, id: string) => msgs.find((m) => m.id === id),
  getMessage: (...args: unknown[]) => mockGetCachedMessage(...args),
  getMessageByStanzaId: (...args: unknown[]) => mockGetCachedMessageByStanzaId(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => `${key}:${params?.name ?? ''}:${params?.emoji ?? ''}`,
  }),
}))

const mockAddToast = vi.fn()
vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: mockAddToast }) },
}))

const mockAddMention = vi.fn()
vi.mock('@/stores/reactionMentionStore', () => ({
  useReactionMentionStore: { getState: () => ({ addMention: mockAddMention }) },
}))

const mockNavigateToMessages = vi.fn()
const mockNavigateToRooms = vi.fn()
vi.mock('@/hooks', () => ({
  useRouteSync: () => ({ navigateToMessages: mockNavigateToMessages, navigateToRooms: mockNavigateToRooms }),
}))

vi.mock('@/components/conversation/messageGrouping', () => ({ scrollToMessage: vi.fn() }))

/** Grab the chat:reactions handler registered on mount. */
function chatHandler(): (ev: Record<string, unknown>) => Promise<void> {
  const call = mockSubscribe.mock.calls.find((c) => c[0] === 'chat:reactions')
  if (!call) throw new Error('chat:reactions not subscribed')
  return call[1]
}

describe('useReactionNotifications — chat reaction resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSubscribe.mockReturnValue(vi.fn())
    chatState.messages = new Map()
    chatState.activeConversationId = null
    connectionState.jid = 'me@example.com'
    mockGetCachedMessage.mockResolvedValue(null)
    mockGetCachedMessageByStanzaId.mockResolvedValue(null)
  })

  it('falls back to the durable cache and raises a toast when the conversation is evicted (not active)', async () => {
    // conversation not resident (evicted on deactivation) and not active
    chatState.activeConversationId = 'other@example.com'
    mockGetCachedMessage.mockResolvedValue({ id: 'm1', isOutgoing: true, body: 'my earlier message' })

    renderHook(() => useReactionNotifications())
    await chatHandler()({
      conversationId: 'peer@example.com',
      messageId: 'm1',
      reactorJid: 'peer@example.com/res',
      emojis: ['🎉'],
      isLive: true,
    })

    expect(mockGetCachedMessage).toHaveBeenCalledWith('m1')
    expect(mockAddToast).toHaveBeenCalledTimes(1)
    expect(mockAddToast).toHaveBeenCalledWith('info', expect.stringContaining('reactions.mention'), 6000, expect.any(Function))
    expect(mockAddMention).not.toHaveBeenCalled()
  })

  it('tries stanzaId lookup when the client-id cache read misses', async () => {
    chatState.activeConversationId = 'other@example.com'
    mockGetCachedMessage.mockResolvedValue(null)
    mockGetCachedMessageByStanzaId.mockResolvedValue({ id: 'm1', isOutgoing: true, body: 'via stanza id' })

    renderHook(() => useReactionNotifications())
    await chatHandler()({
      conversationId: 'peer@example.com',
      messageId: 'stanza-1',
      reactorJid: 'peer@example.com',
      emojis: ['🔥'],
      isLive: true,
    })

    expect(mockGetCachedMessageByStanzaId).toHaveBeenCalledWith('stanza-1')
    expect(mockAddToast).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the message cannot be found in RAM or the cache', async () => {
    chatState.activeConversationId = 'other@example.com'
    renderHook(() => useReactionNotifications())
    await chatHandler()({
      conversationId: 'peer@example.com',
      messageId: 'gone',
      reactorJid: 'peer@example.com',
      emojis: ['👍'],
      isLive: true,
    })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddMention).not.toHaveBeenCalled()
  })

  it('shows a mention (not a toast) for a resident off-screen own message in the active conversation', async () => {
    const conv = 'peer@example.com'
    chatState.activeConversationId = conv
    chatState.messages.set(conv, [
      { id: 'm1', isOutgoing: true, body: 'older own message' },
      { id: 'm2', isOutgoing: false },
      { id: 'last', isOutgoing: false },
    ])

    renderHook(() => useReactionNotifications())
    await chatHandler()({ conversationId: conv, messageId: 'm1', reactorJid: 'peer@example.com', emojis: ['🎉'], isLive: true })

    expect(mockGetCachedMessage).not.toHaveBeenCalled() // resident hit, no cache read
    expect(mockAddMention).toHaveBeenCalledTimes(1)
    expect(mockAddToast).not.toHaveBeenCalled()
  })

  it('ignores our own reactions', async () => {
    chatState.activeConversationId = 'other@example.com'
    mockGetCachedMessage.mockResolvedValue({ id: 'm1', isOutgoing: true, body: 'x' })

    renderHook(() => useReactionNotifications())
    await chatHandler()({ conversationId: 'peer@example.com', messageId: 'm1', reactorJid: 'me@example.com/res', emojis: ['🎉'], isLive: true })

    expect(mockGetCachedMessage).not.toHaveBeenCalled()
    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddMention).not.toHaveBeenCalled()
  })
})
