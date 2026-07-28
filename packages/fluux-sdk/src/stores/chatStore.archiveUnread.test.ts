/**
 * Task 7 (PR B) — chatStore.recomputeUnreadForConversation: archive-derived
 * unread, coverage-gated, latest-wins, mentionsCount-preserving, divider-
 * rederiving.
 *
 * Unlike chatStore.test.ts / chatStore.mds.test.ts, this file does NOT fully
 * mock `../utils/messageCache` — `countUnreadInArchive` and
 * `resolveArchivePosition` run for REAL against fake-indexeddb (wrapped in
 * `vi.fn(actual)` only so the latest-wins test can control resolution order
 * for one call). Everything else in messageCache is the real implementation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { chatStore } from './chatStore'
import { noteTransient, removeTransient, transientIdentity, transientAliases, clearTransientScope, transientCounts, type ScopeKey } from './shared/transientUnread'
import { _resetStorageScopeForTesting, getStorageScopeJid, setStorageScopeJid } from '../utils/storageScope'
import type { Message, Conversation } from '../core/types'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    // Real by default; wrapped so individual tests can control resolution
    // order (vi.fn.mockImplementationOnce) without disabling the real cursor.
    getMessages: vi.fn(actual.getMessages),
    countUnreadInArchive: vi.fn(actual.countUnreadInArchive),
  }
})
import * as messageCache from '../utils/messageCache'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const CID = 'carol@example.com'

function createConversation(id: string): Conversation {
  return { id, name: id, type: 'chat', unreadCount: 0 }
}

function archiveMsg(id: string, ts: number, overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id,
    conversationId: CID,
    from: CID,
    body: 'hi',
    timestamp: new Date(ts),
    isOutgoing: false,
    ...overrides,
  }
}

/** Mark the conversation caught-up-to-live with a coverage record whose bottom
 *  resolves to a REAL archived row at `bottomTs` (must be saved separately). */
function seedCoverage(bottomId: string): void {
  chatStore.setState((state) => {
    const mamQueryStates = new Map(state.mamQueryStates)
    mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
    const conversationCoverage = new Map(state.conversationCoverage)
    conversationCoverage.set(CID, { bottomId })
    return { mamQueryStates, conversationCoverage }
  })
}

function setMeta(patch: Record<string, unknown>): void {
  chatStore.setState((state) => {
    const meta = new Map(state.conversationMeta)
    meta.set(CID, { ...(meta.get(CID) ?? { unreadCount: 0 }), ...patch } as never)
    return { conversationMeta: meta }
  })
}

function scopeKey(): ScopeKey {
  return { accountScope: getStorageScopeJid() ?? '', kind: 'chat', entityId: CID }
}

describe('chatStore.recomputeUnreadForConversation — archive-derived unread (PR B)', () => {
  beforeEach(async () => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as unknown as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
    localStorageMock.clear()
    chatStore.getState().reset()
    chatStore.getState().addConversation(createConversation(CID))
    // mockClear() only resets call history, never the base implementation set
    // by vi.fn(actual.countUnreadInArchive) above, so it stays real by default.
    vi.mocked(messageCache.getMessages).mockClear()
    vi.mocked(messageCache.countUnreadInArchive).mockClear()
    // The transient overlay is a module-level singleton (never cleared on
    // deactivation by design) — reset it between tests explicitly.
    clearTransientScope(getStorageScopeJid() ?? '')
  })

  // ---------------------------------------------------------------------
  // exact
  // ---------------------------------------------------------------------

  it('backgrounded deep pointer with proven coverage derives an exact count from the archive', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      archiveMsg('u2', 1002),
      archiveMsg('u3', 1003),
    ])
    setMeta({
      unreadCount: 99, // stale — must be overwritten by the exact derivation
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(3)
  })

  it('a migrated pointer with no archiveOrderKey over-counts same-millisecond rows rather than reporting zero', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      // Same millisecond as the pointer's own message — an unresolved pointer
      // key must NOT exclude this (over-count is the safe direction).
      archiveMsg('sibling', 1000),
    ])
    setMeta({
      unreadCount: 0,
      // Legacy/migrated shape: no archiveOrderKey at all.
      readPointer: { messageId: 'p0', timestamp: new Date(1000) },
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // At-or-after-TIMESTAMP semantics: with the pointer's key unresolved,
    // EVERY row at its exact millisecond counts as "after" it — including the
    // pointer's own message ('p0') — not just the genuinely-new 'sibling'.
    // Over-counting by the same-ms set is the documented safe direction
    // (messageCache.ts's countUnreadInArchive); asserting the naive "just the
    // sibling" value of 1 here would be the wrong, under-counting reading.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
  })

  // ---------------------------------------------------------------------
  // trigger: cold-start rehydrate
  // ---------------------------------------------------------------------

  it('cold-start rehydrate schedules a recount for every restored conversation', async () => {
    localStorage.setItem(
      'xmpp-chat-storage',
      JSON.stringify({
        state: {
          conversationEntities: [[CID, { id: CID, name: CID, type: 'chat' }]],
          conversationMeta: [[CID, { unreadCount: 3, readPointer: { messageId: 'p0', timestamp: 1000, archiveOrderKey: { kind: 'chat', id: 'p0' } } }]],
          conversations: [[CID, { id: CID, name: CID, type: 'chat', unreadCount: 3 }]],
          archivedConversations: [],
        },
      })
    )
    const original = chatStore.getState().recomputeUnreadForConversation
    const spy = vi.fn(original)
    chatStore.setState({ recomputeUnreadForConversation: spy })

    await chatStore.persist.rehydrate()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(spy).toHaveBeenCalledWith(CID)
    // Restore the un-wrapped action so later tests aren't left with a spy.
    chatStore.setState({ recomputeUnreadForConversation: original })
  })

  // ---------------------------------------------------------------------
  // trigger: forward MAM merge past the floor
  // ---------------------------------------------------------------------

  it('a forward MAM merge into a non-active conversation with new messages triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } } })
    chatStore.setState({ activeConversationId: 'someone-else@example.com' })
    const original = chatStore.getState().recomputeUnreadForConversation
    const spy = vi.fn(original)
    chatStore.setState({ recomputeUnreadForConversation: spy })

    chatStore.getState().mergeMAMMessages(
      CID,
      [archiveMsg('u1', 1001)],
      { first: 'u1' },
      true,
      'forward'
    )

    expect(spy).toHaveBeenCalledWith(CID)
    chatStore.setState({ recomputeUnreadForConversation: original })
  })

  it('a pointerless conversation with trusted unread keeps its count and pointer during a forward merge', () => {
    setMeta({ unreadCount: 4, readPointer: undefined })
    chatStore.setState({ activeConversationId: 'someone-else@example.com' })

    chatStore.getState().mergeMAMMessages(
      CID,
      [archiveMsg('u1', 1001)],
      { first: 'u1' },
      true,
      'forward'
    )

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(4)
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()
    expect(chatStore.getState().conversations.get(CID)?.readPointer).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // trigger: pointer advance / inbound remote marker
  // ---------------------------------------------------------------------

  it('a remote marker advancing a non-active conversation triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } } })
    chatStore.setState({ activeConversationId: 'someone-else@example.com' })
    const original = chatStore.getState().recomputeUnreadForConversation
    const spy = vi.fn(original)
    chatStore.setState({ recomputeUnreadForConversation: spy })

    chatStore.getState().applyRemoteDisplayed(CID, 's-u1', [
      archiveMsg('p0', 1000, { stanzaId: 's-p0' }),
      archiveMsg('u1', 1001, { stanzaId: 's-u1' }),
    ])

    expect(spy).toHaveBeenCalledWith(CID)
    chatStore.setState({ recomputeUnreadForConversation: original })
  })

  // FIX 3 (final whole-branch review): resolveRemoteDisplayed resolves
  // 'advanced-with-divider' — not 'advanced' — for the ACTIVE conversation,
  // and that branch used to be exempted from triggering a recount on the
  // premise that an active entity's count was "already zero" (true before
  // FIX 2). A spy-only assertion ("was recomputeUnreadForConversation
  // called?") would pass even if the guard inside still bailed early — the
  // real regression is that the count never actually changes — so this test
  // drives a REAL archive derivation (fake-indexeddb) end to end and asserts
  // the committed number, not just that a call happened.
  it('a remote marker advancing the ACTIVE conversation re-derives its unread count', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000, { stanzaId: 's-p0' }),
      archiveMsg('u1', 1001, { stanzaId: 's-u1' }),
      archiveMsg('u2', 1002, { stanzaId: 's-u2' }),
      archiveMsg('u3', 1003, { stanzaId: 's-u3' }),
    ])
    // Seeded stale and DISTINCT from the true derived value (3) below — a
    // seed-0/assert-0 (or seed-3/assert-3 with no advance) fixture couldn't
    // tell a real recompute from a no-op.
    setMeta({
      unreadCount: 99,
      readPointer: { messageId: 'anchor', timestamp: new Date(500), archiveOrderKey: { kind: 'chat', id: 'anchor' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState({ activeConversationId: CID })

    const messages = [
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000, { stanzaId: 's-p0' }),
      archiveMsg('u1', 1001, { stanzaId: 's-u1' }),
      archiveMsg('u2', 1002, { stanzaId: 's-u2' }),
      archiveMsg('u3', 1003, { stanzaId: 's-u3' }),
    ]
    // Another device's XEP-0490 marker advances the read position to p0
    // WHILE this conversation is active.
    chatStore.getState().applyRemoteDisplayed(CID, 's-p0', messages)

    // Still active throughout — this is not a "became inactive" race. The
    // pointer advance and divider reposition are applied synchronously inside
    // applyRemoteDisplayed's own `set()` call, so these don't need to wait for
    // the fire-and-forget recount below.
    expect(chatStore.getState().activeConversationId).toBe(CID)
    // The pointer advanced (resolveRemoteDisplayed's job, unaffected by this fix).
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('p0')
    // The divider was positioned at the first message after the new pointer.
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('u1')
    // FIX 3: the count is re-derived from the archive (u1, u2, u3), not left
    // at the stale 99 a guard that still exempted the active entity would
    // produce. The recount is fire-and-forget (cache read, coverage resolve,
    // and countUnreadInArchive are all real async calls against
    // fake-indexeddb) — poll for the derived value instead of guessing a tick
    // count, which under full-suite load can resolve before the recount lands.
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    }, { timeout: 2000 })
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(3)
  })

  // ---------------------------------------------------------------------
  // deferred
  // ---------------------------------------------------------------------

  it('un-migrated legacy read state defers even when the archive is fully caught up and covered', async () => {
    // Drive the real #1081 migration path: persist a legacy lastSeenMessageId
    // that the cache does NOT hold, so migrateReadPointer resolves to
    // undefined and the conversation stays registered as un-migrated.
    localStorage.setItem(
      'xmpp-chat-storage',
      JSON.stringify({
        state: {
          conversationEntities: [[CID, { id: CID, name: CID, type: 'chat' }]],
          conversationMeta: [[CID, { unreadCount: 0, lastSeenMessageId: 'ghost-not-in-cache' }]],
          conversations: [[CID, { id: CID, name: CID, type: 'chat', unreadCount: 0, lastSeenMessageId: 'ghost-not-in-cache' }]],
          archivedConversations: [],
        },
      })
    )
    await chatStore.persist.rehydrate()
    // Let the fire-and-forget migration attempt (and the cold-start recount
    // trigger) run to completion; migration cannot resolve 'ghost-not-in-cache'.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()

    // Overwrite to a known sentinel right before the controlled call under
    // test, so any earlier background churn can't be mistaken for THIS
    // assertion. A readPointer AND a genuinely resolvable, caught-up coverage
    // record are ALSO seeded (the activation-races-the-backfill case: the
    // entry can still be registered in unmigratedLegacyReadState after a
    // readPointer already exists from other activity) so this test is
    // specific to hasUnmigratedLegacyReadState — without a real pointer +
    // proven coverage, pointerlessDefers or the coverage gate would
    // independently defer too, and a broken hasUnmigratedLegacyReadState
    // check would go undetected.
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
    seedCoverage('anchor-stanza')
    setMeta({ unreadCount: 9, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } } })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(9)
  })

  it('a pointerless entity with a nonzero persisted count defers rather than trusting a zero derivation', async () => {
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    setMeta({
      unreadCount: 4,
      readPointer: undefined,
      historyFloor: new Date(0), // ensure a floor exists so !floor isn't what defers this
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(4)
  })

  // The reviewer's control (requirement 1): the legacy pass runs — and its
  // OWN pointer-advance guard fires (an outgoing message moves the pointer,
  // exactly the effect Task 7 must keep) — and its would-be COUNT differs
  // sharply from the persisted one (2 vs 5). The persisted value must survive
  // untouched because coverage is not proven. This is the strong form of the
  // control: it is not enough for legacy.readPointer to stay unchanged (which
  // would make "discard the count" trivially true by construction); the
  // pointer must actually move while the count still does not commit.
  it('CRITICAL: not caught up defers, and the persisted count survives even though recomputeCountsFromPointer ran and moved the pointer', async () => {
    await messageCache.saveMessages([
      archiveMsg('p0', 1000),
      archiveMsg('out1', 1001, { isOutgoing: true }), // the user replied — advances the pointer
      archiveMsg('u1', 1002),
      archiveMsg('u2', 1003),
    ])
    setMeta({
      unreadCount: 5, // the persisted/trusted value
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    // Deliberately NOT caught up (default mamQueryStates), and no coverage record.

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // The legacy guard pass DID run and DID advance the pointer to 'out1'
    // (the reply) — that pointer-advance guard behavior is kept. Its own
    // count over the post-out1 slice (u1, u2) would be 2, not 5 — that
    // would-be count is discarded; the persisted 5 survives.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('out1')
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(5)
  })

  it('a missing coverage record defers (not-yet-covered is not the same as nothing to worry about)', async () => {
    await messageCache.saveMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 7,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    chatStore.setState((state) => {
      const mamQueryStates = new Map(state.mamQueryStates)
      mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
      // No conversationCoverage record at all.
      return { mamQueryStates }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(7)
  })

  it('an unresolvable coverage bottom defers AND invalidates the stale record', async () => {
    await messageCache.saveMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 6,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    // bottomId names an archive stanza-id that was never saved — unresolvable.
    seedCoverage('nonexistent-stanza-id')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()
  })

  // FIX 4 (final whole-branch review, Minor (r)): the coverage gate's fourth
  // branch — a RESOLVED coverage bottom that sits ABOVE (i.e. strictly after)
  // the floor, meaning proven-contiguous coverage does not reach all the way
  // down to the floor — was the only one of the gate's four branches with no
  // test anywhere in the suite. A sign flip here (`< 0` instead of `> 0`)
  // would silently under-count: exactly the unrecoverable direction. Seeded
  // count is a distinguishing 8, not 0, so a broken gate that proceeds to
  // derive+commit the real (different) archive count is caught.
  it('a resolved coverage bottom sitting above the floor defers (coverage does not reach the floor)', async () => {
    await messageCache.saveMessages([
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      // The coverage record's bottom — proven contiguous from here to the
      // live edge, but NEWER than the floor (p0 @ 1000): the region between
      // the floor and this point is an unproven gap.
      archiveMsg('gap-anchor', 1500, { stanzaId: 'gap-anchor-stanza' }),
      archiveMsg('u2', 2000),
    ])
    setMeta({
      unreadCount: 8, // trusted — must survive untouched
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('gap-anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // If the gate proceeded (the bug), it would derive u1+gap-anchor+u2 = 3
    // and overwrite the trusted count — a silent under-count from the
    // reader's point of view (real unread could sit in the unproven gap).
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(8)
  })

  // ---------------------------------------------------------------------
  // FIX 5 (final whole-branch review): same-millisecond live-arrival ordering
  // ---------------------------------------------------------------------

  // appendLive used to append live arrivals in ARRIVAL order (never sorted),
  // while the archive (and every OTHER resident-array construction path —
  // loadOlderSlice/loadNewerSlice/latestSlice) orders same-millisecond chat
  // rows by id. The viewport observer advances the read pointer by RESIDENT
  // INDEX (`advanceReadPointer` → `onMessageSeen`'s forward-only guard), so an
  // unsorted resident array can let that guard make the WRONG forward/no-op
  // decision, landing the stored pointer on the wrong message and skewing the
  // later archive-derived count. 'z-msg' arrives FIRST (wall-clock) but
  // archive-sorts AFTER 'a-msg' (id tie-break) — arrival order deliberately
  // disagrees with archive order, the exact case the fix reconciles.
  it('two same-millisecond live arrivals land in archive order, so the viewport-advance pointer and derived count are both correct', async () => {
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    seedCoverage('anchor-stanza')
    chatStore.setState({ activeConversationId: CID })

    const T = 5000
    chatStore.getState().addMessage(archiveMsg('z-msg', T))
    // Viewport observer reports 'z-msg' seen while it is the only resident message.
    chatStore.getState().advanceReadPointer(CID, 'z-msg')
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('z-msg')

    // A same-millisecond sibling arrives live, SECOND.
    chatStore.getState().addMessage(archiveMsg('a-msg', T))
    // The resident array must be in ARCHIVE order (id-ascending), not arrival
    // order — the load-bearing invariant messageTimeline.test.ts pins at the
    // pure-function level; here it is asserted through the real store.
    expect(chatStore.getState().messages.get(CID)?.map((m) => m.id)).toEqual(['a-msg', 'z-msg'])

    // The observer reports the sibling seen too, as it scrolls into view.
    // 'a-msg' now sits BEFORE 'z-msg' in the (correctly sorted) resident
    // array, so the forward-only guard must NOT move the pointer backward
    // past the already-confirmed 'z-msg'.
    chatStore.getState().advanceReadPointer(CID, 'a-msg')
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('z-msg')

    // Settle: the user navigates away, and the archive-derived recompute runs.
    chatStore.setState({ activeConversationId: null })
    await chatStore.getState().recomputeUnreadForConversation(CID)

    // Both same-millisecond messages were genuinely seen (both reported via
    // advanceReadPointer) — the derived count must be 0. Reverting the sort
    // lets 'a-msg' get appended last, wrongly advances the pointer TO
    // 'a-msg', and 'z-msg' — already-confirmed-seen — then archive-sorts
    // AFTER it and gets wrongly counted as unread.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
  })

  // ---------------------------------------------------------------------
  // FIX 6 (final whole-branch review): active-but-scrolled-up noLocalStore
  // arrivals must be recorded in the overlay
  // ---------------------------------------------------------------------

  // noteAsTransient used to be gated on isUnseenIncomingMessage's COARSE
  // isActive && windowVisible check (no viewport dimension), so an active,
  // focused, but SCROLLED-UP conversation (never reported at-edge) looked
  // "seen" to it — a noLocalStore arrival there took the live +1 (correct at
  // the time, via onMessageReceived's OWN gate, which does track
  // viewportAtLiveEdge) but was never noted in the overlay. Since a
  // noLocalStore message is NEVER archived, the next EXACT recount — deriving
  // purely from the archive — silently dropped its contribution back to 0.
  it('an active-but-scrolled-up noLocalStore arrival is recorded in the overlay and survives an exact recount', async () => {
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    setMeta({
      unreadCount: 0,
      readPointer: { messageId: 'anchor', timestamp: new Date(500), archiveOrderKey: { kind: 'chat', id: 'anchor' } },
    })
    seedCoverage('anchor-stanza')
    // Active + focused (default windowVisible), but viewportAtLiveEdge is
    // never reported — stays at its conservative 'unknown' default, i.e.
    // scrolled up / not at the live edge.
    chatStore.setState({ activeConversationId: CID })

    // Untyped literal (not `: Message`) deliberately — `noLocalStore` is an
    // internal augmentation (`message-internal.ts`), not on the public
    // `Message` type; an explicit annotation here would trip TS's excess-
    // property check, same as the existing noLocalStore fixtures in
    // chatStore.test.ts.
    const ephemeral = {
      type: 'chat' as const,
      id: 'ephemeral-1',
      conversationId: CID,
      from: CID,
      body: 'Ephemeral',
      timestamp: new Date(1000),
      isOutgoing: false,
      noLocalStore: true,
    }
    chatStore.getState().addMessage(ephemeral)

    // The live +1 fires (correct at the time — onMessageReceived's own gate
    // refused the pointer advance since viewportAtLiveEdge isn't 'at-edge').
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    // FIX 6: also recorded in the overlay — a noLocalStore message's ONLY
    // durable representation, since it is never archived.
    expect(
      transientCounts({ accountScope: getStorageScopeJid() ?? '', kind: 'chat', entityId: CID }, undefined).unread
    ).toBe(1)

    // Settle: the conversation deactivates and an EXACT archive recount runs
    // (coverage is proven, a real readPointer exists — this is not a defer).
    chatStore.setState({ activeConversationId: null })
    await chatStore.getState().recomputeUnreadForConversation(CID)

    // The real archive has NO row for the ephemeral message (it was never
    // saved) — without FIX 6 the overlay would be empty here too, and the
    // count would silently drop to 0.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
  })

  // ---------------------------------------------------------------------
  // latest-wins
  // ---------------------------------------------------------------------

  it('latest-wins: a slow recount started before a fast one must not overwrite the fast one', async () => {
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
    setMeta({
      unreadCount: 0,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseSlow!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve }))
      .mockImplementationOnce(async () => ({ unread: 2 }))

    const slow = chatStore.getState().recomputeUnreadForConversation(CID) // A
    await vi.waitFor(() => expect(releaseSlow).toBeDefined())
    const fast = chatStore.getState().recomputeUnreadForConversation(CID) // B
    await fast

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

    releaseSlow({ unread: 55 })
    await slow

    // A (slow) resolved LAST but must be discarded — B's result stands.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
  })

  it('discards a recount whose archive snapshot predates a live arrival', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 5,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCount = resolve })
    )

    const stale = chatStore.getState().recomputeUnreadForConversation(CID)
    await vi.waitFor(() => expect(releaseCount).toBeDefined())

    chatStore.getState().addMessage(archiveMsg('live', 2000))
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)

    releaseCount({ unread: 3 })
    await stale

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(6)
  })

  it('rejects a guard-pass pointer write after the account scope changes', async () => {
    const accountA = 'account-a@example.com'
    const accountB = 'account-b@example.com'

    setStorageScopeJid(accountA)
    chatStore.getState().switchAccount(accountA)
    chatStore.getState().addConversation(createConversation(CID))

    let releaseSlice!: (messages: Message[]) => void
    vi.mocked(messageCache.getMessages).mockImplementationOnce(
      () => new Promise((resolve) => { releaseSlice = resolve })
    )

    const stale = chatStore.getState().recomputeUnreadForConversation(CID)
    await vi.waitFor(() => expect(releaseSlice).toBeDefined())

    setStorageScopeJid(accountB)
    chatStore.getState().switchAccount(accountB)
    chatStore.getState().addConversation(createConversation(CID))
    const accountBPointer = {
      messageId: 'account-b-pointer',
      timestamp: new Date(100),
      archiveOrderKey: { kind: 'chat' as const, id: 'account-b-pointer' },
    }
    chatStore.setState((state) => {
      const conversationMeta = new Map(state.conversationMeta)
      conversationMeta.set(CID, { ...conversationMeta.get(CID)!, unreadCount: 7, readPointer: accountBPointer })
      const conversations = new Map(state.conversations)
      conversations.set(CID, { ...conversations.get(CID)!, unreadCount: 7, readPointer: accountBPointer })
      const messages = new Map(state.messages)
      messages.set(CID, [archiveMsg('account-b-current', 150)])
      return { conversationMeta, conversations, messages }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    releaseSlice([archiveMsg('account-a-outgoing', 1000, { isOutgoing: true })])
    await stale

    expect(getStorageScopeJid()).toBe(accountB)
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(7)
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBe(accountBPointer)
    expect(chatStore.getState().conversations.get(CID)?.readPointer).toBe(accountBPointer)
  })

  // final-fix-2: the race the re-reviewer flagged. An `allowActive` recompute
  // (this fix's new advanceReadPointer trigger runs one) can be in flight
  // while a DIRECT writer — onMessageReceived's own live-edge convergence,
  // which commits straight to conversationMeta and does NOT bump
  // chatRecountVersion — advances the pointer and writes a fresh, correct
  // count in the meantime. chatRecountVersion's "latest-wins" guard above
  // only orders a recompute against ANOTHER recompute; it does nothing here.
  // Re-reading the pointer at commit time (added by this fix) is what closes
  // this specific gap.
  it('a stale allowActive recompute does not clobber a pointer/count that moved via a direct write while it awaited the archive read', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
    ])
    setMeta({
      unreadCount: 5, // stale — the slow recompute below would derive 1 (u1) from THIS pointer
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState({ activeConversationId: CID })

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCount = resolve })
    )

    // The allowActive recompute this fix's advanceReadPointer trigger would
    // schedule — started while the pointer is still 'p0'.
    const slow = chatStore.getState().recomputeUnreadForConversation(CID, { allowActive: true })
    await vi.waitFor(() => expect(releaseCount).toBeDefined())

    // While the slow recompute awaits the archive count, a DIRECT write (NOT
    // going through recomputeUnreadForConversation, exactly like
    // onMessageReceived's live-edge commit) advances the pointer to the
    // newest message and writes the correct, fresh count.
    chatStore.setState((state) => {
      const meta = new Map(state.conversationMeta)
      meta.set(CID, {
        ...meta.get(CID)!,
        unreadCount: 0,
        readPointer: { messageId: 'u1', timestamp: new Date(1001), archiveOrderKey: { kind: 'chat', id: 'u1' } },
      })
      return { conversationMeta: meta }
    })

    // The slow recompute's archive read finally resolves — computed against
    // the OLD pointer ('p0'), it would derive 1 (u1 is still unread from p0's
    // point of view) if it committed.
    releaseCount({ unread: 1 })
    await slow

    // The direct write's fresher, correct state survives untouched — the
    // stale derivation (computed against a pointer that moved since) must not
    // clobber it.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('u1')
  })

  // ---------------------------------------------------------------------
  // divider rederivation
  // ---------------------------------------------------------------------

  it('a remote advance rederives the divider to the new boundary', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
    ])
    setMeta({
      unreadCount: 99,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // A stale marker left over from a previous activation.
    chatStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(CID, 'stale-marker-id')
      return { firstNewMessageMarkers: markers }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('u1')
  })

  it('deletes the divider marker when the derived count is zero', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 99,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(CID, 'stale-marker-id')
      return { firstNewMessageMarkers: markers }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    expect(chatStore.getState().firstNewMessageMarkers.has(CID)).toBe(false)
  })

  // ---------------------------------------------------------------------
  // mentionsCount is NEVER written (three outcomes)
  // ---------------------------------------------------------------------

  describe('mentionsCount is left unchanged by every outcome', () => {
    // ConversationMetadata has no real mentionsCount field (conversations
    // don't track mentions) — seed one anyway to prove the derivation always
    // spreads the existing meta rather than reconstructing it, so ANY field
    // it doesn't explicitly own (mentionsCount included) survives verbatim.
    const SEEDED_MENTIONS = 7

    it('exact outcome', async () => {
      await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      // Seeded unreadCount (5) deliberately differs from the true exact
      // derivation (0, since nothing is archived after the pointer) — this
      // forces the commit path to actually run (a no-op "nothing changed"
      // skip would let a broken mentionsCount-dropping write hide undetected).
      setMeta({
        unreadCount: 5,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('deferred outcome', async () => {
      setMeta({ unreadCount: 3, mentionsCount: SEEDED_MENTIONS, readPointer: { messageId: 'p0', timestamp: new Date(1000) } })
      // Not caught up — defers.

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('unavailable outcome', async () => {
      await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 3,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')
      vi.mocked(messageCache.countUnreadInArchive).mockResolvedValueOnce(null)

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
      // unavailable also leaves unreadCount untouched.
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    })
  })

  // ---------------------------------------------------------------------
  // transient overlay
  // ---------------------------------------------------------------------

  it('the transient overlay is summed into the committed unread count', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      archiveMsg('u2', 1002),
    ])
    setMeta({
      unreadCount: 0,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // One never-archived (noLocalStore) message, after the pointer.
    const key = scopeKey()
    noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'ephemeral-1' }, 'chat'), transientAliases({ id: 'ephemeral-1' }, 'chat'))

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // 2 archived (u1, u2) + 1 transient = 3.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  // ---------------------------------------------------------------------
  // Store-level projection tests (overlay mutation -> recompute -> projection)
  // ---------------------------------------------------------------------

  describe('store-level projection: overlay mutations correctly move the committed count', () => {
    // No archived unread in any of these — the committed count is driven
    // purely by the transient overlay, so the assertions are unambiguous.
    beforeEach(async () => {
      await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 0,
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')
    })

    it('re-noting the same logical message through a new alias does not increment the visible count twice', async () => {
      const key = scopeKey()
      const r1 = noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      expect(r1.added).toBe(true)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      // Same logical message re-noted (plain alias registration, nothing new).
      const r2 = noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      expect(r2.added).toBe(false)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1) // NOT 2
    })

    it('retracting the only transient unread moves the visible count 1 -> 0', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      const removed = removeTransient(key, transientIdentity({ id: 'm1' }, 'chat'))
      expect(removed.removed).toBe(true)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    })

    it('removing one of two transient unread messages moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      noteTransient(key, { position: { timestamp: 1600 } }, transientIdentity({ id: 'm2' }, 'chat'), transientAliases({ id: 'm2' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

      removeTransient(key, transientIdentity({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })

    it('a bridging alias that coalesces two separately-counted transient entries moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, 'origin-key-O', ['origin-key-O'])
      noteTransient(key, { position: { timestamp: 1500 } }, 'stanza-key-S', ['stanza-key-S'])
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

      // A copy carrying BOTH tiers bridges them: added:false, requiresRecount:true.
      const r = noteTransient(key, { position: { timestamp: 1500 } }, 'stanza-key-S', ['stanza-key-S', 'origin-key-O'])
      expect(r).toEqual({ added: false, requiresRecount: true })
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })

    it('an overlay change while not caught up stays conservative and does not clear the trusted count', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      // Coverage proof is lost (e.g. a fresh reconnect before this session's
      // catch-up has re-run) — subsequent recomputes must defer.
      chatStore.setState((state) => {
        const mamQueryStates = new Map(state.mamQueryStates)
        mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: false })
        return { mamQueryStates }
      })
      noteTransient(key, { position: { timestamp: 1600 } }, transientIdentity({ id: 'm2' }, 'chat'), transientAliases({ id: 'm2' }, 'chat'))

      await chatStore.getState().recomputeUnreadForConversation(CID)

      // Deferred: the trusted count (1) survives — NOT recomputed to 2, and
      // NOT cleared to 0 either.
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })
  })

  // ---------------------------------------------------------------------
  // final-fix-2: the previous fix wave removed onActivate's force-zero for
  // the active entity but added no replacement trigger — a pointer that
  // advances (Task 11 live-edge convergence) or an entity that deactivates
  // never re-derived the COUNT to match. These tests pin the two triggers
  // this fix adds: advanceReadPointer and setActiveConversation's
  // deactivation branch. Every seed below is a NONZERO value distinct from
  // the correct outcome, per the reviewer's "seven hollow tests" finding —
  // a seed-0/assert-0 fixture cannot distinguish a real recompute from a
  // no-op.
  // ---------------------------------------------------------------------

  describe('final-fix-2: pointer-advance and deactivation triggers re-derive the count', () => {
    it('acceptance scenario 5: live-edge convergence (pointer reaches the newest message while active+focused) converges the count to 0', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      const m2 = archiveMsg('m2', 1001)
      const m3 = archiveMsg('m3', 1002)
      await messageCache.saveMessages([anchor, m1, m2, m3])
      setMeta({
        unreadCount: 5, // stale — distinct from the correct 0 derived below
        readPointer: { messageId: 'anchor', timestamp: new Date(500), archiveOrderKey: { kind: 'chat', id: 'anchor' } },
      })
      seedCoverage('anchor-stanza')
      // Active + focused (default windowVisible), with the full history
      // resident — this is the "scrolled to the bottom" precondition.
      chatStore.setState({
        activeConversationId: CID,
        messages: new Map([[CID, [anchor, m1, m2, m3]]]),
      })

      // The viewport observer reports the NEWEST resident message seen —
      // reaching the live edge.
      chatStore.getState().advanceReadPointer(CID, 'm3')
      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('m3')

      // Poll for the fire-and-forget archive recount (this fix's trigger) to
      // settle, rather than guessing a tick count.
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
      }, { timeout: 2000 })

      // Still active throughout — this is scenario 5's store half: "the
      // sidebar becomes 0" while active and focused, no deactivation involved.
      expect(chatStore.getState().activeConversationId).toBe(CID)
    })

    it('a partial pointer advance (not to the newest) decreases the count to the correct remaining number', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      const m2 = archiveMsg('m2', 1001)
      const m3 = archiveMsg('m3', 1002)
      await messageCache.saveMessages([anchor, m1, m2, m3])
      setMeta({
        unreadCount: 5, // stale — distinct from BOTH 0 and the correct 2
        readPointer: { messageId: 'anchor', timestamp: new Date(500), archiveOrderKey: { kind: 'chat', id: 'anchor' } },
      })
      seedCoverage('anchor-stanza')
      chatStore.setState({
        activeConversationId: CID,
        messages: new Map([[CID, [anchor, m1, m2, m3]]]),
      })

      // The viewport observer reports 'm1' seen — the user scrolled PARTWAY,
      // not to the bottom. 'm2' and 'm3' remain genuinely unread.
      chatStore.getState().advanceReadPointer(CID, 'm1')
      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.messageId).toBe('m1')

      // Exactly 2 remaining (m2, m3) — neither the stale 5 (trigger missing)
      // nor a wrongly-zeroed 0 (a broken floor/pointer would over-clear).
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
      }, { timeout: 2000 })
    })

    it('reading a conversation to the bottom then deactivating reconciles the stale badge instead of leaving it stuck', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      await messageCache.saveMessages([anchor, m1])
      // The pointer already sits at the newest message (as if the user had
      // read to the bottom through some OTHER path than advanceReadPointer —
      // isolating the deactivation trigger from the advance trigger tested
      // above) while unreadCount is stale.
      setMeta({
        unreadCount: 5, // stale — distinct from the correct 0
        readPointer: { messageId: 'm1', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'm1' } },
      })
      seedCoverage('anchor-stanza')
      chatStore.getState().addConversation(createConversation('someone-else@example.com'))
      chatStore.setState({ activeConversationId: CID })

      // Switch away — exercises setActiveConversation's deactivation branch,
      // NOT advanceReadPointer (never called in this test).
      chatStore.getState().setActiveConversation('someone-else@example.com')
      expect(chatStore.getState().activeConversationId).toBe('someone-else@example.com')

      await vi.waitFor(() => {
        expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
      }, { timeout: 2000 })
    })

    // final-fix-3: the test above (fully read, pointer already at the
    // newest message) converges to 0 — but 0 is ALSO exactly what a naive
    // "just write 0 on deactivation" implementation would produce, which is
    // precisely the force-zero behaviour this whole PR is walking back from
    // onActivate. A seed-5/assert-0 fixture where the pointer sits at the
    // newest message cannot tell "recount ran and correctly derived 0" apart
    // from "deactivation force-zeroed it" — the two are indistinguishable
    // here. This test isolates the deactivation trigger with the pointer at
    // a NON-newest message, so genuinely unread messages remain and the true
    // archive-derived answer is a nonzero remainder: a force-zero
    // implementation would produce 0 (wrong), while "trigger missing" would
    // leave the stale 5 (also wrong) — only a real recount lands on 2.
    it('deactivating with the pointer short of the newest message reconciles to the true nonzero remainder, not zero', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const p0 = archiveMsg('p0', 1000)
      const u1 = archiveMsg('u1', 1001)
      const u2 = archiveMsg('u2', 1002)
      await messageCache.saveMessages([anchor, p0, u1, u2])
      // The pointer is seeded directly at p0 — NOT the newest message — so u1
      // and u2 are genuinely still unread. This isolates the deactivation
      // trigger from the advance trigger (advanceReadPointer is never called
      // here), same as the fully-read sibling test above.
      setMeta({
        unreadCount: 5, // stale — distinct from BOTH 0 (naive force-zero) and the correct 2
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'chat', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')
      chatStore.getState().addConversation(createConversation('someone-else@example.com'))
      chatStore.setState({ activeConversationId: CID })

      // Switch away — exercises setActiveConversation's deactivation branch,
      // NOT advanceReadPointer (never called in this test).
      chatStore.getState().setActiveConversation('someone-else@example.com')
      expect(chatStore.getState().activeConversationId).toBe('someone-else@example.com')

      // The true archive-derived remainder (u1, u2) — not the stale 5 and not
      // a force-zeroed 0.
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
      }, { timeout: 2000 })
    })
  })
})
