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
})
