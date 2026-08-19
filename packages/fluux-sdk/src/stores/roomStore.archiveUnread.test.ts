/**
 * roomStore.recomputeUnreadForRoom: archive-derived unread,
 * coverage-gated, latest-wins, mentionsCount-preserving, divider-rederiving.
 *
 * Mirrors chatStore.archiveUnread.test.ts — see that file for the
 * shared derivation's full rationale. This file additionally covers the
 * room-specific control: two messages sharing an `id` but sent by different
 * occupants (`from`) are two distinct cache positions, not one.
 *
 * Unlike roomStore.test.ts / roomStore.internal.mds.test.ts, this file does NOT fully
 * mock `../utils/messageCache` — `countRoomUnreadInArchive` and
 * `resolveArchivePosition` run for REAL against fake-indexeddb (wrapped in
 * `vi.fn(actual)` only so the latest-wins test can control resolution order
 * for one call). Everything else in messageCache is the real implementation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { roomStore, _resetRoomReadStateForTesting } from './roomStore'
import { noteTransient, removeTransient, transientIdentity, transientAliases, clearTransientScope, transientCounts, type ScopeKey } from './shared/transientUnread'
import { _resetStorageScopeForTesting, getStorageScopeJid, setStorageScopeJid } from '../utils/storageScope'
import { readRecountDeferrals, resetRecountDeferralsForTesting } from './shared/recountDiagnostics'
import type { Room, RoomMessage } from '../core/types'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    // Real by default; wrapped so individual tests can control resolution
    // order (vi.fn.mockImplementationOnce) without disabling the real cursor.
    getRoomMessages: vi.fn(actual.getRoomMessages),
    countRoomUnreadInArchive: vi.fn(actual.countRoomUnreadInArchive),
    saveRoomMessageWithResult: vi.fn(actual.saveRoomMessageWithResult),
    saveRoomMessages: vi.fn(actual.saveRoomMessages),
  }
})
import * as messageCache from '../utils/messageCache'
import { makeCacheOrderKey, type ExactPosition } from './shared/readState'

const countRoomUnreadInArchiveImplementation = vi.mocked(messageCache.countRoomUnreadInArchive).getMockImplementation()!
const saveRoomMessageWithResultImplementation = vi.mocked(messageCache.saveRoomMessageWithResult).getMockImplementation()!
const saveRoomMessagesImplementation = vi.mocked(messageCache.saveRoomMessages).getMockImplementation()!

/**
 * A transient entry's position.
 *
 * These tests exercise identity, aliasing, coalescing and counting — never
 * tie-breaks — so every fixture shares ONE key. Same-millisecond fixtures then
 * compare equal, exactly as they did when they carried no key at all, while
 * `ExactPosition` still holds: a transient entry is always noted from a real
 * message, so in production its tie-break always resolves (#1173).
 */
const FIXTURE_TIEBREAK = makeCacheOrderKey({ from: 'fixture@x', id: 'fixture' }, 'room')
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

const ROOM = 'lounge@conference.example.com'

function createRoom(jid: string): Room {
  return {
    jid,
    name: jid,
    nickname: 'me',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    messages: [],
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

/** An archived room message. `from` defaults to a per-message occupant so a
 *  bare `{ id }` override still resolves to a valid `room/nick` JID. */
function archiveMsg(id: string, ts: number, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    type: 'groupchat',
    id,
    roomJid: ROOM,
    from: `${ROOM}/alice`,
    nick: 'alice',
    body: 'hi',
    timestamp: new Date(ts),
    isOutgoing: false,
    ...overrides,
  }
}

/** Mark the room caught-up-to-live with a coverage record whose bottom
 *  resolves to a REAL archived row at `bottomTs` (must be saved separately). */
function seedCoverage(bottomId: string): void {
  roomStore.setState((state) => {
    const mamQueryStates = new Map(state.mamQueryStates)
    mamQueryStates.set(ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
    const roomCoverage = new Map(state.roomCoverage)
    roomCoverage.set(ROOM, { bottomId })
    return { mamQueryStates, roomCoverage }
  })
}

function setMeta(patch: Record<string, unknown>): void {
  roomStore.setState((state) => {
    const meta = new Map(state.roomMeta)
    meta.set(ROOM, { ...(meta.get(ROOM) ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }), ...patch } as never)
    return { roomMeta: meta }
  })
}

function scopeKey(): ScopeKey {
  return { accountScope: getStorageScopeJid() ?? '', kind: 'room', entityId: ROOM }
}

describe('roomStore.recomputeUnreadForRoom — archive-derived unread (PR B, Task 8)', () => {
  beforeEach(async () => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as unknown as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
    localStorageMock.clear()
    roomStore.getState().reset()
    _resetRoomReadStateForTesting()
    resetRecountDeferralsForTesting()
    roomStore.getState().addRoom(createRoom(ROOM))
    // Reset queued one-shot implementations as well as call history so a
    // deliberately failing race test cannot contaminate the next test.
    vi.mocked(messageCache.getRoomMessages).mockClear()
    vi.mocked(messageCache.countRoomUnreadInArchive).mockReset()
    vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementation(countRoomUnreadInArchiveImplementation)
    vi.mocked(messageCache.saveRoomMessageWithResult).mockReset()
    vi.mocked(messageCache.saveRoomMessageWithResult).mockImplementation(saveRoomMessageWithResultImplementation)
    vi.mocked(messageCache.saveRoomMessages).mockReset()
    vi.mocked(messageCache.saveRoomMessages).mockImplementation(saveRoomMessagesImplementation)
    // The transient overlay is a module-level singleton (never cleared on
    // deactivation by design) — reset it between tests explicitly.
    clearTransientScope(getStorageScopeJid() ?? '')
  })

  // ---------------------------------------------------------------------
  // exact
  // ---------------------------------------------------------------------

  it('backgrounded deep pointer with proven coverage derives an exact count from the archive', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      archiveMsg('u2', 1002),
      archiveMsg('u3', 1003),
    ])
    setMeta({
      unreadCount: 99, // stale — must be overwritten by the exact derivation
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(3)
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(3)
  })

  // Room-specific control: room ids are not unique per sender — a
  // reflected/relayed id collision from two different occupants must count
  // as two distinct positions, never deduped to one.
  it('two messages sharing an id but sent by different occupants count as two distinct positions', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('dup', 1001, { from: `${ROOM}/bob`, nick: 'bob', stanzaId: 's-bob-dup' }),
      archiveMsg('dup', 1002, { from: `${ROOM}/charlie`, nick: 'charlie', stanzaId: 's-charlie-dup' }),
    ])
    setMeta({
      unreadCount: 0,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // Both same-id rows count — NOT deduped to 1.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
  })

  it('a migrated pointer with no tiebreak over-counts same-millisecond rows rather than reporting zero', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      // Same millisecond as the pointer's own message — an unresolved pointer
      // key must NOT exclude this (over-count is the safe direction).
      archiveMsg('sibling', 1000, { from: `${ROOM}/bob`, nick: 'bob' }),
    ])
    setMeta({
      unreadCount: 0,
      // Legacy/migrated shape: no tiebreak at all.
      readPointer: { order: { role: 'floor', timestamp: new Date(1000).getTime() }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // At-or-after-TIMESTAMP semantics: with the pointer's key unresolved,
    // EVERY row at its exact millisecond counts as "after" it — including the
    // pointer's own message ('p0') — not just the genuinely-new 'sibling'.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
  })

  // ---------------------------------------------------------------------
  // trigger: cold-start rehydrate
  // ---------------------------------------------------------------------
  // Rooms have no persist middleware (unlike chatStore) — the cold-start
  // trigger is wired into StateSnapshot.hydrate() instead. See
  // stateSnapshot.test.ts's "cold-start rehydrate schedules a recount for
  // every restored room".

  // ---------------------------------------------------------------------
  // trigger: forward MAM merge past the floor
  // ---------------------------------------------------------------------

  it('a forward MAM merge into a non-active room with new messages triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } } })
    roomStore.setState({ activeRoomJid: 'someone-else@conference.example.com' })
    const original = roomStore.getState().recomputeUnreadForRoom
    const spy = vi.fn(original)
    roomStore.setState({ recomputeUnreadForRoom: spy })

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [archiveMsg('u1', 1001)],
      { first: 'u1' },
      true,
      'forward'
    )

    expect(spy).toHaveBeenCalledWith(ROOM)
    roomStore.setState({ recomputeUnreadForRoom: original })
  })

  it('a pointerless room with trusted unread keeps its count and pointer during a forward merge', () => {
    setMeta({ unreadCount: 4, readPointer: undefined })
    roomStore.setState({ activeRoomJid: 'someone-else@conference.example.com' })

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [archiveMsg('u1', 1001)],
      { first: 'u1' },
      true,
      'forward'
    )

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(4)
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.readPointer).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // trigger: pointer advance / inbound remote marker
  // ---------------------------------------------------------------------

  it('a remote marker advancing a non-active room triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } } })
    roomStore.setState({ activeRoomJid: 'someone-else@conference.example.com' })
    const original = roomStore.getState().recomputeUnreadForRoom
    const spy = vi.fn(original)
    roomStore.setState({ recomputeUnreadForRoom: spy })

    roomStore.getState().applyRemoteDisplayed(ROOM, 's-u1', [
      archiveMsg('p0', 1000, { stanzaId: 's-p0' }),
      archiveMsg('u1', 1001, { stanzaId: 's-u1' }),
    ])

    expect(spy).toHaveBeenCalledWith(ROOM)
    roomStore.setState({ recomputeUnreadForRoom: original })
  })

  // ---------------------------------------------------------------------
  // does not touch the active room
  // ---------------------------------------------------------------------

  it('does not touch the active room (activation owns its counts)', async () => {
    // A real pointer + proven coverage that WOULD derive an exact count of 0
    // (nothing archived after p0) if this guard were missing — isolating the
    // active-room check from pointerlessDefers, which would otherwise defer
    // this scenario on its own and hide a missing guard.
    await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
    setMeta({
      unreadCount: 5,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState({ activeRoomJid: ROOM })

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(5)
  })

  // resolveRemoteDisplayed resolves
  // 'advanced-with-divider' — not 'advanced' — for the ACTIVE room, and that
  // branch used to be exempted from triggering a recount on the premise that
  // an active entity's count was "already zero". A
  // spy-only assertion ("was recomputeUnreadForRoom called?") would pass even
  // if the default active-room no-op above still applied to it — the real
  // regression is that the count never actually changes — so this test
  // drives a REAL archive derivation (fake-indexeddb) end to end and asserts
  // the committed number, not just that a call happened.
  it('a remote marker advancing the ACTIVE room re-derives its unread count', async () => {
    await messageCache.saveRoomMessages([
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
      readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState({ activeRoomJid: ROOM })

    const messages = [
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000, { stanzaId: 's-p0' }),
      archiveMsg('u1', 1001, { stanzaId: 's-u1' }),
      archiveMsg('u2', 1002, { stanzaId: 's-u2' }),
      archiveMsg('u3', 1003, { stanzaId: 's-u3' }),
    ]
    // Another device's XEP-0490 marker advances the read position to p0
    // WHILE this room is active.
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-p0', messages)

    // Still active throughout — this is not a "became inactive" race. The
    // pointer advance and divider reposition are applied synchronously inside
    // applyRemoteDisplayed's own `set()` call, so these don't need to wait for
    // the fire-and-forget recount below.
    expect(roomStore.getState().activeRoomJid).toBe(ROOM)
    // The pointer advanced (resolveRemoteDisplayed's job, unaffected by this fix).
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('p0')
    // The divider was positioned at the first message after the new pointer.
    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('u1')
    // The count is re-derived from the archive (u1, u2, u3), not left
    // at the stale 99 a guard that still exempted the active room would
    // produce. The recount is fire-and-forget (cache read, coverage resolve,
    // and countRoomUnreadInArchive are all real async calls against
    // fake-indexeddb) — poll for the derived value instead of guessing a tick
    // count, which under full-suite load can resolve before the recount lands.
    await vi.waitFor(() => {
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(3)
    }, { timeout: 2000 })
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(3)
  })

  // ---------------------------------------------------------------------
  // deferred
  // ---------------------------------------------------------------------

  // #1174: this used to seed `historyFloor: new Date(0)` against a coverage
  // anchor at t=500, which put the coverage bottom ABOVE the floor — so
  // `isAfterBoundary` deferred the recount before `pointerlessDefers` could
  // matter, and the surviving count proved the coverage gate had fired, not
  // the guard — both former room `pointerlessDefers` call sites could be deleted
  // with this test still green. The coverage-gate branch it was really
  // exercising already has its own unambiguous test ("a resolved coverage
  // bottom sitting above the floor defers"), so this one is repaired to test
  // what it names:
  // the bottom (400) now sits BELOW the floor (500), leaving the guard as the
  // ONLY thing that can stand this recount down. Counterpart to chatStore's
  // "NONZERO persisted count still defers via pointerlessDefers".
  it('a pointerless room with a nonzero persisted count defers at pointerlessDefers, not at the coverage gate', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 400, { stanzaId: 'anchor-stanza' }),
      archiveMsg('m1', 1000),
      archiveMsg('m2', 1001),
      archiveMsg('m3', 1002),
    ])
    seedCoverage('anchor-stanza')
    setMeta({ unreadCount: 6, readPointer: undefined, historyFloor: new Date(500) })

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(6)
    // Assert the mechanism, not just the outcome: the guard must stop the
    // derivation before it ever reads the archive, not merely produce a count
    // that happens to match the seed.
    expect(vi.mocked(messageCache.countRoomUnreadInArchive)).not.toHaveBeenCalled()
    // #1174 + #1214: proves the `pointerless-defer` reason is still emitted,
    // and still reachable, now that the duplicate guard is gone. (It does NOT
    // pin the number of call sites: a guard that returns emits once whether
    // there is one copy or two. What makes the single site matter is that the
    // reason now has exactly one origin, so a recorded defer is unambiguous.)
    expect(readRecountDeferrals()['room:pointerless-defer']).toBe(1)
  })

  // The reviewer's control
  // for the deleted pointer-writing pass. It no longer proves "the count is discarded" by
  // showing the legacy guard pass moved the POINTER while the count stayed
  // put; that pass no longer exists, so the control is rebuilt around the
  // surviving mechanism: coverage IS seeded and resolvable and the archive IS
  // populated, so the ONLY thing deferring this recount is the caught-up gate.
  // Remove that gate and the derivation lands a sharply different 2 (u1, u2
  // after 'p0'; the outgoing 'out1' never counts) over the trusted 5 — so 5
  // surviving is evidence, not an absence of activity. The pointer assertion
  // is the D6 half: in a MUC `isOutgoing` is attributed by nick, and an
  // outgoing message in the counted range must no longer drag the
  // forward-only read position onto itself.
  it('CRITICAL: not caught up defers, the persisted count survives, and the recount never moves the pointer onto an outgoing message', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('out1', 1001, { isOutgoing: true }), // the user replied from another device
      archiveMsg('u1', 1002),
      archiveMsg('u2', 1003),
    ])
    setMeta({
      unreadCount: 5, // the persisted/trusted value
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    // Coverage IS proven and resolvable — but mamQueryStates is left at its
    // default (NOT caught up to live), so the caught-up gate is the single
    // reason this recount defers.
    roomStore.setState((state) => {
      const roomCoverage = new Map(state.roomCoverage)
      roomCoverage.set(ROOM, { bottomId: 'anchor-stanza' })
      return { roomCoverage }
    })

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('p0')
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(5)
  })

  it('a missing coverage record defers (not-yet-covered is not the same as nothing to worry about)', async () => {
    await messageCache.saveRoomMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 7,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    roomStore.setState((state) => {
      const mamQueryStates = new Map(state.mamQueryStates)
      mamQueryStates.set(ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
      // No roomCoverage record at all.
      return { mamQueryStates }
    })

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(7)
  })

  it('an unresolvable coverage bottom defers AND invalidates the stale record', async () => {
    await messageCache.saveRoomMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 6,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    // bottomId names an archive stanza-id that was never saved — unresolvable.
    seedCoverage('nonexistent-stanza-id')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(6)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(readRecountDeferrals()['room:coverage-unresolvable']).toBe(1)
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
    await messageCache.saveRoomMessages([
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
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('gap-anchor-stanza')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // If the gate proceeded (the bug), it would derive u1+gap-anchor+u2 = 3
    // and overwrite the trusted count — a silent under-count from the
    // reader's point of view (real unread could sit in the unproven gap).
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(8)
  })

  // ---------------------------------------------------------------------
  // latest-wins
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Same-millisecond live-arrival ordering
  // ---------------------------------------------------------------------

  // appendLive used to append live arrivals in ARRIVAL order (never sorted),
  // while the archive (and every OTHER resident-array construction path —
  // loadOlderSlice/loadNewerSlice/latestSlice) orders same-millisecond room
  // rows by (from, id). The viewport observer advances the read pointer by
  // RESIDENT INDEX (`advanceReadPointer` → `onMessageSeen`'s forward-only
  // guard), so an unsorted resident array can let that guard make the WRONG
  // forward/no-op decision, landing the stored pointer on the wrong message
  // and skewing the later archive-derived count. The 'zulu' occupant's
  // message arrives FIRST (wall-clock) but cache-sorts AFTER the 'alice'
  // occupant's `(from, id)` tie-break — arrival order deliberately disagrees with
  // cache order, the exact case the fix reconciles.
  it('two same-millisecond live arrivals land in cache order, so the viewport-advance pointer and derived count are both correct', async () => {
    await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    seedCoverage('anchor-stanza')
    roomStore.setState({ activeRoomJid: ROOM })

    const T = 5000
    roomStore.getState().addMessage(ROOM, archiveMsg('m1', T, { from: `${ROOM}/zulu`, nick: 'zulu' }))
    // Viewport observer reports zulu's message seen while it is the only resident message.
    roomStore.getState().advanceReadPointer(ROOM, 'm1')
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m1')
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.order).toMatchObject({ tiebreak: { from: `${ROOM}/zulu` } })

    // A same-millisecond message from a DIFFERENT occupant arrives live, SECOND.
    roomStore.getState().addMessage(ROOM, archiveMsg('m2', T, { from: `${ROOM}/alice`, nick: 'alice' }))
    // The resident array must be in CACHE order ((from, id) ascending — alice
    // before zulu), not arrival order — the load-bearing invariant
    // messageTimeline.test.ts pins at the pure-function level; here it is
    // asserted through the real store.
    expect(roomStore.getState().rooms.get(ROOM)?.messages.map((m) => m.from)).toEqual([
      `${ROOM}/alice`,
      `${ROOM}/zulu`,
    ])

    // The observer reports alice's message seen too, as it scrolls into view.
    // Alice's message now sits BEFORE zulu's in the (correctly sorted)
    // resident array, so the forward-only guard must NOT move the pointer
    // backward past the already-confirmed zulu message.
    roomStore.getState().advanceReadPointer(ROOM, 'm2')
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m1')

    // Settle: the user navigates away, and the archive-derived recompute runs.
    roomStore.setState({ activeRoomJid: null })
    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // Both same-millisecond messages were genuinely seen (both reported via
    // advanceReadPointer) — the derived count must be 0. Reverting the sort
    // lets alice's message get appended last, wrongly advances the pointer TO
    // it, and zulu's message — already-confirmed-seen — then archive-sorts
    // AFTER it and gets wrongly counted as unread.
    await vi.waitFor(() => {
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
    })
  })

  // ---------------------------------------------------------------------
  // Active-but-scrolled-up noLocalStore
  // arrivals must be recorded in the overlay
  // ---------------------------------------------------------------------

  // noteAsTransient used to be gated on isUnseenIncomingMessage's COARSE
  // isActive && windowVisible check (no viewport dimension), so an active,
  // focused, but SCROLLED-UP room (never reported at-edge) looked "seen" to
  // it — a noLocalStore arrival there took the live +1 (correct at the time,
  // via onMessageReceived's OWN gate, which does track viewportAtLiveEdge)
  // but was never noted in the overlay. Since a noLocalStore message is NEVER
  // archived, the next EXACT recount — deriving purely from the archive —
  // silently dropped its contribution back to 0.
  it('an active-but-scrolled-up noLocalStore arrival is recorded in the overlay and survives an exact recount', async () => {
    await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    setMeta({
      unreadCount: 0,
      readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
    })
    seedCoverage('anchor-stanza')
    // Active + focused (default windowVisible), but viewportAtLiveEdge is
    // never reported — stays at its conservative 'unknown' default, i.e.
    // scrolled up / not at the live edge.
    roomStore.setState({ activeRoomJid: ROOM })

    // Untyped literal (not `: RoomMessage`) deliberately — `noLocalStore` is
    // an internal augmentation (`message-internal.ts`), not on the public
    // `RoomMessage` type; an explicit annotation here would trip TS's
    // excess-property check.
    const ephemeral = {
      type: 'groupchat' as const,
      id: 'ephemeral-1',
      roomJid: ROOM,
      from: `${ROOM}/bob`,
      nick: 'bob',
      body: 'Ephemeral',
      timestamp: new Date(1000),
      isOutgoing: false,
      noLocalStore: true,
    }
    roomStore.getState().addMessage(ROOM, ephemeral)

    // The live +1 fires (correct at the time — onMessageReceived's own gate
    // refused the pointer advance since viewportAtLiveEdge isn't 'at-edge').
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
    // Also recorded in the overlay — a noLocalStore message's ONLY
    // durable representation, since it is never archived.
    expect(
      transientCounts({ accountScope: getStorageScopeJid() ?? '', kind: 'room', entityId: ROOM }, undefined).unread
    ).toBe(1)

    // Settle: the room deactivates and an EXACT archive recount runs
    // (coverage is proven, a real readPointer exists — this is not a defer).
    roomStore.setState({ activeRoomJid: null })
    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // The real archive has NO row for the ephemeral message (it was never
    // saved) — without the transient overlay the overlay would be empty here too, and the
    // count would silently drop to 0.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
  })

  it('latest-wins: a slow recount started before a fast one must not overwrite the fast one', async () => {
    await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
    setMeta({
      unreadCount: 0,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseSlow!: (v: { unread: number }) => void
    vi.mocked(messageCache.countRoomUnreadInArchive)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve }))
      .mockImplementationOnce(async () => ({ unread: 2 }))

    const slow = roomStore.getState().recomputeUnreadForRoom(ROOM) // A
    await vi.waitFor(() => expect(releaseSlow).toBeDefined())
    const fast = roomStore.getState().recomputeUnreadForRoom(ROOM) // B
    await fast

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)

    releaseSlow({ unread: 55 })
    await slow

    // A (slow) resolved LAST but must be discarded — B's result stands.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
    expect(readRecountDeferrals()['room:recount-superseded']).toBe(1)
    expect(readRecountDeferrals()['room:context-changed']).toBeUndefined()
  })

  it('holds an invalidated active pointer recount until forward catch-up durably completes', async () => {
    const p0 = archiveMsg('p0', 1000)
    const p1 = archiveMsg('p1', 1500)
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      p0,
      p1,
    ])
    roomStore.setState((state) => {
      const rooms = new Map(state.rooms)
      rooms.set(ROOM, { ...rooms.get(ROOM)!, messages: [p0, p1] })
      return { rooms, messages: new Map(state.messages).set(ROOM, [p0, p1]) }
    })
    setMeta({
      unreadCount: 5,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countRoomUnreadInArchive)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseCount = resolve }))
      .mockImplementationOnce(async () => ({ unread: 7 }))

    roomStore.setState({ activeRoomJid: ROOM })
    roomStore.getState().advanceReadPointer(ROOM, 'p1')
    await vi.waitFor(() => expect(releaseCount).toBeDefined())
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('p1')

    roomStore.getState().addMessage(ROOM, archiveMsg('live', 2000))
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(6)
    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [archiveMsg('catchup-1', 2100)],
      { first: 'catchup-1', last: 'catchup-1' },
      false,
      'forward'
    )

    releaseCount({ unread: 3 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(messageCache.countRoomUnreadInArchive).toHaveBeenCalledTimes(1)
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(6)

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [archiveMsg('catchup-2', 2200)],
      { first: 'catchup-2', last: 'catchup-2' },
      true,
      'forward'
    )

    await vi.waitFor(() => {
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(7)
    })
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(7)
    expect(messageCache.countRoomUnreadInArchive).toHaveBeenCalledTimes(2)
    expect(readRecountDeferrals()['room:input-version-changed']).toBe(1)
    expect(readRecountDeferrals()['room:context-changed']).toBeUndefined()
  })

  it('retains a failed live cache write in the unread recount overlay', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      ...Array.from({ length: 5 }, (_, index) => archiveMsg(`u${index + 1}`, 1100 + index)),
    ])
    setMeta({
      unreadCount: 5,
      readPointer: { order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: `${ROOM}/alice`, id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState({ activeRoomJid: ROOM })

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCount = resolve })
    )
    vi.mocked(messageCache.saveRoomMessageWithResult).mockResolvedValueOnce(false)

    const stale = roomStore.getState().recomputeUnreadForRoom(ROOM, { allowActive: true })
    await vi.waitFor(() => expect(releaseCount).toBeDefined())
    roomStore.getState().addMessage(ROOM, archiveMsg('live-write-failed', 2000))
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(6)

    releaseCount({ unread: 5 })
    await stale

    await vi.waitFor(() => {
      expect(messageCache.countRoomUnreadInArchive).toHaveBeenCalledTimes(2)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(6)
    })
    expect(transientCounts(scopeKey(), undefined).unread).toBe(1)
  })

  it('resumes a held active recount after a backward archive write commits', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('older', 700),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 5,
      readPointer: { order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: `${ROOM}/alice`, id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState({ activeRoomJid: ROOM })

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countRoomUnreadInArchive)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseCount = resolve }))
      .mockImplementationOnce(async () => ({ unread: 7 }))
    let releaseSave!: (committed: boolean) => void
    vi.mocked(messageCache.saveRoomMessages).mockImplementationOnce(
      () => new Promise((resolve) => { releaseSave = resolve })
    )

    const stale = roomStore.getState().recomputeUnreadForRoom(ROOM, { allowActive: true })
    await vi.waitFor(() => expect(releaseCount).toBeDefined())
    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [archiveMsg('older', 700)],
      { first: 'older', last: 'older' },
      true,
      'backward'
    )
    releaseCount({ unread: 3 })
    await stale
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(messageCache.countRoomUnreadInArchive).toHaveBeenCalledTimes(1)
    releaseSave(true)

    await vi.waitFor(() => {
      expect(messageCache.countRoomUnreadInArchive).toHaveBeenCalledTimes(2)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(7)
    })
  })

  it('settles a live write when an unrelated room is removed', async () => {
    const otherRoom = 'other@conference.example.com'
    roomStore.getState().addRoom(createRoom(otherRoom))
    roomStore.setState({ activeRoomJid: ROOM })
    let releaseSave!: (committed: boolean) => void
    vi.mocked(messageCache.saveRoomMessageWithResult).mockImplementationOnce(
      () => new Promise((resolve) => { releaseSave = resolve })
    )

    roomStore.getState().addMessage(ROOM, archiveMsg('pending-live', 2000))
    expect(transientCounts(scopeKey(), undefined).unread).toBe(1)

    roomStore.getState().removeRoom(otherRoom)
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
    roomStore.getState().switchAccount(accountA)
    roomStore.getState().addRoom(createRoom(ROOM))
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 7,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCount = resolve })
    )

    const stale = roomStore.getState().recomputeUnreadForRoom(ROOM)
    await vi.waitFor(() => expect(releaseCount).toBeDefined())

    // The account scope moves on while the archive read is in flight.
    setStorageScopeJid(accountB)

    releaseCount({ unread: 55 })
    await stale

    expect(getStorageScopeJid()).toBe(accountB)
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(7)
    expect(readRecountDeferrals()['room:context-changed']).toBe(1)
  })

  // final-fix-2: the race the re-reviewer flagged, room twin of
  // chatStore.archiveUnread.test.ts's. An `allowActive` recompute (this fix's
  // new advanceReadPointer trigger runs one) can be in flight while a DIRECT
  // writer — onMessageReceived's own live-edge convergence, which commits
  // straight to roomMeta and does NOT bump roomRecountVersion — advances the
  // pointer and writes a fresh, correct count in the meantime.
  // roomRecountVersion's "latest-wins" guard above only orders a recompute
  // against ANOTHER recompute; it does nothing here. Re-reading the pointer
  // at commit time (added by this fix) is what closes this specific gap.
  it('a stale allowActive recompute does not clobber a pointer/count that moved via a direct write while it awaited the archive read', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
    ])
    setMeta({
      unreadCount: 5, // stale — the slow recompute below would derive 1 (u1) from THIS pointer
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState({ activeRoomJid: ROOM })

    let releaseCount!: (v: { unread: number }) => void
    vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementationOnce(
      () => new Promise((resolve) => { releaseCount = resolve })
    )

    // The allowActive recompute this fix's advanceReadPointer trigger would
    // schedule — started while the pointer is still 'p0'.
    const slow = roomStore.getState().recomputeUnreadForRoom(ROOM, { allowActive: true })
    await vi.waitFor(() => expect(releaseCount).toBeDefined())

    // While the slow recompute awaits the archive count, a DIRECT write (NOT
    // going through recomputeUnreadForRoom, exactly like onMessageReceived's
    // live-edge commit) advances the pointer to the newest message and
    // writes the correct, fresh count.
    roomStore.setState((state) => {
      const meta = new Map(state.roomMeta)
      meta.set(ROOM, {
        ...meta.get(ROOM)!,
        unreadCount: 0,
        readPointer: { order: { role: 'exact', timestamp: new Date(1001).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'u1' } }, identity: { state: 'local', messageId: 'u1' } },
      })
      return { roomMeta: meta }
    })

    // The slow recompute's archive read finally resolves — computed against
    // the OLD pointer ('p0'), it would derive 1 (u1) if it committed.
    releaseCount({ unread: 1 })
    await slow

    // The direct write's fresher, correct state survives untouched.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('u1')
    expect(readRecountDeferrals()['room:pointer-changed']).toBe(1)
  })

  // ---------------------------------------------------------------------
  // divider rederivation
  // ---------------------------------------------------------------------

  /** Park a stale divider marker on the ACTIVE room, with `messages` resident. */
  function seedActiveWithStaleMarker(messages: RoomMessage[]): void {
    roomStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(ROOM, 'stale-marker-id')
      return {
        firstNewMessageMarkers: markers,
        activeRoomJid: ROOM,
        messages: new Map(state.messages).set(ROOM, messages),
      }
    })
  }

  // The rederivation scans the RESIDENT array now
  // (the guard pass's cache-window read went with the guard pass), so this
  // test drives the path that actually reaches it — an `allowActive` recount
  // on the ACTIVE room. That is the only path in production: a marker survives
  // only while an entity is active (deactivation deletes it), and both
  // allowActive triggers follow a pointer advance. The seeded marker is a
  // distinct stale id, so 'u1' can only come from a real rederivation.
  it('a remote advance rederives the divider to the new boundary', async () => {
    const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
    const p0 = archiveMsg('p0', 1000)
    const u1 = archiveMsg('u1', 1001)
    await messageCache.saveRoomMessages([anchor, p0, u1])
    setMeta({
      unreadCount: 99,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    seedActiveWithStaleMarker([anchor, p0, u1])

    await roomStore.getState().recomputeUnreadForRoom(ROOM, { allowActive: true })

    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('u1')
    // The count is re-derived too (u1), not left at the stale 99.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
  })

  it('keeps the ACTIVE room\'s divider when the pointer has caught up to the newest message', async () => {
    // Opening a room short enough to fit on screen: the viewport reports the
    // newest message immediately, the pointer lands past the divider, and the
    // allowActive recount that advance schedules used to delete the divider a
    // few milliseconds after it appeared. Chat twin in
    // chatStore.archiveUnread.test.ts.
    const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
    const p0 = archiveMsg('p0', 1000)
    const u1 = archiveMsg('u1', 1001)
    await messageCache.saveRoomMessages([anchor, p0, u1])
    setMeta({
      unreadCount: 1,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState((state) => {
      const nextMessages = new Map(state.messages).set(ROOM, [anchor, p0, u1])
      const markers = new Map(state.firstNewMessageMarkers)
      // The divider activation parked on the first unread message.
      markers.set(ROOM, 'u1')
      return { activeRoomJid: ROOM, messages: nextMessages, firstNewMessageMarkers: markers }
    })

    roomStore.getState().advanceReadPointer(ROOM, 'u1')
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('u1')

    // The count converges (the advance's whole purpose) — but the divider the
    // reader is looking at survives. Clearing it belongs to read-through
    // scroll, Esc, mark-all-read, or deactivation.
    await vi.waitFor(() => {
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
    }, { timeout: 2000 })
    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('u1')
  })

  // A BACKGROUND room with a RESIDENT array deliberately, so the deletion is a
  // real "nothing sits after the boundary" answer rather than the vacuous one an
  // empty slice always gives. Retiring a stale marker is the background half of
  // the rule the two tests above pin for the active half.
  it('deletes the divider marker when the derived count is zero', async () => {
    const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
    const p0 = archiveMsg('p0', 1000)
    await messageCache.saveRoomMessages([anchor, p0])
    setMeta({
      unreadCount: 99,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(ROOM, 'stale-marker-id')
      return {
        firstNewMessageMarkers: markers,
        activeRoomJid: null,
        messages: new Map(state.messages).set(ROOM, [anchor, p0]),
      }
    })

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
    expect(roomStore.getState().firstNewMessageMarkers.has(ROOM)).toBe(false)
  })

  // ---------------------------------------------------------------------
  // mentionsCount is NEVER written (three outcomes)
  // ---------------------------------------------------------------------

  describe('mentionsCount is left unchanged by every outcome', () => {
    // Unlike chat, rooms have a REAL mentionsCount — this is directly
    // testable here, and required: it must survive exact/deferred/unavailable
    // recounts untouched, same as chat's spread-preserved (unused) field.
    const SEEDED_MENTIONS = 7

    it('exact outcome', async () => {
      await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      // Seeded unreadCount (5) deliberately differs from the true exact
      // derivation (0, since nothing is archived after the pointer) — this
      // forces the commit path to actually run (a no-op "nothing changed"
      // skip would let a broken mentionsCount-dropping write hide undetected).
      setMeta({
        unreadCount: 5,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('deferred outcome', async () => {
      setMeta({ unreadCount: 3, mentionsCount: SEEDED_MENTIONS, readPointer: { order: { role: 'floor', timestamp: new Date(1000).getTime() }, identity: { state: 'local', messageId: 'p0' } } })
      // Not caught up — defers.

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('unavailable outcome', async () => {
      await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 3,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')
      vi.mocked(messageCache.countRoomUnreadInArchive).mockResolvedValueOnce(null)

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(SEEDED_MENTIONS)
      // unavailable also leaves unreadCount untouched.
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(3)
    })
  })

  // ---------------------------------------------------------------------
  // transient overlay
  // ---------------------------------------------------------------------

  it('the transient overlay is summed into the committed unread count', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
      archiveMsg('u2', 1002),
    ])
    setMeta({
      unreadCount: 0,
      readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // One never-archived (noLocalStore) message, after the pointer.
    const key = scopeKey()
    noteTransient(
      key,
      { position: posAt(1500) },
      transientIdentity({ roomJid: ROOM, from: `${ROOM}/dave`, id: 'ephemeral-1' }, 'room'),
      transientAliases({ roomJid: ROOM, from: `${ROOM}/dave`, id: 'ephemeral-1' }, 'room')
    )

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // 2 archived (u1, u2) + 1 transient = 3.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(3)
  })

  // ---------------------------------------------------------------------
  // Store-level projection tests (overlay mutation -> recompute -> projection)
  // ---------------------------------------------------------------------

  describe('store-level projection: overlay mutations correctly move the committed count', () => {
    // No archived unread in any of these — the committed count is driven
    // purely by the transient overlay, so the assertions are unambiguous.
    beforeEach(async () => {
      await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 0,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')
    })

    const m1 = { roomJid: ROOM, from: `${ROOM}/dave`, id: 'm1' }
    const m2 = { roomJid: ROOM, from: `${ROOM}/erin`, id: 'm2' }

    it('re-noting the same logical message through a new alias does not increment the visible count twice', async () => {
      const key = scopeKey()
      const r1 = noteTransient(key, { position: posAt(1500) }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      expect(r1.added).toBe(true)
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

      // Same logical message re-noted (plain alias registration, nothing new).
      const r2 = noteTransient(key, { position: posAt(1500) }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      expect(r2.added).toBe(false)
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1) // NOT 2
    })

    it('retracting the only transient unread moves the visible count 1 -> 0', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

      const removed = removeTransient(key, transientIdentity(m1, 'room'))
      expect(removed.removed).toBe(true)
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
    })

    it('removing one of two transient unread messages moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      noteTransient(key, { position: posAt(1600) }, transientIdentity(m2, 'room'), transientAliases(m2, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)

      removeTransient(key, transientIdentity(m1, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
    })

    it('a bridging alias that coalesces two separately-counted transient entries moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, 'origin-key-O', ['origin-key-O'])
      noteTransient(key, { position: posAt(1500) }, 'stanza-key-S', ['stanza-key-S'])
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)

      // A copy carrying BOTH tiers bridges them: added:false, requiresRecount:true.
      const r = noteTransient(key, { position: posAt(1500) }, 'stanza-key-S', ['stanza-key-S', 'origin-key-O'])
      expect(r).toEqual({ added: false, requiresRecount: true })
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
    })

    it('an overlay change while not caught up stays conservative and does not clear the trusted count', async () => {
      const key = scopeKey()
      noteTransient(key, { position: posAt(1500) }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

      // Coverage proof is lost (e.g. a fresh reconnect before this session's
      // catch-up has re-run) — subsequent recomputes must defer.
      roomStore.setState((state) => {
        const mamQueryStates = new Map(state.mamQueryStates)
        mamQueryStates.set(ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: false })
        return { mamQueryStates }
      })
      noteTransient(key, { position: posAt(1600) }, transientIdentity(m2, 'room'), transientAliases(m2, 'room'))

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      // Deferred: the trusted count (1) survives — NOT recomputed to 2, and
      // NOT cleared to 0 either.
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
    })
  })

  // ---------------------------------------------------------------------
  // final-fix-2: the previous fix wave removed onActivate's force-zero for
  // the active entity but added no replacement trigger — a pointer that
  // advances (live-edge convergence) or an entity that deactivates
  // never re-derived the COUNT to match. These tests pin the two triggers
  // this fix adds: advanceReadPointer and setActiveRoom's deactivation
  // branch — the room twins of chatStore.archiveUnread.test.ts's. Every seed
  // below is a NONZERO value distinct from the correct outcome.
  // ---------------------------------------------------------------------

  describe('final-fix-2: pointer-advance and deactivation triggers re-derive the count', () => {
    /** Seed the room's resident window (roomRuntime.messages) directly. */
    function seedResident(messages: RoomMessage[]): void {
      roomStore.setState((state) => {
        return { messages: new Map(state.messages).set(ROOM, messages) }
      })
    }

    it('acceptance scenario 5: live-edge convergence (pointer reaches the newest message while active+focused) converges the count to 0', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      const m2 = archiveMsg('m2', 1001)
      const m3 = archiveMsg('m3', 1002)
      await messageCache.saveRoomMessages([anchor, m1, m2, m3])
      setMeta({
        unreadCount: 5, // stale — distinct from the correct 0 derived below
        readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
      })
      seedCoverage('anchor-stanza')
      // Active + focused (default windowVisible), with the full history
      // resident — this is the "scrolled to the bottom" precondition.
      roomStore.setState({ activeRoomJid: ROOM })
      seedResident([anchor, m1, m2, m3])

      // The viewport observer reports the NEWEST resident message seen —
      // reaching the live edge.
      roomStore.getState().advanceReadPointer(ROOM, 'm3')
      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m3')

      // Poll for the fire-and-forget archive recount (this fix's trigger) to
      // settle, rather than guessing a tick count.
      await vi.waitFor(() => {
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      }, { timeout: 2000 })

      // Still active throughout — this is scenario 5's store half.
      expect(roomStore.getState().activeRoomJid).toBe(ROOM)
    })

    it('a partial pointer advance (not to the newest) decreases the count to the correct remaining number', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      const m2 = archiveMsg('m2', 1001)
      const m3 = archiveMsg('m3', 1002)
      await messageCache.saveRoomMessages([anchor, m1, m2, m3])
      setMeta({
        unreadCount: 5, // stale — distinct from BOTH 0 and the correct 2
        readPointer: { order: { role: 'exact', timestamp: new Date(500).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'anchor' } }, identity: { state: 'local', messageId: 'anchor' } },
      })
      seedCoverage('anchor-stanza')
      roomStore.setState({ activeRoomJid: ROOM })
      seedResident([anchor, m1, m2, m3])

      // The viewport observer reports 'm1' seen — the user scrolled PARTWAY,
      // not to the bottom. 'm2' and 'm3' remain genuinely unread.
      roomStore.getState().advanceReadPointer(ROOM, 'm1')
      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m1')

      // Exactly 2 remaining (m2, m3) — neither the stale 5 (trigger missing)
      // nor a wrongly-zeroed 0 (a broken floor/pointer would over-clear).
      await vi.waitFor(() => {
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
      }, { timeout: 2000 })
    })

    it('reading a room to the bottom then deactivating reconciles the stale badge instead of leaving it stuck', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      await messageCache.saveRoomMessages([anchor, m1])
      // The pointer already sits at the newest message (as if the user had
      // read to the bottom through some OTHER path than advanceReadPointer —
      // isolating the deactivation trigger from the advance trigger tested
      // above) while unreadCount is stale.
      setMeta({
        unreadCount: 5, // stale — distinct from the correct 0
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'm1' } }, identity: { state: 'local', messageId: 'm1' } },
      })
      seedCoverage('anchor-stanza')
      roomStore.getState().addRoom(createRoom('other-room@conference.example.com'))
      roomStore.setState({ activeRoomJid: ROOM })

      // Switch away — exercises setActiveRoom's deactivation branch, NOT
      // advanceReadPointer (never called in this test).
      roomStore.getState().setActiveRoom('other-room@conference.example.com')
      expect(roomStore.getState().activeRoomJid).toBe('other-room@conference.example.com')

      await vi.waitFor(() => {
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      }, { timeout: 2000 })
    })

    // final-fix-3: room twin of chatStore.archiveUnread.test.ts's. The test
    // above (fully read, pointer already at the newest message) converges to
    // 0 — but 0 is ALSO exactly what a naive "just write 0 on deactivation"
    // implementation would produce, the force-zero behaviour this PR is
    // walking back from onActivate. A seed-5/assert-0 fixture with the
    // pointer at the newest message can't tell "recount ran and correctly
    // derived 0" apart from "deactivation force-zeroed it". This test
    // isolates the deactivation trigger with the pointer at a NON-newest
    // message, so genuinely unread messages remain and the true
    // archive-derived answer is a nonzero remainder: a force-zero
    // implementation would produce 0 (wrong), "trigger missing" would leave
    // the stale 5 (also wrong), and only a real recount lands on 2.
    it('deactivating with the pointer short of the newest message reconciles to the true nonzero remainder, not zero', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const p0 = archiveMsg('p0', 1000)
      const u1 = archiveMsg('u1', 1001)
      const u2 = archiveMsg('u2', 1002)
      await messageCache.saveRoomMessages([anchor, p0, u1, u2])
      // The pointer is seeded directly at p0 — NOT the newest message — so u1
      // and u2 are genuinely still unread. This isolates the deactivation
      // trigger from the advance trigger (advanceReadPointer is never called
      // here), same as the fully-read sibling test above.
      setMeta({
        unreadCount: 5, // stale — distinct from BOTH 0 (naive force-zero) and the correct 2
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')
      roomStore.getState().addRoom(createRoom('other-room@conference.example.com'))
      roomStore.setState({ activeRoomJid: ROOM })

      // Switch away — exercises setActiveRoom's deactivation branch, NOT
      // advanceReadPointer (never called in this test).
      roomStore.getState().setActiveRoom('other-room@conference.example.com')
      expect(roomStore.getState().activeRoomJid).toBe('other-room@conference.example.com')

      // The true archive-derived remainder (u1, u2) — not the stale 5 and not
      // a force-zeroed 0.
      await vi.waitFor(() => {
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
      }, { timeout: 2000 })
    })
  })

  // ---------------------------------------------------------------------
  // The pointer-writing recount (recomputeCountsFromPointer) is
  // gone. Both of its pointer effects — the fresh-entity snap and the
  // outgoing-boundary advance — were heuristics that could move the
  // forward-only read pointer past messages the user never saw. In a MUC the
  // outgoing-boundary advance is the worse of the two: `isOutgoing`
  // misattribution (nick reuse, multi-session) destroys the read position.
  // ---------------------------------------------------------------------

  describe('the guard pass no longer writes the pointer (PR C, D6)', () => {
    // The MERGE schedules its recount fire-and-forget (`void get().recompute...`),
    // so asserting the pointer straight after the merge resolves proves NOTHING —
    // the guard pass may not have run yet, and a count seeded at 0 that is still 0
    // is not evidence either. Drive the recount explicitly and await it, THEN
    // assert. Both assertions below are chosen so a surviving guard pass changes
    // them.
    it('a forward merge + recount does NOT snap a fresh room pointer to the newest message', async () => {
      await messageCache.saveRoomMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('h1', 600),
        archiveMsg('h2', 700),
      ])
      // Fresh entity: no pointer, and history predating its creation watermark.
      setMeta({ unreadCount: 0, mentionsCount: 4, readPointer: undefined, historyFloor: new Date(1000) })
      seedCoverage('anchor-stanza')

      roomStore.getState().mergeRoomMAMMessages(
        ROOM,
        [archiveMsg('h1', 600), archiveMsg('h2', 700)],
        { first: 'h1', last: 'h2' },
        true,
        'forward'
      )
      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      // A surviving fresh-entity snap would put this at 'h2'.
      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBeUndefined()
      // No unreadCount assertion here: seeded at 0 and asserting 0 can't tell
      // "floored correctly at the creation watermark" apart from "deferred and
      // touched nothing" — the sibling test below ("messages arriving after
      // creation…", seeded 0, asserts 2) is the one that actually exercises the
      // historyFloor-derived count.
      // Requirement 2: an archive recount never writes mentionsCount.
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(4)
    })

    // The OTHER two call sites: the guard pass inside the derivation itself.
    // Reached with no merge at all, so it needs its own control.
    it('the recount itself does NOT snap a fresh room pointer to the newest message', async () => {
      await messageCache.saveRoomMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('h1', 600),
        archiveMsg('h2', 700),
      ])
      setMeta({ unreadCount: 0, mentionsCount: 4, readPointer: undefined, historyFloor: new Date(1000) })
      seedCoverage('anchor-stanza')

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBeUndefined()
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(4)
    })

    it('the recount itself does NOT advance the pointer to an outgoing message', async () => {
      await messageCache.saveRoomMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('p0', 1000),
        archiveMsg('u1', 1100),
        archiveMsg('mine', 1200, { isOutgoing: true }),
        archiveMsg('u2', 1300),
      ])
      setMeta({
        unreadCount: 3,
        mentionsCount: 4,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      // A surviving outgoing-boundary advance would put this at 'mine' and drop
      // the count to 1 by swallowing u1.
      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('p0')
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(4)
    })

    it('a forward merge does NOT advance the pointer to an outgoing message', async () => {
      await messageCache.saveRoomMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('p0', 1000),
        archiveMsg('u1', 1100),
        archiveMsg('mine', 1200, { isOutgoing: true }),
        archiveMsg('u2', 1300),
        archiveMsg('u3', 1400),
      ])
      setMeta({
        unreadCount: 4,
        mentionsCount: 4,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      roomStore.getState().mergeRoomMAMMessages(
        ROOM,
        [archiveMsg('mine', 1200, { isOutgoing: true })],
        { first: 'mine', last: 'mine' },
        true,
        'forward'
      )
      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      // The reply came from another device. Nothing here is evidence we read u1.
      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('p0')
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(3)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(4)
    })

    it('messages arriving after creation and merged during catch-up count as unread', async () => {
      await messageCache.saveRoomMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('n1', 2000),
        archiveMsg('n2', 3000),
      ])
      setMeta({ unreadCount: 0, mentionsCount: 4, readPointer: undefined, historyFloor: new Date(1000) })
      seedCoverage('anchor-stanza')

      roomStore.getState().mergeRoomMAMMessages(
        ROOM,
        [archiveMsg('n1', 2000), archiveMsg('n2', 3000)],
        { first: 'n1', last: 'n2' },
        true,
        'forward'
      )
      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(4)
    })

    // The race the no-mistakes gate's round-2 fix already
    // closed. This PIN proves the input-version guard is load-bearing, so a later
    // refactor cannot quietly drop it.
    it('a live arrival during an in-flight recount is not clobbered by the stale result', async () => {
      await messageCache.saveRoomMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('p0', 1000),
        archiveMsg('u1', 1100),
      ])
      setMeta({
        unreadCount: 1,
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      // Let the recount reach its archive read, then land an arrival that raises
      // the count WITHOUT moving the pointer — the case the pointer-identity
      // guard alone cannot see.
      vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementationOnce(async (jid, args) => {
        const actual = await vi.importActual<typeof import('../utils/messageCache')>('../utils/messageCache')
        const res = await actual.countRoomUnreadInArchive(jid, args)
        roomStore.getState().addMessage(ROOM, archiveMsg('u2', 1200))
        return res
      })

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      // The stale snapshot said 1; the arrival made it 2. 2 must win.
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
    })
  })

  // ---------------------------------------------------------------------
  // The ACTIVATION trigger. final-fix-2 gave the count two triggers —
  // advanceReadPointer and deactivation — but both are reached only by the
  // read pointer MOVING: advanceReadPointer recounts `if (pointerAdvanced)`,
  // and onMessageSeen returns its input unchanged once the pointer sits on
  // the newest loaded message. A reader who opens a room already at the live
  // edge with the pointer already at newest therefore moves nothing, triggers
  // nothing, and watches a stale badge for as long as the room stays open —
  // the deactivation trigger repairs it only once they leave, so the badge is
  // stuck precisely while it is being looked at. Activation was the one entry
  // point with no recount of its own.
  // ---------------------------------------------------------------------

  describe('activation re-derives the count for the room being entered', () => {
    /** Seed the room's resident window (roomRuntime.messages) directly. */
    function seedResident(messages: RoomMessage[]): void {
      roomStore.setState((state) => {
        return { messages: new Map(state.messages).set(ROOM, messages) }
      })
    }

    it('opening a room whose pointer is already at the newest message clears the stale badge', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const m1 = archiveMsg('m1', 1000)
      await messageCache.saveRoomMessages([anchor, m1])
      // Fully read: the pointer already sits on the newest message, so the
      // viewport observer has nothing left to advance and advanceReadPointer
      // can never schedule a recount. This is the reported defect.
      setMeta({
        unreadCount: 5, // stale — distinct from the correct 0
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'm1' } }, identity: { state: 'local', messageId: 'm1' } },
      })
      seedCoverage('anchor-stanza')
      seedResident([anchor, m1])

      // Open the room. advanceReadPointer is never called in this test, and
      // there is no previous room, so the deactivation trigger cannot fire
      // either — activation is the only trigger under test.
      roomStore.getState().setActiveRoom(ROOM)
      expect(roomStore.getState().activeRoomJid).toBe(ROOM)

      await vi.waitFor(() => {
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      }, { timeout: 2000 })
      // Still active — the badge cleared while the reader sits in the room,
      // which is the whole point (deactivation already covered the rest).
      expect(roomStore.getState().activeRoomJid).toBe(ROOM)
    })

    // The discrimination control, in the spirit of final-fix-3 above: the test
    // above seeds 5 and asserts 0, which a naive "force-zero on activation"
    // would also satisfy — and force-zeroing on activation is exactly the
    // behaviour that was walked back. Here the pointer stops SHORT of the newest
    // message, so genuinely unread messages remain: force-zero lands on 0
    // (wrong), a missing trigger leaves the stale 5 (wrong), and only a real
    // archive derivation lands on 2.
    it('opening a room with the pointer short of the newest message derives the true remainder, not zero', async () => {
      const anchor = archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })
      const p0 = archiveMsg('p0', 1000)
      const u1 = archiveMsg('u1', 1001)
      const u2 = archiveMsg('u2', 1002)
      await messageCache.saveRoomMessages([anchor, p0, u1, u2])
      setMeta({
        unreadCount: 5, // stale — distinct from BOTH 0 (naive force-zero) and the correct 2
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'p0' } }, identity: { state: 'local', messageId: 'p0' } },
      })
      seedCoverage('anchor-stanza')
      seedResident([anchor, p0, u1, u2])

      roomStore.getState().setActiveRoom(ROOM)

      await vi.waitFor(() => {
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
      }, { timeout: 2000 })

      // ...and the "New messages" divider the reader is looking at survives.
      // recomputeUnreadForRoom is reposition-only while the room is ACTIVE;
      // a recount that retired the divider here would reintroduce the defect
      // commit ca26ff35 fixed (divider vanishing right after opening).
      expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('u1')
    })

    it('opening a room whose badge is already clear does not read the archive', async () => {
      await messageCache.saveRoomMessages([
        archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
        archiveMsg('m1', 1000),
      ])
      setMeta({
        unreadCount: 0, // nothing to correct downward
        readPointer: { order: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: ROOM + '/alice', id: 'm1' } }, identity: { state: 'local', messageId: 'm1' } },
      })
      seedCoverage('anchor-stanza')
      vi.mocked(messageCache.countRoomUnreadInArchive).mockClear()

      roomStore.getState().setActiveRoom(ROOM)

      // The guard keeps the common case (opening an already-read room) free of
      // a cache read; an arrival would recount anyway.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(messageCache.countRoomUnreadInArchive).not.toHaveBeenCalled()
    })
  })
})
