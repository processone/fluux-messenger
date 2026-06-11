/**
 * @vitest-environment happy-dom
 *
 * Regression guard for the MAM "item-not-found" scroll-up bug.
 *
 * `fetchOlderHistory` must NEVER send a client-generated message id as the RSM
 * `<before>` cursor — the server rejects it with item-not-found and dead-ends
 * "load older history". These tests exercise the real hook wiring
 * (useChat → createFetchOlderHistory → client.chat.queryMAM) to prove the
 * cursor is always a server stanzaId, or the id-independent timestamp recovery,
 * but never a client UUID. They fail against the original
 * `messages[0].stanzaId || messages[0].id` cursor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useChat } from './useChat'
import type { Message } from '../core/types'
import { chatStore, connectionStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'

const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return { ...actual, useXMPPContext: () => ({ client: mockClient }) }
})

// Empty cache so fetchOlderHistory falls through to the MAM path.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return { ...actual, getMessages: vi.fn().mockResolvedValue([]) }
})

function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

const CONV = 'alice@example.com'

function seedMessages(messages: Message[]) {
  chatStore.setState({
    conversations: new Map(),
    conversationEntities: new Map(),
    conversationMeta: new Map(),
    messages: new Map(),
    mamQueryStates: new Map(),
    activeConversationId: null,
  })
  chatStore.getState().addConversation({ id: CONV, name: 'Alice', type: 'chat', unreadCount: 0 })
  chatStore.setState((s) => {
    const m = new Map(s.messages)
    m.set(CONV, messages)
    return { messages: m }
  })
  chatStore.getState().setActiveConversation(CONV)
  connectionStore.getState().setStatus('online')
}

const outgoing = (id: string, ts: string): Message => ({
  type: 'chat', id, originId: id, conversationId: CONV,
  from: 'me@example.com/desktop', body: 'hi', timestamp: new Date(ts), isOutgoing: true,
})
const incoming = (id: string, ts: string, stanzaId: string): Message => ({
  type: 'chat', id, conversationId: CONV, from: CONV, body: 'hi',
  timestamp: new Date(ts), isOutgoing: false, stanzaId,
})

describe('useChat fetchOlderHistory — MAM cursor regression', () => {
  beforeEach(() => {
    vi.mocked(mockClient.chat.queryMAM).mockReset().mockResolvedValue(undefined)
  })

  it('uses the oldest server stanzaId as the cursor — never the client id — when the oldest message is outgoing', async () => {
    // Oldest message is one we sent (no stanzaId); a later received message has one.
    seedMessages([
      outgoing('uuid-sent', '2026-06-01T10:00:00Z'),
      incoming('r1', '2026-06-01T10:05:00Z', 'archive-1'),
    ])
    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      await result.current.fetchOlderHistory()
    })

    expect(mockClient.chat.queryMAM).toHaveBeenCalledTimes(1)
    expect(mockClient.chat.queryMAM).toHaveBeenCalledWith({ with: CONV, before: 'archive-1' })
    // The client UUID must never be used as a cursor.
    const before = vi.mocked(mockClient.chat.queryMAM).mock.calls[0][0].before
    expect(before).not.toBe('uuid-sent')
  })

  it('recovers via a timestamp window — never the client id — when no in-memory message has a stanzaId', async () => {
    seedMessages([
      outgoing('uuid-1', '2026-06-01T10:00:00Z'),
      outgoing('uuid-2', '2026-06-01T10:05:00Z'),
    ])
    const { result } = renderHook(() => useChat(), { wrapper })

    await act(async () => {
      await result.current.fetchOlderHistory()
    })

    // Recovery: query by the `end` timestamp of the oldest message, empty before.
    expect(mockClient.chat.queryMAM).toHaveBeenCalledTimes(1)
    expect(mockClient.chat.queryMAM).toHaveBeenCalledWith({
      with: CONV,
      end: new Date('2026-06-01T10:00:00Z').toISOString(),
      before: '',
    })
    // No call ever uses a client UUID as `before`.
    for (const [opts] of vi.mocked(mockClient.chat.queryMAM).mock.calls) {
      expect(['uuid-1', 'uuid-2']).not.toContain(opts.before)
    }
  })
})
