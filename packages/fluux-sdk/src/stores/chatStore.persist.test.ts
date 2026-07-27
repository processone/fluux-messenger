import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

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

  it('persists a gap FORMATION that was coalesced into an open window', () => {
    seedConversation(CID) // leading edge writes a blob with NO gap, opens the window
    localStorageMock.setItem.mockClear()

    chatStore.getState().mergeMAMMessages(
      CID, unstoredPage('edge', new Date('2026-05-14T09:00:00Z')), {}, false, 'forward'
    )
    expect(chatStore.getState().conversationGaps.has(CID)).toBe(true) // the transition happened

    expect(gapsOnDisk().has(CID)).toBe(true)
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
