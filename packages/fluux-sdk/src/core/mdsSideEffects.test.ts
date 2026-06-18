/**
 * Tests for the MDS (XEP-0490) read-position publisher side effect.
 *
 * Verifies debounced, coalesced, forward-only publishing of the resolved
 * stanza-id per conversation:
 * - A local read advance publishes the resolved stanza-id once, debounced.
 * - A read marker with no resolvable stanza-id does NOT publish.
 * - Pending publishes are DROPPED on disconnect (localStorage is the durable buffer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock localStorage before importing stores (chatStore persist middleware).
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { setupMdsSideEffects } from './mdsSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import type { Message } from './types/chat'

function msg(id: string, stanzaId: string | undefined): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    conversationId: 'juliet@capulet.example',
    from: 'juliet@capulet.example',
    body: id,
    timestamp: new Date(),
    isOutgoing: false,
  } as Message
}

/** Seed messages directly into the store's messages Map (same as chatStore.mds.test.ts). */
function seedMessages(cid: string, messages: Message[]): void {
  chatStore.setState((state) => {
    const newMessages = new Map(state.messages)
    newMessages.set(cid, messages)
    return { messages: newMessages }
  })
}

/**
 * Seed a conversationMeta entry so updateLastSeenMessageId is allowed to advance.
 * updateLastSeenMessageId early-returns when no meta entry exists.
 */
function seedMeta(cid: string, lastSeenMessageId?: string): void {
  chatStore.setState((state) => {
    const newMeta = new Map(state.conversationMeta)
    newMeta.set(cid, { unreadCount: 0, lastSeenMessageId })
    const newConvs = new Map(state.conversations)
    newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId })
    return { conversationMeta: newMeta, conversations: newConvs }
  })
}

function makeClient() {
  const handlers: Record<string, Array<(p?: unknown) => void>> = {}
  const register = (ev: string, cb: (p?: unknown) => void) => {
    ;(handlers[ev] ||= []).push(cb)
    return () => {
      handlers[ev] = (handlers[ev] || []).filter((h) => h !== cb)
    }
  }
  return {
    // Connection lifecycle events ('online'/'resumed') use client.on(...).
    on: register,
    // SDK events ('read:displayed-synced') use client.subscribe(...).
    subscribe: register,
    _emit: (ev: string, p?: unknown) => (handlers[ev] || []).forEach((h) => h(p)),
    mds: {
      publishDisplayed: vi.fn().mockResolvedValue(undefined),
      fetchAllDisplayed: vi.fn().mockResolvedValue([]),
    },
  }
}

describe('setupMdsSideEffects', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connectionStore.getState().reset()
    chatStore.getState().reset()
    localStorageMock.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('publishes the resolved stanza-id once, debounced, on a local read advance', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online' } as never)
    const cleanup = setupMdsSideEffects(client as never)

    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // let the async seed settle

    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')
    chatStore.getState().updateLastSeenMessageId(cid, 'm2')

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled() // still debouncing
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2')
    cleanup()
  })

  it('does not publish a marker with no stanza-id', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    seedMessages(cid, [msg('m1', undefined)])
    seedMeta(cid)
    chatStore.getState().updateLastSeenMessageId(cid, 'm1')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('drops pending publishes on disconnect', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    seedMessages(cid, [msg('m1', 's1')])
    seedMeta(cid)
    chatStore.getState().updateLastSeenMessageId(cid, 'm1')
    connectionStore.setState({ status: 'connecting' } as never) // disconnect
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not re-publish the echo of a live incoming remote marker', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online' } as never)

    // Conversation already exists with a settled local read position at m1 before
    // the side effect starts, so the fresh-session seed snapshots m1 as the last
    // considered position (no spurious publish for the existing position).
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // let the async seed settle

    // A live remote marker for s2 arrives from a peer device (PubSub emits
    // 'read:displayed-synced' and storeBindings calls applyRemoteDisplayed). Apply
    // the store advance FIRST so the conversationMeta subscription → consider()
    // enqueues s2 with no node value recorded yet (worst-case handler order). Only
    // THEN record the node high-water mark. This exercises the doPublish exact-equal
    // skip specifically — consider() already enqueued before the node value existed.
    chatStore.getState().applyRemoteDisplayed(cid, 's2')
    client._emit('read:displayed-synced', { conversationId: cid, stanzaId: 's2' })

    await vi.advanceTimersByTimeAsync(2_000)

    // The marker s2 is already on the node (it is the echo) → must NOT republish.
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })
})
