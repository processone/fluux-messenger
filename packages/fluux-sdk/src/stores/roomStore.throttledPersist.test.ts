import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

// Needed only by the deferred-commit case at the bottom: a merge carrying
// persistable messages gates its coverage transition on the IndexedDB write.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return { ...actual, saveRoomMessages: vi.fn().mockResolvedValue(true) }
})

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
const ROOM3 = 'room3@conference.example.com'
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
  // scenarios seed the maps and then clear TWO rooms.
  //
  // NOTE: this pair no longer coalesces anything, and the name says so. With no
  // baseline for this key yet, the FIRST write sees every present gap as an
  // addition and force-flushes, which CLOSES the window; the second clear is
  // therefore not coalesced behind it but takes a fresh leading edge of its own.
  // Measured: 1 write after the first clear, 2 after the second, still 2 after
  // `flush()` — the trailing flush writes nothing, because nothing is pending.
  // What survives is that both clears reach disk. The gap-side COALESCING half
  // lives in `still coalesces a gap shrink once the baseline is established`
  // below, which establishes the baseline first so the window can stay open.
  it('persists both gap-anchor clears across two rooms', () => {
    // GapInterval is { start, end?, startId?, endId? } — epoch ms, not Dates.
    roomStore.setState({
      roomGaps: new Map([
        [ROOM, { start: 1000, startId: 'gap-anchor-1' }],
        [ROOM2, { start: 2000, startId: 'gap-anchor-2' }],
      ]),
    })
    localStorageMock.setItem.mockClear()

    roomStore.getState().clearRoomGapAnchor(ROOM, 'gap-anchor-1') // leading edge, force-flushed
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'gap-anchor-2') // fresh leading edge
    flush() // writes nothing — kept only so the assertions read as end-state

    const raw = localStorage.getItem('fluux-room-gaps') ?? ''
    expect(raw).not.toContain('gap-anchor-1')
    expect(raw).not.toContain('gap-anchor-2')
  })

  // NOTE: a coverage REMOVAL is now force-flushed (design §4.2), so what this
  // test still pins is that both removals reach disk — not coalescing, and the
  // name says so. As with its gap twin above, the first write also force-flushes
  // on the unknown baseline and closes the window, so the second removal takes a
  // fresh leading edge rather than being coalesced. The coalescing half lives in
  // the `topId` refresh test in the structural-durability suite below, which
  // drives the one coverage transition that is still throttled.
  it('persists both coverage removals across two rooms', () => {
    // CoverageRecord is { bottomId, topId? }.
    roomStore.setState({
      roomCoverage: new Map([
        [ROOM, { bottomId: 'cov-1' }],
        [ROOM2, { bottomId: 'cov-2' }],
      ]),
    })
    localStorageMock.setItem.mockClear()

    roomStore.getState().clearRoomCoverage(ROOM) // leading edge, force-flushed
    roomStore.getState().clearRoomCoverage(ROOM2) // fresh leading edge
    flush() // writes nothing — kept only so the assertions read as end-state

    const raw = localStorage.getItem('fluux-room-coverage') ?? ''
    expect(raw).not.toContain('cov-1')
    expect(raw).not.toContain('cov-2')
  })

  // `advanceReadPointer` persists only when: connectionStore.windowVisible is
  // true (it defaults to true, so no setup needed), the room is in `rooms`,
  // it has a `roomMeta` entry, and the message id is resident. `addRoom` with
  // a populated `messages` array satisfies the last three.
  it('coalesces room read state and keeps the latest pointer', () => {
    roomStore.getState().addRoom(createRoom(ROOM, {
      joined: true,
    }), [
      createMessage('r1', ROOM, 'alice', 'first', false, new Date(1000)),
      createMessage('r2', ROOM, 'alice', 'second', false, new Date(2000)),
    ])
    localStorageMock.setItem.mockClear()

    // NOTE: `addRoom` itself ends with `persistRoomReadState`, so the
    // read-state window is ALREADY OPEN here — unlike the gap and coverage
    // scenarios above, neither call below is a leading edge. Both coalesce,
    // and the second replaces the first in the pending thunk. (mockClear
    // resets the write counter; it does not close the window.)
    roomStore.getState().advanceReadPointer(ROOM, { id: 'r1' }) // coalesced
    roomStore.getState().advanceReadPointer(ROOM, { id: 'r2' }) // replaces the pending thunk
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
    roomStore.getState().addRoom(createRoom(ROOM, {
      joined: true,
    }), [
      createMessage('read-first', ROOM, 'alice', 'a', false, new Date(1000)),
      createMessage('read-pending', ROOM, 'alice', 'b', false, new Date(2000)),
    ])
    // Leave a pending write on each of the three keys. Gaps and coverage open
    // their window on the first clear; read state's is already open, since
    // `addRoom` above ended with `persistRoomReadState`.
    roomStore.getState().clearRoomGapAnchor(ROOM, 'gap-first')
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'gap-pending')
    roomStore.getState().clearRoomCoverage(ROOM)
    roomStore.getState().clearRoomCoverage(ROOM2)
    roomStore.getState().advanceReadPointer(ROOM, { id: 'read-first' })
    roomStore.getState().advanceReadPointer(ROOM, { id: 'read-pending' })

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
    roomStore.getState().addRoom(createRoom(ROOM, {
      joined: true,
    }), [
      createMessage('r-first', ROOM, 'alice', 'a', false, new Date(1000)),
      createMessage('r-pending', ROOM, 'alice', 'b', false, new Date(2000)),
    ])
    // `addRoom` already opened the read-state window, so both of these
    // coalesce and 'r-pending' is left sitting in the pending thunk.
    roomStore.getState().advanceReadPointer(ROOM, { id: 'r-first' })
    roomStore.getState().advanceReadPointer(ROOM, { id: 'r-pending' })

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

  /** A Phase B page: a plain backward query resumed id-exactly from the
   *  recorded bottom, extending the same contiguous run. */
  function deepenCoverage(room: string, from: string, to: string): void {
    roomStore.getState().mergeRoomMAMMessages(
      room, [], { first: to }, false, 'backward', false, false, { initialBefore: from }
    )
  }

  it('persists a gap FORMATION that was coalesced into an open window', () => {
    // TWO throttled writes are needed before the formation, and the order is
    // load-bearing (§5.5).
    //
    // The FIRST gaps write of a session has no baseline, so every gap present
    // reads as an addition and it force-flushes — which CLOSES the window.
    // (Measured: with only one preparatory write, the formation landed on a
    // fresh leading edge and would have been persisted by a plain `schedule`
    // too, so the test could not tell "flush on formation" from "flush on any
    // gaps write".) So: write #1 establishes the baseline and closes the window,
    // write #2 — a monotone shrink against that baseline, hence throttled —
    // takes the leading edge and leaves the window OPEN, and only then is the
    // formation genuinely the coalesced-but-forced case.
    roomStore.setState({
      roomGaps: new Map([
        [ROOM2, { start: 1000, startId: 'anchor-2' }],
        [ROOM3, { start: 2000, startId: 'anchor-3' }],
      ]),
    })
    roomStore.getState().clearRoomGapAnchor(ROOM2, 'anchor-2') // baseline established, window CLOSED
    roomStore.getState().clearRoomGapAnchor(ROOM3, 'anchor-3') // shrink → leading edge → window OPEN
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

  // The gap-side twin of the `topId` refresh guard below: §4.2's "gaps: shrink /
  // close / removal → throttle" row. Without it a mutant that force-flushes on
  // EVERY gaps write passes the whole suite — every durability test still goes
  // green, because flushing more is never less durable.
  //
  // The shrink is driven through a real backward "load older" merge: a page that
  // reaches from above the gap down INTO it moves `end` down and leaves `start` /
  // `startId` alone (`closeGapWithBackwardPage`). That is the whole asymmetry —
  // the hole closing from below is a lagging mirror; the boundary moving up is
  // not. (This case used to be driven with `clearRoomGapAnchor`, which strips
  // `startId`: now a boundary change, hence force-flushed, so it no longer states
  // the row it was written to state.)
  //
  // Same shape as the formation test: write #1 establishes the baseline and
  // closes the window (the unknown-baseline force-flush), write #2 opens it, and
  // write #3 is the one that must be coalesced.
  it('still coalesces a gap shrink once the baseline is established', () => {
    for (const room of [ROOM2, ROOM3]) {
      roomStore.getState().addRoom(createRoom(room, { joined: true }))
    }
    const start = new Date('2026-05-14T09:00:00Z').getTime()
    roomStore.setState({
      roomGaps: new Map([
        [ROOM, { start: 500, startId: 'anchor-1' }],
        [ROOM2, { start, end: new Date('2026-05-14T18:00:00Z').getTime(), startId: 'anchor-2' }],
        [ROOM3, { start, end: new Date('2026-05-14T18:00:00Z').getTime(), startId: 'anchor-3' }],
      ]),
    })
    roomStore.getState().clearRoomGapAnchor(ROOM, 'anchor-1') // baseline established, window CLOSED

    /** A backward page landing inside the gap: `end` moves down to its oldest. */
    const shrink = (room: string, oldest: string): void => {
      roomStore.getState().mergeRoomMAMMessages(
        room,
        [
          { ...createMessage(`lo-${room}`, room, 'a', 'lo', false, new Date(oldest)), noLocalStore: true } as RoomMessage,
          { ...createMessage(`hi-${room}`, room, 'a', 'hi', false, new Date('2026-05-14T19:00:00Z')), noLocalStore: true } as RoomMessage,
        ],
        { first: `lo-${room}` }, false, 'backward'
      )
    }

    shrink(ROOM2, '2026-05-14T15:00:00Z') // shrink → leading edge → window OPEN
    shrink(ROOM3, '2026-05-14T14:00:00Z') // shrink → coalesced, NOT force-flushed

    // `start` / `startId` untouched on both — this really is an end-only move.
    expect(roomStore.getState().roomGaps.get(ROOM3)).toMatchObject({ start, startId: 'anchor-3' })

    expect(gapsOnDisk().get(ROOM2)?.end).toBe(new Date('2026-05-14T15:00:00Z').getTime())
    expect(gapsOnDisk().get(ROOM3)?.end).toBe(new Date('2026-05-14T18:00:00Z').getTime()) // still pending

    flush()
    expect(gapsOnDisk().get(ROOM3)?.end).toBe(new Date('2026-05-14T14:00:00Z').getTime())
  })

  /**
   * The crash/restart path a lost gap BOUNDARY opens.
   *
   * A multi-page forward catch-up advances `start`/`startId` under the SAME gap
   * key on each incomplete page (`MAM_CATCHUP_FORWARD_BAIL_PAGES` = 3, so at
   * most three), then bails to a `before:''` fetch-latest. If only the first
   * page (the formation) is forced out of the window, a hard kill leaves disk
   * holding a STALE, LOWER boundary — and the true hole above it can then be
   * erased by a backward "load older" page that closes the stale interval.
   *
   * Three pages is the minimum that discriminates: page 1 force-flushes on the
   * formation and CLOSES the window, page 2 therefore takes a fresh leading edge
   * and lands regardless, and only page 3 is genuinely coalesced (§5.5).
   */
  it('persists the LATEST boundary of a multi-page forward catch-up', () => {
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))

    const page1 = new Date('2026-05-14T09:00:00Z')
    const page2 = new Date('2026-05-14T10:00:00Z')
    const page3 = new Date('2026-05-14T11:00:00Z')

    // Page 1 — the gap FORMATION. Force-flushed, window CLOSED.
    roomStore.getState().mergeRoomMAMMessages(
      ROOM, unstoredPage('p1', page1), { last: 'arc-1' }, false, 'forward'
    )
    expect(roomStore.getState().roomGaps.get(ROOM)?.startId).toBe('arc-1')

    // Page 2 — same key, higher hole. Leading edge (window was closed), so it
    // lands either way; what matters is that it re-OPENS the window.
    roomStore.getState().mergeRoomMAMMessages(
      ROOM, unstoredPage('p2', page2), { last: 'arc-2' }, false, 'forward'
    )
    expect(gapsOnDisk().get(ROOM)?.startId).toBe('arc-2')

    // Page 3 — the boundary advance that lands inside an OPEN window.
    roomStore.getState().mergeRoomMAMMessages(
      ROOM, unstoredPage('p3', page3), { last: 'arc-3' }, false, 'forward'
    )
    expect(roomStore.getState().roomGaps.get(ROOM)).toMatchObject({
      start: page3.getTime(), startId: 'arc-3',
    })

    // The hard kill: no timer advance, no flush, no lifecycle event. Then the
    // restart reads whatever is on disk.
    expect(gapsOnDisk().get(ROOM)).toMatchObject({ start: page3.getTime(), startId: 'arc-3' })
  })

  /**
   * The user-visible harm, carried one step further: a "load older" page that
   * lands between the stale anchor and the true one destroys the gap outright.
   *
   * `closeGapWithBackwardPage` reads a backward page against `gap.start`:
   * `newestTs <= start` → the page is entirely below the gap and says nothing;
   * `oldestTs <= start` → the regions connect → CLEAR. A page spanning
   * [09:00, 10:30] therefore hits opposite branches depending on the anchor:
   *
   * - true anchor 11:00 → `newestTs (10:30) <= 11:00` → gap PRESERVED, still
   *   healable next session;
   * - stale anchor 10:00 → `oldestTs (09:00) <= 10:00` → gap CLEARED, and the
   *   real hole above 11:00 is now unrecorded while the forward cursor already
   *   sits above it. Silent forever.
   *
   * Driven through the real store actions: multi-page catch-up, hard kill,
   * rehydrate from whatever is on disk, one backward merge.
   */
  it('keeps the gap healable after a load-older page that would erase a stale one', () => {
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))

    const pages = [
      new Date('2026-05-14T09:00:00Z'),
      new Date('2026-05-14T10:00:00Z'),
      new Date('2026-05-14T11:00:00Z'),
    ]
    for (const [i, ts] of pages.entries()) {
      roomStore.getState().mergeRoomMAMMessages(
        ROOM, unstoredPage(`p${i + 1}`, ts), { last: `arc-${i + 1}` }, false, 'forward'
      )
    }

    // Hard kill — no timer, no flush — then restart on whatever disk holds.
    const restored = gapsOnDisk()
    roomStore.getState().reset()
    roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
    roomStore.setState({ roomGaps: restored })

    // "Load older": a page that sits entirely below the TRUE hole but straddles
    // the stale anchor.
    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [
        { ...createMessage('older', ROOM, 'a', 'older', false, new Date('2026-05-14T09:00:00Z')), noLocalStore: true } as RoomMessage,
        { ...createMessage('newer', ROOM, 'a', 'newer', false, new Date('2026-05-14T10:30:00Z')), noLocalStore: true } as RoomMessage,
      ],
      { first: 'older' }, false, 'backward'
    )

    expect(roomStore.getState().roomGaps.get(ROOM)).toMatchObject({ start: pages[2].getTime() })
  })

  it('persists a coverage REPLACEMENT that was coalesced into an open window', () => {
    roomStore.getState().addRoom(createRoom(ROOM, {
      joined: true,
    }), [createMessage('held', ROOM, 'a', 'held', false, new Date('2026-07-20T00:00:00Z'))])

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
    }), [createMessage('held', ROOM, 'a', 'held', false, new Date('2026-07-20T00:00:00Z'))])
    createCoverage(ROOM, 'cov-bottom', 'top-1')
    localStorageMock.setItem.mockClear()

    refreshCoverageTop(ROOM, 'cov-bottom', 'top-2') // leading edge → window OPEN
    refreshCoverageTop(ROOM, 'cov-bottom', 'top-3') // coalesced, NOT force-flushed
    expect(writeCount()).toBe(1)
    expect(coverageOnDisk().get(ROOM)).toEqual({ bottomId: 'cov-bottom', topId: 'top-2' })

    flush()
    expect(coverageOnDisk().get(ROOM)).toEqual({ bottomId: 'cov-bottom', topId: 'top-3' })
  })

  /**
   * #1138, room side. Room coverage lives under its OWN key rather than inside
   * a whole-store blob, so each forced write is cheap — but the FREQUENCY is
   * the same, and every one of them still closes the window for the next.
   *
   * Three rooms, because the first coverage write of a session has no baseline
   * and force-flushes on that rule alone (closing the window), the second takes
   * a fresh leading edge (opening it), and only the third is genuinely the
   * coalesced case (§5.5).
   */
  it('coalesces coverage bootstraps across rooms', () => {
    for (const room of [ROOM, ROOM2, ROOM3]) {
      roomStore.getState().addRoom(createRoom(room, { joined: true }))
    }
    localStorageMock.setItem.mockClear()

    createCoverage(ROOM, 'cov-1', 'top-1') // unknown baseline → forced, window CLOSED
    createCoverage(ROOM2, 'cov-2', 'top-1') // creation → throttled → leading edge, window OPEN
    expect(writeCount()).toBe(2)

    createCoverage(ROOM3, 'cov-3', 'top-1') // creation → coalesced

    // 3 under #1133's "key added → force-flush".
    expect(writeCount()).toBe(2)
    expect(coverageOnDisk().has(ROOM3)).toBe(false)

    flush()
    expect(coverageOnDisk().get(ROOM3)).toEqual({ bottomId: 'cov-3', topId: 'top-1' })
  })

  it('coalesces a Phase B bottomId deepening', () => {
    for (const room of [ROOM, ROOM2]) {
      roomStore.getState().addRoom(createRoom(room, { joined: true }))
    }
    localStorageMock.setItem.mockClear()

    createCoverage(ROOM, 'deep-0', 'top-1') // unknown baseline → forced, window CLOSED
    createCoverage(ROOM2, 'other', 'top-1') // creation → leading edge, window OPEN
    expect(writeCount()).toBe(2)

    deepenCoverage(ROOM, 'deep-0', 'deep-1')
    deepenCoverage(ROOM, 'deep-1', 'deep-2')
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({ bottomId: 'deep-2', topId: 'top-1' })

    expect(writeCount()).toBe(2) // 4 under #1133
    flush()
    expect(coverageOnDisk().get(ROOM)).toEqual({ bottomId: 'deep-2', topId: 'top-1' })
  })

  /**
   * The DEFERRED replacement — the room twin of the chat case.
   *
   * A merge carrying persistable messages gates its coverage transition on the
   * IndexedDB commit, so the record lands from `scheduleDeferredCommit` rather
   * than from the merge's own `set`. Reporting the transition at merge time
   * would arm the flush for a write that still carries the OLD record. Timers
   * are never advanced and `flush()` is never called.
   */
  it('persists a DEFERRED coverage replacement that was coalesced into an open window', async () => {
    for (const room of [ROOM, ROOM2]) {
      roomStore.getState().addRoom(createRoom(room, { joined: true }))
    }
    createCoverage(ROOM, 'deep-old', 'top-1') // unknown baseline → forced, window CLOSED
    createCoverage(ROOM2, 'other', 'top-1') // creation → leading edge, window OPEN
    localStorageMock.setItem.mockClear()

    // A storable page, so the transition defers behind the durable write.
    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [createMessage('p1', ROOM, 'a', 'p1', false, new Date('2026-05-14T09:00:00Z'))],
      { first: 'new-shallow' }, true, 'backward', false, true, { sawCoverageTop: false },
    )
    // Deliberately still the old record: the transition has NOT applied yet.
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({ bottomId: 'deep-old', topId: 'top-1' })

    // Drain the save chain's microtasks WITHOUT advancing the throttle timer.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({ bottomId: 'new-shallow' })

    expect(coverageOnDisk().get(ROOM)).toEqual({ bottomId: 'new-shallow' })
  })

  it('persists a coverage REMOVAL that was coalesced into an open window', () => {
    for (const room of [ROOM, ROOM2]) {
      roomStore.getState().addRoom(createRoom(room, {
        joined: true,
      }), [createMessage(`held-${room}`, room, 'a', 'held', false, new Date('2026-07-20T00:00:00Z'))])
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
