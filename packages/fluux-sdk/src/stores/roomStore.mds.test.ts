import { describe, it, expect, beforeEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import { roomSelectors } from './roomSelectors'
import type { Room, RoomMessage } from '../core/types/room'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

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
    saveRoomMessages: vi.fn().mockResolvedValue(undefined),
    getRoomMessages: vi.fn().mockResolvedValue([]),
    updateRoomMessage: vi.fn().mockResolvedValue(undefined),
    deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  }
})

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
