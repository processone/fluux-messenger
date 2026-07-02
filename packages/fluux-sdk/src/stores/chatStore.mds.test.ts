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

describe('chatStore — new-message divider is session-only', () => {
  beforeEach(() => chatStore.getState().reset())

  it('parks the divider in firstNewMessageMarkers, not in conversationMeta', () => {
    const cid = 'juliet@capulet.example'
    // m1 outgoing-read baseline, then two incoming unread messages.
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 2, lastSeenMessageId: 'm1' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 2, lastSeenMessageId: 'm1' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().setActiveConversation(cid)

    // Divider derived at m2 (first unread after m1) and stored in the session map.
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toBe('m2')
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m2')
    // The metadata entry carries NO divider field.
    expect('firstNewMessageId' in (chatStore.getState().conversationMeta.get(cid) as object)).toBe(false)
  })

  it('deactivating a conversation deletes its marker (switching to another conversation)', () => {
    const cidA = 'juliet@capulet.example'
    const cidB = 'romeo@montague.example'

    // Seed conversation A with one read message and one unread message.
    seedMessages(cidA, [msg('a1', 'sa1'), msg('a2', 'sa2')])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cidA, { unreadCount: 1, lastSeenMessageId: 'a1' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cidA, { id: cidA, name: cidA, type: 'chat', unreadCount: 1, lastSeenMessageId: 'a1' })
      // Seed conversation B with no unread so its activation sets no marker.
      newMeta.set(cidB, { unreadCount: 0 })
      newConvs.set(cidB, { id: cidB, name: cidB, type: 'chat', unreadCount: 0 })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
    seedMessages(cidB, [msg('b1', 'sb1')])

    // Activate A — should park the divider at a2.
    chatStore.getState().setActiveConversation(cidA)
    expect(chatStore.getState().firstNewMessageMarkers.get(cidA)).toBe('a2')

    // Switching to B must delete A's marker (the deactivate branch).
    chatStore.getState().setActiveConversation(cidB)
    expect(chatStore.getState().firstNewMessageMarkers.get(cidA)).toBeUndefined()
    // B has no unread, so it should not gain a marker either.
    expect(chatStore.getState().firstNewMessageMarkers.get(cidB)).toBeUndefined()
  })

  it('never writes the divider to persisted storage', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 1, lastSeenMessageId: 'm1' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 1, lastSeenMessageId: 'm1' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
    chatStore.getState().setActiveConversation(cid)
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toBe('m2')

    // Whatever the persist middleware wrote must not mention the divider.
    const dump = JSON.stringify(localStorage)
    expect(dump.includes('firstNewMessageId')).toBe(false)
    expect(dump.includes('firstNewMessageMarkers')).toBe(false)
  })
})

describe('chatStore.applyRemoteDisplayed — late marker corrects the ACTIVE divider', () => {
  beforeEach(() => chatStore.getState().reset())

  // Reproduces the fresh-session seed race: the conversation is activated (divider
  // derived from the STALE local read position) BEFORE the async MDS seed lands, so
  // the marker arrives via applyRemoteDisplayed while the conversation is already
  // active. The divider must be recomputed to reflect the synced read position, not
  // left frozen at the stale local one (which is what made the view open at the last
  // local place and only jump to the synced place on the next open).
  it('recomputes firstNewMessageMarkers when a late marker advances the active conversation past the divider', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedMessages(cid, messages)

    // Post-activation state: local read stale at m2, divider parked at m3 (first unread),
    // conversation is the active one. No pending marker yet (seed hasn't landed).
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm2' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm2' })
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.set(cid, 'm3')
      return { conversationMeta: newMeta, conversations: newConvs, firstNewMessageMarkers: newMarkers, activeConversationId: cid }
    })

    // The MDS seed lands late: the other device had read to s4 (the last message).
    chatStore.getState().applyRemoteDisplayed(cid, 's4')

    // Read position advanced to m4 …
    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m4')
    // … and because m4 is the last message, there is nothing new: the divider clears
    // (the UI then settles to the bottom instead of holding the stale m3 marker).
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBeUndefined()
  })

  it('does NOT recompute the divider for a non-active conversation (it is derived fresh on activation)', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedMessages(cid, messages)

    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm2' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm2' })
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.set(cid, 'm3')
      // Some OTHER conversation is active, not cid.
      return { conversationMeta: newMeta, conversations: newConvs, firstNewMessageMarkers: newMarkers, activeConversationId: 'romeo@montague.example' }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's4')

    // Read position still advances (forward-only sync is unconditional) …
    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m4')
    // … but the session divider for the inactive conversation is left untouched;
    // it is recomputed the next time the conversation is activated.
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toBe('m3')
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

  it('does NOT re-fold a remote read marker on a later activation in the same session', async () => {
    const cid = 'juliet@capulet.example'
    // Distinct, increasing timestamps so sortMessagesByTimestamp gives a stable order and the
    // index-based forward-only advance is deterministic.
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const messages = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m4', 's4', 4)]
    seedMessages(cid, messages)

    // First open: local read stale at m2, a remote device read up to s3 (pending).
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, lastSeenMessageId: 'm2', pendingRemoteDisplayedStanzaId: 's3' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId: 'm2', pendingRemoteDisplayedStanzaId: 's3' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)
    // First open folds the synced read forward to m3.
    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m3')

    // Leave (deactivation evicts the resident message array — memory windowing).
    await chatStore.getState().activateConversation(null)

    // Re-open: the cache reload brings the messages back (re-seed simulates it), and a NEW remote
    // read (s4, further ahead) has arrived as a fresh pending marker since first open.
    seedMessages(cid, messages)
    chatStore.setState((state) => {
      const meta = state.conversationMeta.get(cid)!
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { ...meta, pendingRemoteDisplayedStanzaId: 's4' })
      return { conversationMeta: newMeta }
    })

    // Re-open in the SAME session: the synced marker must NOT be folded again — XEP-0490 markers
    // broadcast live over PEP, so the read position (and the divider) stay where this client left
    // it. Without the gate this would fold s4 and advance lastSeenMessageId to m4.
    await chatStore.getState().activateConversation(cid)
    expect(chatStore.getState().conversationMeta.get(cid)?.lastSeenMessageId).toBe('m3')
  })
})
