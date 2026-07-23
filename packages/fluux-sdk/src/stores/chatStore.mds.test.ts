/**
 * Tests for chatStore.applyRemoteDisplayed — XEP-0490 read-position sync.
 *
 * Invariants under test:
 * 1. Forward-only: advances the read pointer to the local id of the matching stanza-id.
 * 2. Never regresses: incoming marker behind current position is silently ignored.
 * 3. Pending high-water mark: stanza-id not in loaded messages → stored in
 *    pendingRemoteDisplayedStanzaId; read pointer unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore } from './chatStore'
import { connectionStore } from './connectionStore'
import { chatSelectors } from './chatSelectors'
import type { Message } from '../core/types/chat'

// Mock messageCache: the deep-pointer activation tests need getMessagesAround to
// return a controlled around-slice; everything else is a harmless stub.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesAround: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessages: vi.fn().mockResolvedValue(undefined),
  }
})
import * as messageCache from '../utils/messageCache'

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

// Deterministic per-id timestamp: 'm3' → base + 3s. Read pointers carry the
// timestamp of the message they name (#1081), so `pointerAt` below can build one
// from an id alone without holding the array — and message order by timestamp
// now matches order by index, which `new Date()` for every message did not.
const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime()
function timeFor(id: string): Date {
  return new Date(BASE_TIME + (Number(id.replace(/\D/g, '')) || 0) * 1000)
}

/** The read pointer naming `id`, carrying that message's own timestamp. */
function pointerAt(id: string): { messageId: string; timestamp: Date } {
  return { messageId: id, timestamp: timeFor(id) }
}

// Minimal Message factory — only the fields used by applyRemoteDisplayed.
function msg(id: string, stanzaId: string): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    conversationId: 'juliet@capulet.example',
    from: 'juliet@capulet.example',
    body: id,
    timestamp: timeFor(id),
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

  it('advances the read pointer forward to the local id of the matching stanza-id', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)

    // Simulate conversation present in conversationMeta with m1 as last seen.
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m1') })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's3')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.messageId).toBe('m3')
    // Also verify the combined conversations map is kept in sync.
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.messageId).toBe('m3')
  })

  it('never regresses the read pointer when the incoming marker is behind current', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)

    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m3') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m3') })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's1') // behind → must be ignored

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m3')
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.messageId).toBe('m3')
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
    expect(meta?.readPointer).toBeUndefined() // unchanged
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
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m3'), pendingRemoteDisplayedStanzaId: 's2' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, {
        id: cid,
        name: cid,
        type: 'chat',
        unreadCount: 0,
        readPointer: pointerAt('m3'),
        pendingRemoteDisplayedStanzaId: 's2',
      })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    // s2's message IS present but the read pointer is already ahead → no advance.
    chatStore.getState().applyRemoteDisplayed(cid, 's2')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.messageId).toBe('m3') // unchanged
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined) // cleared
    // Combined conversations map kept in sync.
    expect(chatStore.getState().conversations.get(cid)?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  // Inbound read-state sync (spec §4): a marker published by another client
  // clears a backgrounded conversation's badge immediately, not on the next
  // activation (mirrors the roomStore behavior; conversations have no mentions).
  it('applyRemoteDisplayed on a non-active conversation recomputes the unread badge', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]

    // Backgrounded conversation: NO resident messages (evicted); the marker
    // arrives with the just-merged messages (the mergeMAMMessages override path).
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 3, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 3, readPointer: pointerAt('m1') })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's4', messages)

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.messageId).toBe('m4')
    expect(meta?.unreadCount).toBe(0)
    // The combined conversations mirror is kept coherent with conversationMeta.
    expect(chatStore.getState().conversations.get(cid)?.unreadCount).toBe(0)
  })

  // Exact badge recount (Phase B pointer resolution, non-resident conversation):
  // the sync recount inside applyRemoteDisplayed only sees the page it was handed
  // (mergedForMarker = the final backward page for a non-resident conversation).
  // The unread messages downloaded by EARLIER pages of the same walk (the
  // fetch-latest page, previous backward pages) live only in IndexedDB — the
  // final count must come from the cache, not the page.
  it('recounts the badge from the full cached set when the pointer resolves during a multi-page background walk', async () => {
    const cid = 'juliet@capulet.example'
    const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min))
    function timedMsg(id: string, stanzaId: string, ts: Date): Message {
      return { ...msg(id, stanzaId), timestamp: ts }
    }

    // Non-active, non-resident conversation with a pending deep pointer
    // (new-device sync: no local read state yet).
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0 })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0 })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
    chatStore.getState().applyRemoteDisplayed(cid, 's-ptr')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s-ptr')

    // Phase A fetch-latest page: 10 unread messages at the live edge; the
    // pointer's message is NOT here → stays pending.
    const latestPage = Array.from({ length: 10 }, (_, i) => timedMsg(`f${i}`, `sf${i}`, t(51 + i)))
    chatStore.getState().mergeMAMMessages(cid, latestPage, { first: 'sf0' }, false, 'backward', true)
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s-ptr')

    // Phase B backward page: contains the pointer's own message (oldest) plus
    // 9 more unread after it.
    const backwardPage = [
      timedMsg('p0', 's-ptr', t(41)),
      ...Array.from({ length: 9 }, (_, i) => timedMsg(`p${i + 1}`, `sp${i + 1}`, t(42 + i))),
    ]
    // The async exact recount reads the newest cached window — the union of
    // everything the walk downloaded (both pages, chronological).
    vi.mocked(messageCache.getMessages).mockResolvedValueOnce([...backwardPage, ...latestPage])
    chatStore.getState().mergeMAMMessages(cid, backwardPage, { first: 's-ptr' }, false, 'backward')

    // Pointer resolved at p0 → everything after it is unread: 9 (rest of the
    // backward page) + 10 (fetch-latest page) = 19, NOT just the 9 visible in
    // the final page.
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('p0')
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(19)
    })
    // Combined conversations mirror kept coherent.
    expect(chatStore.getState().conversations.get(cid)?.unreadCount).toBe(19)

    // Restore the factory default so a stale one-shot can't leak into later tests.
    vi.mocked(messageCache.getMessages).mockReset().mockResolvedValue([])
  })

  it('skips the async cache recount when the conversation became active meanwhile', async () => {
    const cid = 'juliet@capulet.example'
    const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min))
    function timedMsg(id: string, stanzaId: string, ts: Date): Message {
      return { ...msg(id, stanzaId), timestamp: ts }
    }

    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0 })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0 })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
    chatStore.getState().applyRemoteDisplayed(cid, 's-ptr')

    const page = [timedMsg('p0', 's-ptr', t(41)), timedMsg('p1', 'sp1', t(42))]
    // Cache read resolves AFTER the conversation becomes active: gate it.
    let releaseCache: (msgs: Message[]) => void
    vi.mocked(messageCache.getMessages).mockReturnValueOnce(
      new Promise<Message[]>((resolve) => { releaseCache = resolve })
    )
    chatStore.getState().mergeMAMMessages(cid, page, { first: 's-ptr' }, false, 'backward')
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(1)

    // User opens the conversation before the cache read lands; activation owns
    // the recount now — the stale async result must NOT clobber it.
    chatStore.setState({ activeConversationId: cid })
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { ...newMeta.get(cid)!, unreadCount: 0 })
      return { conversationMeta: newMeta }
    })
    releaseCache!([...page, timedMsg('f0', 'sf0', t(51))])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(0)

    // Restore the factory default so a stale one-shot can't leak into later tests.
    vi.mocked(messageCache.getMessages).mockReset().mockResolvedValue([])
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

    // Seed initial message m1/s1 and set up conversation meta with the read pointer at m1
    seedMessages(cid, [timedMsg('m1', 's1', t0)])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m1') })
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
    expect(meta?.readPointer?.messageId).toBe('m5')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })
})

describe('chatStore.markAsRead — read-pointer advance for XEP-0490 sync', () => {
  beforeEach(() => chatStore.getState().reset())

  // At the live edge the newest loaded message IS the true newest; clearing the
  // badge means the user caught up to it, so the read pointer must advance for the
  // MDS publisher (which watches the read pointer) to sync the marker.
  it('advances the read pointer to the newest loaded message when at the live edge', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 2, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 2, readPointer: pointerAt('m1') })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    chatStore.getState().markAsRead(cid)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m3')
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.messageId).toBe('m3')
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(0)
  })

  // Slid up into history: the badge still clears (the user acknowledged the
  // conversation) but the pointer must stay put so MDS never publishes a read
  // position past messages the user has not seen.
  it('does NOT advance the read pointer when the window is slid up into history', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 2, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 2, readPointer: pointerAt('m1') })
      const newEdge = new Map(state.windowAtLiveEdge)
      newEdge.set(cid, false)
      return { conversationMeta: newMeta, conversations: newConvs, windowAtLiveEdge: newEdge }
    })

    chatStore.getState().markAsRead(cid)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m1')
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(0)
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
      newMeta.set(cid, { unreadCount: 2, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 2, readPointer: pointerAt('m1') })
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
      newMeta.set(cidA, { unreadCount: 1, readPointer: pointerAt('a1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cidA, { id: cidA, name: cidA, type: 'chat', unreadCount: 1, readPointer: pointerAt('a1') })
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
      newMeta.set(cid, { unreadCount: 1, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 1, readPointer: pointerAt('m1') })
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
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2') })
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.set(cid, 'm3')
      return { conversationMeta: newMeta, conversations: newConvs, firstNewMessageMarkers: newMarkers, activeConversationId: cid }
    })

    // The MDS seed lands late: the other device had read to s4 (the last message).
    chatStore.getState().applyRemoteDisplayed(cid, 's4')

    // Read position advanced to m4 …
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m4')
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
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2') })
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.set(cid, 'm3')
      // Some OTHER conversation is active, not cid.
      return { conversationMeta: newMeta, conversations: newConvs, firstNewMessageMarkers: newMarkers, activeConversationId: 'romeo@montague.example' }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's4')

    // Read position still advances (forward-only sync is unconditional) …
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m4')
    // … but the session divider for the inactive conversation is left untouched;
    // it is recomputed the next time the conversation is activated.
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toBe('m3')
  })
})

describe('chatStore.activateConversation — XEP-0490 divider sync', () => {
  beforeEach(() => chatStore.getState().reset())

  it('folds a pending remote read marker into the read pointer before deriving the divider', async () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedMessages(cid, messages)

    // Local read is stale at m2; a remote device read up to s4, seeded as pending
    // before the messages were loaded (the fresh-session MDS seed ordering).
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's4' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's4' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)

    // The pending marker is resolved at activation, advancing the read position.
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m4')
    // So the divider reflects the synced read (m4 is the last message → nothing new),
    // NOT the stale 'm3' it would show if the marker resolved after onActivate.
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBeUndefined()
  })

  it('does NOT re-fold the SAME already-folded read marker on a later activation', async () => {
    const cid = 'juliet@capulet.example'
    // Distinct, increasing timestamps so sortMessagesByTimestamp gives a stable order and the
    // index-based forward-only advance is deterministic.
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const messages = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m4', 's4', 4)]
    seedMessages(cid, messages)

    // First open: local read stale at m2, a remote device read up to s3 (pending) → folds to m3.
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's3' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's3' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m3')

    // Leave (deactivation evicts the resident message array — memory windowing).
    await chatStore.getState().activateConversation(null)

    // Re-open with the SAME pending marker still set: the gate must skip re-folding the identical
    // marker so it can't reposition the divider on every return (XEP-0490 markers broadcast live).
    seedMessages(cid, messages)
    chatStore.setState((state) => {
      const meta = state.conversationMeta.get(cid)!
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { ...meta, pendingRemoteDisplayedStanzaId: 's3' })
      return { conversationMeta: newMeta }
    })
    await chatStore.getState().activateConversation(cid)
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m3')
  })

  // Regression (bug: "read on another device, still unread on return"): a NEWER remote read
  // arrives while the conversation is inactive. Inactive conversations evict their message array,
  // so the live `read:displayed-synced` notify can only stash it as pending. The next activation
  // fold is the only path that can apply it, so the gate must NOT suppress a marker it has never
  // folded, even though the conversation was opened before.
  it('folds a NEWER read marker that arrived while the conversation was inactive', async () => {
    const cid = 'romeo@montague.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const messages = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m4', 's4', 4)]
    seedMessages(cid, messages)

    // First open: local read stale at m2, a remote device read up to s3 (pending) → folds to m3.
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's3' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's3' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m3')

    await chatStore.getState().activateConversation(null)

    // Re-open: cache reload brings messages back, and a NEW further-ahead remote read (s4) has
    // arrived as a fresh pending marker that the live notify could only stash while unloaded.
    seedMessages(cid, messages)
    chatStore.setState((state) => {
      const meta = state.conversationMeta.get(cid)!
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { ...meta, pendingRemoteDisplayedStanzaId: 's4' })
      return { conversationMeta: newMeta }
    })
    await chatStore.getState().activateConversation(cid)
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m4')
  })

  // Regression (gate burn on stash): a fold that could not resolve (marker's message not
  // loaded) must not consume the session gate — otherwise the pending marker is stuck for
  // the whole session (re-entry skips the fold as "already consumed").
  it('retries the fold on a later activation when the first fold could not resolve (marker message not yet loaded)', async () => {
    const cid = 'retry-stash@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const early = [timed('m1', 's1', 1), timed('m2', 's2', 2)]
    seedMessages(cid, early)
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m1'), pendingRemoteDisplayedStanzaId: 's9' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m1'), pendingRemoteDisplayedStanzaId: 's9' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)
    // Unresolvable → stash survives, pointer untouched.
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m1')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s9')

    await chatStore.getState().activateConversation(null)

    // The archive healed since (catch-up landed): the marker's message is loadable now.
    seedMessages(cid, [...early, timed('m9', 's9', 9)])

    await chatStore.getState().activateConversation(cid)
    // The gate must allow the retry (the marker was never actually folded).
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m9')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
  })

  // Regression (fold ran only before the load-around): with a deep backlog the pending
  // marker's message is outside the latest-100 slice, so the first fold stashes. The
  // load-around of the stale pointer brings it in — the fold must re-attempt against
  // the around-slice so the divider reflects the synced read position.
  it('re-attempts the fold against the slice loaded around a deep stale pointer', async () => {
    const cid = 'deep-pointer@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:${String(n).padStart(2, '0')}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const latest = [timed('m10', 's10', 10), timed('m11', 's11', 11), timed('m12', 's12', 12)]
    // Resident window = latest slice; the read pointer (m2) is deeper than it.
    seedMessages(cid, latest)
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's5' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's5' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
    // The IndexedDB slice around the stale pointer contains the marker's message (m5).
    const aroundSlice = [
      timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3),
      timed('m4', 's4', 4), timed('m5', 's5', 5), timed('m6', 's6', 6),
    ]
    vi.mocked(messageCache.getMessagesAround).mockResolvedValueOnce(aroundSlice)

    await chatStore.getState().activateConversation(cid)

    // The retried fold advances the pointer to the synced position…
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m5')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    // …and the divider derives from it, not from the stale local pointer (m2 → 'm3').
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m6')
  })

  // A divider derived while a pending marker is still UNRESOLVED is provisional —
  // the synced read position may move or erase it once the marker's message loads.
  // The UI renders it muted until it is confirmed (pending resolved).
  it('flags the divider provisional while the pending marker is unresolved, confirmed once it resolves', async () => {
    const cid = 'provisional@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const messages = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m4', 's4', 4)]
    seedMessages(cid, messages)
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's0' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's0' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)

    // Divider derived from the local pointer, but the synced position is unknown → provisional.
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m3')
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(true)

    // The marker's message arrives (merge): it sits BEHIND the pointer → clear-pending.
    // The divider is untouched but now confirmed.
    chatStore.getState().applyRemoteDisplayed(cid, 's0', [timed('m0', 's0', 0), ...messages])
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m3')
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(false)
  })

  it('a divider derived with no pending marker is never provisional', async () => {
    const cid = 'confirmed@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    seedMessages(cid, [timed('m1', 's1', 1), timed('m2', 's2', 2)])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m1') })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m1') })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)

    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m2')
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(false)
  })

  it('a pending marker without a divider is not provisional (nothing to render)', () => {
    const cid = 'pending-no-divider@capulet.example'
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m1'), pendingRemoteDisplayedStanzaId: 's9' })
      return { conversationMeta: newMeta }
    })

    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(false)
  })

  // The flash scenario, made explicit: a provisional divider must settle to its
  // DEFINITIVE position (moved, confirmed) when the marker resolves AHEAD of it
  // on the active conversation — and stop being provisional.
  it('moves the divider and confirms it when the marker resolves ahead of it (active conversation)', async () => {
    const cid = 'resolve-ahead@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    // m4 is NOT loaded at activation (deep gap) — the marker for s4 can only stash.
    const loaded = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m5', 's5', 5)]
    seedMessages(cid, loaded)
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's4' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's4' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)
    // Provisional divider from the stale local pointer (m2 → m3).
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m3')
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(true)

    // The marker's message arrives (merge): the synced read is ahead → the divider
    // settles after the synced position, definitive.
    const full = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m4', 's4', 4), timed('m5', 's5', 5)]
    chatStore.getState().applyRemoteDisplayed(cid, 's4', full)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m4')
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m5')
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(false)
  })

  it('erases the provisional divider when the marker resolves at the newest message (all read elsewhere)', async () => {
    const cid = 'resolve-erase@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const loaded = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3)]
    seedMessages(cid, loaded)
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt('m1'), pendingRemoteDisplayedStanzaId: 's9' })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt('m1'), pendingRemoteDisplayedStanzaId: 's9' })
      return { conversationMeta: newMeta, conversations: newConvs }
    })

    await chatStore.getState().activateConversation(cid)
    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBe('m2')
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(true)

    // The other device read everything: the marker resolves at the newest message.
    chatStore.getState().applyRemoteDisplayed(cid, 's9', [...loaded, timed('m9', 's9', 9)])

    expect(chatSelectors.firstNewMessageIdFor(cid)(chatStore.getState())).toBeUndefined()
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(false)
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Fresh-instance catch-up ordering (issue #1076) — twin of the roomStore case.
//
// A new instance has no local read state, so the marker from the client the user
// left arrives before any message can resolve it and lands pending. The catch-up
// merge recomputed counts first, and the fresh-entity guard snapped the pointer
// to the newest message — past the marker, which the forward-only fold then
// discarded.
// ---------------------------------------------------------------------------

describe('chatStore fresh-instance catch-up preserves the remote read position', () => {
  const cid = 'juliet@capulet.example'

  beforeEach(() => chatStore.getState().reset())

  /** Register the conversation with NO read state at all (fresh instance). */
  function seedFreshConversation(): void {
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0 })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0 })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
  }

  const archive = () => Array.from({ length: 10 }, (_, i) => msg(`m${i + 1}`, `s${i + 1}`))

  it('keeps the pointer at the marker instead of snapping to newest', () => {
    seedFreshConversation()
    chatStore.getState().applyRemoteDisplayed(cid, 's3') // nothing loaded → pending
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s3')

    chatStore.getState().mergeMAMMessages(cid, archive(), {}, true, 'forward')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.messageId).toBe('m3')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  it('counts the messages after the marker as unread', () => {
    seedFreshConversation()
    chatStore.getState().applyRemoteDisplayed(cid, 's3')

    chatStore.getState().mergeMAMMessages(cid, archive(), {}, true, 'forward')

    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(7)
  })

  // Control: no remote marker ⇒ a fresh conversation is still caught up.
  it('still treats a fresh conversation with no remote marker as caught up', () => {
    seedFreshConversation()

    chatStore.getState().mergeMAMMessages(cid, archive(), {}, true, 'forward')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.unreadCount).toBe(0)
    expect(meta?.readPointer?.messageId).toBe('m10')
  })
})

// ---------------------------------------------------------------------------
// advanceReadPointer presence gate (issue #1076) — twin of the roomStore case.
// ---------------------------------------------------------------------------

describe('chatStore.advanceReadPointer presence gate', () => {
  const cid = 'juliet@capulet.example'

  beforeEach(() => {
    chatStore.getState().reset()
    connectionStore.getState().setWindowVisible(true)
  })

  function seedWithPointer(seenMessageId: string): void {
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { unreadCount: 0, readPointer: pointerAt(seenMessageId) })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer: pointerAt(seenMessageId) })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
  }

  it('advances the read pointer when the window is focused', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(true)
    chatStore.getState().advanceReadPointer(cid, 'm3')
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m3')
  })

  it('does not advance the read pointer while the window is unfocused', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(false)
    chatStore.getState().advanceReadPointer(cid, 'm3')
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m1')
  })

  it('leaves the combined conversations map untouched while unfocused', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(false)
    chatStore.getState().advanceReadPointer(cid, 'm3')
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.messageId).toBe('m1')
  })

  it('resumes advancing once the window regains focus', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(false)
    chatStore.getState().advanceReadPointer(cid, 'm2')
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m1')
    connectionStore.getState().setWindowVisible(true)
    chatStore.getState().advanceReadPointer(cid, 'm3')
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.messageId).toBe('m3')
  })
})
