import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEasterEggNotifications } from './useEasterEggNotifications'

// --- SDK surface -----------------------------------------------------------
const mockSubscribe = vi.fn()
const chatState = {
  activeConversationId: null as string | null,
}
const roomState = {
  rooms: new Map<string, { nickname: string }>(),
  activeRoomJid: null as string | null,
}
const connectionState = { jid: 'me@example.com/res' }

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useXMPP: () => ({ client: { subscribe: mockSubscribe } }),
  chatStore: { getState: () => chatState },
  roomStore: { getState: () => roomState },
  connectionStore: { getState: () => connectionState },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => `${key}:${params?.name ?? ''}`,
  }),
}))

const mockAddToast = vi.fn()
vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: mockAddToast }) },
}))

const mockAddEgg = vi.fn()
vi.mock('@/stores/easterEggMentionStore', () => ({
  useEasterEggMentionStore: { getState: () => ({ add: mockAddEgg }) },
}))

const mockNavigateToConversation = vi.fn()
const mockNavigateToRoom = vi.fn()
vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation: mockNavigateToConversation, navigateToRoom: mockNavigateToRoom }),
}))

/** Grab a subscribed handler by event name. */
function handlerFor(event: string): (ev: Record<string, unknown>) => void {
  const call = mockSubscribe.mock.calls.find((c) => c[0] === event)
  if (!call) throw new Error(`${event} not subscribed`)
  return call[1]
}
const chatHandler = () => handlerFor('chat:animation')
const roomHandler = () => handlerFor('room:animation')

describe('useEasterEggNotifications — chat animation resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSubscribe.mockReturnValue(vi.fn())
    chatState.activeConversationId = null
    connectionState.jid = 'me@example.com/res'
    roomState.rooms = new Map()
    roomState.activeRoomJid = null
  })

  it('toasts and stores a pending egg for an inactive conversation from someone else', () => {
    chatState.activeConversationId = 'other@example.com'

    renderHook(() => useEasterEggNotifications())
    chatHandler()({ conversationId: 'ava@example.com', animation: 'fireworks', senderJid: 'ava@example.com/mobile' })

    expect(mockAddToast).toHaveBeenCalledTimes(1)
    expect(mockAddToast).toHaveBeenCalledWith('info', expect.stringContaining('easterEgg.mention'), 6000, expect.any(Function))
    expect(mockAddEgg).toHaveBeenCalledTimes(1)
    expect(useEasterEggMentionStoreGetMock().animation).toBe('fireworks')

    // Clicking the toast navigates to the conversation
    const onClick = mockAddToast.mock.calls[0][3] as () => void
    onClick()
    expect(mockNavigateToConversation).toHaveBeenCalledWith('ava@example.com')
  })

  it('does nothing when the conversation is active', () => {
    chatState.activeConversationId = 'ava@example.com'

    renderHook(() => useEasterEggNotifications())
    chatHandler()({ conversationId: 'ava@example.com', animation: 'fireworks', senderJid: 'ava@example.com/mobile' })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddEgg).not.toHaveBeenCalled()
  })

  it('does nothing for our own sent egg', () => {
    chatState.activeConversationId = 'other@example.com'

    renderHook(() => useEasterEggNotifications())
    chatHandler()({ conversationId: 'ava@example.com', animation: 'fireworks', senderJid: 'me@example.com/other-res' })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddEgg).not.toHaveBeenCalled()
  })
})

describe('useEasterEggNotifications — room animation resolution', () => {
  const ROOM = 'team@conference.example.com'

  beforeEach(() => {
    vi.clearAllMocks()
    mockSubscribe.mockReturnValue(vi.fn())
    connectionState.jid = 'me@example.com/res'
    chatState.activeConversationId = null
    roomState.rooms = new Map()
    roomState.activeRoomJid = null
    roomState.rooms.set(ROOM, { nickname: 'Me' })
  })

  it('toasts and stores a pending egg for an inactive room from another occupant', () => {
    roomState.activeRoomJid = 'other@conference.example.com'

    renderHook(() => useEasterEggNotifications())
    roomHandler()({ roomJid: ROOM, animation: 'confetti', senderNick: 'Alice' })

    expect(mockAddToast).toHaveBeenCalledTimes(1)
    expect(mockAddEgg).toHaveBeenCalledTimes(1)

    const onClick = mockAddToast.mock.calls[0][3] as () => void
    onClick()
    expect(mockNavigateToRoom).toHaveBeenCalledWith(ROOM)
  })

  it('does nothing when the room is active', () => {
    roomState.activeRoomJid = ROOM

    renderHook(() => useEasterEggNotifications())
    roomHandler()({ roomJid: ROOM, animation: 'confetti', senderNick: 'Alice' })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddEgg).not.toHaveBeenCalled()
  })

  it('does nothing for our own nick', () => {
    roomState.activeRoomJid = 'other@conference.example.com'

    renderHook(() => useEasterEggNotifications())
    roomHandler()({ roomJid: ROOM, animation: 'confetti', senderNick: 'Me' })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddEgg).not.toHaveBeenCalled()
  })

  it('does nothing for an unknown room', () => {
    roomState.rooms = new Map()

    renderHook(() => useEasterEggNotifications())
    roomHandler()({ roomJid: 'unknown@conference.example.com', animation: 'confetti', senderNick: 'Alice' })

    expect(mockAddToast).not.toHaveBeenCalled()
    expect(mockAddEgg).not.toHaveBeenCalled()
  })
})

/** Helper to read the last add() call's egg payload. */
function useEasterEggMentionStoreGetMock() {
  return mockAddEgg.mock.calls[0][0] as { conversationId: string; animation: string; senderName: string }
}
