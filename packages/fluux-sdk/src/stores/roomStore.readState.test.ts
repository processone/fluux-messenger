import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import { connectionStore } from './connectionStore'
import { loadRoomReadState, getRoomReadStateStorageKey } from './shared/readStateStorage'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import type { Room, RoomMessage } from '../core/types/room'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// removeRoom deletes the room's cached messages; keep the suite off IndexedDB.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
    saveRoomMessage: vi.fn().mockResolvedValue(undefined),
    getRoomMessages: vi.fn().mockResolvedValue([]),
  }
})

const JID = 'me@example.com'
const ROOM = 'room@conf.example.com'
const OTHER_ROOM = 'other@conf.example.com'
// A room this file never writes through the store — the disk-load test below
// depends on its row existing ONLY in localStorage.
const DISK_ONLY_ROOM = 'restored@conf.example.com'

// Ask the module for the key it actually uses rather than re-spelling it: a
// rename would otherwise leave the assertions below reading an absent row and
// failing as a confusing "expected null not to be null".
const STORAGE_KEY = getRoomReadStateStorageKey(JID)

function rmsg(id: string, ms: number, roomJid = ROOM): RoomMessage {
  return {
    type: 'groupchat',
    id,
    stanzaId: `s-${id}`,
    roomJid,
    from: `${roomJid}/alice`,
    nick: 'alice',
    body: id,
    timestamp: new Date(ms),
    isOutgoing: false,
  } as RoomMessage
}

function makeRoom(jid = ROOM, messages: RoomMessage[] = []): Room {
  return {
    jid,
    name: 'Room',
    nickname: 'me',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    messages,
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

/**
 * Re-initialise the store the way a new app run does: `switchAccount` is the
 * production re-entry point (XMPPClient.connect calls it), and it is the only
 * path that re-reads the scoped storage after module load.
 *
 * This does NOT prove the load half on its own: `setState` cannot reach the
 * module-level map roomStore folds into `roomMeta`, so a test that wrote through
 * the store earlier in the same test would still find its pointer in memory even
 * if nothing were read back from disk. What these restart tests DO cover is that
 * a re-added room recovers its position rather than being reset by the incoming
 * bookmark/presence Room. "loads read state from disk on switchAccount" below is
 * the test that isolates the disk read itself.
 */
function restartSession(): void {
  roomStore.setState({ rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map() })
  roomStore.getState().switchAccount(JID)
}

let previousWindowVisible = true

beforeEach(() => {
  // A stamped `historyFloor` is `new Date()`. Two addRoom calls in one tick land
  // on the same millisecond, so with a real clock a restamping implementation
  // would produce an EQUAL date and the "does NOT restamp" control could not
  // fail. Fake timers make the clock move only when a test moves it.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-22T10:00:00Z'))
  localStorage.clear()
  _resetStorageScopeForTesting()
  setStorageScopeJid(JID)
  roomStore.getState().reset()
  previousWindowVisible = connectionStore.getState().windowVisible
  // advanceReadPointer is gated on the window being focused (#1080); an
  // unfocused window would make the pointer-advance tests silently no-op.
  connectionStore.getState().setWindowVisible(true)
})

afterEach(() => {
  connectionStore.getState().setWindowVisible(previousWindowVisible)
  vi.useRealTimers()
})

describe('room read state persistence', () => {
  it('stamps historyFloor when a room is first added', () => {
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true } as never)
    expect(roomStore.getState().roomMeta.get(ROOM)?.historyFloor).toBeInstanceOf(Date)
  })

  // Control: an implementation that stamps the floor on every addRoom (rejoin,
  // bookmark reload) passes "floor is set" but fails this. A moving floor would
  // silently erase unread history on every reconnect.
  it('does NOT restamp historyFloor when an existing room is re-added', () => {
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true } as never)
    const first = roomStore.getState().roomMeta.get(ROOM)?.historyFloor
    vi.setSystemTime(new Date('2026-07-22T11:00:00Z'))
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true } as never)
    expect(roomStore.getState().roomMeta.get(ROOM)?.historyFloor).toEqual(first)
  })

  it('persists the pointer so it survives a store reset + rehydrate', () => {
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m4', 4000), rmsg('m5', 5000)]))
    roomStore.getState().advanceReadPointer(ROOM, 'm5')

    // Whatever the in-memory state, the durable copy is what matters here.
    const persisted = loadRoomReadState(JID)
    expect(persisted.get(ROOM)?.historyFloor).toBeInstanceOf(Date)
    // …and the pointer itself, not just the creation-time floor: a wiring that
    // only saved at addRoom would pass the floor assertion above on its own.
    expect(persisted.get(ROOM)?.readPointer).toEqual({ messageId: 'm5', timestamp: new Date(5000) })
  })

  // The one shape that can tell DISK apart from MEMORY, and so the only test
  // that covers the load half at all. Nothing here has written to the store, and
  // beforeEach's `reset()` emptied the module-level map, so this row exists ONLY
  // in localStorage: if switchAccount stopped re-reading the scoped key, there
  // would be no row for this room and no pointer could reach roomMeta.
  // The payload is hand-written in its on-disk form rather than produced by
  // saveRoomReadState, so a save/load pair that agreed with each other but not
  // with the documented encoding could not pass.
  it('loads read state from disk on switchAccount', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        [DISK_ONLY_ROOM, { readPointer: { messageId: 'd7', timestamp: 7000 }, historyFloor: 1000 }],
      ])
    )

    roomStore.getState().switchAccount(JID)
    // Bookmarks re-add the room on the next run; it carries no read state.
    roomStore.getState().addRoom(makeRoom(DISK_ONLY_ROOM))

    const meta = roomStore.getState().roomMeta.get(DISK_ONLY_ROOM)
    expect(meta?.readPointer).toEqual({ messageId: 'd7', timestamp: new Date(7000) })
    // …and the floor must come from disk rather than being restamped to now.
    expect(meta?.historyFloor).toEqual(new Date(1000))
  })

  it('rehydrates the persisted pointer into roomMeta on the next session', () => {
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m4', 4000), rmsg('m5', 5000)]))
    roomStore.getState().advanceReadPointer(ROOM, 'm5')

    restartSession()
    // Bookmarks re-add the room on the next run; it carries no read state.
    roomStore.getState().addRoom(makeRoom(ROOM))

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.readPointer).toEqual({ messageId: 'm5', timestamp: new Date(5000) })
  })

  // The cross-restart half of the "written once" rule: re-adding the room in a
  // LATER session must not restamp the floor either — otherwise every app start
  // moves the floor forward and buries whatever arrived while we were away.
  it('keeps the original historyFloor across a restart', () => {
    roomStore.getState().addRoom(makeRoom(ROOM))
    const first = roomStore.getState().roomMeta.get(ROOM)?.historyFloor

    vi.setSystemTime(new Date('2026-07-23T10:00:00Z'))
    restartSession()
    roomStore.getState().addRoom(makeRoom(ROOM))

    expect(roomStore.getState().roomMeta.get(ROOM)?.historyFloor).toEqual(first)
  })

  it('persists a pointer advanced through commitRoomUpdate (markReadToNewest)', () => {
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m1', 1000), rmsg('m2', 2000)]))
    roomStore.getState().markReadToNewest(ROOM)

    expect(loadRoomReadState(JID).get(ROOM)?.readPointer).toEqual({
      messageId: 'm2',
      timestamp: new Date(2000),
    })
  })

  // A save triggered by ONE room must not garbage-collect the rows of rooms
  // whose bookmarks have not landed yet — the save projects roomMeta, and at
  // that moment roomMeta knows nothing about the other room.
  it('keeps the row of a room that has not been re-added this session', () => {
    roomStore.getState().addRoom(makeRoom(OTHER_ROOM))
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m5', 5000)]))

    restartSession()
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m5', 5000)]))
    roomStore.getState().advanceReadPointer(ROOM, 'm5')

    expect(loadRoomReadState(JID).has(OTHER_ROOM)).toBe(true)
  })

  // setBookmark is the other place a room entity is born: a bookmark pushed
  // from another device materialises a room we have never joined.
  it('stamps and restores read state for a room born from a bookmark', () => {
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m5', 5000)]))
    roomStore.getState().advanceReadPointer(ROOM, 'm5')
    const floor = roomStore.getState().roomMeta.get(ROOM)?.historyFloor

    restartSession()
    vi.setSystemTime(new Date('2026-07-23T10:00:00Z'))
    roomStore.getState().setBookmark(ROOM, { name: 'Room', nick: 'me', autojoin: true })

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.readPointer).toEqual({ messageId: 'm5', timestamp: new Date(5000) })
    expect(meta?.historyFloor).toEqual(floor)
  })

  // The SDK state snapshot carries a `readPointer` again since #1081, so a
  // restored Room can arrive holding one — and it is a 500 ms-debounced mirror of
  // the same store the durable row is written from synchronously, so it can be
  // BEHIND that row. Taking it at face value would then have addRoom's
  // persistRoomReadState write the older position back over the newer one.
  // Neither source can be ahead of the user's true position, so the later wins.
  it('keeps the durable pointer when the snapshot Room carries a staler one', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([[ROOM, { readPointer: { messageId: 'm9', timestamp: 9000 }, historyFloor: 1000 }]])
    )
    roomStore.getState().switchAccount(JID)

    // The snapshot was written before the last few advances landed.
    roomStore.getState().addRoom({ ...makeRoom(ROOM), readPointer: { messageId: 'm5', timestamp: new Date(5000) } } as Room)

    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toEqual({ messageId: 'm9', timestamp: new Date(9000) })
    // …and the durable row must not have been overwritten with the staler one.
    expect(loadRoomReadState(JID).get(ROOM)?.readPointer).toEqual({ messageId: 'm9', timestamp: new Date(9000) })
  })

  // Control for the same rule in the other direction: the snapshot is not being
  // ignored, it simply has to be the later of the two to win.
  it('takes the snapshot pointer when it is ahead of the durable row', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([[ROOM, { readPointer: { messageId: 'm5', timestamp: 5000 }, historyFloor: 1000 }]])
    )
    roomStore.getState().switchAccount(JID)

    roomStore.getState().addRoom({ ...makeRoom(ROOM), readPointer: { messageId: 'm9', timestamp: new Date(9000) } } as Room)

    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toEqual({ messageId: 'm9', timestamp: new Date(9000) })
  })

  it('drops a removed room from the durable copy', () => {
    roomStore.getState().addRoom(makeRoom(ROOM))
    expect(loadRoomReadState(JID).has(ROOM)).toBe(true)

    roomStore.getState().removeRoom(ROOM)
    expect(loadRoomReadState(JID).has(ROOM)).toBe(false)
  })

  // unreadCount is derived from the archive against the pointer, not stored:
  // a persisted count outlives the messages it counted and comes back wrong.
  it('does not persist unreadCount', () => {
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m5', 5000)]))
    roomStore.getState().advanceReadPointer(ROOM, 'm5')

    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('unreadCount')
  })
})
