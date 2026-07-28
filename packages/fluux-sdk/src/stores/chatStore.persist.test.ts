import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

// Needed only by the deferred-commit case at the bottom: a merge carrying
// persistable messages gates its coverage transition on the IndexedDB write.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return { ...actual, saveMessages: vi.fn().mockResolvedValue(true) }
})

import { chatStore } from './chatStore'
import { _resetForTesting, flush } from './shared/throttledStorage'
import { forgetAllDurableMapBaselines } from './shared/durableMapPersist'
import type { Message } from '../core/types'
import type { GapInterval } from './shared/mamGap'
import type { CoverageRecord } from './shared/mamCoverage'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

const KEY = 'xmpp-chat-storage'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

function seedConversation(id: string): void {
  // `Conversation extends ConversationEntity, ConversationMetadata`, so
  // `unreadCount` is required.
  chatStore.getState().addConversation({ id, name: id, type: 'chat', unreadCount: 0 })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  _resetForTesting()
  _resetStorageScopeForTesting()
  chatStore.getState().reset()
  _resetForTesting()
  // The structural baselines outlive a throttle reset, and a leaked one would
  // silently turn a later formation into a no-op transition.
  forgetAllDurableMapBaselines()
  localStorageMock.setItem.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('chatStore persistence throttling', () => {
  it('collapses a long burst of mutations into far fewer writes', () => {
    seedConversation('a@example.com')
    localStorageMock.setItem.mockClear()

    // 180 MAM pages' worth of churn, spread over ~20s of wall clock.
    for (let i = 0; i < 180; i++) {
      chatStore.getState().setMAMLoading('a@example.com', i % 2 === 0)
      vi.advanceTimersByTime(110)
    }
    flush()

    expect(writeCount()).toBeGreaterThan(0)
    expect(writeCount()).toBeLessThanOrEqual(25)
  })

  it('after flush, on-disk state equals the final state', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com')
    chatStore.getState().setMAMLoading('a@example.com', true)
    flush()

    const onDisk = JSON.parse(localStorage.getItem(KEY)!)
    const ids = onDisk.state.conversationEntities.map(([id]: [string]) => id)
    expect(ids).toEqual(['a@example.com', 'b@example.com'])
  })

  it('a pagehide persists without an explicit flush', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com') // coalesced into the pending thunk
    window.dispatchEvent(new Event('pagehide'))

    const onDisk = JSON.parse(localStorage.getItem(KEY)!)
    const ids = onDisk.state.conversationEntities.map(([id]: [string]) => id)
    expect(ids).toContain('b@example.com')
  })

  // The one test in this area that can actually fail. `reset` cannot carry it:
  // its trailing `set(empty)` overwrites the pending thunk, so the reset test
  // below passes with `cancel` removed AND with the throttle removed.
  it('a cancelled write never lands after the key is cleared', () => {
    seedConversation('a@example.com')
    seedConversation('b@example.com') // coalesced into the pending thunk
    chatStore.persist.clearStorage()
    vi.advanceTimersByTime(5000)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('reset leaves no pre-logout data behind', () => {
    seedConversation('secret@example.com')
    seedConversation('secret2@example.com') // pending, not yet written
    chatStore.getState().reset()

    // Guards the `cancel()` in `reset()`: with the window cancelled, the
    // trailing `set(empty)` takes the leading edge and writes synchronously.
    // Without it that `set` is coalesced and the key stays null for a window.
    expect(localStorage.getItem(KEY)).not.toBeNull()

    vi.advanceTimersByTime(5000)

    // Per spec 2.1 the key EXISTS holding an empty blob — asserting absence
    // would assert something that has never been true, throttle or not.
    const raw = localStorage.getItem(KEY)
    expect(raw ?? '').not.toContain('secret@example.com')
    expect(raw ?? '').not.toContain('secret2@example.com')
  })
})

describe('pending retraction durability', () => {
  // The window MUST be opened first, on this same key. Recording a retraction
  // into an idle store is hollow: with no window open, the leading edge writes
  // it anyway and the test passes with flushKey removed.
  it('persists a retraction that was coalesced into an open window', () => {
    const id = 'a@example.com'
    seedConversation(id) // leading edge writes a blob with NO retraction, opens the window
    localStorageMock.setItem.mockClear()

    chatStore.getState().recordPendingRetraction(id, 'target-msg-1', 'someone@example.com')

    // The hard kill: no timer, no flush, no lifecycle event.
    const raw = localStorage.getItem(KEY)!
    expect(raw).toContain('target-msg-1')
  })

  // Pins the synchronous-setItem assumption. If a zustand upgrade ever defers
  // the adapter, this fails loudly instead of retractions quietly becoming losable.
  it('has persisted before recordPendingRetraction returns', () => {
    const id = 'b@example.com'
    seedConversation(id)
    chatStore.getState().recordPendingRetraction(id, 'target-msg-2', 'someone@example.com')
    expect(localStorage.getItem(KEY)!).toContain('target-msg-2')
  })
})

/**
 * `conversationGaps` and `conversationCoverage` ride inside the SINGLE chat
 * blob, so a structural transition has to force the whole blob out of the
 * window — see the roomStore suite's header for why these transitions are not
 * lagging mirrors, and design §4.2 for the decision table.
 *
 * Every scenario is a HARD KILL (no timer advance, no `flush()`, no lifecycle
 * event) and every one opens the blob's window first with an ordinary chat
 * mutation, so the ordinary throttled path would NOT have persisted (§5.5).
 */
describe('chat gap/coverage structural durability', () => {
  const CID = 'gaps@example.com'
  const CID2 = 'gaps2@example.com'

  /** A page the merge will NOT write to IndexedDB, so the transition applies
   *  synchronously rather than deferring behind the durable commit
   *  (`mustGateOnChain`). */
  function unstoredPage(id: string, timestamp: Date): Message[] {
    return [{
      type: 'chat', id, conversationId: CID, from: CID, body: id, timestamp,
      isOutgoing: false, noLocalStore: true,
    } as Message]
  }

  function blobOnDisk(): { conversationGaps: [string, GapInterval][]; conversationCoverage: [string, CoverageRecord][] } {
    return JSON.parse(localStorage.getItem(KEY)!).state
  }

  function gapsOnDisk(): Map<string, GapInterval> {
    return new Map(blobOnDisk().conversationGaps ?? [])
  }

  function coverageOnDisk(): Map<string, CoverageRecord> {
    return new Map(blobOnDisk().conversationCoverage ?? [])
  }

  /** Establish a record: a `before:''` fetch-latest with contiguity unproven
   *  writes the walk extent as a brand-new record. */
  function createCoverage(cid: string, bottomId: string, topId: string): void {
    chatStore.getState().mergeMAMMessages(
      cid, [], { first: bottomId }, true, 'backward', true, false,
      { sawCoverageTop: false, fetchLatestTopId: topId }
    )
  }

  /** Re-entry marker: contiguity PROVEN, so only `topId` refreshes — the one
   *  coverage transition that stays throttled after the fix. */
  function refreshCoverageTop(cid: string, bottomId: string, topId: string): void {
    chatStore.getState().mergeMAMMessages(
      cid, [], { first: bottomId }, true, 'backward', true, false,
      { sawCoverageTop: true, fetchLatestTopId: topId }
    )
  }

  /** The bootstrap branch: a COMPLETED forward catch-up with a resume cursor
   *  seeds the record for an entity that has none. */
  function bootstrapCoverage(cid: string, initialAfter: string): void {
    chatStore.getState().mergeMAMMessages(
      cid, [], {}, true, 'forward', false, false, { initialAfter }
    )
  }

  /** A Phase B page: a plain backward query resumed id-exactly from the
   *  recorded bottom, extending the same contiguous run. */
  function deepenCoverage(cid: string, from: string, to: string): void {
    chatStore.getState().mergeMAMMessages(
      cid, [], { first: to }, false, 'backward', false, false, { initialBefore: from }
    )
  }

  it('persists a gap FORMATION that was coalesced into an open window', () => {
    seedConversation(CID) // leading edge writes a blob with NO gap, opens the window
    localStorageMock.setItem.mockClear()

    chatStore.getState().mergeMAMMessages(
      CID, unstoredPage('edge', new Date('2026-05-14T09:00:00Z')), {}, false, 'forward'
    )
    expect(chatStore.getState().conversationGaps.has(CID)).toBe(true) // the transition happened

    expect(gapsOnDisk().has(CID)).toBe(true)
  })

  /**
   * The crash/restart path a lost gap BOUNDARY opens, for the chat blob.
   *
   * A multi-page forward catch-up advances `start`/`startId` under the SAME gap
   * key on each incomplete page, then bails to a `before:''` fetch-latest. If
   * only the formation is forced out of the window, a hard kill leaves disk
   * holding a STALE, LOWER boundary, and the true hole above it can be erased by
   * a later "load older" page.
   *
   * Three pages is the minimum that discriminates: page 1 force-flushes on the
   * formation and CLOSES the window, page 2 takes a fresh leading edge and lands
   * regardless, and only page 3 is genuinely coalesced (§5.5).
   */
  it('persists the LATEST boundary of a multi-page forward catch-up', () => {
    seedConversation(CID)

    const page1 = new Date('2026-05-14T09:00:00Z')
    const page2 = new Date('2026-05-14T10:00:00Z')
    const page3 = new Date('2026-05-14T11:00:00Z')

    chatStore.getState().mergeMAMMessages(CID, unstoredPage('p1', page1), { last: 'arc-1' }, false, 'forward')
    expect(chatStore.getState().conversationGaps.get(CID)?.startId).toBe('arc-1')

    chatStore.getState().mergeMAMMessages(CID, unstoredPage('p2', page2), { last: 'arc-2' }, false, 'forward')
    expect(gapsOnDisk().get(CID)?.startId).toBe('arc-2') // leading edge — lands either way

    chatStore.getState().mergeMAMMessages(CID, unstoredPage('p3', page3), { last: 'arc-3' }, false, 'forward')
    expect(chatStore.getState().conversationGaps.get(CID)).toMatchObject({
      start: page3.getTime(), startId: 'arc-3',
    })

    // The hard kill: no timer advance, no flush, no lifecycle event.
    expect(gapsOnDisk().get(CID)).toMatchObject({ start: page3.getTime(), startId: 'arc-3' })
  })

  it('persists a coverage REPLACEMENT that was coalesced into an open window', () => {
    seedConversation(CID)

    createCoverage(CID, 'deep-old', 'top-1')
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'deep-old', topId: 'top-1' })

    refreshCoverageTop(CID, 'deep-old', 'top-2') // throttled → window OPEN
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'deep-old', topId: 'top-2' })

    chatStore.getState().mergeMAMMessages(
      CID, [], { first: 'new-shallow' }, true, 'backward', true, false, { sawCoverageTop: false }
    )
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'new-shallow' })

    expect(coverageOnDisk().get(CID)).toEqual({ bottomId: 'new-shallow' })
  })

  /**
   * #1138's headline: the coverage bootstrap.
   *
   * `syncCoverageAfterArchiveMerge` seeds a record for every entity that has
   * none and completes a forward catch-up, which on a first session is
   * essentially every conversation. #1133 force-flushed each one, so a
   * 400-conversation profile paid ~400 whole-blob serializations — the same
   * order as the burst the throttle exists to remove, and measurably identical
   * to the pre-throttle baseline.
   *
   * A creation is safe to coalesce because losing it leaves NO record: the next
   * session re-seeds from the local downloaded edge, which is shallower. The
   * write-count assertion is the one that fails under the old rule; the
   * REPLACEMENT tests above are what stop "coalesce everything" from passing.
   */
  it('coalesces the coverage bootstrap across conversations', () => {
    seedConversation(CID) // leading edge (both maps empty → not structural), window OPEN
    seedConversation(CID2) // coalesced
    expect(writeCount()).toBe(1)

    bootstrapCoverage(CID, 'edge-1')
    bootstrapCoverage(CID2, 'edge-2')
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'edge-1' })
    expect(chatStore.getState().getConversationCoverage(CID2)).toEqual({ bottomId: 'edge-2' })

    // Under #1133's "bottomId changed → force-flush" this is 3.
    expect(writeCount()).toBe(1)
    expect(coverageOnDisk().size).toBe(0)

    flush()
    expect(coverageOnDisk().get(CID)).toEqual({ bottomId: 'edge-1' })
    expect(coverageOnDisk().get(CID2)).toEqual({ bottomId: 'edge-2' })
  })

  /**
   * The other half of the measured cost: Phase B's read-pointer stitch walks up
   * to `MAM_POINTER_STITCH_MAX_PAGES` (10) backward pages per entity per
   * session, each advancing `bottomId` id-exactly from the recorded one. Losing
   * one leaves the shallower bottom, which is still true.
   */
  it('coalesces a Phase B bottomId deepening', () => {
    seedConversation(CID)
    createCoverage(CID, 'deep-0', 'top-1') // creation → throttled
    expect(writeCount()).toBe(1)

    deepenCoverage(CID, 'deep-0', 'deep-1')
    deepenCoverage(CID, 'deep-1', 'deep-2')
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'deep-2', topId: 'top-1' })

    expect(writeCount()).toBe(1) // 3 under #1133
    flush()
    expect(coverageOnDisk().get(CID)).toEqual({ bottomId: 'deep-2', topId: 'top-1' })
  })

  /**
   * The DEFERRED replacement.
   *
   * When the merge carries persistable messages, the coverage transition waits
   * for the IndexedDB commit (`mustGateOnChain`) and lands from
   * `scheduleDeferredCommit`, not from the merge's own `set`. Reporting the
   * transition at merge time would arm the flush for a write that still carries
   * the OLD record and leave the real one sitting in the throttle window — a
   * durability hole that the synchronous replacement test above cannot see,
   * because it deliberately uses unstored pages.
   *
   * Timers are never advanced and `flush()` is never called: the record reaches
   * disk only if the deferred write force-flushed.
   */
  it('persists a DEFERRED coverage replacement that was coalesced into an open window', async () => {
    seedConversation(CID)
    createCoverage(CID, 'deep-old', 'top-1') // creation → throttled, window OPEN
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'deep-old', topId: 'top-1' })
    // The window is open and nothing coverage-related has reached disk, so the
    // ordinary throttled path demonstrably would NOT persist what follows.
    expect(coverageOnDisk().has(CID)).toBe(false)

    // A storable page, so the transition defers behind the durable write.
    const stored: Message[] = [{
      type: 'chat', id: 'p1', conversationId: CID, from: CID, body: 'p1',
      timestamp: new Date('2026-05-14T09:00:00Z'), isOutgoing: false, stanzaId: 'new-shallow',
    } as Message]
    chatStore.getState().mergeMAMMessages(
      CID, stored, { first: 'new-shallow' }, true, 'backward', true, false, { sawCoverageTop: false }
    )
    // Deliberately still the old record: the transition has NOT applied yet.
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'deep-old', topId: 'top-1' })

    // Drain the save chain's microtasks WITHOUT advancing the throttle timer.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(chatStore.getState().getConversationCoverage(CID)).toEqual({ bottomId: 'new-shallow' })

    expect(coverageOnDisk().get(CID)).toEqual({ bottomId: 'new-shallow' })
  })

  it('persists a coverage REMOVAL that was coalesced into an open window', () => {
    seedConversation(CID)
    seedConversation(CID2)
    createCoverage(CID, 'cov-1', 'top-1')
    createCoverage(CID2, 'cov-2', 'top-1')

    refreshCoverageTop(CID2, 'cov-2', 'top-2') // throttled → window OPEN

    chatStore.getState().clearConversationCoverage(CID)
    expect(chatStore.getState().getConversationCoverage(CID)).toBeUndefined()

    const onDisk = coverageOnDisk()
    expect(onDisk.has(CID)).toBe(false)
    // The neighbour proves the blob was rewritten rather than merely emptied.
    expect(onDisk.has(CID2)).toBe(true)
  })
})
