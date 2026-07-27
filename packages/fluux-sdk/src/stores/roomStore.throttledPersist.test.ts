import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { roomStore } from './roomStore'
import { _resetForTesting, flush } from './shared/throttledStorage'
import { forgetAllDurableMapBaselines } from './shared/durableMapPersist'
import { _clearAllRoomReadStateForTesting } from './shared/readStateStorage'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { createRoom, createMessage } from './roomStore.testHelpers'
import type { RoomMessage } from '../core/types'
import type { GapInterval } from './shared/mamGap'
import type { CoverageRecord } from './shared/mamCoverage'

const ROOM = 'room@conference.example.com'
const ROOM2 = 'room2@conference.example.com'
const GAPS_KEY = 'fluux-room-gaps'
const COVERAGE_KEY = 'fluux-room-coverage'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  _resetForTesting()
  _resetStorageScopeForTesting()
  roomStore.getState().reset()
  _resetForTesting()
  // The structural baselines outlive a throttle reset, and a leaked one would
  // silently turn a later formation into a no-op transition.
  forgetAllDurableMapBaselines()
  localStorageMock.setItem.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('roomStore throttled persistence', () => {
  it('coalesces repeated draft writes and keeps the latest', () => {
    roomStore.getState().setDraft(ROOM, 'one')
    roomStore.getState().setDraft(ROOM, 'two')
    roomStore.getState().setDraft(ROOM, 'three')
    expect(writeCount()).toBe(1)
    flush()
    expect(localStorage.getItem('fluux-room-drafts')).toContain('three')
  })

  it('gives each key its own window', () => {
    roomStore.getState().setDraft(ROOM, 'draft-a')
    roomStore.getState().setDraft(ROOM, 'draft-b')
    // Drafts' window is open; a first poll write must still take its own
    // leading edge rather than being coalesced behind it.
    roomStore.getState().recordPollVote(ROOM, 'poll-1')
    expect(localStorage.getItem('fluux-room-voted-polls')).toContain('poll-1')
    expect(localStorage.getItem('fluux-room-drafts')).toContain('draft-a')
    expect(localStorage.getItem('fluux-room-drafts')).not.toContain('draft-b')
  })

  it('switchAccount flushes the outgoing account under its own key', () => {
    setStorageScopeJid('a@example.com')
    roomStore.getState().setDraft(ROOM, 'a-first')
    roomStore.getState().setDraft(ROOM, 'a-pending')

    // Production order: XMPPClient.ts:1020-1022 sets the storage scope FIRST,
    // then calls switchAccount on both stores. Skipping the scope change would
    // test a sequence that never occurs.
    setStorageScopeJid('b@example.com')
    roomStore.getState().switchAccount('b@example.com')
    // Deliberately NO timer advance. Advancing the clock lets the pending
    // thunk fire on its own timer — and since it already carries the outgoing
    // key AND map, it writes a byte-identical result, so the test would pass
    // with switchAccount's flush deleted. Asserting immediately is what makes
    // the flush the only thing that can have written this.

    expect(localStorage.getItem('fluux-room-drafts:a@example.com')).toContain('a-pending')
    expect(localStorage.getItem('fluux-room-drafts:b@example.com') ?? '').not.toContain('a-pending')

    setStorageScopeJid('a@example.com')
    roomStore.getState().switchAccount('a@example.com')
    // The state field is `drafts`, not `roomDrafts`.
    expect(roomStore.getState().drafts.get(ROOM)).toBe('a-pending')
  })

  // Drafts and polls alone leave the three durable maps untested — and those
  // are the ones the #1081 read-pointer work depends on.
  //
  // There are no `recordRoomGap` / `recordRoomCoverage` setters. Gaps and
  // coverage are written from `removeRoom`, `mergeRoomMAMMessages`,
  // `clearRoomGapAnchor` and `clearRoomCoverage`. The two `clear*` actions are
  // the only ones with a signature small enough to drive directly, so the
  // scenarios seed the maps and then clear TWO rooms: the first clear takes the
  // leading edge, the second is the coalesced one that only lands if the
  // trailing write works.
  it('coalesces gap writes across two rooms', () => {
    // GapInterval is { start, end?, startId?, endId? } — epoch ms, not Dates.
    roomStore.setState({
      roomGaps: new Map([
        [ROOM, { start: 1000, startId: 'gap-anchor-1' }],
        [ROOM2, { start: 2000, startId: 'gap-anchor-2' }],
      ]),
    })
    localStorageMock.setItem.mockClear()

    roomStore.getState().clearRoomGapAnchor(ROOM, 'gap-anchor-1') // leading edge
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'gap-anchor-2') // coalesced
    flush()

    const raw = localStorage.getItem('fluux-room-gaps') ?? ''
    expect(raw).not.toContain('gap-anchor-1')
    expect(raw).not.toContain('gap-anchor-2')
  })

  // NOTE: a coverage REMOVAL is now force-flushed (design §4.2), so what this
  // test still pins is that both removals reach disk — not coalescing. The
  // coalescing half moved to the `topId` refresh test in the structural-
  // durability suite below, which drives the one coverage transition that is
  // still throttled.
  it('coalesces coverage writes across two rooms', () => {
    // CoverageRecord is { bottomId, topId? }.
    roomStore.setState({
      roomCoverage: new Map([
        [ROOM, { bottomId: 'cov-1' }],
        [ROOM2, { bottomId: 'cov-2' }],
      ]),
    })
    localStorageMock.setItem.mockClear()

    roomStore.getState().clearRoomCoverage(ROOM) // leading edge
    roomStore.getState().clearRoomCoverage(ROOM2) // coalesced
    flush()

    const raw = localStorage.getItem('fluux-room-coverage') ?? ''
    expect(raw).not.toContain('cov-1')
    expect(raw).not.toContain('cov-2')
  })

  // `advanceReadPointer` persists only when: connectionStore.windowVisible is
  // true (it defaults to true, so no setup needed), the room is in `rooms`,
  // it has a `roomMeta` entry, and the message id is resident. `addRoom` with
  // a populated `messages` array satisfies the last three.
  it('coalesces room read state and keeps the latest pointer', () => {
    roomStore.getState().addRoom(
      createRoom(ROOM, {
        joined: true,
        messages: [
          createMessage('r1', ROOM, 'alice', 'first', false, new Date(1000)),
          createMessage('r2', ROOM, 'alice', 'second', false, new Date(2000)),
        ],
      })
    )
    localStorageMock.setItem.mockClear()

    // NOTE: `addRoom` itself ends with `persistRoomReadState`, so the
    // read-state window is ALREADY OPEN here — unlike the gap and coverage
    // scenarios above, neither call below is a leading edge. Both coalesce,
    // and the second replaces the first in the pending thunk. (mockClear
    // resets the write counter; it does not close the window.)
    roomStore.getState().advanceReadPointer(ROOM, 'r1') // coalesced
    roomStore.getState().advanceReadPointer(ROOM, 'r2') // replaces the pending thunk
    flush()

    expect(localStorage.getItem('fluux-room-read-state')).toContain('r2')
  })

  it('reset cancels pending gap, coverage and read-state writes', () => {
    roomStore.setState({
      roomGaps: new Map([
        [ROOM, { start: 1000, startId: 'gap-first' }],
        [ROOM2, { start: 2000, startId: 'gap-pending' }],
      ]),
      roomCoverage: new Map([
        [ROOM, { bottomId: 'cov-first' }],
        [ROOM2, { bottomId: 'cov-pending' }],
      ]),
    })
    roomStore.getState().addRoom(
      createRoom(ROOM, {
        joined: true,
        messages: [
          createMessage('read-first', ROOM, 'alice', 'a', false, new Date(1000)),
          createMessage('read-pending', ROOM, 'alice', 'b', false, new Date(2000)),
        ],
      })
    )
    // Leave a pending write on each of the three keys. Gaps and coverage open
    // their window on the first clear; read state's is already open, since
    // `addRoom` above ended with `persistRoomReadState`.
    roomStore.getState().clearRoomGapAnchor(ROOM, 'gap-first')
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'gap-pending')
    roomStore.getState().clearRoomCoverage(ROOM)
    roomStore.getState().clearRoomCoverage(ROOM2)
    roomStore.getState().advanceReadPointer(ROOM, 'read-first')
    roomStore.getState().advanceReadPointer(ROOM, 'read-pending')

    roomStore.getState().reset()
    vi.advanceTimersByTime(5000)

    // Assert the KEYS ARE GONE, not that a marker string is absent.
    //
    // A `not.toContain` here is non-discriminating: the pending gap thunk holds
    // a map with BOTH anchors already stripped, and the pending coverage thunk
    // holds `[]`. With `cancel` missing, those thunks fire after `removeItem`
    // and recreate the keys — while still containing neither 'gap-pending' nor
    // 'cov-pending'. The substring assertions would pass on a resurrection.
    //
    // Nothing legitimately rewrites these keys after reset: unlike chatStore,
    // roomStore's `set(createEmptyRoomState())` does not re-trigger the save
    // helpers, so absence is the correct expectation.
    expect(localStorage.getItem('fluux-room-gaps')).toBeNull()
    expect(localStorage.getItem('fluux-room-coverage')).toBeNull()
    expect(localStorage.getItem('fluux-room-read-state')).toBeNull()
  })

  it('_clearAllRoomReadStateForTesting leaves no row to resurrect', () => {
    roomStore.getState().addRoom(
      createRoom(ROOM, {
        joined: true,
        messages: [
          createMessage('r-first', ROOM, 'alice', 'a', false, new Date(1000)),
          createMessage('r-pending', ROOM, 'alice', 'b', false, new Date(2000)),
        ],
      })
    )
    // `addRoom` already opened the read-state window, so both of these
    // coalesce and 'r-pending' is left sitting in the pending thunk.
    roomStore.getState().advanceReadPointer(ROOM, 'r-first')
    roomStore.getState().advanceReadPointer(ROOM, 'r-pending')

    _clearAllRoomReadStateForTesting()
    vi.advanceTimersByTime(5000)

    // Key absence, for the same reason as the reset test: a pending thunk that
    // fires after the clear recreates the row, and a substring assertion would
    // not notice.
    expect(localStorage.getItem('fluux-room-read-state')).toBeNull()
  })

  it('reset does not let a pending write resurrect room data', () => {
    roomStore.getState().setDraft(ROOM, 'first')
    roomStore.getState().setDraft(ROOM, 'secret-pending')
    roomStore.getState().reset()
    vi.advanceTimersByTime(5000)
    // Key absence, consistent with the gap/coverage/read-state reset test.
    // A substring assertion happens to discriminate here — the pending drafts
    // thunk still contains 'secret-pending' — but absence is what `reset` is
    // actually promising, and it does not depend on that coincidence.
    expect(localStorage.getItem('fluux-room-drafts')).toBeNull()
  })

  // The throttle is PER KEY, so opening a window on room-read-state proves
  // nothing here. Both retractions must be on the retraction key: if that
  // helper were ever routed through `schedule`, the SECOND would be sitting
  // in a pending thunk.
  it('keeps pending retractions synchronous', () => {
    roomStore.getState().recordPendingRetraction(ROOM, 'target-1', 'nick-1')
    roomStore.getState().recordPendingRetraction(ROOM, 'target-2', 'nick-2')

    const raw = localStorage.getItem('fluux-room-pending-retractions') ?? ''
    expect(raw).toContain('target-1')
    expect(raw).toContain('target-2')
  })
})

/**
 * Gaps and coverage are only HALF lagging mirrors (design §4.2).
 *
 * The monotone moves are mirrors: a lost gap shrink costs a redundant re-heal,
 * a lost coverage re-entry marker costs a re-walk. The STRUCTURAL transitions
 * are not:
 *
 * - a lost gap FORMATION is never re-detected — the next session's catch-up
 *   cursor already sits above the hole, so the marker stays silent forever;
 * - a lost coverage REPLACEMENT/REMOVAL leaves the stale, deeper record on disk
 *   asserting a contiguity this merge actively disproved, and Phase B seeds its
 *   backward walk from it, skipping the disconnected interval.
 *
 * Every scenario below is a HARD KILL: no timer advance, no `flush()`, no
 * lifecycle event. And every one first puts THIS KEY's window into the state
 * where the ordinary throttled path would NOT have persisted (§5.5) — using a
 * transition that is still throttled after the fix, so the assertion keeps
 * discriminating instead of riding a neighbouring force-flush that closed the
 * window for it.
 */
describe('roomStore gap/coverage structural durability', () => {
  /**
   * A page the merge will NOT write to IndexedDB, so the gap/coverage
   * transition applies synchronously instead of deferring behind the durable
   * commit (`mustGateOnChain` in mergeRoomMAMMessages). A deferred transition
   * would need the promise chain to settle, which is a different test.
   */
  function unstoredPage(id: string, timestamp: Date): RoomMessage[] {
    return [{ ...createMessage(id, ROOM, 'a', id, false, timestamp), noLocalStore: true } as RoomMessage]
  }

  function gapsOnDisk(): Map<string, GapInterval> {
    return new Map(JSON.parse(localStorage.getItem(GAPS_KEY) ?? '[]') as [string, GapInterval][])
  }

  function coverageOnDisk(): Map<string, CoverageRecord> {
    return new Map(JSON.parse(localStorage.getItem(COVERAGE_KEY) ?? '[]') as [string, CoverageRecord][])
  }

  /** Establish a coverage record: a `before:''` fetch-latest with contiguity
   *  unproven writes the walk extent as a brand-new record. */
  function createCoverage(room: string, bottomId: string, topId: string): void {
    roomStore.getState().mergeRoomMAMMessages(
      room, [], { first: bottomId }, true, 'backward', false, true,
      { sawCoverageTop: false, fetchLatestTopId: topId }
    )
  }

  /** The re-entry marker: contiguity PROVEN, so only `topId` refreshes. The
   *  one coverage transition that stays throttled after the fix — and hence
   *  the only thing that can legitimately leave this key's window open. */
  function refreshCoverageTop(room: string, bottomId: string, topId: string): void {
    roomStore.getState().mergeRoomMAMMessages(
      room, [], { first: bottomId }, true, 'backward', false, true,
      { sawCoverageTop: true, fetchLatestTopId: topId }
    )
  }

  it('persists a gap FORMATION that was coalesced into an open window', () => {
    // A gap SHRINK is monotone and stays throttled, so it is what opens the
    // gaps window and leaves it open.
    roomStore.setState({ roomGaps: new Map([[ROOM2, { start: 1000, startId: 'anchor-2' }]]) })
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'anchor-2') // leading edge → window OPEN
    expect(gapsOnDisk().has(ROOM2)).toBe(true)

    roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
    // A forward catch-up that came back incomplete plants a gap at the newest
    // fetched timestamp: formation.
    roomStore.getState().mergeRoomMAMMessages(
      ROOM, unstoredPage('edge', new Date('2026-05-14T09:00:00Z')), {}, false, 'forward'
    )
    expect(roomStore.getState().roomGaps.has(ROOM)).toBe(true) // the transition happened

    expect(gapsOnDisk().has(ROOM)).toBe(true)
  })

  it('persists a coverage REPLACEMENT that was coalesced into an open window', () => {
    roomStore.getState().addRoom(createRoom(ROOM, {
      joined: true,
      messages: [createMessage('held', ROOM, 'a', 'held', false, new Date('2026-07-20T00:00:00Z'))],
    }))

    createCoverage(ROOM, 'deep-old', 'top-1')
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({ bottomId: 'deep-old', topId: 'top-1' })

    refreshCoverageTop(ROOM, 'deep-old', 'top-2') // throttled → window OPEN
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({ bottomId: 'deep-old', topId: 'top-2' })

    // Contiguity with the record actively DISPROVEN → the record is replaced
    // wholesale with this walk's extent, which may be far shallower.
    roomStore.getState().mergeRoomMAMMessages(
      ROOM, [], { first: 'new-shallow' }, true, 'backward', false, true, { sawCoverageTop: false }
    )
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({ bottomId: 'new-shallow' })

    // Memory holds new-shallow; storage must not still hold deep-old.
    expect(coverageOnDisk().get(ROOM)).toEqual({ bottomId: 'new-shallow' })
  })

  // The other half of the bound: the fix must not defeat the throttle for the
  // monotone move. A `topId` refresh is the re-entry marker — it proves nothing
  // new about the bottom, so losing one only costs a re-walk.
  it('still coalesces the throttled coverage transition (topId refresh)', () => {
    roomStore.getState().addRoom(createRoom(ROOM, {
      joined: true,
      messages: [createMessage('held', ROOM, 'a', 'held', false, new Date('2026-07-20T00:00:00Z'))],
    }))
    createCoverage(ROOM, 'cov-bottom', 'top-1')
    localStorageMock.setItem.mockClear()

    refreshCoverageTop(ROOM, 'cov-bottom', 'top-2') // leading edge → window OPEN
    refreshCoverageTop(ROOM, 'cov-bottom', 'top-3') // coalesced, NOT force-flushed
    expect(writeCount()).toBe(1)
    expect(coverageOnDisk().get(ROOM)).toEqual({ bottomId: 'cov-bottom', topId: 'top-2' })

    flush()
    expect(coverageOnDisk().get(ROOM)).toEqual({ bottomId: 'cov-bottom', topId: 'top-3' })
  })

  it('persists a coverage REMOVAL that was coalesced into an open window', () => {
    for (const room of [ROOM, ROOM2]) {
      roomStore.getState().addRoom(createRoom(room, {
        joined: true,
        messages: [createMessage(`held-${room}`, room, 'a', 'held', false, new Date('2026-07-20T00:00:00Z'))],
      }))
    }
    createCoverage(ROOM, 'cov-room-1', 'top-1')
    createCoverage(ROOM2, 'cov-room-2', 'top-1')

    refreshCoverageTop(ROOM2, 'cov-room-2', 'top-2') // throttled → window OPEN

    // The purge guard drops the record: the anchor it names is known gone, so
    // keeping it on disk would seed Phase B from a cursor that no longer exists.
    roomStore.getState().clearRoomCoverage(ROOM)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()

    const onDisk = coverageOnDisk()
    expect(onDisk.has(ROOM)).toBe(false)
    // The neighbour proves the key was rewritten rather than merely absent.
    expect(onDisk.has(ROOM2)).toBe(true)
  })
})
