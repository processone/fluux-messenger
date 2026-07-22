import { describe, it, expect, beforeEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import { roomSelectors } from './roomSelectors'
import type { Room, RoomMessage } from '../core/types/room'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { connectionStore } from './connectionStore'

// Mock localStorage (required because roomStore uses persist middleware)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock messageCache (required because roomStore imports it)
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    saveRoomMessage: vi.fn().mockResolvedValue(undefined),
    saveRoomMessages: vi.fn().mockResolvedValue(true),
    getRoomMessages: vi.fn().mockResolvedValue([]),
    getRoomMessagesAround: vi.fn().mockResolvedValue([]),
    updateRoomMessage: vi.fn().mockResolvedValue(undefined),
    deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  }
})
import * as messageCache from '../utils/messageCache'

const ROOM = 'room@conference.example'

function rmsg(id: string, stanzaId: string, t: number): RoomMessage {
  return {
    type: 'groupchat',
    id,
    stanzaId,
    roomJid: ROOM,
    from: `${ROOM}/alice`,
    nick: 'alice',
    body: id,
    timestamp: new Date(t),
    isOutgoing: false,
  } as RoomMessage
}

/**
 * Seed a room into the store using the real addRoom idiom (mirrors the
 * activateWith helper in roomStore.test.ts). addRoom populates rooms,
 * roomEntities, roomMeta, and roomRuntime from a single Room object.
 * An optional lastSeenMessageId is patched into roomMeta afterwards.
 */
function seedRoom(jid: string, messages: RoomMessage[], lastSeenMessageId?: string) {
  const room: Room = {
    jid,
    name: getLocalPart(jid),
    nickname: 'testuser',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    messages,
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
  roomStore.getState().addRoom(room)
  if (lastSeenMessageId !== undefined) {
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      const existing = meta.get(jid)!
      meta.set(jid, { ...existing, lastSeenMessageId })
      return { roomMeta: meta }
    })
  }
}

describe('roomStore.applyRemoteDisplayed', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    vi.clearAllMocks()
  })

  it('advances lastSeenMessageId forward to the local id of the matching stanza-id', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's3')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m3')
  })

  it('never regresses lastSeenMessageId (incoming marker behind current)', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm3')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's1')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m3')
  })

  it('stores a pending high-water mark when the stanza-id is not yet loaded', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1)], 'm1')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-future')
    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe('s-future')
    expect(meta?.lastSeenMessageId).toBe('m1')
  })

  it('clears a stale pending marker when the message is loaded but position already past it', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2)], 'm2')
    // Simulate a stale pending set on the room
    const meta = roomStore.getState().roomMeta.get(ROOM)!
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(ROOM, { ...meta, pendingRemoteDisplayedStanzaId: 's1' })
      return { roomMeta: m }
    })
    roomStore.getState().applyRemoteDisplayed(ROOM, 's1')
    const after = roomStore.getState().roomMeta.get(ROOM)
    expect(after?.pendingRemoteDisplayedStanzaId).toBe(undefined)
    expect(after?.lastSeenMessageId).toBe('m2')
  })

  // Fresh-session seed race (MUC): the room is activated (divider derived from the
  // stale local read) BEFORE the async MDS seed lands, so the marker arrives while the
  // room is already active. The divider must be recomputed from the advanced position,
  // not frozen at the stale local one.
  it('recomputes firstNewMessageMarkers when a late marker advances the ACTIVE room past the divider', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4)], 'm2')
    roomStore.setState((s) => {
      const markers = new Map(s.firstNewMessageMarkers)
      markers.set(ROOM, 'm3')
      return { firstNewMessageMarkers: markers, activeRoomJid: ROOM }
    })

    roomStore.getState().applyRemoteDisplayed(ROOM, 's4')

    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m4')
    expect(roomSelectors.firstNewMessageIdFor(ROOM)(roomStore.getState())).toBeUndefined()
  })

  it('does NOT recompute the divider for a non-active room', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4)], 'm2')
    roomStore.setState((s) => {
      const markers = new Map(s.firstNewMessageMarkers)
      markers.set(ROOM, 'm3')
      return { firstNewMessageMarkers: markers, activeRoomJid: 'other@conference.example' }
    })

    roomStore.getState().applyRemoteDisplayed(ROOM, 's4')

    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m4')
    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('m3')
  })

  // Inbound read-state sync (spec §4): a marker published by another client
  // clears a backgrounded room's badge immediately, not on the next activation.
  it('applyRemoteDisplayed on a non-active room recomputes badge counts', () => {
    const messages = [
      rmsg('m1', 's1', 1),
      rmsg('m2', 's2', 2),
      { ...rmsg('m3', 's3', 3), isMention: true },
      rmsg('m4', 's4', 4),
    ]
    // Backgrounded room: resident array evicted; the marker arrives with the
    // just-merged messages (the mergeRoomMAMMessages messagesOverride path).
    seedRoom(ROOM, [])
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(ROOM, { ...m.get(ROOM)!, lastSeenMessageId: 'm1', unreadCount: 3, mentionsCount: 1 })
      const rooms = new Map(s.rooms)
      rooms.set(ROOM, { ...rooms.get(ROOM)!, lastSeenMessageId: 'm1', unreadCount: 3, mentionsCount: 1 })
      return { roomMeta: m, rooms }
    })

    roomStore.getState().applyRemoteDisplayed(ROOM, 's4', messages)

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.lastSeenMessageId).toBe('m4')
    expect(meta?.unreadCount).toBe(0)
    expect(meta?.mentionsCount).toBe(0)
    // The combined rooms mirror is kept coherent with roomMeta.
    const room = roomStore.getState().rooms.get(ROOM)
    expect(room?.unreadCount).toBe(0)
    expect(room?.mentionsCount).toBe(0)
  })

  it('applyRemoteDisplayed to a mid-history position leaves the honest remainder', () => {
    const messages = [
      rmsg('m1', 's1', 1),
      rmsg('m2', 's2', 2),
      { ...rmsg('m3', 's3', 3), isMention: true },
      rmsg('m4', 's4', 4),
    ]
    seedRoom(ROOM, [])
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(ROOM, { ...m.get(ROOM)!, lastSeenMessageId: 'm1', unreadCount: 3, mentionsCount: 1 })
      return { roomMeta: m }
    })

    // The other device read only up to m2 — m3 (a mention) and m4 stay unread.
    roomStore.getState().applyRemoteDisplayed(ROOM, 's2', messages)

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.lastSeenMessageId).toBe('m2')
    expect(meta?.unreadCount).toBe(2)
    expect(meta?.mentionsCount).toBe(1)
  })

  it('resolves a pending room marker once the message arrives via room MAM merge', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1)], 'm1')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's5') // not loaded → pending

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [rmsg('m2', 's2', 2), rmsg('m5', 's5', 5)],
      {}, // RSMResponse — all fields optional, empty is valid
      true,
      'forward'
    )

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.lastSeenMessageId).toBe('m5')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  // Exact badge recount (Phase B pointer resolution, non-resident room): the
  // sync recount inside applyRemoteDisplayed only sees the page it was handed
  // (mergedForMarker = the final backward page for a non-resident room). The
  // unread/mention messages downloaded by EARLIER pages of the same walk live
  // only in IndexedDB — the final counts must come from the cache, not the page.
  it('recounts the badge from the full cached set when the pointer resolves during a multi-page background walk', async () => {
    // Non-active, non-resident room with a pending deep pointer (new-device
    // sync: no local read state yet).
    seedRoom(ROOM, [])
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-ptr')
    expect(roomStore.getState().roomMeta.get(ROOM)?.pendingRemoteDisplayedStanzaId).toBe('s-ptr')

    // Phase A fetch-latest page: 10 unread messages at the live edge, one a
    // mention; the pointer's message is NOT here → stays pending.
    const latestPage = Array.from({ length: 10 }, (_, i) => rmsg(`f${i}`, `sf${i}`, 5100 + i * 100))
    latestPage[3] = { ...latestPage[3], isMention: true }
    roomStore.getState().mergeRoomMAMMessages(ROOM, latestPage, { first: 'sf0' }, false, 'backward', false, true)
    expect(roomStore.getState().roomMeta.get(ROOM)?.pendingRemoteDisplayedStanzaId).toBe('s-ptr')

    // Phase B backward page: contains the pointer's own message (oldest) plus
    // 9 more unread after it.
    const backwardPage = [
      rmsg('p0', 's-ptr', 4100),
      ...Array.from({ length: 9 }, (_, i) => rmsg(`p${i + 1}`, `sp${i + 1}`, 4200 + i * 100)),
    ]
    // The async exact recount reads the newest cached window — the union of
    // everything the walk downloaded (both pages, chronological).
    vi.mocked(messageCache.getRoomMessages).mockResolvedValueOnce([...backwardPage, ...latestPage])
    roomStore.getState().mergeRoomMAMMessages(ROOM, backwardPage, { first: 's-ptr' }, false, 'backward')

    // Pointer resolved at p0 → everything after it is unread: 9 (rest of the
    // backward page) + 10 (fetch-latest page, incl. 1 mention) = 19, NOT just
    // the 9 visible in the final page.
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('p0')
    await vi.waitFor(() => {
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(19)
    })
    expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(1)
    // Combined rooms mirror kept coherent.
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(19)
    expect(roomStore.getState().rooms.get(ROOM)?.mentionsCount).toBe(1)

    // Restore the factory default so a stale one-shot can't leak into later tests.
    vi.mocked(messageCache.getRoomMessages).mockReset().mockResolvedValue([])
  })

  it('skips the async cache recount when the room became active meanwhile', async () => {
    seedRoom(ROOM, [])
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-ptr')

    const page = [rmsg('p0', 's-ptr', 4100), rmsg('p1', 'sp1', 4200)]
    // Cache read resolves AFTER the room becomes active: gate it.
    let releaseCache: (msgs: RoomMessage[]) => void
    vi.mocked(messageCache.getRoomMessages).mockReturnValueOnce(
      new Promise<RoomMessage[]>((resolve) => { releaseCache = resolve })
    )
    roomStore.getState().mergeRoomMAMMessages(ROOM, page, { first: 's-ptr' }, false, 'backward')
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

    // User opens the room before the cache read lands; activation owns the
    // recount now — the stale async result must NOT clobber it.
    roomStore.setState({ activeRoomJid: ROOM })
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(ROOM, { ...m.get(ROOM)!, unreadCount: 0 })
      return { roomMeta: m }
    })
    releaseCache!([...page, rmsg('f0', 'sf0', 5100)])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)

    // Restore the factory default so a stale one-shot can't leak into later tests.
    vi.mocked(messageCache.getRoomMessages).mockReset().mockResolvedValue([])
  })
})

describe('roomStore.activateRoom — XEP-0490 divider sync', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    vi.clearAllMocks()
  })

  it('folds a pending remote room marker into lastSeenMessageId before deriving the divider', async () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4)], 'm2')
    // A remote device read up to s4, seeded as pending before messages loaded.
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      const existing = m.get(ROOM)!
      m.set(ROOM, { ...existing, pendingRemoteDisplayedStanzaId: 's4' })
      return { roomMeta: m }
    })

    await roomStore.getState().activateRoom(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m4')
    expect(roomSelectors.firstNewMessageIdFor(ROOM)(roomStore.getState())).toBeUndefined()
  })

  it('does NOT re-fold the SAME already-folded room marker on a later activation', async () => {
    // Distinct jid: the session-scoped "consumed" set is module-level and (unlike chatStore's
    // reset-based beforeEach) this file's beforeEach only resets store STATE, so a room consumed by
    // an earlier test would otherwise pre-mark this one and skip the legitimate first-open fold.
    const REOPEN_ROOM = 'reopen-same@conference.example'
    const messages = [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4)]
    seedRoom(REOPEN_ROOM, messages, 'm2')
    // First open: a remote device read up to s3 (pending) → folds to m3.
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(REOPEN_ROOM, { ...m.get(REOPEN_ROOM)!, pendingRemoteDisplayedStanzaId: 's3' })
      return { roomMeta: m }
    })
    await roomStore.getState().activateRoom(REOPEN_ROOM)
    expect(roomStore.getState().roomMeta.get(REOPEN_ROOM)?.lastSeenMessageId).toBe('m3')

    // Leave (deactivation evicts the resident message array).
    await roomStore.getState().activateRoom(null)

    // Re-open with the SAME pending marker still present (e.g. never cleared because the message
    // was outside the loaded window). The gate must skip re-folding the identical marker so it
    // can't reposition the divider on every return (XEP-0490 markers broadcast live over PEP).
    roomStore.setState((s) => {
      const rt = new Map(s.roomRuntime)
      const existing = rt.get(REOPEN_ROOM)
      if (existing) rt.set(REOPEN_ROOM, { ...existing, messages })
      const m = new Map(s.roomMeta)
      m.set(REOPEN_ROOM, { ...m.get(REOPEN_ROOM)!, pendingRemoteDisplayedStanzaId: 's3' })
      return { roomRuntime: rt, roomMeta: m }
    })
    await roomStore.getState().activateRoom(REOPEN_ROOM)
    expect(roomStore.getState().roomMeta.get(REOPEN_ROOM)?.lastSeenMessageId).toBe('m3')
  })

  // Regression (bug: "read on another device, still unread on return"): a NEWER remote read
  // arrives while the room is inactive. Inactive rooms evict their message array, so the live
  // `read:displayed-synced` notify can only stash it as pending — it cannot advance
  // lastSeenMessageId. The next activation fold is the only path that can apply it, so the gate
  // must NOT suppress a marker it has never folded, even though the room was opened before.
  it('folds a NEWER remote room marker that arrived while the room was inactive', async () => {
    const REOPEN_ROOM = 'reopen-newer@conference.example'
    const messages = [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4)]
    seedRoom(REOPEN_ROOM, messages, 'm2')
    // First open: a remote device read up to s3 (pending) → folds to m3.
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(REOPEN_ROOM, { ...m.get(REOPEN_ROOM)!, pendingRemoteDisplayedStanzaId: 's3' })
      return { roomMeta: m }
    })
    await roomStore.getState().activateRoom(REOPEN_ROOM)
    expect(roomStore.getState().roomMeta.get(REOPEN_ROOM)?.lastSeenMessageId).toBe('m3')

    // Leave (deactivation evicts the resident message array).
    await roomStore.getState().activateRoom(null)

    // Re-open: rehydrate the messages (cache reload) and a NEW further-ahead remote read (s4)
    // that the live notify could only stash while the room was unloaded.
    roomStore.setState((s) => {
      const rt = new Map(s.roomRuntime)
      const existing = rt.get(REOPEN_ROOM)
      if (existing) rt.set(REOPEN_ROOM, { ...existing, messages })
      const m = new Map(s.roomMeta)
      m.set(REOPEN_ROOM, { ...m.get(REOPEN_ROOM)!, pendingRemoteDisplayedStanzaId: 's4' })
      return { roomRuntime: rt, roomMeta: m }
    })
    await roomStore.getState().activateRoom(REOPEN_ROOM)
    expect(roomStore.getState().roomMeta.get(REOPEN_ROOM)?.lastSeenMessageId).toBe('m4')
  })

  // Regression (gate burn on stash): the first activation fold may find the marker's
  // message NOT loaded (stash-pending). A fold that never applied must not consume the
  // session gate — otherwise the marker stays stuck as pending forever: re-entry skips
  // the fold ("already consumed") and re-entry of a caught-up room runs no MAM merge,
  // leaving no heal path for the whole session.
  it('retries the fold on a later activation when the first fold could not resolve (marker message not yet loaded)', async () => {
    const RETRY_ROOM = 'retry-stash@conference.example'
    const early = [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2)]
    seedRoom(RETRY_ROOM, early, 'm1')
    // A remote device read up to s9 — that message is not in any loaded slice yet.
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(RETRY_ROOM, { ...m.get(RETRY_ROOM)!, pendingRemoteDisplayedStanzaId: 's9' })
      return { roomMeta: m }
    })

    await roomStore.getState().activateRoom(RETRY_ROOM)
    // Unresolvable → stash survives, pointer untouched.
    expect(roomStore.getState().roomMeta.get(RETRY_ROOM)?.lastSeenMessageId).toBe('m1')
    expect(roomStore.getState().roomMeta.get(RETRY_ROOM)?.pendingRemoteDisplayedStanzaId).toBe('s9')

    await roomStore.getState().activateRoom(null)

    // The archive healed since (e.g. catch-up landed): the marker's message is loadable now.
    const healed = [...early, rmsg('m9', 's9', 9)]
    roomStore.setState((s) => {
      const rt = new Map(s.roomRuntime)
      const existing = rt.get(RETRY_ROOM)
      if (existing) rt.set(RETRY_ROOM, { ...existing, messages: healed })
      return { roomRuntime: rt }
    })

    await roomStore.getState().activateRoom(RETRY_ROOM)
    // The gate must allow the retry (the marker was never actually folded).
    expect(roomStore.getState().roomMeta.get(RETRY_ROOM)?.lastSeenMessageId).toBe('m9')
    expect(roomStore.getState().roomMeta.get(RETRY_ROOM)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
  })

  // Regression (fold ran only before the load-around): with a deep backlog the pending
  // marker's message is outside the latest-100 slice, so the first fold stashes. The
  // subsequent load-around of the stale pointer brings that message in — the fold must
  // be re-attempted against the around-slice, or the divider derives from the stale
  // local pointer and shows messages already read on the other device as new.
  it('re-attempts the fold against the slice loaded around a deep stale pointer', async () => {
    const DEEP_ROOM = 'deep-pointer@conference.example'
    const latest = [rmsg('m10', 's10', 10), rmsg('m11', 's11', 11), rmsg('m12', 's12', 12)]
    // Resident window = latest slice; the read pointer (m2) is deeper than it.
    seedRoom(DEEP_ROOM, latest, 'm2')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(DEEP_ROOM, { ...m.get(DEEP_ROOM)!, pendingRemoteDisplayedStanzaId: 's5' })
      return { roomMeta: m }
    })
    // The IndexedDB slice around the stale pointer contains the marker's message (m5).
    const aroundSlice = [
      rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3),
      rmsg('m4', 's4', 4), rmsg('m5', 's5', 5), rmsg('m6', 's6', 6),
    ]
    vi.mocked(messageCache.getRoomMessagesAround).mockResolvedValueOnce(aroundSlice)

    await roomStore.getState().activateRoom(DEEP_ROOM)

    // The retried fold advances the pointer to the synced position…
    expect(roomStore.getState().roomMeta.get(DEEP_ROOM)?.lastSeenMessageId).toBe('m5')
    expect(roomStore.getState().roomMeta.get(DEEP_ROOM)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    // …and the divider derives from it, not from the stale local pointer (m2 → 'm3').
    expect(roomSelectors.firstNewMessageIdFor(DEEP_ROOM)(roomStore.getState())).toBe('m6')
  })

  // A divider derived while a pending marker is still UNRESOLVED is provisional —
  // the synced read position may move or erase it once the marker's message loads.
  // The UI renders it muted until it is confirmed (pending resolved).
  it('flags the divider provisional while the pending marker is unresolved, confirmed once it resolves', async () => {
    const PROV_ROOM = 'provisional@conference.example'
    const messages = [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4)]
    seedRoom(PROV_ROOM, messages, 'm2')
    // A marker references a message that is not loadable yet (e.g. s0 predates the slice).
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(PROV_ROOM, { ...m.get(PROV_ROOM)!, pendingRemoteDisplayedStanzaId: 's0' })
      return { roomMeta: m }
    })

    await roomStore.getState().activateRoom(PROV_ROOM)

    // Divider derived from the local pointer, but the synced position is unknown → provisional.
    expect(roomSelectors.firstNewMessageIdFor(PROV_ROOM)(roomStore.getState())).toBe('m3')
    expect(roomSelectors.firstNewMessageIsProvisionalFor(PROV_ROOM)(roomStore.getState())).toBe(true)

    // The marker's message arrives (merge): it sits BEHIND the pointer → clear-pending.
    // The divider is untouched but now confirmed.
    roomStore.getState().applyRemoteDisplayed(PROV_ROOM, 's0', [rmsg('m0', 's0', 0), ...messages])
    expect(roomSelectors.firstNewMessageIdFor(PROV_ROOM)(roomStore.getState())).toBe('m3')
    expect(roomSelectors.firstNewMessageIsProvisionalFor(PROV_ROOM)(roomStore.getState())).toBe(false)
  })

  it('a divider derived with no pending marker is never provisional', async () => {
    const CONF_ROOM = 'confirmed@conference.example'
    seedRoom(CONF_ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2)], 'm1')

    await roomStore.getState().activateRoom(CONF_ROOM)

    expect(roomSelectors.firstNewMessageIdFor(CONF_ROOM)(roomStore.getState())).toBe('m2')
    expect(roomSelectors.firstNewMessageIsProvisionalFor(CONF_ROOM)(roomStore.getState())).toBe(false)
  })

  it('a pending marker without a divider is not provisional (nothing to render)', () => {
    const NO_DIVIDER_ROOM = 'pending-no-divider@conference.example'
    seedRoom(NO_DIVIDER_ROOM, [rmsg('m1', 's1', 1)], 'm1')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(NO_DIVIDER_ROOM, { ...m.get(NO_DIVIDER_ROOM)!, pendingRemoteDisplayedStanzaId: 's9' })
      return { roomMeta: m }
    })

    expect(roomSelectors.firstNewMessageIsProvisionalFor(NO_DIVIDER_ROOM)(roomStore.getState())).toBe(false)
  })

  // The flash scenario, made explicit: a provisional divider must settle to its
  // DEFINITIVE position (moved, confirmed) when the marker resolves AHEAD of it
  // on the active room — and stop being provisional.
  it('moves the divider and confirms it when the marker resolves ahead of it (active room)', async () => {
    const AHEAD_ROOM = 'resolve-ahead@conference.example'
    // m4 is NOT loaded at activation (deep gap) — the marker for s4 can only stash.
    const loaded = [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m5', 's5', 5)]
    seedRoom(AHEAD_ROOM, loaded, 'm2')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(AHEAD_ROOM, { ...m.get(AHEAD_ROOM)!, pendingRemoteDisplayedStanzaId: 's4' })
      return { roomMeta: m }
    })

    await roomStore.getState().activateRoom(AHEAD_ROOM)
    // Provisional divider from the stale local pointer (m2 → m3).
    expect(roomSelectors.firstNewMessageIdFor(AHEAD_ROOM)(roomStore.getState())).toBe('m3')
    expect(roomSelectors.firstNewMessageIsProvisionalFor(AHEAD_ROOM)(roomStore.getState())).toBe(true)

    // The marker's message arrives (merge): the synced read is ahead → the divider
    // settles after the synced position, definitive.
    const full = [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3), rmsg('m4', 's4', 4), rmsg('m5', 's5', 5)]
    roomStore.getState().applyRemoteDisplayed(AHEAD_ROOM, 's4', full)

    expect(roomStore.getState().roomMeta.get(AHEAD_ROOM)?.lastSeenMessageId).toBe('m4')
    expect(roomSelectors.firstNewMessageIdFor(AHEAD_ROOM)(roomStore.getState())).toBe('m5')
    expect(roomSelectors.firstNewMessageIsProvisionalFor(AHEAD_ROOM)(roomStore.getState())).toBe(false)
  })

  it('erases the provisional divider when the marker resolves at the newest message (all read elsewhere)', async () => {
    const ERASE_ROOM = 'resolve-erase@conference.example'
    const loaded = [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)]
    seedRoom(ERASE_ROOM, loaded, 'm1')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(ERASE_ROOM, { ...m.get(ERASE_ROOM)!, pendingRemoteDisplayedStanzaId: 's9' })
      return { roomMeta: m }
    })

    await roomStore.getState().activateRoom(ERASE_ROOM)
    expect(roomSelectors.firstNewMessageIdFor(ERASE_ROOM)(roomStore.getState())).toBe('m2')
    expect(roomSelectors.firstNewMessageIsProvisionalFor(ERASE_ROOM)(roomStore.getState())).toBe(true)

    // The other device read everything: the marker resolves at the newest message.
    roomStore.getState().applyRemoteDisplayed(ERASE_ROOM, 's9', [...loaded, rmsg('m9', 's9', 9)])

    expect(roomSelectors.firstNewMessageIdFor(ERASE_ROOM)(roomStore.getState())).toBeUndefined()
    expect(roomSelectors.firstNewMessageIsProvisionalFor(ERASE_ROOM)(roomStore.getState())).toBe(false)
    expect(roomStore.getState().roomMeta.get(ERASE_ROOM)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
  })
})

describe('roomStore — new-message divider is session-only', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    vi.clearAllMocks()
  })

  it('parks the divider in firstNewMessageMarkers, not in roomMeta', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      const existing = m.get(ROOM)!
      m.set(ROOM, { ...existing, unreadCount: 2 })
      return { roomMeta: m }
    })

    roomStore.getState().setActiveRoom(ROOM)

    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('m2')
    expect(roomSelectors.firstNewMessageIdFor(ROOM)(roomStore.getState())).toBe('m2')
    expect('firstNewMessageId' in (roomStore.getState().roomMeta.get(ROOM) as object)).toBe(false)
  })

  it('deactivating a room deletes its marker (switching to another room)', () => {
    const ROOM_B = 'other@conference.example'

    // Seed room A with one read message and two unread so activation sets a divider at m2.
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      const existing = m.get(ROOM)!
      m.set(ROOM, { ...existing, unreadCount: 2 })
      return { roomMeta: m }
    })

    // Seed room B with no unread so switching to it sets no marker.
    seedRoom(ROOM_B, [rmsg('b1', 'sb1', 10)], 'b1')

    // Activate ROOM — divider should be placed at m2.
    roomStore.getState().setActiveRoom(ROOM)
    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBe('m2')

    // Switch to ROOM_B — must delete ROOM's marker (the deactivate branch).
    roomStore.getState().setActiveRoom(ROOM_B)
    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toBeUndefined()
    // ROOM_B has no unread, so it should not gain a marker.
    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM_B)).toBeUndefined()
  })
})

describe('roomStore.markAsRead — read-pointer advance for XEP-0490 sync', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    vi.clearAllMocks()
  })

  // At the live edge, clearing the badge means the user caught up to the newest
  // message — advance the read pointer so the MDS publisher syncs the marker.
  it('advances lastSeenMessageId to the newest loaded message when at the live edge', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(ROOM, { ...m.get(ROOM)!, unreadCount: 2 })
      return { roomMeta: m }
    })

    roomStore.getState().markAsRead(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m3')
    expect(roomStore.getState().rooms.get(ROOM)?.lastSeenMessageId).toBe('m3')
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
  })

  // Slid up into history: badge clears but the pointer stays put, so MDS never
  // publishes a read position past messages the user has not seen.
  it('does NOT advance lastSeenMessageId when the window is slid up into history', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    roomStore.setState((s) => {
      const m = new Map(s.roomMeta)
      m.set(ROOM, { ...m.get(ROOM)!, unreadCount: 2 })
      const rt = new Map(s.roomRuntime)
      rt.set(ROOM, { ...rt.get(ROOM)!, windowAtLiveEdge: false })
      return { roomMeta: m, roomRuntime: rt }
    })

    roomStore.getState().markAsRead(ROOM)

    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m1')
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// updateLastSeenMessageId — presence gate (issue #1076)
//
// The viewport observer equated "rendered on screen" with "read". Combined with
// auto-scroll-on-new-message, a backgrounded client marked every arriving message
// read in real time: the pointer rode the live edge, the "new messages" divider
// never survived, and the position was published over XEP-0490. A message painted
// while the user is in another app has not been seen.
// ---------------------------------------------------------------------------

describe('roomStore.updateLastSeenMessageId presence gate', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    connectionStore.getState().setWindowVisible(true)
    vi.clearAllMocks()
  })

  it('advances the read pointer when the window is focused', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    connectionStore.getState().setWindowVisible(true)
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm3')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m3')
  })

  it('does not advance the read pointer while the window is unfocused', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    connectionStore.getState().setWindowVisible(false)
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm3')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m1')
  })

  it('resumes advancing once the window regains focus', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1), rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)], 'm1')
    connectionStore.getState().setWindowVisible(false)
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm2')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m1')
    connectionStore.getState().setWindowVisible(true)
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm3')
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m3')
  })
})

// ---------------------------------------------------------------------------
// Fresh-instance catch-up ordering (issue #1076)
//
// A new install / new device / cleared cache has NO local read state for a room.
// The MDS marker from the client the user left always arrives before the room has
// messages to resolve it against, so it lands in pendingRemoteDisplayedStanzaId.
// The catch-up merge then recomputed counts FIRST — and its fresh-entity guard
// ("no pointer, no lastReadAt ⇒ caught up") snapped the pointer to the newest
// message. The pending fold that runs afterwards is forward-only, so the user's
// real position was already behind it and got discarded.
// ---------------------------------------------------------------------------

describe('roomStore fresh-instance catch-up preserves the remote read position', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    connectionStore.getState().setWindowVisible(true)
    vi.clearAllMocks()
  })

  /** 10 archived messages, m1..m10 / s1..s10. */
  const archive = () => Array.from({ length: 10 }, (_, i) => rmsg(`m${i + 1}`, `s${i + 1}`, i + 1))

  it('keeps the pointer at the marker instead of snapping to newest', () => {
    seedRoom(ROOM, []) // fresh instance: no messages, no pointer, no lastReadAt
    roomStore.getState().applyRemoteDisplayed(ROOM, 's3') // non-resident → pending
    expect(roomStore.getState().roomMeta.get(ROOM)?.pendingRemoteDisplayedStanzaId).toBe('s3')

    roomStore.getState().mergeRoomMAMMessages(ROOM, archive(), {}, true, 'forward')

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.lastSeenMessageId).toBe('m3')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  it('counts the messages after the marker as unread', () => {
    seedRoom(ROOM, [])
    roomStore.getState().applyRemoteDisplayed(ROOM, 's3')

    roomStore.getState().mergeRoomMAMMessages(ROOM, archive(), {}, true, 'forward')

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(7)
  })

  // Control: a genuinely fresh room with NO remote marker must still be treated as
  // caught up, or every new join would manufacture unread debt from its history.
  it('still treats a fresh room with no remote marker as caught up', () => {
    seedRoom(ROOM, [])

    roomStore.getState().mergeRoomMAMMessages(ROOM, archive(), {}, true, 'forward')

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.unreadCount).toBe(0)
    expect(meta?.lastSeenMessageId).toBe('m10')
  })
})

// ---------------------------------------------------------------------------
// Pending-marker guard: edges around the fresh-instance fix (issue #1076).
// ---------------------------------------------------------------------------

describe('roomStore pending-marker guard edges', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    connectionStore.getState().setWindowVisible(true)
    vi.clearAllMocks()
  })

  // The guard must not strand a room forever: when the marker's message is NOT in
  // the delivered page it stays pending (rather than snapping the pointer past it),
  // and a later page carrying that message still resolves it.
  it('holds the position pending when the marker is not in the delivered page', () => {
    seedRoom(ROOM, [])
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-deep')

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [rmsg('m8', 's8', 8), rmsg('m9', 's9', 9)],
      {}, true, 'forward'
    )

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe('s-deep')
    expect(meta?.lastSeenMessageId).toBe(undefined)
  })

  it('resolves that held position once a later page carries the marker message', () => {
    seedRoom(ROOM, [])
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-deep')
    roomStore.getState().mergeRoomMAMMessages(ROOM, [rmsg('m9', 's9', 9)], {}, true, 'forward')

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [rmsg('m5', 's-deep', 5), rmsg('m6', 's6', 6)],
      {}, true, 'forward'
    )

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.lastSeenMessageId).toBe('m5')
    expect(meta?.pendingRemoteDisplayedStanzaId).toBe(undefined)
  })

  // The guard is scoped to the fresh-entity branch — a room that already has a
  // local pointer must keep counting from it, pending marker or not.
  it('counts from the existing local pointer when one is already set', () => {
    seedRoom(ROOM, [rmsg('m1', 's1', 1)], 'm1')
    roomStore.getState().applyRemoteDisplayed(ROOM, 's-future')

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [rmsg('m2', 's2', 2), rmsg('m3', 's3', 3)],
      {}, true, 'forward'
    )

    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
  })

  it('counts mentions after the resolved marker, not from the start of the page', () => {
    seedRoom(ROOM, [])
    roomStore.getState().applyRemoteDisplayed(ROOM, 's2')

    const page = [
      rmsg('m1', 's1', 1),
      { ...rmsg('m2', 's2', 2), isMention: true } as RoomMessage,
      { ...rmsg('m3', 's3', 3), isMention: true } as RoomMessage,
      rmsg('m4', 's4', 4),
    ]
    roomStore.getState().mergeRoomMAMMessages(ROOM, page, {}, true, 'forward')

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.lastSeenMessageId).toBe('m2')
    expect(meta?.unreadCount).toBe(2)
    // m2's mention is at/behind the read position — only m3's counts.
    expect(meta?.mentionsCount).toBe(1)
  })
})
