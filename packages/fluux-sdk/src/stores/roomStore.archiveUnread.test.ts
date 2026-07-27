/**
 * Task 8 (PR B) — roomStore.recomputeUnreadForRoom: archive-derived unread,
 * coverage-gated, latest-wins, mentionsCount-preserving, divider-rederiving.
 *
 * Mirrors chatStore.archiveUnread.test.ts (Task 7) — see that file for the
 * shared derivation's full rationale. This file additionally covers the
 * room-specific control: two messages sharing an `id` but sent by different
 * occupants (`from`) are two distinct archive positions, not one.
 *
 * Unlike roomStore.test.ts / roomStore.mds.test.ts, this file does NOT fully
 * mock `../utils/messageCache` — `countRoomUnreadInArchive` and
 * `resolveArchivePosition` run for REAL against fake-indexeddb (wrapped in
 * `vi.fn(actual)` only so the latest-wins test can control resolution order
 * for one call). Everything else in messageCache is the real implementation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { roomStore, _resetRoomReadStateForTesting } from './roomStore'
import { noteTransient, removeTransient, transientIdentity, transientAliases, clearTransientScope, type ScopeKey } from './shared/transientUnread'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import type { Room, RoomMessage } from '../core/types'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    // Real by default; wrapped so individual tests can control resolution
    // order (vi.fn.mockImplementationOnce) without disabling the real cursor.
    countRoomUnreadInArchive: vi.fn(actual.countRoomUnreadInArchive),
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
    roomStore.getState().addRoom(createRoom(ROOM))
    // mockClear() only resets call history, never the base implementation set
    // by vi.fn(actual.countRoomUnreadInArchive) above, so it stays real by default.
    vi.mocked(messageCache.countRoomUnreadInArchive).mockClear()
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
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(3)
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(3)
  })

  // Room-specific control (Task 8): room ids are not unique per sender — a
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
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // Both same-id rows count — NOT deduped to 1.
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
  })

  it('a migrated pointer with no archiveOrderKey over-counts same-millisecond rows rather than reporting zero', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      // Same millisecond as the pointer's own message — an unresolved pointer
      // key must NOT exclude this (over-count is the safe direction).
      archiveMsg('sibling', 1000, { from: `${ROOM}/bob`, nick: 'bob' }),
    ])
    setMeta({
      unreadCount: 0,
      // Legacy/migrated shape: no archiveOrderKey at all.
      readPointer: { messageId: 'p0', timestamp: new Date(1000) },
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
    setMeta({ unreadCount: 0, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } } })
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

  // ---------------------------------------------------------------------
  // trigger: pointer advance / inbound remote marker
  // ---------------------------------------------------------------------

  it('a remote marker advancing a non-active room triggers a recount', () => {
    setMeta({ unreadCount: 0, readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } } })
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
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState({ activeRoomJid: ROOM })

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(5)
  })

  // ---------------------------------------------------------------------
  // deferred
  // ---------------------------------------------------------------------

  it('a pointerless entity with a nonzero persisted count defers rather than trusting a zero derivation', async () => {
    await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' })])
    setMeta({
      unreadCount: 4,
      readPointer: undefined,
      historyFloor: new Date(0), // ensure a floor exists so !floor isn't what defers this
    })
    seedCoverage('anchor-stanza')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(4)
  })

  // The reviewer's control (requirement 1, mirrored from Task 7): the legacy
  // pass runs — and its OWN pointer-advance guard fires (an outgoing message
  // moves the pointer) — and its would-be COUNT differs sharply from the
  // persisted one (2 vs 5). The persisted value must survive untouched
  // because coverage is not proven.
  it('CRITICAL: not caught up defers, and the persisted count survives even though recomputeCountsFromPointer ran and moved the pointer', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('p0', 1000),
      archiveMsg('out1', 1001, { isOutgoing: true }), // the user replied — advances the pointer
      archiveMsg('u1', 1002),
      archiveMsg('u2', 1003),
    ])
    setMeta({
      unreadCount: 5, // the persisted/trusted value
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    // Deliberately NOT caught up (default mamQueryStates), and no coverage record.

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    // The legacy guard pass DID run and DID advance the pointer to 'out1'
    // (the reply) — that pointer-advance guard behavior is kept. Its own
    // count over the post-out1 slice (u1, u2) would be 2, not 5 — that
    // would-be count is discarded; the persisted 5 survives.
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.messageId).toBe('out1')
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(5)
  })

  it('a missing coverage record defers (not-yet-covered is not the same as nothing to worry about)', async () => {
    await messageCache.saveRoomMessages([archiveMsg('p0', 1000), archiveMsg('u1', 1001)])
    setMeta({
      unreadCount: 7,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
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
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    // bottomId names an archive stanza-id that was never saved — unresolvable.
    seedCoverage('nonexistent-stanza-id')

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(6)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // latest-wins
  // ---------------------------------------------------------------------

  it('latest-wins: a slow recount started before a fast one must not overwrite the fast one', async () => {
    await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
    setMeta({
      unreadCount: 0,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
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
  })

  // ---------------------------------------------------------------------
  // divider rederivation
  // ---------------------------------------------------------------------

  it('a remote advance rederives the divider to the new boundary', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
      archiveMsg('u1', 1001),
    ])
    setMeta({
      unreadCount: 99,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // A stale marker left over from a previous activation.
    roomStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(ROOM, 'stale-marker-id')
      return { firstNewMessageMarkers: markers }
    })

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('u1')
  })

  it('deletes the divider marker when the derived count is zero', async () => {
    await messageCache.saveRoomMessages([
      archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
      archiveMsg('p0', 1000),
    ])
    setMeta({
      unreadCount: 99,
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    roomStore.setState((state) => {
      const markers = new Map(state.firstNewMessageMarkers)
      markers.set(ROOM, 'stale-marker-id')
      return { firstNewMessageMarkers: markers }
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
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('deferred outcome', async () => {
      setMeta({ unreadCount: 3, mentionsCount: SEEDED_MENTIONS, readPointer: { messageId: 'p0', timestamp: new Date(1000) } })
      // Not caught up — defers.

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(SEEDED_MENTIONS)
    })

    it('unavailable outcome', async () => {
      await messageCache.saveRoomMessages([archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }), archiveMsg('p0', 1000)])
      setMeta({
        unreadCount: 3,
        mentionsCount: SEEDED_MENTIONS,
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
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
      readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
    })
    seedCoverage('anchor-stanza')
    // One never-archived (noLocalStore) message, after the pointer.
    const key = scopeKey()
    noteTransient(
      key,
      { position: { timestamp: 1500 } },
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
        readPointer: { messageId: 'p0', timestamp: new Date(1000), archiveOrderKey: { kind: 'room', from: ROOM + '/alice', id: 'p0' } },
      })
      seedCoverage('anchor-stanza')
    })

    const m1 = { roomJid: ROOM, from: `${ROOM}/dave`, id: 'm1' }
    const m2 = { roomJid: ROOM, from: `${ROOM}/erin`, id: 'm2' }

    it('re-noting the same logical message through a new alias does not increment the visible count twice', async () => {
      const key = scopeKey()
      const r1 = noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      expect(r1.added).toBe(true)
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

      // Same logical message re-noted (plain alias registration, nothing new).
      const r2 = noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      expect(r2.added).toBe(false)
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1) // NOT 2
    })

    it('retracting the only transient unread moves the visible count 1 -> 0', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

      const removed = removeTransient(key, transientIdentity(m1, 'room'))
      expect(removed.removed).toBe(true)
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
    })

    it('removing one of two transient unread messages moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      noteTransient(key, { position: { timestamp: 1600 } }, transientIdentity(m2, 'room'), transientAliases(m2, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)

      removeTransient(key, transientIdentity(m1, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
    })

    it('a bridging alias that coalesces two separately-counted transient entries moves the visible count 2 -> 1', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, 'origin-key-O', ['origin-key-O'])
      noteTransient(key, { position: { timestamp: 1500 } }, 'stanza-key-S', ['stanza-key-S'])
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)

      // A copy carrying BOTH tiers bridges them: added:false, requiresRecount:true.
      const r = noteTransient(key, { position: { timestamp: 1500 } }, 'stanza-key-S', ['stanza-key-S', 'origin-key-O'])
      expect(r).toEqual({ added: false, requiresRecount: true })
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
    })

    it('an overlay change while not caught up stays conservative and does not clear the trusted count', async () => {
      const key = scopeKey()
      noteTransient(key, { position: { timestamp: 1500 } }, transientIdentity(m1, 'room'), transientAliases(m1, 'room'))
      await roomStore.getState().recomputeUnreadForRoom(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

      // Coverage proof is lost (e.g. a fresh reconnect before this session's
      // catch-up has re-run) — subsequent recomputes must defer.
      roomStore.setState((state) => {
        const mamQueryStates = new Map(state.mamQueryStates)
        mamQueryStates.set(ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: false })
        return { mamQueryStates }
      })
      noteTransient(key, { position: { timestamp: 1600 } }, transientIdentity(m2, 'room'), transientAliases(m2, 'room'))

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      // Deferred: the trusted count (1) survives — NOT recomputed to 2, and
      // NOT cleared to 0 either.
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)
    })
  })
})
