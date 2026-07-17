/**
 * @vitest-environment happy-dom
 *
 * Regression: continueChatCatchUp / continueRoomCatchUp must ALWAYS clear the
 * MAM loading flag — even when no pagination cursor is found and no query runs.
 * The functions set isLoading=true up front; the original code only cleared it
 * in a catch block, so the no-cursor path (gap cleared between render and click,
 * or timestamp-less cached messages) left the "load missing messages" gap-marker
 * button spinning forever.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useChatActive } from './useChatActive'
import { useRoomActive } from './useRoomActive'
import { chatStore, roomStore, connectionStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'

const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return { ...actual, useXMPPContext: () => ({ client: mockClient }) }
})

// Empty cache so the catch-up reaches the cursor decision (instead of throwing
// in loadMessagesFromCache, which would mask the no-cursor path).
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

describe('continueCatchUp always clears the MAM loading flag', () => {
  const CONV = 'alice@example.com'
  const ROOM = 'room@conference.example.com'

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
  })

  it('continueChatCatchUp clears isLoading when no cursor is found (no query runs)', async () => {
    chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0 })
    chatStore.getState().setActiveConversation(CONV)
    // No messages and no recorded gap → selectCatchUpQuery yields no forward cursor.

    const { result } = renderHook(() => useChatActive(), { wrapper })

    await act(async () => {
      await result.current.continueChatCatchUp()
    })

    expect(mockClient.chat.queryMAM).not.toHaveBeenCalled()
    expect(chatStore.getState().getMAMQueryState(CONV).isLoading).toBe(false)
  })

  it('continueRoomCatchUp clears isLoading when no cursor is found (no query runs)', async () => {
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

    const { result } = renderHook(() => useRoomActive(), { wrapper })

    await act(async () => {
      await result.current.continueRoomCatchUp()
    })

    expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
  })
})
