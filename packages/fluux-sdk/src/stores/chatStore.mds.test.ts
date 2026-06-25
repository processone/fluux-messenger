/**
 * Tests for chatStore.applyRemoteDisplayed — XEP-0490 read-position sync.
 *
 * Invariants under test:
 * 1. Forward-only: advances lastSeenMessageId to the local id of the matching stanza-id.
 * 2. Never regresses: incoming marker behind current position is silently ignored.
 * 3. Pending high-water mark: stanza-id not in loaded messages → stored in
 *    pendingRemoteDisplayedStanzaId; lastSeenMessageId unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { chatStore } from './chatStore'
import { chatSelectors } from './chatSelectors'
import type { Message } from '../core/types/chat'

// Mock localStorage (required by chatStore's persist middleware)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

// Minimal Message factory — only the fields used by applyRemoteDisplayed.
function msg(id: string, stanzaId: string): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    conversationId: 'juliet@capulet.example',
    from: 'juliet@capulet.example',
    body: id,
    timestamp: new Date(),
    isOutgoing: false,
  }
}

/** Seed messages directly into the store's messages Map (same mechanism as chatStore.test.ts). */
function seedMessages(cid: string, messages: Message[]): void {
  chatStore.setState((state) => {
    const newMessages = new Map(state.messages)
    newMessages.set(cid, messages)
    return { messages: newMessages }
  })
}

describe('chatStore.applyRemoteDisplayed', () => {
  beforeEach(() => chatStore.getState().reset())

  it('advances lastSeenMessageId forward to the local id of the matching stanza-id', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)

    // Simulate conversation present in conversationMeta with m1 as last seen.
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm1' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm1' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's3')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.lastSeenMessageId).toBe('m3')
    // Also verify the combined conversations map is kept in sync.
    expect(chatStore.getState().conversations.get(cid)?.lastSeenMessageId).toBe('m3')
  })

  it('never regresses lastSeenMessageId when the incoming marker is behind current', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)

    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm3' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm3' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's1') // behind → must be ignored

    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m3')
    expect(chatStore.getState().conversations.get(cid)?.lastSeenMessageId).toBe('m3')
  })

  it('stores a pending high-water mark when the stanza-id is not yet loaded', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1')])

    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0 })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0 })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's-future')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe('s-future')
    expect(meta?.lastSeenMessageId).toBeUndefined() // unchanged
  })

  it('clears a stale pending marker when the message is present but already passed', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)

    // Local position is already at m3 (past s2), yet a stale pending marker for
    // s2 lingers — e.g. set before the message loaded, then resolved by a local
    // advance that didn't go through applyRemoteDisplayed.
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm3', pendingRemoteDisplayedStanzaId: 's2' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, {
        id: cid,
        name: cid,
        type: 'chat',
        unreadCount: 0,
        lastSeenMessageId: 'm3',
        pendingRemoteDisplayedStanzaId: 's2',
      })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    // s2's message IS present but lastSeenMessageId is already ahead → no advance.
    chatStore.getState().applyRemoteDisplayed(cid, 's2')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.lastSeenMessageId).toBe('m3') // unchanged
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined) // cleared
    // Combined conversations map kept in sync.
    expect(chatStore.getState().conversations.get(cid)?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  it('resolves a pending remote marker once the message arrives via MAM merge', () => {
    const cid = 'juliet@capulet.example'

    // Use distinct timestamps so sortMessagesByTimestamp gives a stable order.
    const t0 = new Date('2026-01-01T00:00:00Z')
    const t1 = new Date('2026-01-01T00:01:00Z')
    const t2 = new Date('2026-01-01T00:02:00Z')

    function timedMsg(id: string, stanzaId: string, ts: Date): Message {
      return { ...msg(id, stanzaId), timestamp: ts }
    }

    // Seed initial message m1/s1 and set up conversation meta with lastSeenMessageId=m1
    seedMessages(cid, [timedMsg('m1', 's1', t0)])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm1' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm1' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    // Remote marker for s5 arrives before m5 is loaded → stored as pending
    chatStore.getState().applyRemoteDisplayed(cid, 's5')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s5')

    // MAM merge brings in m2 and m5/s5 (newer than m1)
    chatStore.getState().mergeMAMMessages(
      cid,
      [timedMsg('m2', 's2', t1), timedMsg('m5', 's5', t2)],
      {},
      true,
      'forward'
    )

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.lastSeenMessageId).toBe('m5')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })
})

describe('chatStore.activateConversation — XEP-0490 divider sync', () => {
  beforeEach(() => chatStore.getState().reset())

  it('folds a pending remote read marker into lastSeenMessageId before deriving the divider', async () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedMessages(cid, messages)

    // Local read is stale at m2; a remote device read up to s4, seeded as pending
    // before the messages were loaded (the fresh-session MDS seed ordering).
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm2', pendingRemoteDisplayedStanzaId: 's4' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm2', pendingRemoteDisplayedStanzaId: 's4' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)

    // The pending marker is resolved at activation, advancing the read position.
    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m4')
    // So the divider reflects the synced read (m4 is the last message → nothing new),
    // NOT the stale 'm3' it would show if the marker resolved after onActivate.
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBeUndefined()
  })
})
