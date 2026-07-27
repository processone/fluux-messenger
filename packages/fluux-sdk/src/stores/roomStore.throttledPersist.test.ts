import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { roomStore } from './roomStore'
import { _resetForTesting, flush } from './shared/throttledStorage'
import { _clearAllRoomReadStateForTesting } from './shared/readStateStorage'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { createRoom, createMessage } from './roomStore.testHelpers'

const ROOM = 'room@conference.example.com'

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
    const ROOM2 = 'room2@conference.example.com'
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

  it('coalesces coverage writes across two rooms', () => {
    const ROOM2 = 'room2@conference.example.com'
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
    const ROOM2 = 'room2@conference.example.com'
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
