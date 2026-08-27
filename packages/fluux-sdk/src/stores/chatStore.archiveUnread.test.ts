/**
 * chatStore.recomputeUnreadForConversation: archive-derived
 * unread, coverage-gated, latest-wins, mentionsCount-preserving, divider-
 * rederiving.
 *
 * Unlike chatStore.test.ts / chatStore.internal.mds.test.ts, this file does NOT fully
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
import { _resetForTesting as _resetThrottledStorageForTesting } from './shared/throttledStorage'
import { readRecountDeferrals, resetRecountDeferralsForTesting } from './shared/recountDiagnostics'
import type { Message, Conversation } from '../core/types'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    // Real by default; wrapped so individual tests can control resolution
    // order (vi.fn.mockImplementationOnce) without disabling the real cursor.
    getMessages: vi.fn(actual.getMessages),
    countUnreadInArchive: vi.fn(actual.countUnreadInArchive),
    saveMessageWithResult: vi.fn(actual.saveMessageWithResult),
    saveMessages: vi.fn(actual.saveMessages),
  }
})
import * as messageCache from '../utils/messageCache'
import { makeCacheOrderKey, type ExactPosition } from './shared/readState'

const countUnreadInArchiveImplementation = vi.mocked(messageCache.countUnreadInArchive).getMockImplementation()!
const saveMessageWithResultImplementation = vi.mocked(messageCache.saveMessageWithResult).getMockImplementation()!
const saveMessagesImplementation = vi.mocked(messageCache.saveMessages).getMockImplementation()!

/**
 * A transient entry's position.
 *
 * These tests exercise identity, aliasing, coalescing and counting — never
 * tie-breaks — so every fixture shares ONE key. Same-millisecond fixtures then
 * compare equal, exactly as they did when they carried no key at all, while
 * `ExactPosition` still holds: a transient entry is always noted from a real
 * message, so in production its tie-break always resolves (#1173).
 */
const FIXTURE_TIEBREAK = makeCacheOrderKey({ from: 'fixture@x', id: 'fixture' }, 'chat')
const posAt = (timestamp: number): ExactPosition => ({ role: 'exact', timestamp, tiebreak: FIXTURE_TIEBREAK })

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
    resetRecountDeferralsForTesting()
    chatStore.getState().addConversation(createConversation(CID))
    // Reset queued one-shot implementations as well as call history so a
    // deliberately failing race test cannot contaminate the next test.
    vi.mocked(messageCache.getMessages).mockClear()
    vi.mocked(messageCache.countUnreadInArchive).mockReset()
    vi.mocked(messageCache.countUnreadInArchive).mockImplementation(countUnreadInArchiveImplementation)
    vi.mocked(messageCache.saveMessageWithResult).mockReset()
    vi.mocked(messageCache.saveMessageWithResult).mockImplementation(saveMessageWithResultImplementation)
    vi.mocked(messageCache.saveMessages).mockReset()
    vi.mocked(messageCache.saveMessages).mockImplementation(saveMessagesImplementation)
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
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(3)
  })

  it('a migrated pointer with no tiebreak over-counts same-millisecond rows rather than reporting zero', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      // Same millisecond as the pointer's own message — an unresolved pointer
      // key must NOT exclude this (over-count is the safe direction).
      archiveMsg('sibling', 1000),
    ])
    setMeta({
      unreadCount: 0,
      // Legacy/migrated shape: no tiebreak at all.
      readPointer: { order: { role: 'floor', timestamp: new Date(1000).getTime() }, identity: { state: 'local', messageId: 'p0' } },
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
    // Assert the KEY, not just that a recount was scheduled. The fixture above
    // is a real on-disk blob written by a build BEFORE the tie-break's on-disk
    // rename, so it carries the historical name `archiveOrderKey` — which
    // `deserializeReadPointer` still reads through its documented fallback. A
    // fixture whose key name no reader recognises still restores a pointer,
    // just a KEYLESS one, so a test that only checks the recount stays green
    // while the hydrated position silently degrades to the
    // at-or-after-timestamp fallback. This assertion is what makes that failure
    // loud: the `id` is reconstructed from `messageId`, so a keyed hydration is
    // only possible when the stored name was actually recognised.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.order).toEqual({
      role: 'exact',
      timestamp: 1000,
      tiebreak: { kind: 'chat', id: 'p0' },
    })
    // Restore the un-wrapped action so later tests aren't left with a spy.
    chatStore.setState({ recomputeUnreadForConversation: original })
  })

  // ---------------------------------------------------------------------
  // trigger: forward MAM merge past the floor
  // ---------------------------------------------------------------------

  it('a forward MAM merge into a non-active conversation with new messages triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } } })
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
    setMeta({ unreadCount: 0, readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } } })
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

  // resolveRemoteDisplayed resolves
  // 'advanced-active' — not 'advanced' — for the ACTIVE conversation,
  // and that branch used to be exempted from triggering a recount on the
  // premise that an active entity's count was "already zero"
  // A spy-only assertion ("was recomputeUnreadForConversation
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
      readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'chat', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
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
    // pointer advance is applied synchronously inside applyRemoteDisplayed's own
    // `set()` call and the divider is left untouched, so neither assertion needs
    // to wait for the fire-and-forget recount below.
    expect(chatStore.getState().activeConversationId).toBe(CID)
    // The pointer advanced (resolveRemoteDisplayed's job, unaffected by this fix).
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('p0')
    // No divider appears. Placing the line belongs to activation; an inbound marker on an
    // already-open view moves the pointer and the count, never the landmark.
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBeUndefined()
    // The count is re-derived from the archive (u1, u2, u3), not left
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

  /**
   * Drive the real #1081 migration path: persist a legacy `lastSeenMessageId`
   * the cache does NOT hold, so `migrateReadPointer` resolves to undefined and
   * the conversation stays registered as un-migrated for the whole session.
   * `persistedUnread` is what the blob (and therefore the restored meta) carries.
   */
  async function rehydrateWithStuckLegacyReadState(persistedUnread: number): Promise<void> {
    localStorage.setItem(
      'xmpp-chat-storage',
      JSON.stringify({
        state: {
          conversationEntities: [[CID, { id: CID, name: CID, type: 'chat' }]],
          conversationMeta: [[CID, { unreadCount: persistedUnread, lastSeenMessageId: 'ghost-not-in-cache' }]],
          conversations: [[CID, { id: CID, name: CID, type: 'chat', unreadCount: persistedUnread, lastSeenMessageId: 'ghost-not-in-cache' }]],
          archivedConversations: [],
        },
      })
    )
    await chatStore.persist.rehydrate()
    // Let the fire-and-forget migration attempt (and the cold-start recount
    // trigger) run to completion; migration cannot resolve 'ghost-not-in-cache',
    // so the entry is left in `pending` — the permanently-stuck shape.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()
  }

  // This no longer asserts the count FROZE at its
  // persisted value while the legacy migration stayed unresolved. That
  // stand-down (`hasUnmigratedLegacyReadState`) is deleted — it was introduced
  // against a recount that could WRITE the pointer, and D6 deleted that pass, so
  // all it did afterwards was suppress a count that IS grounded in a real
  // pointer, for the rest of the session.
  //
  // Nothing else in the chain can produce the asserted 2: the pointer is real
  // (so the `pointerlessDefers` check does not fire and `computeFloor` has a floor),
  // `pendingRemoteDisplayedStanzaId` is unset, the conversation is not active,
  // and coverage is caught-up AND resolvable to a row BELOW the floor. Any
  // surviving defer would leave the sharply different persisted 7 in place.
  it('un-migrated legacy read state no longer freezes the count once a real pointer exists', async () => {
    await rehydrateWithStuckLegacyReadState(0)

    // The activation-races-the-backfill case: the entry is still registered in
    // unmigratedLegacyReadState, but a direct path (activation, markAsRead,
    // XEP-0490) has since written a REAL pointer. Overwritten right before the
    // controlled call so earlier background churn can't be mistaken for this
    // assertion.
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      archiveMsg('u2', 1002),
    ])
    seedCoverage('anchor-stanza')
    setMeta({ unreadCount: 7, readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } } })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // u1 and u2 are the only rows strictly after the pointer — a reversal of
    // the stale 7, not a restatement of it.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(2)
    // The recount still never touches the read position it counted against.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('p0')
  })

  // Residual state (a): pointerless, migration outstanding, persisted
  // count 0. The derivation counts from `historyFloor`, which for a pre-#1081
  // conversation is either absent (deferred by `if (!floor) return`) or stamped
  // at its first post-upgrade re-add — never BEHIND the legacy read position —
  // so the commit can only RAISE the badge. Seeded 0, asserted 3: never 0 → 0.
  //
  // The only defer that could apply here is the one being removed:
  // `pointerlessDefers` needs a nonzero persisted count (it is 0), the floor
  // exists, coverage is caught-up and resolves below the floor, and the
  // conversation is not active.
  it('un-migrated legacy read state with a zero persisted count now raises the badge from the archive', async () => {
    await rehydrateWithStuckLegacyReadState(0)

    await messageCache.saveMessages([
      archiveMsg('anchor', 400, { stanzaId: 'anchor-stanza' }),
      archiveMsg('m1', 1000),
      archiveMsg('m2', 1001),
      archiveMsg('m3', 1002),
    ])
    seedCoverage('anchor-stanza')
    setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: new Date(500) })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(3)
    // Still pointerless: raising the badge must not invent a read position.
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()
  })

  // Control: retiring the legacy stand-down must NOT open the pointerless
  // path it used to overlap with. Same stuck-migration fixture as the two tests
  // above — the only difference is the nonzero persisted count, which is exactly
  // what `pointerlessDefers` exists to protect. Neutralise that check and this
  // lands the archive-derived 3 over the trusted 6.
  it('un-migrated legacy read state with a NONZERO persisted count still defers via pointerlessDefers', async () => {
    await rehydrateWithStuckLegacyReadState(6)

    await messageCache.saveMessages([
      archiveMsg('anchor', 400, { stanzaId: 'anchor-stanza' }),
      archiveMsg('m1', 1000),
      archiveMsg('m2', 1001),
      archiveMsg('m3', 1002),
    ])
    seedCoverage('anchor-stanza')
    setMeta({ unreadCount: 6, readPointer: undefined, historyFloor: new Date(500) })

    // Cleared right before the controlled call so the rehydrate fixture's own
    // cold-start recount — which defers at this same guard — cannot be mistaken
    // for the deferral this test asserts.
    resetRecountDeferralsForTesting()
    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    // Assert the mechanism, not just the outcome: pointerlessDefers must stop
    // the derivation before it ever reads the archive, not merely produce a
    // count that happens to match the seed.
    expect(vi.mocked(messageCache.countUnreadInArchive)).not.toHaveBeenCalled()
    // #1174 + #1214: proves the `pointerless-defer` reason is still emitted,
    // and still reachable, now that the duplicate guard is gone. (It does NOT
    // pin the number of call sites: a guard that returns emits once whether
    // there is one copy or two. What makes the single site matter is that the
    // reason now has exactly one origin, so a recorded defer is unambiguous.)
    expect(readRecountDeferrals()['chat:pointerless-defer']).toBe(1)
  })

  // #1174: this used to seed `historyFloor: new Date(0)` against a coverage
  // anchor at t=500, which put the coverage bottom ABOVE the floor — so
  // `isAfterBoundary` deferred the recount before `pointerlessDefers` could
  // matter, and the surviving count proved the coverage gate had fired, not
  // the guard. The coverage-gate branch it was really exercising already has
  // its own unambiguous test ("a resolved coverage bottom sitting above the
  // floor defers"), so this one is repaired to test what it names: the bottom
  // (400) now sits BELOW the floor (500), leaving the guard as the ONLY thing
  // that can stand this recount down. Distinct from the sibling above, which
  // reaches the same guard through the stuck-legacy-migration path rather than
  // a plain pointerless conversation.
  it('a pointerless conversation with a nonzero persisted count defers at pointerlessDefers, not at the coverage gate', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 400, { stanzaId: 'anchor-stanza' }),
      archiveMsg('m1', 1000),
      archiveMsg('m2', 1001),
      archiveMsg('m3', 1002),
    ])
    seedCoverage('anchor-stanza')
    setMeta({ unreadCount: 6, readPointer: undefined, historyFloor: new Date(500) })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    // Assert the mechanism, not just the outcome: the guard must stop the
    // derivation before it ever reads the archive, not merely produce a count
    // that happens to match the seed.
    expect(vi.mocked(messageCache.countUnreadInArchive)).not.toHaveBeenCalled()
    // #1174 + #1214: proves the `pointerless-defer` reason is still emitted,
    // and still reachable, now that the duplicate guard is gone. (It does NOT
    // pin the number of call sites: a guard that returns emits once whether
    // there is one copy or two. What makes the single site matter is that the
    // reason now has exactly one origin, so a recorded defer is unambiguous.)
    expect(readRecountDeferrals()['chat:pointerless-defer']).toBe(1)
  })

  // The reviewer's control.
  // It used to prove "the count is discarded" by showing the legacy guard pass
  // moved the POINTER while the count stayed put; that pass no longer exists,
  // so the control is rebuilt around the surviving mechanism: coverage IS
  // seeded and resolvable and the archive IS populated, so the ONLY thing
  // deferring this recount is the caught-up gate. Remove that gate and the
  // derivation lands a sharply different 2 (u1, u2 after 'p0'; the outgoing
  // 'out1' never counts) over the trusted 5 — so 5 surviving is evidence, not
  // an absence of activity. The pointer assertion is the D6 half: an outgoing
  // message sitting in the counted range must NOT drag the read position onto
  // itself any more.
  it('CRITICAL: not caught up defers, the persisted count survives, and the recount never moves the pointer onto an outgoing message', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('out1', 1001, { isOutgoing: true }), // the user replied from another device
      archiveMsg('u1', 1002),
      archiveMsg('u2', 1003),
    ])
    setMeta({
      unreadCount: 5, // the persisted/trusted value
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    // Coverage IS proven and resolvable — but mamQueryStates is left at its
    // default (NOT caught up to live), so the caught-up gate is the single
    // reason this recount defers.
    chatStore.setState((state) => {
      const conversationCoverage = new Map(state.conversationCoverage)
      conversationCoverage.set(CID, { bottomId: 'anchor-stanza' })
      return { conversationCoverage }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('p0')
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(5)
  })

  it('a missing coverage record defers (not-yet-covered is not the same as nothing to worry about)', async () => {
    await messageCache.saveMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 7,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
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
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    // bottomId names an archive stanza-id that was never saved — unresolvable.
    seedCoverage('nonexistent-stanza-id')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()
    expect(readRecountDeferrals()['chat:coverage-unresolvable']).toBe(1)
  })

  // The coverage gate's fourth
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
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('gap-anchor-stanza')

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // If the gate proceeded (the bug), it would derive u1+gap-anchor+u2 = 3
    // and overwrite the trusted count — a silent under-count from the
    // reader's point of view (real unread could sit in the unproven gap).
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(8)
  })

  // ---------------------------------------------------------------------
  // Same-millisecond live-arrival ordering
  // ---------------------------------------------------------------------

  // appendLive used to append live arrivals in ARRIVAL order (never sorted),
  // while the archive (and every OTHER resident-array construction path —
  // loadOlderSlice/loadNewerSlice/latestSlice) orders same-millisecond chat
  // rows by id. The viewport observer advances the read pointer by RESIDENT
  // INDEX (`advanceReadPointer` → `onMessageSeen`'s forward-only guard), so an
  // unsorted resident array can let that guard make the WRONG forward/no-op
  // decision, landing the stored pointer on the wrong message and skewing the
  // later archive-derived count. 'z-msg' arrives FIRST (wall-clock) but
  // cache-sorts AFTER 'a-msg' (id tie-break) — arrival order deliberately
  // disagrees with cache order, the exact case the fix reconciles.
  it('two same-millisecond live arrivals land in cache order, so the viewport-advance pointer and derived count are both correct', async () => {
    await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    seedCoverage('anchor-stanza')
    chatStore.setState({ activeConversationId: CID })

    const T = 5000
    chatStore.getState().addMessage(archiveMsg('z-msg', T))
    // Viewport observer reports 'z-msg' seen while it is the only resident message.
    chatStore.getState().advanceReadPointer(CID, 'z-msg')
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('z-msg')

    // A same-millisecond sibling arrives live, SECOND.
    chatStore.getState().addMessage(archiveMsg('a-msg', T))
    // The resident array must be in CACHE order (id-ascending), not arrival
    // order — the load-bearing invariant messageTimeline.test.ts pins at the
    // pure-function level; here it is asserted through the real store.
    expect(chatStore.getState().messages.get(CID)?.map((m) => m.id)).toEqual(['a-msg', 'z-msg'])

    // The observer reports the sibling seen too, as it scrolls into view.
    // 'a-msg' now sits BEFORE 'z-msg' in the (correctly sorted) resident
    // array, so the forward-only guard must NOT move the pointer backward
    // past the already-confirmed 'z-msg'.
    chatStore.getState().advanceReadPointer(CID, 'a-msg')
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('z-msg')

    // Settle: the user navigates away, and the archive-derived recompute runs.
    chatStore.setState({ activeConversationId: null })
    await chatStore.getState().recomputeUnreadForConversation(CID)

    // Both same-millisecond messages were genuinely seen (both reported via
    // advanceReadPointer) — the derived count must be 0. Reverting the sort
    // lets 'a-msg' get appended last, wrongly advances the pointer TO
    // 'a-msg', and 'z-msg' — already-confirmed-seen — then archive-sorts
    // AFTER it and gets wrongly counted as unread.
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    })
  })

  // ---------------------------------------------------------------------
  // Active-but-scrolled-up noLocalStore
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
      readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'chat', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
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
    // Also recorded in the overlay — a noLocalStore message's ONLY
    // durable representation, since it is never archived.
    expect(
      transientCounts({ accountScope: getStorageScopeJid() ?? '', kind: 'chat', entityId: CID }, undefined).unread
    ).toBe(1)

    // Settle: the conversation deactivates and an EXACT archive recount runs
    // (coverage is proven, a real readPointer exists — this is not a defer).
    chatStore.setState({ activeConversationId: null })
    await chatStore.getState().recomputeUnreadForConversation(CID)

    // The real archive has NO row for the ephemeral message (it was never
    // saved) — without the transient overlay the overlay would be empty here too, and the
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
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
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
    expect(readRecountDeferrals()['chat:recount-superseded']).toBe(1)
    expect(readRecountDeferrals()['chat:context-changed']).toBeUndefined()
  })

  it('holds an invalidated active recount until forward catch-up durably completes', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 5,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseCount = resolve }))
      .mockImplementationOnce(async () => ({ unread: 7 }))

    chatStore.setState({ activeConversationId: CID })
    const stale = chatStore.getState().recomputeUnreadForConversation(CID, { allowActive: true })
    await vi.waitFor(() => expect(releaseCount).toBeDefined())

    chatStore.getState().addMessage(archiveMsg('live', 2000))
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    chatStore.getState().mergeMAMMessages(
      CID,
      [archiveMsg('catchup-1', 2100)],
      { first: 'catchup-1', last: 'catchup-1' },
      false,
      'forward'
    )

    releaseCount({ unread: 3 })
    await stale
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(1)
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)

    chatStore.getState().mergeMAMMessages(
      CID,
      [archiveMsg('catchup-2', 2200)],
      { first: 'catchup-2', last: 'catchup-2' },
      true,
      'forward'
    )

    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(7)
    })
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(7)
    expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(2)
    expect(readRecountDeferrals()['chat:input-version-changed']).toBe(1)
    expect(readRecountDeferrals()['chat:context-changed']).toBeUndefined()
  })

  it('retains a failed live cache write in the unread recount overlay', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      ...Array.from({ length: 5 }, (_, index) => archiveMsg(`u${index + 1}`, 1100 + index)),
    ])
    setMeta({
      unreadCount: 5,
      readPointer: { order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState({ activeConversationId: CID })

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCount = resolve })
    )
    vi.mocked(messageCache.saveMessageWithResult).mockResolvedValueOnce(false)

    const stale = chatStore.getState().recomputeUnreadForConversation(CID, { allowActive: true })
    await vi.waitFor(() => expect(releaseCount).toBeDefined())
    chatStore.getState().addMessage(archiveMsg('live-write-failed', 2000))
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)

    releaseCount({ unread: 5 })
    await stale

    await vi.waitFor(() => {
      expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(2)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(6)
    })
    expect(transientCounts(scopeKey(), undefined).unread).toBe(1)
  })

  it('resumes a held active recount after a backward archive write commits', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('older', 700),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 5,
      readPointer: { order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState({ activeConversationId: CID })

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseCount = resolve }))
      .mockImplementationOnce(async () => ({ unread: 7 }))
    let releaseSave!: (committed: boolean) => void
    vi.mocked(messageCache.saveMessages).mockImplementationOnce(
      () => new Promise((resolve) => { releaseSave = resolve })
    )

    const stale = chatStore.getState().recomputeUnreadForConversation(CID, { allowActive: true })
    await vi.waitFor(() => expect(releaseCount).toBeDefined())
    chatStore.getState().mergeMAMMessages(
      CID,
      [archiveMsg('older', 700)],
      { first: 'older', last: 'older' },
      true,
      'backward'
    )
    releaseCount({ unread: 3 })
    await stale
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(1)
    releaseSave(true)

    await vi.waitFor(() => {
      expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(2)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(7)
    })
  })

  it('settles a live write when an unrelated conversation is deleted', async () => {
    const otherId = 'other@example.com'
    chatStore.getState().addConversation(createConversation(otherId))
    chatStore.setState({ activeConversationId: CID })
    let releaseSave!: (committed: boolean) => void
    vi.mocked(messageCache.saveMessageWithResult).mockImplementationOnce(
      () => new Promise((resolve) => { releaseSave = resolve })
    )

    chatStore.getState().addMessage(archiveMsg('pending-live', 2000))
    expect(transientCounts(scopeKey(), undefined).unread).toBe(1)

    chatStore.getState().deleteConversation(otherId)
    releaseSave(true)

    await vi.waitFor(() => {
      expect(transientCounts(scopeKey(), undefined).unread).toBe(0)
    })
  })

  // Was 'rejects a guard-pass pointer write after the account scope changes',
  // which blocked on the guard pass's cache read. That read is gone with the
  // guard pass, so the same invariant — a derivation computed under
  // one account must never commit into another's state — is now pinned on the
  // remaining await, the archive count. Nothing else about the recount context
  // changes across the swap here (no switchAccount, so the cache epoch, the
  // recount version, the input version and the pointer are all identical),
    // which makes the storage-scope term of `recountContextDeferral` the single
  // load-bearing guard: drop it and the account-A result of 55 overwrites 7.
  it('rejects a recount commit after the account scope changes', async () => {
    const accountA = 'account-a@example.com'
    const accountB = 'account-b@example.com'

    setStorageScopeJid(accountA)
    // Isolation, not decoration. `switchAccount` flushes the pending persist
    // window and REHYDRATES the new account from storage, and a rehydrated
    // conversation list schedules one archive recount per restored conversation
    // on a macrotask (`scheduleColdStartRecounts`). Left unbounded, that
    // deferred recount lands in the middle of the race this test measures: it
    // consumes the `countUnreadInArchive` mock armed below, and commits its own
    // archive-derived count over the seeded 7 — an intermittent `expected +0 to
    // be 7`. The seed for it is this suite's own `beforeEach` (reset +
    // addConversation), whose still-open persist window `switchAccount` flushes
    // and then migrates into account A. Drop that window and the blob it would
    // restore from, so the switch has nothing to rehydrate and schedules no
    // recount at all. The `toHaveBeenCalledTimes(1)` control below fails if this
    // ever stops holding.
    _resetThrottledStorageForTesting()
    localStorageMock.clear()
    chatStore.getState().switchAccount(accountA)
    // Deterministic proof the isolation held: account A rehydrated nothing, so
    // no cold-start recount was scheduled. Drop the two lines above and this
    // fails every run — the switch migrates the beforeEach conversation in.
    expect(localStorage.getItem(`xmpp-chat-storage:${accountA}`) ?? '').not.toContain(CID)
    chatStore.getState().addConversation(createConversation(CID))
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 7,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCount = resolve })
    )

    const stale = chatStore.getState().recomputeUnreadForConversation(CID)
    await vi.waitFor(() => expect(releaseCount).toBeDefined())

    // The account scope moves on while the archive read is in flight.
    setStorageScopeJid(accountB)

    releaseCount({ unread: 55 })
    await stale

    expect(getStorageScopeJid()).toBe(accountB)
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(7)
    expect(readRecountDeferrals()['chat:context-changed']).toBe(1)
    // Control for the isolation above: `stale` is the ONLY archive count this
    // test may produce. A second one means a deferred recount slipped in, which
    // is exactly how the seeded 7 used to get overwritten with a real 0.
    expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(1)
  })

  // An `allowActive` recompute (advanceReadPointer runs one) can be in flight
  // while a DIRECT writer — onMessageReceived's own live-edge convergence,
  // which commits straight to conversationMeta and does NOT bump
  // chatRecountVersion — advances the pointer and writes a fresh, correct
  // count in the meantime. chatRecountVersion's "latest-wins" guard above
  // only orders a recompute against ANOTHER recompute; it does nothing here.
  // Re-reading the pointer at commit time is what closes this gap.
  it('a stale allowActive recompute does not clobber a pointer/count that moved via a direct write while it awaited the archive read', async () => {
    await messageCache.saveMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
    ])
    setMeta({
      unreadCount: 5, // stale — the slow recompute below would derive 1 (u1) from THIS pointer
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
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
        readPointer: { order: { role: 'exact', timestamp: new Date(1001).getTime(), tiebreak: { kind: 'chat', id: 'u1' } }, identity: { state: 'local', messageId: 'u1' } },
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
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('u1')
    expect(readRecountDeferrals()['chat:pointer-changed']).toBe(1)
  })

  // ---------------------------------------------------------------------
  // divider rederivation
  // ---------------------------------------------------------------------

  // The rederivation scans the RESIDENT array now
  // (the guard pass's cache-window read went with the guard pass), so this
  // test drives the path that actually reaches it — an `allowActive` recount
  // on the ACTIVE conversation. That is the only path in production: a marker
  // survives only while an entity is active (deactivation deletes it), and
  // both allowActive triggers follow a pointer advance. The seeded marker is a
  // distinct stale id, so 'u1' can only come from a real rederivation.
  it('holds the ACTIVE entity\'s divider through a pointer advance, while the count re-derives', async () => {
    const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
    const p0 = archiveMsg('p0', 1000)
    const u1 = archiveMsg('u1', 1001)
    await messageCache.saveMessages([anchor, p0, u1])
    setMeta({
      unreadCount: 99,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // A stale marker left over from before the boundary moved, on the ACTIVE
    // conversation (the only entity that keeps both a marker and a resident
    // array).
    chatStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(CID, 'stale-marker-id')
      return {
        firstNewMessageMarkers: markers,
        activeConversationId: CID,
        messages: new Map([[CID, [anchor, p0, u1]]]),
      }
    })

    await chatStore.getState().recomputeUnreadForConversation(CID, { allowActive: true })

    // The line stays where this view opened. Re-deriving it from the advanced pointer would
    // walk it down the screen under the reader; only re-opening the view places it again.
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('stale-marker-id')
    // The count still re-derives (u1), rather than staying at the stale 99.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
  })

  it('keeps the ACTIVE conversation\'s divider when the pointer has caught up to the newest message', async () => {
    // Opening a conversation short enough to fit on screen: the viewport
    // reports the newest message immediately, the pointer lands past the
    // divider, and the allowActive recount that advance schedules used to
    // delete the divider a few milliseconds after it appeared.
    const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
    const p0 = archiveMsg('p0', 1000)
    const u1 = archiveMsg('u1', 1001)
    await messageCache.saveMessages([anchor, p0, u1])
    setMeta({
      unreadCount: 1,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState({
      activeConversationId: CID,
      messages: new Map([[CID, [anchor, p0, u1]]]),
    })
    // The divider activation parked on the first unread message.
    chatStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(CID, 'u1')
      return { firstNewMessageMarkers: markers }
    })

    chatStore.getState().advanceReadPointer(CID, 'u1')
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('u1')

    // The count converges (the advance's whole purpose) — but the divider the
    // reader is looking at survives. Clearing it belongs to read-through
    // scroll, Esc, mark-all-read, or deactivation.
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    }, { timeout: 2000 })
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('u1')
  })

  it('opening a short conversation keeps the divider the activation just derived', async () => {
    // End-to-end shape of the same bug, driven through setActiveConversation
    // rather than a pre-seeded marker.
    const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
    const p0 = archiveMsg('p0', 1000)
    const u1 = archiveMsg('u1', 1001)
    const resident = [anchor, p0, u1]
    await messageCache.saveMessages(resident)
    setMeta({
      unreadCount: 1,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState({ messages: new Map([[CID, resident]]) })

    chatStore.getState().setActiveConversation(CID)
    chatStore.setState((state) => {
      const messages = new Map(state.messages)
      messages.set(CID, resident)
      return { messages }
    })
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('u1')

    chatStore.getState().advanceReadPointer(CID, 'u1')
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    }, { timeout: 2000 })
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('u1')
  })

  // A BACKGROUND conversation with a RESIDENT array deliberately, so the
  // deletion is a real "nothing sits after the boundary" answer rather than the
  // vacuous one an empty slice always gives. Retiring a stale marker is the
  // background half of the rule the two tests above pin for the active half.
  it('deletes the divider marker when the derived count is zero', async () => {
    const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
    const p0 = archiveMsg('p0', 1000)
    await messageCache.saveMessages([anchor, p0])
    setMeta({
      unreadCount: 99,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    chatStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(CID, 'stale-marker-id')
      return {
        firstNewMessageMarkers: markers,
        activeConversationId: null,
        messages: new Map([[CID, [anchor, p0]]]),
      }
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
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('deferred outcome', async () => {
      setMeta({ unreadCount: 3, mentionsCount: SEEDED_MENTIONS, readPointer: { order: { role: 'floor', timestamp: new Date(1000).getTime() }, identity: { state: 'local', messageId: 'p0' } } })
      // Not caught up — defers.

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect((chatStore.getState().conversationMeta.get(CID) as unknown as { mentionsCount: number }).mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('unavailable outcome', async () => {
      await messageCache.saveMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 3,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
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
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // One never-archived (noLocalStore) message, after the pointer.
    const key = scopeKey()
    noteTransient(key, { position: posAt(1500) }, transientIdentity({ id: 'ephemeral-1' }, 'chat'), transientAliases({ id: 'ephemeral-1' }, 'chat'))

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
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')
    })

    it('re-noting the same logical message through a new alias does not increment the visible count twice', async () => {
      const key = scopeKey()
      const r1 = noteTransient(key, { position: posAt(1500) }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      expect(r1.added).toBe(true)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      // Same logical message re-noted (plain alias registration, nothing new).
      const r2 = noteTransient(key, { position: posAt(1500) }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      expect(r2.added).toBe(false)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1) // NOT 2
    })

    it('retracting the only transient unread moves the visible count 1 -> 0', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      const removed = removeTransient(key, transientIdentity({ id: 'm1' }, 'chat'))
      expect(removed.removed).toBe(true)
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    })

    it('removing one of two transient unread messages moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      noteTransient(key, { position: posAt(1600) }, transientIdentity({ id: 'm2' }, 'chat'), transientAliases({ id: 'm2' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

      removeTransient(key, transientIdentity({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })

    it('a bridging alias that coalesces two separately-counted transient entries moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, 'origin-key-O', ['origin-key-O'])
      noteTransient(key, { position: posAt(1500) }, 'stanza-key-S', ['stanza-key-S'])
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)

      // A copy carrying BOTH tiers bridges them: added:false, requiresRecount:true.
      const r = noteTransient(key, { position: posAt(1500) }, 'stanza-key-S', ['stanza-key-S', 'origin-key-O'])
      expect(r).toEqual({ added: false, requiresRecount: true })
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })

    it('an overlay change while not caught up stays conservative and does not clear the trusted count', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, transientIdentity({ id: 'm1' }, 'chat'), transientAliases({ id: 'm1' }, 'chat'))
      await chatStore.getState().recomputeUnreadForConversation(CID)
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)

      // Coverage proof is lost (e.g. a fresh reconnect before this session's
      // catch-up has re-run) — subsequent recomputes must defer.
      chatStore.setState((state) => {
        const mamQueryStates = new Map(state.mamQueryStates)
        mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: false })
        return { mamQueryStates }
      })
      noteTransient(key, { position: posAt(1600) }, transientIdentity({ id: 'm2' }, 'chat'), transientAliases({ id: 'm2' }, 'chat'))

      await chatStore.getState().recomputeUnreadForConversation(CID)

      // Deferred: the trusted count (1) survives — NOT recomputed to 2, and
      // NOT cleared to 0 either.
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(1)
    })
  })

  // ---------------------------------------------------------------------
  // Activation does not force the active entity's count to zero, so the COUNT
  // is re-derived by two triggers, both pinned below: advanceReadPointer and
  // setActiveConversation's deactivation branch. Every seed below is a NONZERO
  // value distinct from the correct outcome — a seed-0/assert-0 fixture cannot
  // distinguish a real recompute from a no-op.
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
        readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'chat', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
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
      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m3')

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
        readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'chat', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
      })
      seedCoverage('anchor-stanza')
      chatStore.setState({
        activeConversationId: CID,
        messages: new Map([[CID, [anchor, m1, m2, m3]]]),
      })

      // The viewport observer reports 'm1' seen — the user scrolled PARTWAY,
      // not to the bottom. 'm2' and 'm3' remain genuinely unread.
      chatStore.getState().advanceReadPointer(CID, 'm1')
      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('m1')

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
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'm1' } }, identity: { state: 'local', messageId: 'm1' } },
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

    // The test above (fully read, pointer already at the
    // newest message) converges to 0 — but 0 is ALSO exactly what a naive
    // "just write 0 on deactivation" implementation would produce, which is
    // precisely the force-zero behaviour activation must avoid. A
    // seed-5/assert-0 fixture where the pointer sits at the
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
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
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

  // ---------------------------------------------------------------------
  // The pointer-writing recount (recomputeCountsFromPointer) is
  // gone. Both of its pointer effects — the fresh-entity snap and the
  // outgoing-boundary advance — were heuristics that could move the
  // forward-only read pointer past messages the user never saw.
  // ---------------------------------------------------------------------

  describe('the guard pass no longer writes the pointer (PR C, D6)', () => {
    // The MERGE schedules its recount fire-and-forget (`void get().recompute...`),
    // so asserting the pointer straight after the merge resolves proves NOTHING —
    // the guard pass may not have run yet, and a count seeded at 0 that is still 0
    // is not evidence either. Drive the recount explicitly and await it, THEN
    // assert. Both assertions below are chosen so a surviving guard pass changes
    // them.
    it('a forward merge + recount does NOT snap a fresh conversation pointer to the newest message', async () => {
      await messageCache.saveMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('h1', 600),
        archiveMsg('h2', 700),
      ])
      // Fresh entity: no pointer, and history predating its creation watermark.
      setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: new Date(1000) })
      seedCoverage('anchor-stanza')

      chatStore.getState().mergeMAMMessages(
        CID,
        [archiveMsg('h1', 600), archiveMsg('h2', 700)],
        { first: 'h1', last: 'h2' },
        true,
        'forward'
      )
      await chatStore.getState().recomputeUnreadForConversation(CID)

      // A surviving fresh-entity snap would put this at 'h2'.
      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()
      // No unreadCount assertion here: seeded at 0 and asserting 0 can't tell
      // "floored correctly at the creation watermark" apart from "deferred and
      // touched nothing" — the sibling test below ("messages arriving after
      // creation…", seeded 0, asserts 2) is the one that actually exercises the
      // historyFloor-derived count.
    })

    // The OTHER two call sites: the guard pass inside the derivation itself.
    // Reached with no merge at all, so it needs its own control.
    it('the recount itself does NOT snap a fresh conversation pointer to the newest message', async () => {
      await messageCache.saveMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('h1', 600),
        archiveMsg('h2', 700),
      ])
      setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: new Date(1000) })
      seedCoverage('anchor-stanza')

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBeUndefined()
    })

    it('the recount itself does NOT advance the pointer to an outgoing message', async () => {
      await messageCache.saveMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('p0', 1000),
        archiveMsg('u1', 1100),
        archiveMsg('mine', 1200, { isOutgoing: true }),
        archiveMsg('u2', 1300),
      ])
      setMeta({
        unreadCount: 3,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      await chatStore.getState().recomputeUnreadForConversation(CID)

      // A surviving outgoing-boundary advance would put this at 'mine' and drop
      // the count to 1 by swallowing u1.
      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('p0')
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
    })

    it('a forward merge does NOT advance the pointer to an outgoing message', async () => {
      await messageCache.saveMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('p0', 1000),
        archiveMsg('u1', 1100),
        archiveMsg('mine', 1200, { isOutgoing: true }),
        archiveMsg('u2', 1300),
        archiveMsg('u3', 1400),
      ])
      setMeta({
        unreadCount: 4,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      chatStore.getState().mergeMAMMessages(
        CID,
        [archiveMsg('mine', 1200, { isOutgoing: true })],
        { first: 'mine', last: 'mine' },
        true,
        'forward'
      )
      await chatStore.getState().recomputeUnreadForConversation(CID)

      // The reply came from another device. Nothing here is evidence we read u1.
      expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe('p0')
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    })

    it('messages arriving after creation and merged during catch-up count as unread', async () => {
      await messageCache.saveMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('n1', 2000),
        archiveMsg('n2', 3000),
      ])
      setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: new Date(1000) })
      seedCoverage('anchor-stanza')

      chatStore.getState().mergeMAMMessages(
        CID,
        [archiveMsg('n1', 2000), archiveMsg('n2', 3000)],
        { first: 'n1', last: 'n2' },
        true,
        'forward'
      )
      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
    })

    // The race the no-mistakes gate's round-2 fix already
    // closed. This PIN proves the input-version guard is load-bearing, so a later
    // refactor cannot quietly drop it.
    it('a live arrival during an in-flight recount is not clobbered by the stale result', async () => {
      await messageCache.saveMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('p0', 1000),
        archiveMsg('u1', 1100),
      ])
      setMeta({
        unreadCount: 1,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      // Let the recount reach its archive read, then land an arrival that raises
      // the count WITHOUT moving the pointer — the case the pointer-identity
      // guard alone cannot see.
      vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(async (id, args) => {
        const actual = await vi.importActual<typeof import('../utils/messageCache')>('../utils/messageCache')
        const res = await actual.countUnreadInArchive(id, args)
        chatStore.getState().addMessage(archiveMsg('u2', 1200))
        return res
      })

      await chatStore.getState().recomputeUnreadForConversation(CID)

      // The stale snapshot said 1; the arrival made it 2. 2 must win.
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
    })
  })

  // ---------------------------------------------------------------------
  // The ACTIVATION trigger (room twin: roomStore.archiveUnread.test.ts).
  // The pointer-advance and deactivation triggers are both reached only by the
  // read pointer MOVING: advanceReadPointer recounts `if (pointerAdvanced)`, and
  // onMessageSeen returns its input unchanged once the pointer sits on the
  // newest loaded message. Opening a conversation already at the live edge
  // with the pointer already at newest therefore moves nothing and triggers
  // nothing — the deactivation trigger repairs it only on the way out, so the
  // badge is stuck precisely while it is being looked at.
  // ---------------------------------------------------------------------

  describe('activation re-derives the count for the conversation being entered', () => {
    it('opening a conversation whose pointer is already at the newest message clears the stale badge', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      await messageCache.saveMessages([anchor, m1])
      // Fully read: the pointer already sits on the newest message, so the
      // viewport observer has nothing left to advance.
      setMeta({
        unreadCount: 5, // stale — distinct from the correct 0
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'm1' } }, identity: { state: 'local', messageId: 'm1' } },
      })
      seedCoverage('anchor-stanza')
      chatStore.setState({ messages: new Map([[CID, [anchor, m1]]]) })

      // Open it. advanceReadPointer is never called, and there is no previous
      // conversation, so the deactivation trigger cannot fire either —
      // activation is the only trigger under test.
      chatStore.getState().setActiveConversation(CID)
      expect(chatStore.getState().activeConversationId).toBe(CID)

      await vi.waitFor(() => {
        expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
      }, { timeout: 2000 })
      expect(chatStore.getState().activeConversationId).toBe(CID)
    })

    // Discrimination control, as in the test above: seed-5/assert-0 would
    // also be satisfied by a force-zero on activation — the very behaviour
    // activation must avoid. With the pointer SHORT of newest, force-zero lands
    // on 0 (wrong), a missing trigger leaves 5 (wrong), only a real derivation
    // lands on 2.
    it('opening a conversation with the pointer short of the newest message derives the true remainder, not zero', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const p0 = archiveMsg('p0', 1000)
      const u1 = archiveMsg('u1', 1001)
      const u2 = archiveMsg('u2', 1002)
      await messageCache.saveMessages([anchor, p0, u1, u2])
      setMeta({
        unreadCount: 5, // stale — distinct from BOTH 0 (naive force-zero) and the correct 2
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')
      chatStore.setState({ messages: new Map([[CID, [anchor, p0, u1, u2]]]) })

      chatStore.getState().setActiveConversation(CID)

      await vi.waitFor(() => {
        expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(2)
      }, { timeout: 2000 })

      // ...and the divider the reader is looking at survives the recount.
      expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBe('u1')
    })
  })
})

/**
 * A timestamp-resumed catch-up has no `initialAfter`. The fixture uses an own
 * send without an archive id as that edge, so a completed walk must anchor
 * missing coverage on the oldest persistable archive id it carried itself.
 */
describe('chatStore — `start`-filtered catch-up bootstraps coverage from its walk extent', () => {
  const SELF = 'me@example.com'

  /** Our own last send: persisted with an origin-id and NO archive id. */
  function ownSend(overrides: Partial<Message> = {}): Message {
    return archiveMsg('own', 1000, {
      from: SELF,
      isOutgoing: true,
      originId: 'own-origin',
      body: 'last word',
      ...overrides,
    })
  }

  const POINTER_ON_OWN_SEND = {
    order: { role: 'exact' as const, timestamp: 1000, tiebreak: { kind: 'chat' as const, id: 'own' } },
    identity: { state: 'local' as const, messageId: 'own' },
  }

  function markCaughtUpWithoutCoverage(): void {
    chatStore.setState((state) => {
      const mamQueryStates = new Map(state.mamQueryStates)
      mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
      return { mamQueryStates }
    })
  }

  /** The walk's messages carry archive ids: `start` is inclusive, so the
   *  anchor own send comes back down with the id the archive gave it. */
  function catchUp(complete: boolean): void {
    chatStore.getState().mergeMAMMessages(
      CID,
      [ownSend({ stanzaId: 'own-archive-id' })],
      { first: 'own-archive-id' },
      complete,
      'forward',
      false,
      false,
      // No `initialAfter`: this walk resumed from a timestamp, not a cursor.
      { walkCarriedModifications: false, walkOldestId: 'own-archive-id' }
    )
  }

  /** Let the archive write, and the coverage commit gated on it, settle. */
  async function settle(): Promise<void> {
    await vi.waitFor(() => {
      expect(chatStore.getState().getConversationCoverage(CID)).toBeDefined()
    }, { timeout: 2000 })
  }

  beforeEach(async () => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as unknown as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
    localStorageMock.clear()
    chatStore.getState().reset()
    resetRecountDeferralsForTesting()
    clearTransientScope(getStorageScopeJid() ?? '')
    chatStore.getState().addConversation(createConversation(CID))

    await messageCache.saveMessages([ownSend()])
    chatStore.setState({ activeConversationId: 'someone-else@example.com' })
    setMeta({ unreadCount: 4, readPointer: POINTER_ON_OWN_SEND })
    markCaughtUpWithoutCoverage()
    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()
  })

  it('gets a coverage record, and the frozen badge finally recomputes', async () => {
    catchUp(true)
    await settle()

    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'own-archive-id' })

    // Nothing sits after the pointer, so the seeded count of 4 converges to 0 with
    // no further prodding — the merge re-derives once its record commits.
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    }, { timeout: 2000 })
    expect(chatStore.getState().conversations.get(CID)?.unreadCount).toBe(0)

    expect(readRecountDeferrals()['chat:coverage-missing']).toBeUndefined()
  })

  it('gates an active dedupe backfill and then recomputes it once', async () => {
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    vi.mocked(messageCache.saveMessages).mockClear()
    vi.mocked(messageCache.saveMessages).mockImplementationOnce(async (messages) => {
      const committed = await saveMessagesImplementation(messages)
      await writeGate
      return committed
    })
    chatStore.setState((state) => ({
      activeConversationId: CID,
      messages: new Map(state.messages).set(CID, [ownSend()]),
    }))

    catchUp(true)
    await vi.waitFor(() => {
      expect(messageCache.saveMessages).toHaveBeenCalled()
    })
    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(4)

    releaseWrite()
    await settle()
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    }, { timeout: 2000 })

    expect(readRecountDeferrals()['chat:coverage-missing']).toBeUndefined()
    expect(readRecountDeferrals()['chat:active-skipped']).toBeUndefined()
  })

  it('an INCOMPLETE walk still leaves no coverage, and the badge still freezes', async () => {
    // Completion is the whole warrant for trusting the walk's extent.
    catchUp(false)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()

    resetRecountDeferralsForTesting()
    await chatStore.getState().recomputeUnreadForConversation(CID)

    // An unfinished walk also clears `isCaughtUpToLive`, so the recount stands
    // down one guard earlier. Re-assert caught-up to reach the coverage gate
    // itself and show the door it used to leak through is still shut.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(4)
    expect(readRecountDeferrals()['chat:history-not-caught-up']).toBe(1)

    markCaughtUpWithoutCoverage()
    resetRecountDeferralsForTesting()
    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(4)
    expect(readRecountDeferrals()['chat:coverage-missing']).toBe(1)
  })

  it('re-establishes coverage after an unresolvable bottom dropped the record', async () => {
    // An unresolvable bottom drops the record. A later completed timestamp
    // catch-up must be able to establish durable coverage again.
    seedCoverage('evicted-stanza-id')
    await chatStore.getState().recomputeUnreadForConversation(CID)
    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()
    expect(readRecountDeferrals()['chat:coverage-unresolvable']).toBe(1)

    catchUp(true)
    await settle()

    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'own-archive-id' })
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    }, { timeout: 2000 })
    expect(readRecountDeferrals()['chat:coverage-missing']).toBeUndefined()
  })

  it('leaves the other deferral reasons standing in their own conditions', async () => {
    // Closing this exit must not open the others: a walk that reached live is
    // not a licence to count from history that has not caught up.
    catchUp(true)
    await settle()
    await vi.waitFor(() => {
      expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    }, { timeout: 2000 })

    // Coverage is now proven, so only the OTHER guards can stand between a
    // stale badge and the archive. Re-stale it and take one away.
    setMeta({ unreadCount: 4 })
    chatStore.setState((state) => {
      const mamQueryStates = new Map(state.mamQueryStates)
      mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: false, isCaughtUpToLive: false })
      return { mamQueryStates }
    })

    resetRecountDeferralsForTesting()
    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(4)
    expect(readRecountDeferrals()['chat:history-not-caught-up']).toBe(1)
  })
})
