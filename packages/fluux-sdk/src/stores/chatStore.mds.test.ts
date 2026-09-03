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
import { makeReadPointer, type ReadPointer } from './shared/readPointer'
import { chatSelectors } from './chatSelectors'
import type { Message, ConversationEntity, ConversationMetadata } from '../core/types/chat'
import {
  _clearAllViewportEvidenceForTesting,
  currentViewportGeneration,
  reportViewport,
} from './shared/viewportEvidence'
import { _resetPurgedMarkersForTesting } from './shared/purgedMarkers'
import { getStorageScopeJid } from '../utils/storageScope'

// Mock messageCache: the deep-pointer activation tests need getMessagesAround to
// return a controlled around-slice; everything else is a harmless stub.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessageWithResult: vi.fn().mockResolvedValue(true),
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

/**
 * The read pointer naming `id`, carrying that message's own timestamp.
 *
 * KEYED, exactly as `makeReadPointer` writes every pointer: the divider and the
 * unread count are derived by archive POSITION. Under `isAfterBoundary`, a
 * keyless pointer treats every row at its millisecond as after the boundary, so
 * the message it NAMES would take the divider itself.
 */
function pointerAt(id: string): ReadPointer {
  return makeReadPointer({ id, timestamp: timeFor(id) }, 'chat')
}

/**
 * The read pointer naming `id` WITHIN `messages` — for the fixtures below that
 * override timestamps with a local `timed()` helper, where `pointerAt`'s
 * id-derived timestamp would disagree with the message's own. A pointer's
 * timestamp must BE its named message's own (#1081), and the divider is now
 * derived from that position rather than from the array index, so a disagreeing
 * pair no longer passes unnoticed.
 */
function pointerIn(messages: Message[], id: string): ReadPointer {
  const found = messages.find((m) => m.id === id)
  if (!found) throw new Error(`pointerIn: no message ${id} in the seeded slice`)
  return makeReadPointer(found, 'chat')
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

/**
 * Seed a conversation across all three maps, with the compat entry DERIVED from
 * the entity and the metadata — the same rule the store itself now follows (see
 * shared/conversationMaps) and the same one `deserializeState` applies on
 * reload.
 *
 * Written out here rather than delegating to the production draft, so a bug in
 * that module cannot quietly make these fixtures agree with it. Fixtures that
 * set `conversations` without `conversationEntities` build a state the store can
 * no longer reach, and assertions over the compat map then prove nothing.
 */
function seedConversation(cid: string, meta: ConversationMetadata): void {
  const entity: ConversationEntity = { id: cid, name: cid, type: 'chat' }
  chatStore.setState((state) => ({
    conversationEntities: new Map(state.conversationEntities).set(cid, entity),
    conversationMeta: new Map(state.conversationMeta).set(cid, meta),
    conversations: new Map(state.conversations).set(cid, { ...entity, ...meta }),
  }))
}

function reportChatViewport(cid: string, evidence: 'at-edge' | 'away'): void {
  const key = {
    accountScope: getStorageScopeJid() ?? '',
    kind: 'chat' as const,
    entityId: cid,
  }
  reportViewport(key, currentViewportGeneration(key), evidence)
}

describe('chatStore.applyRemoteDisplayed', () => {
  beforeEach(() => chatStore.getState().reset())

  it('advances the read pointer forward to the local id of the matching stanza-id', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)

    // Simulate conversation present in conversationMeta with m1 as last seen.
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m1') })

    chatStore.getState().applyRemoteDisplayed(cid, 's3')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.identity.messageId).toBe('m3')
    // Also verify the combined conversations map is kept in sync.
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.identity.messageId).toBe('m3')
  })

  it('never regresses the read pointer when the incoming marker is behind current', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')]
    seedMessages(cid, messages)

    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m3') })

    chatStore.getState().applyRemoteDisplayed(cid, 's1') // behind → must be ignored

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.identity.messageId).toBe('m3')
  })

  it('stores a pending high-water mark when the stanza-id is not yet loaded', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1')])

    seedConversation(cid, { unreadCount: 0 })

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
    seedConversation(cid, {
      unreadCount: 0,
      readPointer: pointerAt('m3'),
      pendingRemoteDisplayedStanzaId: 's2',
    })

    // s2's message IS present but the read pointer is already ahead → no advance.
    chatStore.getState().applyRemoteDisplayed(cid, 's2')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.identity.messageId).toBe('m3') // unchanged
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined) // cleared
    // Combined conversations map kept in sync.
    expect(chatStore.getState().conversations.get(cid)?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  // Inbound read-state sync (spec §4): a marker published by another client
  // advances a backgrounded conversation's read POSITION immediately (the
  // pointer is unconditional, forward-only). The archive-derived recount
  // no longer derives the COUNT from the page-scoped slice this method was
  // handed — that undercounts a multi-page pointer-stitch walk (see the next
  // test's comment) and can never be trusted as "exact". The count is instead
  // re-derived from the durable archive via recomputeUnreadForConversation,
  // triggered fire-and-forget; see chatStore.archiveUnread.test.ts for its
  // exact/deferred/unavailable outcomes. Nothing here seeds
  // mamQueryStates/conversationCoverage, so that derivation defers — the
  // stale count (3) survives rather than snapping to this page's own tally.
  it('applyRemoteDisplayed on a non-active conversation advances the pointer; the count is archive-derived and defers without proven coverage', async () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]

    // Backgrounded conversation: NO resident messages (evicted); the marker
    // arrives with the just-merged messages (the mergeMAMMessages override path).
    seedConversation(cid, { unreadCount: 3, readPointer: pointerAt('m1') })

    chatStore.getState().applyRemoteDisplayed(cid, 's4', messages)

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.identity.messageId).toBe('m4')

    // Let the fire-and-forget archive recount run to completion.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(3)
    // The combined conversations mirror is kept coherent with conversationMeta.
    expect(chatStore.getState().conversations.get(cid)?.unreadCount).toBe(3)
  })

  // The widening — at the store layer, where it actually bites. The store
  // CHOOSES the array: `mergeMAMMessages` hands `applyRemoteDisplayed` a single
  // trimmed MAM page (`mergedForMarker`, chatStore.ts:2954), and the pointer's
  // own message need not be in it. Before D3 that was `undefined`/undecidable and
  // the marker stayed stashed for the activation fold; now a KEYED pointer is
  // ordered by archive POSITION against a page it was never orderable against.
  // Only a store-level test exercises that page-choosing call site.
  it('advances a KEYED pointer that is absent from the merged page, against that page', () => {
    const cid = 'juliet@capulet.example'
    // The merged page: m2..m4. The local pointer names m0, which is NOT in it.
    const mergedPage = [msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedConversation(cid, {
      unreadCount: 5,
      readPointer: pointerAt('m0'),
      pendingRemoteDisplayedStanzaId: 's3',
    })
    // No resident messages at all — a backgrounded conversation, exactly as the
    // merge path finds it.
    expect(chatStore.getState().messages.get(cid)).toBeUndefined()

    chatStore.getState().applyRemoteDisplayed(cid, 's3', mergedPage)

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.identity.messageId).toBe('m3')
    // Resolved, so the high-water mark is retired rather than left to re-fire.
    expect(meta?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    // The count is NOT this page's own tally (which would be 1: m4 alone). It
    // stays archive-derived, and with no coverage/MAM state seeded that
    // derivation defers, so the stale 5 survives — see the non-active test above.
    expect(meta?.unreadCount).toBe(5)
  })

  // Multi-page background walk: the pointer resolves against only the FINAL
  // page (mergedForMarker), which undercounts a walk spanning several pages
  // (the fetch-latest page, earlier backward pages) — the badge would read
  // ~9 instead of the true 19. The archive-derived recount fixes this architecturally rather than by
  // re-reading a wider cache window: the archive-derived recount
  // (recomputeUnreadForConversation) cursors the DURABLE ARCHIVE from the
  // floor forward, so it has no page-boundary undercount to begin with. It
  // still defers here (no mamQueryStates/conversationCoverage seeded), which
  // is the correct conservative behavior — the exact-count path (real
  // coverage + archive rows) is exercised in chatStore.archiveUnread.test.ts.
  it('the pointer resolves at the true position across a multi-page background walk; the count defers without proven coverage', async () => {
    const cid = 'juliet@capulet.example'
    const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min))
    function timedMsg(id: string, stanzaId: string, ts: Date): Message {
      return { ...msg(id, stanzaId), timestamp: ts }
    }

    // Non-active, non-resident conversation with a pending deep pointer
    // (new-device sync: no local read state yet). Seeded with a distinguishing
    // nonzero stale count — NOT equal to either the old page-scoped undercount
    // (9) or the true full-walk total (19) — so a broken defer gate that
    // commits a derived count instead of returning early fails loudly.
    seedConversation(cid, { unreadCount: 8 })
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
    chatStore.getState().mergeMAMMessages(cid, backwardPage, { first: 's-ptr' }, false, 'backward')

    // Pointer resolved at p0 (forward-only sync is unconditional and
    // unaffected by the archive-derived count).
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('p0')

    // The archive-derived recount runs (fire-and-forget) but defers: no
    // mamQueryStates/conversationCoverage were seeded, so coverage down to
    // the new floor is not proven. The count stays at its last trusted value
    // (8) rather than either the old page-scoped undercount (9) or a snap to
    // the true total (19) it cannot yet prove.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(8)
    expect(chatStore.getState().conversations.get(cid)?.unreadCount).toBe(8)
  })

  // NOTE: this test does NOT isolate the active-conversation guard. This
  // conversation has no coverage record/mamQueryStates seeded, so
  // the coverage gate alone makes `recomputeUnreadForConversation` defer
  // regardless of `activeConversationId`. The dedicated, genuinely isolating
  // test for that guard lives in chatStore.archiveUnread.test.ts (the analogous
  // room test is "does not touch the active room (activation owns its counts)"),
  // which seeds real coverage so the guard is the only thing standing between
  // the seeded count and a different derived one. What this test actually proves:
  // a stale recompute that settles after external state changes mid-flight
  // (conversation becomes active, count is set to a fresh value) does not clobber
  // that fresher state, here via the still-unproven coverage gate.
  it('a stale in-flight recount that settles after the conversation becomes active does not clobber the fresher count', async () => {
    const cid = 'juliet@capulet.example'
    const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min))
    function timedMsg(id: string, stanzaId: string, ts: Date): Message {
      return { ...msg(id, stanzaId), timestamp: ts }
    }

    seedConversation(cid, { unreadCount: 0 })
    chatStore.getState().applyRemoteDisplayed(cid, 's-ptr')

    const page = [timedMsg('p0', 's-ptr', t(41)), timedMsg('p1', 'sp1', t(42))]
    // Cache read resolves AFTER the conversation becomes active: gate it.
    let releaseCache: (msgs: Message[]) => void
    vi.mocked(messageCache.getMessages).mockReturnValueOnce(
      new Promise<Message[]>((resolve) => { releaseCache = resolve })
    )
    chatStore.getState().mergeMAMMessages(cid, page, { first: 's-ptr' }, false, 'backward')
    // The pointer resolves synchronously, but the count is no longer
    // written synchronously from this page — the archive-derived recount is
    // still pending on the gated cache read below, so the count is untouched.
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('p0')
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(0)

    // User opens the conversation before the cache read lands. No coverage
    // record or mamQueryStates is seeded anywhere in this test, so the
    // pending recompute defers at the coverage gate once it resumes below —
    // regardless of activeConversationId. Seeded to a distinguishing NONZERO
    // value (5), not 0, so "still 5 after the stale cache read lands" isn't a
    // trivial 0-to-0 no-op.
    chatStore.setState({ activeConversationId: cid })
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { ...newMeta.get(cid)!, unreadCount: 5 })
      return { conversationMeta: newMeta }
    })
    releaseCache!([...page, timedMsg('f0', 'sf0', t(51))])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(5)

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
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m1') })

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
    expect(meta?.readPointer?.identity.messageId).toBe('m5')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })
})

describe('chatStore.markAsRead — read-pointer advance for XEP-0490 sync', () => {
  beforeEach(() => {
    _clearAllViewportEvidenceForTesting()
    chatStore.getState().reset()
  })

  // At the live edge the newest loaded message IS the true newest; clearing the
  // badge means the user caught up to it, so the read pointer must advance for the
  // MDS publisher (which watches the read pointer) to sync the marker.
  it('advances the read pointer to the newest loaded message when at the live edge', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    seedConversation(cid, { unreadCount: 2, readPointer: pointerAt('m1') })
    chatStore.getState().setActiveConversation(cid)
    reportChatViewport(cid, 'at-edge')

    chatStore.getState().markAsRead(cid)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.identity.messageId).toBe('m3')
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(0)
  })

  // Slid up into history: the badge still clears (the user acknowledged the
  // conversation) but the pointer must stay put so MDS never publishes a read
  // position past messages the user has not seen.
  it('does NOT advance the read pointer when the window is slid up into history', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    seedConversation(cid, { unreadCount: 2, readPointer: pointerAt('m1') })
    chatStore.getState().setActiveConversation(cid)
    reportChatViewport(cid, 'at-edge')
    chatStore.setState((state) => {
      const newEdge = new Map(state.windowAtLiveEdge)
      newEdge.set(cid, false)
      return { windowAtLiveEdge: newEdge }
    })

    chatStore.getState().markAsRead(cid)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m1')
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(0)
  })

  it('does NOT advance the read pointer when the viewport is away from the live edge', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3')])
    seedConversation(cid, { unreadCount: 2, readPointer: pointerAt('m1') })
    chatStore.getState().setActiveConversation(cid)
    reportChatViewport(cid, 'away')

    chatStore.getState().markAsRead(cid)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m1')
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
    seedConversation(cid, { unreadCount: 2, readPointer: pointerAt('m1') })

    chatStore.getState().setActiveConversation(cid)

    // Divider derived at m2 (first unread after m1) and stored in the session map.
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toEqual({ id:'m2' })
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm2' })
    // The metadata entry carries NO divider field.
    expect('firstNewMessageRow' in (chatStore.getState().conversationMeta.get(cid) as object)).toBe(false)
  })

  it('deactivating a conversation deletes its marker (switching to another conversation)', () => {
    const cidA = 'juliet@capulet.example'
    const cidB = 'romeo@montague.example'

    // Seed conversation A with one read message and one unread message.
    seedMessages(cidA, [msg('a1', 'sa1'), msg('a2', 'sa2')])
    seedConversation(cidA, { unreadCount: 1, readPointer: pointerAt('a1') })
    // Seed conversation B with no unread so its activation sets no marker.
    seedConversation(cidB, { unreadCount: 0 })
    seedMessages(cidB, [msg('b1', 'sb1')])

    // Activate A — should park the divider at a2.
    chatStore.getState().setActiveConversation(cidA)
    expect(chatStore.getState().firstNewMessageMarkers.get(cidA)).toEqual({ id:'a2' })

    // Switching to B must delete A's marker (the deactivate branch).
    chatStore.getState().setActiveConversation(cidB)
    expect(chatStore.getState().firstNewMessageMarkers.get(cidA)).toBeUndefined()
    // B has no unread, so it should not gain a marker either.
    expect(chatStore.getState().firstNewMessageMarkers.get(cidB)).toBeUndefined()
  })

  it('never writes the divider to persisted storage', () => {
    const cid = 'juliet@capulet.example'
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedConversation(cid, { unreadCount: 1, readPointer: pointerAt('m1') })
    chatStore.getState().setActiveConversation(cid)
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toEqual({ id:'m2' })

    // Whatever the persist middleware wrote must not mention the divider.
    const dump = JSON.stringify(localStorage)
    expect(dump.includes('firstNewMessageRow')).toBe(false)
    expect(dump.includes('firstNewMessageMarkers')).toBe(false)
  })
})

describe('chatStore.applyRemoteDisplayed — late marker advances the ACTIVE read state and carries the line with it', () => {
  beforeEach(() => chatStore.getState().reset())

  // Reproduces the fresh-session seed race: the conversation is activated before the async MDS
  // seed lands, so the marker arrives while the conversation is already active. The marker still
  // advances the read pointer, but the divider remains the landmark placed for this visit.
  it('keeps firstNewMessageMarkers when a late marker reaches the newest message', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedMessages(cid, messages)

    // Post-activation state: local read stale at m2, divider parked at m3 (first unread),
    // conversation is the active one. No pending marker yet (seed hasn't landed).
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m2') })
    chatStore.setState((state) => {
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.set(cid, { id: 'm3' })
      return { firstNewMessageMarkers: newMarkers, activeConversationId: cid }
    })

    // The MDS seed lands late: the other device had read to s4 (the last message).
    chatStore.getState().applyRemoteDisplayed(cid, 's4')

    // Read position advanced to m4 …
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m4')
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm3' })
  })

  it('does NOT recompute the divider for a non-active conversation (it is derived fresh on activation)', () => {
    const cid = 'juliet@capulet.example'
    const messages = [msg('m1', 's1'), msg('m2', 's2'), msg('m3', 's3'), msg('m4', 's4')]
    seedMessages(cid, messages)

    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m2') })
    chatStore.setState((state) => {
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.set(cid, { id: 'm3' })
      // Some OTHER conversation is active, not cid.
      return { firstNewMessageMarkers: newMarkers, activeConversationId: 'romeo@montague.example' }
    })

    chatStore.getState().applyRemoteDisplayed(cid, 's4')

    // Read position still advances (forward-only sync is unconditional) …
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m4')
    // … but the session divider for the inactive conversation is left untouched;
    // it is recomputed the next time the conversation is activated.
    expect(chatStore.getState().firstNewMessageMarkers.get(cid)).toEqual({ id:'m3' })
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
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's4' })

    await chatStore.getState().activateConversation(cid)

    // The pending marker is resolved at activation, advancing the read position.
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m4')
    // So the divider reflects the synced read (m4 is the last message → nothing new),
    // NOT the stale 'm3' it would show if the marker resolved after onActivate.
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toBeUndefined()
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
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's3' })

    await chatStore.getState().activateConversation(cid)
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')

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
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')
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
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's3' })

    await chatStore.getState().activateConversation(cid)
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')

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
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m4')
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
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m1'), pendingRemoteDisplayedStanzaId: 's9' })

    await chatStore.getState().activateConversation(cid)
    // Unresolvable → stash survives, pointer untouched.
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m1')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s9')

    await chatStore.getState().activateConversation(null)

    // The archive healed since (catch-up landed): the marker's message is loadable now.
    seedMessages(cid, [...early, timed('m9', 's9', 9)])

    await chatStore.getState().activateConversation(cid)
    // The gate must allow the retry (the marker was never actually folded).
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m9')
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
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt('m2'), pendingRemoteDisplayedStanzaId: 's5' })
    // The IndexedDB slice around the stale pointer contains the marker's message (m5).
    const aroundSlice = [
      timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3),
      timed('m4', 's4', 4), timed('m5', 's5', 5), timed('m6', 's6', 6),
    ]
    vi.mocked(messageCache.getMessagesAround).mockResolvedValueOnce(aroundSlice)

    await chatStore.getState().activateConversation(cid)

    // The retried fold advances the pointer to the synced position…
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m5')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    // …and the divider derives from it, not from the stale local pointer (m2 → 'm3').
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm6' })
  })

  // A divider derived while a pending marker is still UNRESOLVED is provisional.
  // The UI renders it muted until the pending position is resolved.
  it('flags the divider provisional while the pending marker is unresolved, confirmed once it resolves', async () => {
    const cid = 'provisional@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const messages = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m4', 's4', 4)]
    seedMessages(cid, messages)
    seedConversation(cid, {
      unreadCount: 0,
      readPointer: pointerIn(messages, 'm2'),
      pendingRemoteDisplayedStanzaId: 's0',
    })

    await chatStore.getState().activateConversation(cid)

    // Divider derived from the local pointer, but the synced position is unknown → provisional.
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm3' })
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(true)

    // The marker's message arrives (merge): it sits BEHIND the pointer → clear-pending.
    // The divider is untouched but now confirmed.
    chatStore.getState().applyRemoteDisplayed(cid, 's0', [timed('m0', 's0', 0), ...messages])
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm3' })
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(false)
  })

  it('a divider derived with no pending marker is never provisional', async () => {
    const cid = 'confirmed@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const messages = [timed('m1', 's1', 1), timed('m2', 's2', 2)]
    seedMessages(cid, messages)
    seedConversation(cid, { unreadCount: 0, readPointer: pointerIn(messages, 'm1') })

    await chatStore.getState().activateConversation(cid)

    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm2' })
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

  it('moves the line past what the other device had already read', async () => {
    // The marker is evidence of reading, not navigation: the other device read through m4,
    // so leaving the line at m3 would label as new two messages the user has already seen.
    const cid = 'resolve-ahead@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    // m4 is NOT loaded at activation (deep gap) — the marker for s4 can only stash.
    const loaded = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m5', 's5', 5)]
    seedMessages(cid, loaded)
    seedConversation(cid, {
      unreadCount: 0,
      readPointer: pointerIn(loaded, 'm2'),
      pendingRemoteDisplayedStanzaId: 's4',
    })

    await chatStore.getState().activateConversation(cid)
    // Provisional divider from the stale local pointer (m2 → m3).
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm3' })
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(true)

    const full = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m4', 's4', 4), timed('m5', 's5', 5)]
    chatStore.getState().applyRemoteDisplayed(cid, 's4', full)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m4')
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm5' })
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(false)
  })

  it('does not resurrect a cleared divider when a pending marker resolves ahead', async () => {
    const cid = 'resolve-after-clear@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const loaded = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3), timed('m5', 's5', 5)]
    seedMessages(cid, loaded)
    seedConversation(cid, {
      unreadCount: 0,
      readPointer: pointerIn(loaded, 'm2'),
      pendingRemoteDisplayedStanzaId: 's4',
    })

    await chatStore.getState().activateConversation(cid)
    chatStore.getState().clearFirstNewMessageId(cid)
    chatStore.getState().applyRemoteDisplayed(cid, 's4', [...loaded, timed('m4', 's4', 4)])

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m4')
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toBeUndefined()
  })

  it('keeps the divider when the marker resolves at the newest message', async () => {
    const cid = 'resolve-erase@capulet.example'
    const t = (n: number) => new Date(`2026-01-01T00:0${n}:00Z`)
    const timed = (id: string, stanzaId: string, n: number): Message => ({ ...msg(id, stanzaId), timestamp: t(n) })
    const loaded = [timed('m1', 's1', 1), timed('m2', 's2', 2), timed('m3', 's3', 3)]
    seedMessages(cid, loaded)
    seedConversation(cid, {
      unreadCount: 0,
      readPointer: pointerIn(loaded, 'm1'),
      pendingRemoteDisplayedStanzaId: 's9',
    })

    await chatStore.getState().activateConversation(cid)
    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm2' })
    expect(chatSelectors.firstNewMessageIsProvisionalFor(cid)(chatStore.getState())).toBe(true)

    // The other device read everything: the marker resolves at the newest message.
    chatStore.getState().applyRemoteDisplayed(cid, 's9', [...loaded, timed('m9', 's9', 9)])

    expect(chatSelectors.firstNewMessageRowFor(cid)(chatStore.getState())).toEqual({ id: 'm2' })
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
    seedConversation(cid, { unreadCount: 0 })
  }

  const archive = () => Array.from({ length: 10 }, (_, i) => msg(`m${i + 1}`, `s${i + 1}`))

  it('keeps the pointer at the marker instead of snapping to newest', () => {
    seedFreshConversation()
    chatStore.getState().applyRemoteDisplayed(cid, 's3') // nothing loaded → pending
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s3')

    chatStore.getState().mergeMAMMessages(cid, archive(), {}, true, 'forward')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.readPointer?.identity.messageId).toBe('m3')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  // The count is no longer written synchronously from this page — it is
  // archive-derived (recomputeUnreadForConversation, triggered fire-and-forget
  // by both the forward-merge and the marker-resolution paths). With no
  // mamQueryStates/conversationCoverage seeded, that derivation defers, so the
  // count stays at its seeded stale value (5, chosen to differ from this
  // page's own tally of 7) rather than snapping to this page's own tally (7).
  // The exact-outcome equivalent (real coverage + archive rows) lives in
  // chatStore.archiveUnread.test.ts.
  it('the marker resolves the pointer; the count defers without proven coverage', async () => {
    seedFreshConversation()
    // Override the shared fresh-instance seed (0) with a distinguishing
    // nonzero stale count — NOT equal to the page's own tally of 7 unread
    // messages (m4..m10) — so a broken defer gate that commits the derived
    // count instead of returning early fails loudly. Other tests in this
    // describe block rely on seedFreshConversation()'s own 0, so this
    // override is local to this test only.
    chatStore.setState((state) => {
      const newMeta = new Map(state.conversationMeta)
      newMeta.set(cid, { ...state.conversationMeta.get(cid)!, unreadCount: 5 })
      const newConvs = new Map(state.conversations)
      newConvs.set(cid, { ...state.conversations.get(cid)!, unreadCount: 5 })
      return { conversationMeta: newMeta, conversations: newConvs }
    })
    chatStore.getState().applyRemoteDisplayed(cid, 's3')

    chatStore.getState().mergeMAMMessages(cid, archive(), {}, true, 'forward')

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(5)
  })

  // Control for the test above, inverted. It no longer asserts that
  // WITHOUT a pending marker the merge snapped the pointer to 'm10' — proving
  // the marker check was what suppressed the snap. That snap is deleted, so the
  // control now proves the complement, which is the stronger statement: the
  // merge writes no pointer for anyone, so the 'm3' the sibling test observes
  // can only have come from the marker fold.
  it('a fresh conversation with no remote marker gets no pointer from the merge either', () => {
    seedFreshConversation()

    chatStore.getState().mergeMAMMessages(cid, archive(), {}, true, 'forward')

    const meta = chatStore.getState().conversationMeta.get(cid)
    expect(meta?.unreadCount).toBe(0)
    expect(meta?.readPointer).toBeUndefined()
  })
})

describe('chatStore.discardPurgedRemoteDisplayed', () => {
  const cid = 'juliet@capulet.example'

  beforeEach(() => {
    chatStore.getState().reset()
    _resetPurgedMarkersForTesting()
  })

  it('drops the proven-purged marker without moving the pointer and ignores its reconnect replay', () => {
    const messages = [msg('m1', 's1'), msg('m2', 's2')]
    seedMessages(cid, messages)
    seedConversation(cid, {
      unreadCount: 7,
      readPointer: pointerAt('m2'),
      pendingRemoteDisplayedStanzaId: 's-purged',
    })
    const pointerBefore = chatStore.getState().conversationMeta.get(cid)?.readPointer

    chatStore.getState().discardPurgedRemoteDisplayed(cid, 's-purged')

    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    expect(chatStore.getState().conversations.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer).toEqual(pointerBefore)

    chatStore.getState().applyRemoteDisplayed(cid, 's-purged')
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
  })

  it('does not discard a newer marker that replaced the proof target', () => {
    seedConversation(cid, {
      unreadCount: 0,
      readPointer: pointerAt('m1'),
      pendingRemoteDisplayedStanzaId: 's-newer',
    })

    chatStore.getState().discardPurgedRemoteDisplayed(cid, 's-purged')

    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s-newer')
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
    seedConversation(cid, { unreadCount: 0, readPointer: pointerAt(seenMessageId) })
  }

  it('advances the read pointer when the window is focused', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(true)
    chatStore.getState().advanceReadPointer(cid, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')
  })

  it('does not advance the read pointer while the window is unfocused', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(false)
    chatStore.getState().advanceReadPointer(cid, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m1')
  })

  it('leaves the combined conversations map untouched while unfocused', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(false)
    chatStore.getState().advanceReadPointer(cid, { id: 'm3' })
    expect(chatStore.getState().conversations.get(cid)?.readPointer?.identity.messageId).toBe('m1')
  })

  it('resumes advancing once the window regains focus', () => {
    seedWithPointer('m1')
    connectionStore.getState().setWindowVisible(false)
    chatStore.getState().advanceReadPointer(cid, { id: 'm2' })
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m1')
    connectionStore.getState().setWindowVisible(true)
    chatStore.getState().advanceReadPointer(cid, { id: 'm3' })
    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m3')
  })
})
