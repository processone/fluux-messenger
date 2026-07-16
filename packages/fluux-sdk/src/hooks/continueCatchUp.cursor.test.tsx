/**
 * @vitest-environment happy-dom
 *
 * Cursor selection for continueChatCatchUp / continueRoomCatchUp (the "Load
 * missing messages" action), previously untested:
 *
 * - a recorded gap with a startId resumes id-exact (`after:` the seam's
 *   last-downloaded archive id) with the manual pagination cap;
 * - a gap with only a timestamp falls back to `start: gapTs + 1ms`;
 * - with NO recorded gap, the newest cached message's archive id is the
 *   id-exact `after:` cursor (selectCatchUpQuery policy — this pins the
 *   intentional delta from the retired findContinueCatchUpCursor, which used
 *   timestamp + 1ms here);
 * - the loading flag is always cleared, including when the query rejects.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useChatActive } from './useChatActive'
import { useRoomActive } from './useRoomActive'
import { chatStore, roomStore, connectionStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'
import { MAM_CATCHUP_FORWARD_MAX, MAM_ROOM_FORWARD_MAX_PAGES_MANUAL } from '../utils/mamCatchUpUtils'

const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return { ...actual, useXMPPContext: () => ({ client: mockClient }) }
})

// Empty cache: the store's resident messages (seeded per test) stay untouched
// by the pre-query cache load, so each test controls the cursor inputs.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    getMessages: vi.fn().mockResolvedValue([]),
    getRoomMessages: vi.fn().mockResolvedValue([]),
  }
})

function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

const CONV = 'alice@example.com'
const ROOM = 'room@conference.example.com'

const seedChatMessages = (messages: Array<{ timestamp?: Date; stanzaId?: string }>) => {
  chatStore.setState({ messages: new Map([[CONV, messages as never]]) })
}

const seedRoomMessages = (messages: Array<{ timestamp?: Date; stanzaId?: string }>) => {
  const rooms = new Map(roomStore.getState().rooms)
  const room = rooms.get(ROOM)!
  rooms.set(ROOM, { ...room, messages: messages as never })
  roomStore.setState({ rooms })
}

beforeEach(() => {
  vi.mocked(mockClient.chat.queryMAM).mockReset().mockResolvedValue(undefined)
  vi.mocked(mockClient.chat.queryRoomMAM).mockReset().mockResolvedValue(undefined)
  chatStore.setState({
    conversations: new Map(),
    conversationEntities: new Map(),
    conversationMeta: new Map(),
    messages: new Map(),
    mamQueryStates: new Map(),
    conversationGaps: new Map(),
    activeConversationId: null,
  })
  roomStore.setState({
    rooms: new Map(),
    roomEntities: new Map(),
    roomMeta: new Map(),
    roomRuntime: new Map(),
    mamQueryStates: new Map(),
    roomGaps: new Map(),
    activeRoomJid: null,
  })
  connectionStore.getState().setStatus('online')

  chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0 })
  chatStore.getState().setActiveConversation(CONV)
  roomStore.getState().addRoom({
    jid: ROOM,
    name: 'Room',
    nickname: 'me',
    joined: true,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  } as never)
  roomStore.getState().setActiveRoom(ROOM)
})

describe('continueChatCatchUp cursor selection', () => {
  it('resumes a gap id-exact (after: seam startId) with the manual pagination cap', async () => {
    chatStore.setState({
      conversationGaps: new Map([[CONV, { start: new Date('2026-05-14T09:00:00Z').getTime(), startId: 'gap-id-1' } as never]]),
    })
    const { result } = renderHook(() => useChatActive(), { wrapper })

    await act(async () => {
      await result.current.continueChatCatchUp()
    })

    expect(mockClient.chat.queryMAM).toHaveBeenCalledWith({
      with: CONV,
      after: 'gap-id-1',
      max: MAM_CATCHUP_FORWARD_MAX,
      maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
    })
  })

  it('falls back to start: gap timestamp + 1ms when the gap carries no startId', async () => {
    chatStore.setState({
      conversationGaps: new Map([[CONV, { start: new Date('2026-05-14T09:00:00.000Z').getTime() } as never]]),
    })
    // Newer cached messages must NOT win over the recorded hole boundary.
    seedChatMessages([{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'above-hole' }])
    const { result } = renderHook(() => useChatActive(), { wrapper })

    await act(async () => {
      await result.current.continueChatCatchUp()
    })

    expect(mockClient.chat.queryMAM).toHaveBeenCalledWith({
      with: CONV,
      start: '2026-05-14T09:00:00.001Z',
      max: MAM_CATCHUP_FORWARD_MAX,
      maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
    })
  })

  it('with no gap, resumes id-exact from the newest cached archive id (intentional delta from the timestamp+1ms cursor)', async () => {
    seedChatMessages([
      { timestamp: new Date('2026-06-01T11:00:00Z'), stanzaId: 'older-id' },
      { timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newest-id' },
    ])
    const { result } = renderHook(() => useChatActive(), { wrapper })

    await act(async () => {
      await result.current.continueChatCatchUp()
    })

    expect(mockClient.chat.queryMAM).toHaveBeenCalledWith({
      with: CONV,
      after: 'newest-id',
      max: MAM_CATCHUP_FORWARD_MAX,
      maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
    })
  })

  it('clears the loading flag when the query rejects', async () => {
    chatStore.setState({
      conversationGaps: new Map([[CONV, { start: Date.now(), startId: 'gap-id-1' } as never]]),
    })
    vi.mocked(mockClient.chat.queryMAM).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useChatActive(), { wrapper })

    await act(async () => {
      await result.current.continueChatCatchUp()
    })

    expect(mockClient.chat.queryMAM).toHaveBeenCalled()
    expect(chatStore.getState().getMAMQueryState(CONV).isLoading).toBe(false)
  })
})

describe('continueRoomCatchUp cursor selection', () => {
  it('resumes a gap id-exact (after: seam startId) with the manual pagination cap', async () => {
    roomStore.setState({
      roomGaps: new Map([[ROOM, { start: new Date('2026-05-14T09:00:00Z').getTime(), startId: 'gap-id-1' } as never]]),
    })
    const { result } = renderHook(() => useRoomActive(), { wrapper })

    await act(async () => {
      await result.current.continueRoomCatchUp()
    })

    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith({
      roomJid: ROOM,
      after: 'gap-id-1',
      max: MAM_CATCHUP_FORWARD_MAX,
      maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
    })
  })

  it('falls back to start: gap timestamp + 1ms when the gap carries no startId', async () => {
    roomStore.setState({
      roomGaps: new Map([[ROOM, { start: new Date('2026-05-14T09:00:00.000Z').getTime() } as never]]),
    })
    seedRoomMessages([{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'above-hole' }])
    const { result } = renderHook(() => useRoomActive(), { wrapper })

    await act(async () => {
      await result.current.continueRoomCatchUp()
    })

    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith({
      roomJid: ROOM,
      start: '2026-05-14T09:00:00.001Z',
      max: MAM_CATCHUP_FORWARD_MAX,
      maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
    })
  })

  it('with no gap, resumes id-exact from the newest cached archive id (intentional delta from the timestamp+1ms cursor)', async () => {
    seedRoomMessages([
      { timestamp: new Date('2026-06-01T11:00:00Z'), stanzaId: 'older-id' },
      { timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newest-id' },
    ])
    const { result } = renderHook(() => useRoomActive(), { wrapper })

    await act(async () => {
      await result.current.continueRoomCatchUp()
    })

    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith({
      roomJid: ROOM,
      after: 'newest-id',
      max: MAM_CATCHUP_FORWARD_MAX,
      maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
    })
  })

  it('clears the loading flag when the query rejects', async () => {
    roomStore.setState({
      roomGaps: new Map([[ROOM, { start: Date.now(), startId: 'gap-id-1' } as never]]),
    })
    vi.mocked(mockClient.chat.queryRoomMAM).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useRoomActive(), { wrapper })

    await act(async () => {
      await result.current.continueRoomCatchUp()
    })

    expect(mockClient.chat.queryRoomMAM).toHaveBeenCalled()
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
  })
})
