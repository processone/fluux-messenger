import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useReactionNotifications } from './useReactionNotifications'

// --- SDK surface -----------------------------------------------------------
const mockSubscribe = vi.fn()
const chatState = {
  messages: new Map<string, Array<{ id: string; stanzaId?: string; isOutgoing?: boolean; body?: string }>>(),
  activeConversationId: null as string | null,
}
type RoomMsg = { id: string; stanzaId?: string; nick?: string; body?: string }
const roomState = {
  rooms: new Map<string, { nickname: string; messages: RoomMsg[] }>(),
  // The resident window, like the chat mock above it.
  messages: new Map<string, RoomMsg[]>(),
  getMessage: vi.fn(),
  activeRoomJid: null as string | null,
}
const connectionState = { jid: 'me@example.com' }

/** Seed a room's identity and its resident window, which live in two maps. */
function seedRoom(jid: string, messages: RoomMsg[]): void {
  roomState.rooms.set(jid, { nickname: 'Me', messages })
  roomState.messages.set(jid, messages)
}
const mockGetCachedMessage = vi.fn()
const mockGetCachedMessageByStanzaId = vi.fn()
const mockGetCachedRoomMessage = vi.fn()
const mockGetCachedRoomMessageByStanzaId = vi.fn()

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useXMPP: () => ({ client: { subscribe: mockSubscribe } }),
  chatStore: { getState: () => chatState },
  roomStore: { getState: () => roomState },
  connectionStore: { getState: () => connectionState },
  // Mirror the real multi-tier resolution: client id first, then stanza-id.
  findMessageById: (msgs: Array<{ id: string; stanzaId?: string }>, id: string) =>
    msgs.find((m) => m.id === id) ?? msgs.find((m) => m.stanzaId === id),
}))

// Cache reads moved to the @fluux/sdk/cache escape-hatch subpath.
vi.mock('@fluux/sdk/cache', () => ({
  getMessage: (...args: unknown[]) => mockGetCachedMessage(...args),
  getMessageByStanzaId: (...args: unknown[]) => mockGetCachedMessageByStanzaId(...args),
  getRoomMessage: (...args: unknown[]) => mockGetCachedRoomMessage(...args),
  getRoomMessageByStanzaId: (...args: unknown[]) => mockGetCachedRoomMessageByStanzaId(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Include `preview` so tests can assert the derived preview text, not just the key.
    t: (key: string, params?: Record<string, unknown>) =>
      `${key}:${params?.name ?? ''}:${params?.emoji ?? ''}:${params?.preview ?? ''}`,
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

const mockNavigateToConversation = vi.fn()
const mockNavigateToRoom = vi.fn()
vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation: mockNavigateToConversation, navigateToRoom: mockNavigateToRoom }),
}))

/** Grab a subscribed handler by event name. */
function handlerFor(event: string): (ev: Record<string, unknown>) => Promise<void> {
  const call = mockSubscribe.mock.calls.find((c) => c[0] === event)
  if (!call) throw new Error(`${event} not subscribed`)
  return call[1]
}
const chatHandler = () => handlerFor('chat:reactions')
const roomHandler = () => handlerFor('room:reactions')

describe('useReactionNotifications — chat reaction resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSubscribe.mockReturnValue(vi.fn())
    chatState.messages = new Map()
    chatState.activeConversationId = null
    connectionState.jid = 'me@example.com'
    roomState.rooms = new Map()
    roomState.activeRoomJid = null
    roomState.getMessage = vi.fn().mockReturnValue(undefined)
    mockGetCachedMessage.mockResolvedValue(null)
    mockGetCachedMessageByStanzaId.mockResolvedValue(null)
    mockGetCachedRoomMessage.mockResolvedValue(null)
    mockGetCachedRoomMessageByStanzaId.mockResolvedValue(null)
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

    // Clicking the toast must jump by message reference (load-around-by-id), not a DOM query,
    // so it works even when the reacted message has scrolled out of the loaded window (#923).
    const onClick = mockAddToast.mock.calls[0][3] as () => void
    onClick()
    expect(mockNavigateToConversation).toHaveBeenCalledWith('peer@example.com', 'm1')
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

  it('navigates with the canonical message id when the reaction references the stanza-id', async () => {
    // The reactor's client references our message by its server stanza-id. The scroll
    // target machinery (getIndexForMessageId / data-message-id) resolves only the client
    // id, so navigation must use the resolved message's own id, not the raw reference.
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

    const onClick = mockAddToast.mock.calls[0][3] as () => void
    onClick()
    expect(mockNavigateToConversation).toHaveBeenCalledWith('peer@example.com', 'm1')
  })

  it('stores the canonical message id in the mention chip for a stanza-id reference', async () => {
    const conv = 'peer@example.com'
    chatState.activeConversationId = conv
    chatState.messages.set(conv, [
      { id: 'm1', stanzaId: 'stanza-m1', isOutgoing: true, body: 'older own message' },
      { id: 'last', isOutgoing: false },
    ])

    renderHook(() => useReactionNotifications())
    await chatHandler()({ conversationId: conv, messageId: 'stanza-m1', reactorJid: 'peer@example.com', emojis: ['🎉'], isLive: true })

    expect(mockAddMention).toHaveBeenCalledWith(expect.objectContaining({ id: `${conv}:m1`, messageId: 'm1' }))
  })

  it('suppresses the notification when the reaction references the last message by stanza-id', async () => {
    const conv = 'peer@example.com'
    chatState.activeConversationId = conv
    chatState.messages.set(conv, [
      { id: 'm1', isOutgoing: false },
      { id: 'last', stanzaId: 'stanza-last', isOutgoing: true, body: 'my latest' },
    ])

    renderHook(() => useReactionNotifications())
    await chatHandler()({ conversationId: conv, messageId: 'stanza-last', reactorJid: 'peer@example.com', emojis: ['🎉'], isLive: true })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddMention).not.toHaveBeenCalled()
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

  it('does no store or cache work for a non-live (replayed) reaction', async () => {
    chatState.activeConversationId = 'other@example.com'
    mockGetCachedMessage.mockResolvedValue({ id: 'm1', isOutgoing: true, body: 'x' })

    renderHook(() => useReactionNotifications())
    await chatHandler()({ conversationId: 'peer@example.com', messageId: 'm1', reactorJid: 'peer@example.com', emojis: ['🎉'], isLive: false })

    expect(mockGetCachedMessage).not.toHaveBeenCalled()
    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddMention).not.toHaveBeenCalled()
  })
})

describe('useReactionNotifications — room reaction resolution', () => {
  const ROOM = 'team@conference.example.com'

  beforeEach(() => {
    vi.clearAllMocks()
    mockSubscribe.mockReturnValue(vi.fn())
    connectionState.jid = 'me@example.com'
    mockGetCachedRoomMessage.mockResolvedValue(null)
    mockGetCachedRoomMessageByStanzaId.mockResolvedValue(null)
    roomState.rooms = new Map()
    roomState.activeRoomJid = null
    roomState.getMessage = vi.fn().mockReturnValue(undefined)
    seedRoom(ROOM, [{ id: 'r-last', nick: 'Alice' }])
  })

  it('raises a toast for a resident own room message reacted to while a different room is active', async () => {
    roomState.activeRoomJid = 'other@conference.example.com'
    roomState.getMessage = vi.fn().mockReturnValue({ id: 'r1', nick: 'Me', body: 'my room message' })

    renderHook(() => useReactionNotifications())
    await roomHandler()({ roomJid: ROOM, messageId: 'r1', reactorNick: 'Alice', emojis: ['🎉'], isLive: true })

    expect(mockAddToast).toHaveBeenCalledTimes(1)
    expect(mockAddMention).not.toHaveBeenCalled()

    // Room toast jumps by message reference too (#923).
    const onClick = mockAddToast.mock.calls[0][3] as () => void
    onClick()
    expect(mockNavigateToRoom).toHaveBeenCalledWith(ROOM, 'r1')
  })

  it('falls back to the durable room cache when the reacted message is not resident', async () => {
    roomState.activeRoomJid = 'other@conference.example.com'
    roomState.getMessage = vi.fn().mockReturnValue(undefined) // evicted from the resident window
    mockGetCachedRoomMessage.mockResolvedValue({ id: 'r-old', nick: 'Me', body: 'scrolled-away message' })

    renderHook(() => useReactionNotifications())
    await roomHandler()({ roomJid: ROOM, messageId: 'r-old', reactorNick: 'Alice', emojis: ['🔥'], isLive: true })

    expect(mockGetCachedRoomMessage).toHaveBeenCalledWith(ROOM, 'r-old')
    expect(mockAddToast).toHaveBeenCalledTimes(1)
  })

  it('navigates with the canonical message id when the room reaction references the stanza-id', async () => {
    // MUC reactions reference the server stanza-id (the canonical id other clients see);
    // roomStore.getMessage resolves it multi-tier, but navigation must use message.id.
    roomState.activeRoomJid = 'other@conference.example.com'
    roomState.getMessage = vi.fn().mockReturnValue({ id: 'r1', stanzaId: 'stanza-r1', nick: 'Me', body: 'my room message' })

    renderHook(() => useReactionNotifications())
    await roomHandler()({ roomJid: ROOM, messageId: 'stanza-r1', reactorNick: 'Alice', emojis: ['🎉'], isLive: true })

    const onClick = mockAddToast.mock.calls[0][3] as () => void
    onClick()
    expect(mockNavigateToRoom).toHaveBeenCalledWith(ROOM, 'r1')
  })

  it('suppresses the notification when the room reaction references the last message by stanza-id', async () => {
    roomState.activeRoomJid = ROOM
    const last = { id: 'r-last', stanzaId: 'stanza-r-last', nick: 'Me', body: 'my latest' }
    seedRoom(ROOM, [{ id: 'r1', nick: 'Alice' }, last])
    roomState.getMessage = vi.fn().mockReturnValue(last)

    renderHook(() => useReactionNotifications())
    await roomHandler()({ roomJid: ROOM, messageId: 'stanza-r-last', reactorNick: 'Alice', emojis: ['🎉'], isLive: true })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddMention).not.toHaveBeenCalled()
  })

  it('ignores a reaction to another occupant\'s message', async () => {
    roomState.getMessage = vi.fn().mockReturnValue({ id: 'r2', nick: 'Bob', body: 'not mine' })

    renderHook(() => useReactionNotifications())
    await roomHandler()({ roomJid: ROOM, messageId: 'r2', reactorNick: 'Alice', emojis: ['🎉'], isLive: true })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddMention).not.toHaveBeenCalled()
  })

  it('does no cache work for a non-live room reaction', async () => {
    roomState.getMessage = vi.fn().mockReturnValue(undefined)

    renderHook(() => useReactionNotifications())
    await roomHandler()({ roomJid: ROOM, messageId: 'r-old', reactorNick: 'Alice', emojis: ['🎉'], isLive: false })

    expect(mockGetCachedRoomMessage).not.toHaveBeenCalled()
    expect(mockAddToast).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Preview derivation
//
// The notification quotes what was reacted to. Deriving that from `body` alone
// left every bodiless message kind quoting nothing — a reaction to a poll read
// `1️⃣ danielstein reacted to ''`. Both paths now go through the same shared
// derivation the sidebar uses (formatLocalizedPreview), so a poll names its
// title, an attachment names its file, and a message with nothing to quote
// falls back to a quote-free string instead of empty quotes.
// ---------------------------------------------------------------------------
describe('useReactionNotifications — notification preview', () => {
  const ROOM = 'team@conference.example.com'
  const POLL = {
    title: 'Which emoji do you use more often?',
    options: [
      { emoji: '1️⃣', label: 'thumbs up' },
      { emoji: '2️⃣', label: 'heart' },
    ],
    settings: { allowMultiple: false, hideResultsBeforeVote: false },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockSubscribe.mockReturnValue(vi.fn())
    chatState.messages = new Map()
    chatState.activeConversationId = 'other@example.com'
    connectionState.jid = 'me@example.com'
    roomState.rooms = new Map()
    roomState.activeRoomJid = 'other@conference.example.com'
    roomState.getMessage = vi.fn().mockReturnValue(undefined)
    mockGetCachedMessage.mockResolvedValue(null)
    mockGetCachedMessageByStanzaId.mockResolvedValue(null)
    mockGetCachedRoomMessage.mockResolvedValue(null)
    mockGetCachedRoomMessageByStanzaId.mockResolvedValue(null)
    seedRoom(ROOM, [{ id: 'r-last', nick: 'Alice' }])
  })

  /** The toast label the hook handed to the toast store. */
  function toastLabel(): string {
    expect(mockAddToast).toHaveBeenCalledTimes(1)
    return mockAddToast.mock.calls[0][1] as string
  }

  /** Drive the 1:1 path with `message` resolved from the durable cache. */
  async function reactInChat(message: Record<string, unknown>): Promise<void> {
    mockGetCachedMessage.mockResolvedValue({ id: 'm1', isOutgoing: true, body: '', ...message })
    renderHook(() => useReactionNotifications())
    await chatHandler()({
      conversationId: 'peer@example.com',
      messageId: 'm1',
      reactorJid: 'peer@example.com/res',
      emojis: ['1️⃣'],
      isLive: true,
    })
  }

  /** Drive the room path with `message` resident in the room window. */
  async function reactInRoom(message: Record<string, unknown>): Promise<void> {
    roomState.getMessage = vi.fn().mockReturnValue({ id: 'r1', nick: 'Me', body: '', ...message })
    renderHook(() => useReactionNotifications())
    await roomHandler()({ roomJid: ROOM, messageId: 'r1', reactorNick: 'danielstein', emojis: ['1️⃣'], isLive: true })
  }

  it('names the poll when a poll is reacted to in a 1:1 chat', async () => {
    await reactInChat({ poll: POLL })

    expect(toastLabel()).toContain('Which emoji do you use more often?')
  })

  it('names the poll when a poll is reacted to in a room', async () => {
    await reactInRoom({ poll: POLL })

    expect(toastLabel()).toContain('Which emoji do you use more often?')
  })

  it('names the poll in the in-flow mention chip too', async () => {
    const conv = 'peer@example.com'
    chatState.activeConversationId = conv
    chatState.messages.set(conv, [
      { id: 'm1', isOutgoing: true, body: '', poll: POLL } as never,
      { id: 'last', isOutgoing: false },
    ])

    renderHook(() => useReactionNotifications())
    await chatHandler()({ conversationId: conv, messageId: 'm1', reactorJid: 'peer@example.com', emojis: ['1️⃣'], isLive: true })

    expect(mockAddMention).toHaveBeenCalledWith(
      expect.objectContaining({ preview: expect.stringContaining('Which emoji do you use more often?') }),
    )
  })

  it('names the poll for a frozen poll-results announcement', async () => {
    await reactInChat({
      pollClosed: { title: 'Which emoji do you use more often?', pollMessageId: 'p1', results: [] },
    })

    expect(toastLabel()).toContain('Which emoji do you use more often?')
  })

  it('names the file for an attachment-only message', async () => {
    await reactInRoom({
      attachment: { url: 'https://example.com/report.pdf', name: 'report.pdf', mediaType: 'application/pdf' },
    })

    expect(toastLabel()).toContain('report.pdf')
  })

  it('shows the localized deleted-message notice for a retracted message', async () => {
    await reactInChat({ isRetracted: true, body: '' })

    expect(toastLabel()).toContain('chat.messageDeleted')
  })

  it('shows the localized notice — not the sender-chosen fallback body — for unsupported encryption', async () => {
    await reactInChat({
      body: 'You received a message encrypted with OMEMO but your client does not support it.',
      unsupportedEncryption: { name: 'OMEMO' },
    })

    const label = toastLabel()
    expect(label).toContain('chat.encryption.unsupportedMessage')
    expect(label).not.toContain('but your client does not support it')
  })

  it('keeps the 80-character truncation for long text bodies', async () => {
    const body = 'x'.repeat(200)
    await reactInChat({ body })

    // The mocked t() renders `key:name:emoji:preview`, so the preview is the last segment.
    const preview = toastLabel().split(':').pop() as string
    expect(preview).toBe('x'.repeat(80))
  })

  it('falls back to a quote-free label when nothing can be previewed', async () => {
    // A bodiless signal placeholder (e.g. an encrypted reaction stored as an
    // empty-body message) has nothing to quote. It must never render `''`.
    await reactInChat({ body: '   ' })

    const label = toastLabel()
    expect(label).toContain('reactions.mentionNoPreview')
    expect(label).not.toContain("''")
  })

  it('falls back to a quote-free label when formatting leaves only whitespace', async () => {
    await reactInChat({ body: '`````` ``````' })

    const label = toastLabel()
    expect(label).toContain('reactions.mentionNoPreview')
    expect(label).not.toContain("''")
  })
})
