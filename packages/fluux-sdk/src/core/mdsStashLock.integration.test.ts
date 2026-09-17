/**
 * XEP-0490: a remote read marker the loaded slice cannot order must not lock the entity.
 *
 * A stashed marker (`pendingRemoteDisplayedStanzaId`) defers every unread recount and, while the
 * node still serves it, keeps the publisher from sending the local read position. These cases run
 * the real stores, the real message cache over fake IndexedDB and the real publisher, and observe
 * the lock where it shows: the stash, the recount's count, and what reaches the MDS node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { setupMdsSideEffects } from './mdsSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { roomStore, _resetRoomReadStateForTesting } from '../stores/roomStore'
import { makeReadPointer, type ReadPointer } from '../stores/shared/readPointer'
import * as messageCache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { subscribeDiagnostics, type UnreadRecountVerdict } from '../diagnostics/channel'
import { localStorageMock } from './sideEffects.testHelpers'
import type { DisplayedMarker } from './modules/Mds'
import type { Message, Room, RoomMessage } from './types'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

const OWN_BARE = 'romeo@montague.example'
const OWN_JID = `${OWN_BARE}/desktop`
const ROOM = 'lounge@conference.example'
const CID = 'juliet@capulet.example'
const WAIT = { timeout: 1_500, interval: 10 }
// Publishes are debounced by 1.5 s.
const PUBLISH_WAIT = { timeout: 3_500, interval: 20 }

function roomRow(id: string, stanzaId: string, timestamp: number): RoomMessage {
  const message = {
    type: 'groupchat',
    id,
    stanzaId,
    roomJid: ROOM,
    from: `${ROOM}/alice`,
    nick: 'alice',
    body: id,
    timestamp: new Date(timestamp),
    isOutgoing: false,
  } as RoomMessage
  return { ...message, localRowRef: { id } }
}

function chatRow(id: string, stanzaId: string, timestamp: number): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    conversationId: CID,
    from: CID,
    body: id,
    timestamp: new Date(timestamp),
    isOutgoing: false,
  } as Message
}

/** An exact room pointer on `row`, named by its local id as a viewport report would name it. */
function roomPointerOn(row: RoomMessage): ReadPointer {
  return {
    order: { role: 'exact', timestamp: row.timestamp.getTime(), tiebreak: { kind: 'room', from: row.from, id: row.id } },
    identity: { state: 'local', messageId: row.id },
  }
}

function floorPointerOn(row: { id: string; timestamp: Date }): ReadPointer {
  return {
    order: { role: 'floor', timestamp: row.timestamp.getTime() },
    identity: { state: 'local', messageId: row.id },
  }
}

const ANCHOR = roomRow('anchor', 's-anchor', 1_000)
const DEEP = roomRow('deep', 's-deep', 2_000)
const P0 = roomRow('p0', 's-p0', 5_000)
const U1 = roomRow('u1', 's-u1', 6_000)
const U2 = roomRow('u2', 's-u2', 7_000)

function addRoom(resident: RoomMessage[] = []): void {
  const room: Room = {
    jid: ROOM,
    name: 'lounge',
    nickname: 'romeo',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
  roomStore.getState().addRoom(room, resident)
}

/** A caught-up room whose contiguous coverage reaches down to ANCHOR, read up to `pointer`. */
function readRoomUpTo(pointer: ReadPointer, staleUnreadCount: number): void {
  roomStore.setState((state) => {
    const roomMeta = new Map(state.roomMeta)
    roomMeta.set(ROOM, { ...roomMeta.get(ROOM)!, readPointer: pointer, unreadCount: staleUnreadCount })
    const mamQueryStates = new Map(state.mamQueryStates)
    mamQueryStates.set(ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
    const roomCoverage = new Map(state.roomCoverage)
    roomCoverage.set(ROOM, { bottomId: ANCHOR.stanzaId! })
    return { roomMeta, mamQueryStates, roomCoverage }
  })
}

function roomMeta() {
  return roomStore.getState().roomMeta.get(ROOM)
}

function makeClient(markers: DisplayedMarker[]) {
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {}
  const register = (event: string, handler: (payload?: unknown) => void) => {
    ;(handlers[event] ||= []).push(handler)
    return () => {
      handlers[event] = (handlers[event] ?? []).filter((candidate) => candidate !== handler)
    }
  }
  const mds = {
    publishDisplayed: vi.fn().mockResolvedValue(undefined),
    fetchAllDisplayed: vi.fn().mockResolvedValue(markers),
    fetchAllDisplayedResult: vi.fn().mockResolvedValue({ status: 'authoritative' as const, markers }),
    retractDisplayed: vi.fn().mockResolvedValue(undefined),
  }
  return {
    subscribe: register,
    _emit: (event: string, payload?: unknown) => {
      for (const handler of handlers[event] ?? []) handler(payload)
    },
    internal: { on: register, mds },
  }
}

/** Connect and let the fresh-session seed deliver `markers` from the MDS node. */
async function connectWithNode(markers: DisplayedMarker[]) {
  const client = makeClient(markers)
  connectionStore.setState({ status: 'online', jid: OWN_JID } as never)
  const cleanup = setupMdsSideEffects(client as never)
  client._emit('online')
  await vi.waitFor(() => {
    expect(client.internal.mds.fetchAllDisplayedResult).toHaveBeenCalledTimes(1)
  }, WAIT)
  return { client, cleanup }
}

/** A live notify from another device, applied the way the store binding applies it. */
function remoteDisplayed(client: ReturnType<typeof makeClient>, conversationId: string, stanzaId: string): void {
  if (conversationId === ROOM) roomStore.getState().applyRemoteDisplayed(conversationId, stanzaId)
  else chatStore.getState().applyRemoteDisplayed(conversationId, stanzaId)
  client._emit('read:displayed-synced', { conversationId, stanzaId })
}

function recountVerdicts(entityId: string): UnreadRecountVerdict[] {
  const verdicts: UnreadRecountVerdict[] = []
  unsubscribes.push(subscribeDiagnostics((event) => {
    if (event.kind === 'unread-recount' && event.entityId === entityId) verdicts.push(event.verdict)
  }, { kinds: ['unread-recount'] }))
  return verdicts
}

let unsubscribes: Array<() => void> = []

describe('XEP-0490 stashed marker lock', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    messageCache._resetDBForTesting()
    _resetStorageScopeForTesting()
    setStorageScopeJid(OWN_BARE)
    localStorageMock.clear()
    connectionStore.getState().reset()
    chatStore.getState().reset()
    roomStore.getState().reset()
    _resetRoomReadStateForTesting()
  })

  afterEach(() => {
    for (const unsubscribe of unsubscribes) unsubscribe()
    unsubscribes = []
    messageCache._resetDBForTesting()
    _resetStorageScopeForTesting()
    vi.restoreAllMocks()
  })

  describe('a room', () => {
    it('orders a marker deep in the cached archive, releasing the recount and the publisher', async () => {
      await messageCache.saveRoomMessages([ANCHOR, DEEP, P0, U1, U2])
      addRoom()
      readRoomUpTo(roomPointerOn(P0), 9)

      // The node still serves a marker far older than anything resident: a backgrounded room has
      // no resident rows at all, so only the cache can order it.
      const { client, cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: DEEP.stanzaId! }])

      // The room's read position reaches the node again, replacing the stale marker…
      await vi.waitFor(() => {
        expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, P0.stanzaId, ROOM)
      }, PUBLISH_WAIT)
      // …and the recount no longer waits on it.
      await vi.waitFor(() => {
        expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
        expect(roomMeta()?.unreadCount).toBe(2)
      }, WAIT)
      // Behind the local position: ordering it moves nothing.
      expect(roomMeta()?.readPointer?.identity.messageId).toBe(P0.id)
      cleanup()
    })

    it('still lets a genuinely newer marker, ordered from the cache, advance the read pointer', async () => {
      await messageCache.saveRoomMessages([ANCHOR, P0, U1, U2])
      addRoom()
      readRoomUpTo(roomPointerOn(P0), 9)
      const { client, cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: P0.stanzaId! }])

      // Another device read up to u2 while this room sits in the background.
      remoteDisplayed(client, ROOM, U2.stanzaId!)

      await vi.waitFor(() => {
        expect(roomMeta()?.readPointer?.identity.messageId).toBe(U2.id)
        expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
        expect(roomMeta()?.unreadCount).toBe(0)
      }, WAIT)
      // The node already holds that position; the older local one is never sent over it.
      expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(ROOM, P0.stanzaId, ROOM)
      cleanup()
    })

    it('clears a cached marker behind a floor pointer without moving it', async () => {
      await messageCache.saveRoomMessages([ANCHOR, DEEP, P0, U1, U2])
      addRoom()
      readRoomUpTo(floorPointerOn(P0), 2)

      const { cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: DEEP.stanzaId! }])

      await vi.waitFor(() => {
        expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
        expect(roomMeta()?.readPointer?.identity.messageId).toBe(P0.id)
      }, WAIT)
      cleanup()
    })

    it('advances a floor pointer to a cached marker ahead of it', async () => {
      await messageCache.saveRoomMessages([ANCHOR, P0, U1, U2])
      addRoom()
      readRoomUpTo(floorPointerOn(P0), 2)

      const { cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: U1.stanzaId! }])

      await vi.waitFor(() => {
        expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
        expect(roomMeta()?.readPointer?.identity.messageId).toBe(U1.id)
      }, WAIT)
      cleanup()
    })

    it('resumes the recount once a later marker is ordered, keeping the stash it superseded', async () => {
      await messageCache.saveRoomMessages([ANCHOR, P0, U1, U2])
      addRoom([P0, U1, U2])
      readRoomUpTo(roomPointerOn(P0), 9)
      const verdicts = recountVerdicts(ROOM)

      // Neither the resident slice nor the cache holds this marker.
      const { client, cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: 's-hole' }])
      await vi.waitFor(() => expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBe('s-hole'), WAIT)

      // The node moves on to a position the resident slice can order.
      remoteDisplayed(client, ROOM, U1.stanzaId!)

      await vi.waitFor(() => {
        expect(roomMeta()?.readPointer?.identity.messageId).toBe(U1.id)
        expect(roomMeta()?.unreadCount).toBe(1)
      }, WAIT)
      expect(verdicts.at(-1)).toEqual({ status: 'counted', count: 1, previousCount: 9 })
      // Kept, not dropped: it may still name a position ahead of ours.
      expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBe('s-hole')
      cleanup()
    })

    it('still advances to a superseded stash once it can be ordered and is ahead', async () => {
      await messageCache.saveRoomMessages([ANCHOR, P0, U1, U2])
      addRoom([P0, U1, U2])
      readRoomUpTo(roomPointerOn(P0), 9)
      const { client, cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: 's-hole' }])
      await vi.waitFor(() => expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBe('s-hole'), WAIT)
      remoteDisplayed(client, ROOM, U1.stanzaId!)
      await vi.waitFor(() => expect(roomMeta()?.readPointer?.identity.messageId).toBe(U1.id), WAIT)

      const hole = roomRow('hole', 's-hole', 8_000)
      roomStore.getState().mergeRoomMAMMessages(ROOM, [hole], {}, true, 'forward')

      expect(roomMeta()?.readPointer?.identity.messageId).toBe(hole.id)
      expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
      cleanup()
    })

    it('keeps holding the publisher and the recount on a current marker nothing can order', async () => {
      await messageCache.saveRoomMessages([ANCHOR, P0, U1, U2])
      addRoom()
      readRoomUpTo(roomPointerOn(P0), 9)
      const verdicts = recountVerdicts(ROOM)
      const { client, cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: 's-hole' }])
      await vi.waitFor(() => expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBe('s-hole'), WAIT)

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(verdicts.at(-1)).toEqual({ status: 'deferred', reason: 'pending-remote-displayed' })
      expect(roomMeta()?.unreadCount).toBe(9)
      // Publishing p0 could walk every other device back from wherever s-hole sits.
      await new Promise((resolve) => setTimeout(resolve, 1_700))
      expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
      cleanup()
    })

    it('defers a released recount when a new marker becomes pending', async () => {
      await messageCache.saveRoomMessages([ANCHOR, P0, U1, U2])
      addRoom([P0, U1, U2])
      readRoomUpTo(roomPointerOn(P0), 9)
      const verdicts = recountVerdicts(ROOM)
      let releaseCount!: (value: { unread: number }) => void
      const count = new Promise<{ unread: number }>((resolve) => { releaseCount = resolve })
      const countUnread = vi.spyOn(messageCache, 'countRoomUnreadInArchive').mockImplementationOnce(() => count)

      const { client, cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: 's-hole' }])
      await vi.waitFor(() => expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBe('s-hole'), WAIT)
      remoteDisplayed(client, ROOM, U1.stanzaId!)
      await vi.waitFor(() => expect(countUnread).toHaveBeenCalledTimes(1), WAIT)

      roomStore.getState().applyRemoteDisplayed(ROOM, 's-new')
      releaseCount({ unread: 1 })

      await vi.waitFor(() => {
        expect(verdicts).toContainEqual({ status: 'deferred', reason: 'input-version-changed' })
        expect(roomMeta()?.unreadCount).toBe(9)
      }, WAIT)
      cleanup()
    })

    it('publishes after a superseding node marker resolves behind the local pointer', async () => {
      await messageCache.saveRoomMessages([ANCHOR, DEEP, P0, U1, U2])
      addRoom([DEEP, P0, U1, U2])
      readRoomUpTo(roomPointerOn(P0), 2)

      const { client, cleanup } = await connectWithNode([{ conversationJid: ROOM, stanzaId: 's-hole' }])
      await vi.waitFor(() => expect(roomMeta()?.pendingRemoteDisplayedStanzaId).toBe('s-hole'), WAIT)
      remoteDisplayed(client, ROOM, DEEP.stanzaId!)

      await vi.waitFor(() => {
        expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, P0.stanzaId, ROOM)
        expect(roomMeta()?.readPointer?.identity.messageId).toBe(P0.id)
        expect(roomMeta()?.unreadCount).toBe(2)
      }, PUBLISH_WAIT)
      cleanup()
    })
  })

  describe('a 1:1 conversation', () => {
    const C_ANCHOR = chatRow('c-anchor', 'c-s-anchor', 1_000)
    const C_DEEP = chatRow('c-deep', 'c-s-deep', 2_000)
    const C_P0 = chatRow('c-p0', 'c-s-p0', 5_000)
    const C_U1 = chatRow('c-u1', 'c-s-u1', 6_000)
    const C_U2 = chatRow('c-u2', 'c-s-u2', 7_000)

    function readChatUpTo(pointer: ReadPointer, staleUnreadCount: number): void {
      chatStore.getState().addConversation({ id: CID, name: CID, type: 'chat', unreadCount: 0 })
      chatStore.setState((state) => {
        const conversationMeta = new Map(state.conversationMeta)
        conversationMeta.set(CID, { ...conversationMeta.get(CID)!, readPointer: pointer, unreadCount: staleUnreadCount })
        const mamQueryStates = new Map(state.mamQueryStates)
        mamQueryStates.set(CID, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true })
        const conversationCoverage = new Map(state.conversationCoverage)
        conversationCoverage.set(CID, { bottomId: C_ANCHOR.stanzaId! })
        return { conversationMeta, mamQueryStates, conversationCoverage }
      })
    }

    function chatMeta() {
      return chatStore.getState().conversationMeta.get(CID)
    }

    it('orders a marker deep in the cached archive, releasing the recount and the publisher', async () => {
      await messageCache.saveMessages([C_ANCHOR, C_DEEP, C_P0, C_U1, C_U2])
      readChatUpTo(makeReadPointer(C_P0, 'chat'), 9)

      const { client, cleanup } = await connectWithNode([{ conversationJid: CID, stanzaId: C_DEEP.stanzaId! }])

      await vi.waitFor(() => {
        expect(chatMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
        expect(chatMeta()?.unreadCount).toBe(2)
        expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, C_P0.stanzaId, OWN_BARE)
      }, PUBLISH_WAIT)
      expect(chatMeta()?.readPointer?.identity.messageId).toBe(C_P0.id)
      cleanup()
    })

    it('clears a cached marker behind a floor pointer without moving it', async () => {
      await messageCache.saveMessages([C_ANCHOR, C_DEEP, C_P0, C_U1, C_U2])
      readChatUpTo(floorPointerOn(C_P0), 2)

      const { cleanup } = await connectWithNode([{ conversationJid: CID, stanzaId: C_DEEP.stanzaId! }])

      await vi.waitFor(() => {
        expect(chatMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
        expect(chatMeta()?.readPointer?.identity.messageId).toBe(C_P0.id)
      }, WAIT)
      cleanup()
    })

    it('advances a floor pointer to a cached marker ahead of it', async () => {
      await messageCache.saveMessages([C_ANCHOR, C_P0, C_U1, C_U2])
      readChatUpTo(floorPointerOn(C_P0), 2)

      const { cleanup } = await connectWithNode([{ conversationJid: CID, stanzaId: C_U1.stanzaId! }])

      await vi.waitFor(() => {
        expect(chatMeta()?.pendingRemoteDisplayedStanzaId).toBeUndefined()
        expect(chatMeta()?.readPointer?.identity.messageId).toBe(C_U1.id)
      }, WAIT)
      cleanup()
    })

    it('resumes the recount once a later marker is ordered, keeping the stash it superseded', async () => {
      await messageCache.saveMessages([C_ANCHOR, C_P0, C_U1, C_U2])
      readChatUpTo(makeReadPointer(C_P0, 'chat'), 9)
      chatStore.setState((state) => ({ messages: new Map(state.messages).set(CID, [C_P0, C_U1, C_U2]) }))
      const { client, cleanup } = await connectWithNode([{ conversationJid: CID, stanzaId: 'c-s-hole' }])
      await vi.waitFor(() => expect(chatMeta()?.pendingRemoteDisplayedStanzaId).toBe('c-s-hole'), WAIT)

      remoteDisplayed(client, CID, C_U1.stanzaId!)

      await vi.waitFor(() => {
        expect(chatMeta()?.readPointer?.identity.messageId).toBe(C_U1.id)
        expect(chatMeta()?.unreadCount).toBe(1)
      }, WAIT)
      expect(chatMeta()?.pendingRemoteDisplayedStanzaId).toBe('c-s-hole')
      cleanup()
    })
  })
})
