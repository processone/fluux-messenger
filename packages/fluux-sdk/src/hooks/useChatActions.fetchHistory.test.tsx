/**
 * @vitest-environment happy-dom
 *
 * fetchHistory(conversationId?) accepts an explicit target that may not be the
 * active conversation. The active entity must never run the backward
 * pointer-stitch (Phase B would keep-oldest-evict its resident live edge), but
 * a non-active target should stitch so its unread region becomes contiguous —
 * matching the background catch-up path. See MAM.ts catchUpConversationHistory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useChatActions } from './useChatActions'
import { chatStore, connectionStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'

const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return { ...actual, useXMPPContext: () => ({ client: mockClient }) }
})

function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

describe('fetchHistory stitchReadPointer active/non-active rule', () => {
  const ACTIVE = 'alice@example.com'
  const OTHER = 'bob@example.com'

  beforeEach(() => {
    vi.mocked(mockClient.mam.catchUpConversationHistory).mockReset().mockResolvedValue(undefined)
    chatStore.setState({
      conversations: new Map(),
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      messages: new Map(),
      mamQueryStates: new Map(),
      conversationGaps: new Map(),
      activeConversationId: null,
    })
    chatStore.getState().addConversation({ id: ACTIVE, name: 'Alice', type: 'chat', unreadCount: 0 })
    chatStore.getState().addConversation({ id: OTHER, name: 'Bob', type: 'chat', unreadCount: 0 })
    chatStore.getState().setActiveConversation(ACTIVE)
    // Seed a cached message so fetchHistory skips loadMessagesFromCache (avoids
    // needing a messageCache mock) and proceeds straight to the catch-up call.
    chatStore.setState((state) => {
      const messages = new Map(state.messages)
      const seed = { id: 'seed-1', timestamp: new Date().toISOString() }
      messages.set(ACTIVE, [seed] as never)
      messages.set(OTHER, [seed] as never)
      return { messages }
    })
    connectionStore.getState().setStatus('online')
  })

  it('does not stitch the read pointer when the target is the active conversation', async () => {
    const { result } = renderHook(() => useChatActions(), { wrapper })

    await act(async () => {
      await result.current.fetchHistory(ACTIVE)
    })

    expect(mockClient.mam.catchUpConversationHistory).toHaveBeenCalledWith(
      ACTIVE,
      expect.anything(),
      expect.objectContaining({ stitchReadPointer: false })
    )
  })

  it('does not stitch the read pointer when defaulting to the active conversation', async () => {
    const { result } = renderHook(() => useChatActions(), { wrapper })

    await act(async () => {
      await result.current.fetchHistory()
    })

    expect(mockClient.mam.catchUpConversationHistory).toHaveBeenCalledWith(
      ACTIVE,
      expect.anything(),
      expect.objectContaining({ stitchReadPointer: false })
    )
  })

  it('stitches the read pointer when the target is a non-active conversation', async () => {
    const { result } = renderHook(() => useChatActions(), { wrapper })

    await act(async () => {
      await result.current.fetchHistory(OTHER)
    })

    expect(mockClient.mam.catchUpConversationHistory).toHaveBeenCalledWith(
      OTHER,
      expect.anything(),
      expect.objectContaining({ stitchReadPointer: true })
    )
  })
})
