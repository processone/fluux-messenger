import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import { connectionStore } from './connectionStore'
import { loadRoomReadState } from './shared/readStateStorage'
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

// The room read-state key is private to shared/readStateStorage; this is the
// on-disk name it builds for the scoped account.
const STORAGE_KEY = `fluux-room-read-state:${JID}`

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
 * path that re-reads the scoped storage after module load. Asserting through it
 * is what proves the LOAD half is wired — in-memory state alone would pass even
 * if nothing were ever read back.
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
  // updateLastSeenMessageId is gated on the window being focused (#1080); an
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
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm5')

    // Whatever the in-memory state, the durable copy is what matters here.
    const persisted = loadRoomReadState(JID)
    expect(persisted.get(ROOM)?.historyFloor).toBeInstanceOf(Date)
    // …and the pointer itself, not just the creation-time floor: a wiring that
    // only saved at addRoom would pass the floor assertion above on its own.
    expect(persisted.get(ROOM)?.readPointer).toEqual({ messageId: 'm5', timestamp: new Date(5000) })
  })

  it('rehydrates the persisted pointer into roomMeta on the next session', () => {
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m4', 4000), rmsg('m5', 5000)]))
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm5')

    restartSession()
    // Bookmarks re-add the room on the next run; it carries no read state.
    roomStore.getState().addRoom(makeRoom(ROOM))

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.readPointer).toEqual({ messageId: 'm5', timestamp: new Date(5000) })
    // The restored pointer has to land on lastSeenMessageId too — every reader
    // (divider placement, XEP-0490 publisher) still keys off that field, so
    // restoring the pointer alone would persist a position nothing acts on.
    expect(meta?.lastSeenMessageId).toBe('m5')
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
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm5')

    expect(loadRoomReadState(JID).has(OTHER_ROOM)).toBe(true)
  })

  // setBookmark is the other place a room entity is born: a bookmark pushed
  // from another device materialises a room we have never joined.
  it('stamps and restores read state for a room born from a bookmark', () => {
    roomStore.getState().addRoom(makeRoom(ROOM, [rmsg('m5', 5000)]))
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm5')
    const floor = roomStore.getState().roomMeta.get(ROOM)?.historyFloor

    restartSession()
    vi.setSystemTime(new Date('2026-07-23T10:00:00Z'))
    roomStore.getState().setBookmark(ROOM, { name: 'Room', nick: 'me', autojoin: true })

    const meta = roomStore.getState().roomMeta.get(ROOM)
    expect(meta?.readPointer).toEqual({ messageId: 'm5', timestamp: new Date(5000) })
    expect(meta?.historyFloor).toEqual(floor)
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
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm5')

    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('unreadCount')
  })
})
