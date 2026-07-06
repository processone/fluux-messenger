/**
 * Tests for the MDS (XEP-0490) read-position publisher side effect.
 *
 * Verifies debounced, coalesced, forward-only publishing of the resolved
 * stanza-id per conversation:
 * - A local read advance publishes the resolved stanza-id once, debounced.
 * - A read marker with no resolvable stanza-id does NOT publish.
 * - Pending publishes are DROPPED on disconnect (localStorage is the durable buffer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock localStorage before importing stores (chatStore persist middleware).
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { setupMdsSideEffects } from './mdsSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { roomStore } from '../stores/roomStore'
import type { Message } from './types/chat'
import type { Room, RoomMessage } from './types/room'
import { getLocalPart } from './jid'

function msg(id: string, stanzaId: string | undefined): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    conversationId: 'juliet@capulet.example',
    from: 'juliet@capulet.example',
    body: id,
    timestamp: new Date(),
    isOutgoing: false,
  } as Message
}

/** Seed messages directly into the store's messages Map (same as chatStore.mds.test.ts). */
function seedMessages(cid: string, messages: Message[]): void {
  chatStore.setState((state) => {
    const newMessages = new Map(state.messages)
    newMessages.set(cid, messages)
    return { messages: newMessages }
  })
}

/**
 * Seed a conversationMeta entry so updateLastSeenMessageId is allowed to advance.
 * updateLastSeenMessageId early-returns when no meta entry exists.
 */
function seedMeta(cid: string, lastSeenMessageId?: string): void {
  chatStore.setState((state) => {
    const newMeta = new Map(state.conversationMeta)
    newMeta.set(cid, { unreadCount: 0, lastSeenMessageId })
    const newConvs = new Map(state.conversations)
    newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, lastSeenMessageId })
    return { conversationMeta: newMeta, conversations: newConvs }
  })
}

/** Build a RoomMessage (mirrors roomStore.mds.test.ts rmsg helper). */
function rmsg(room: string, id: string, stanzaId: string, t: number): RoomMessage {
  return {
    type: 'groupchat',
    id,
    stanzaId,
    roomJid: room,
    from: `${room}/alice`,
    nick: 'alice',
    body: id,
    timestamp: new Date(t),
    isOutgoing: false,
  } as RoomMessage
}

/**
 * Seed a room into roomStore via the real addRoom idiom (mirrors roomStore.mds.test.ts).
 * addRoom populates rooms, roomEntities, roomMeta, and roomRuntime from one Room object,
 * so isRoom()/routing and message lookup work. An optional lastSeenMessageId is patched in.
 */
function seedRoom(jid: string, messages: RoomMessage[], lastSeenMessageId?: string): void {
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

function makeClient() {
  const handlers: Record<string, Array<(p?: unknown) => void>> = {}
  const register = (ev: string, cb: (p?: unknown) => void) => {
    ;(handlers[ev] ||= []).push(cb)
    return () => {
      handlers[ev] = (handlers[ev] || []).filter((h) => h !== cb)
    }
  }
  return {
    // Connection lifecycle events ('online'/'resumed') use client.on(...).
    on: register,
    // SDK events ('read:displayed-synced') use client.subscribe(...).
    subscribe: register,
    _emit: (ev: string, p?: unknown) => (handlers[ev] || []).forEach((h) => h(p)),
    mds: {
      publishDisplayed: vi.fn().mockResolvedValue(undefined),
      fetchAllDisplayed: vi.fn().mockResolvedValue([]),
      retractDisplayed: vi.fn().mockResolvedValue(undefined),
    },
  }
}

/** Add a 1:1 conversation entity via the real addConversation store action. */
function addConversation(id: string): void {
  chatStore.getState().addConversation({ id, name: id, type: 'chat', unreadCount: 0 })
}

describe('setupMdsSideEffects', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connectionStore.getState().reset()
    chatStore.getState().reset()
    roomStore.getState().reset()
    localStorageMock.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('publishes the resolved stanza-id once, debounced, on a local read advance', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)

    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // let the async seed settle

    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')
    chatStore.getState().updateLastSeenMessageId(cid, 'm2')

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled() // still debouncing
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    // 1:1 → by is our own bare JID (the archive that assigned the stanza-id).
    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    cleanup()
  })

  it('does not publish a marker with no stanza-id', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    seedMessages(cid, [msg('m1', undefined)])
    seedMeta(cid)
    chatStore.getState().updateLastSeenMessageId(cid, 'm1')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('drops pending publishes on disconnect', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    seedMessages(cid, [msg('m1', 's1')])
    seedMeta(cid)
    chatStore.getState().updateLastSeenMessageId(cid, 'm1')
    connectionStore.setState({ status: 'connecting' } as never) // disconnect
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not re-publish the echo of a live incoming remote marker', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Conversation already exists with a settled local read position at m1 before
    // the side effect starts, so the fresh-session seed snapshots m1 as the last
    // considered position (no spurious publish for the existing position).
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // let the async seed settle

    // A live remote marker for s2 arrives from a peer device (PubSub emits
    // 'read:displayed-synced' and storeBindings calls applyRemoteDisplayed). Apply
    // the store advance FIRST so the conversationMeta subscription → consider()
    // enqueues s2 with no node value recorded yet (worst-case handler order). Only
    // THEN record the node high-water mark. This exercises the doPublish exact-equal
    // skip specifically — consider() already enqueued before the node value existed.
    chatStore.getState().applyRemoteDisplayed(cid, 's2')
    client._emit('read:displayed-synced', { conversationId: cid, stanzaId: 's2' })

    await vi.advanceTimersByTimeAsync(2_000)

    // The marker s2 is already on the node (it is the echo) → must NOT republish.
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('publishes the room-archive stanza-id on a local room read advance, debounced', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Seed the room (rooms + roomRuntime + roomMeta) so isRoom()/routing works.
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)], 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // let the async seed settle

    roomStore.getState().updateLastSeenMessageId(ROOM, 'm2')
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled() // still debouncing
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    // MUC → by is the room JID (the room's archive assigned the stanza-id).
    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's2', ROOM)
    cleanup()
  })

  it('seeds a room marker from the node into roomStore', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    client.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's2' }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // roomStore.rooms must contain ROOM with its messages so the seed routes to
    // the room and applyRemoteDisplayed can resolve the stanza-id to a local id.
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)], 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m2')
    cleanup()
  })

  it('re-applies a seed marker to a room that becomes known after the seed', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    // The node holds a marker for a room that is NOT yet in roomStore.rooms at
    // seed time (bookmarks load after the online seed on a cold start).
    client.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's2' }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // settle the async seed

    // Room unknown at seed time → marker routed to chat (no-op), so the room's
    // read position is NOT advanced and no room entity exists yet.
    expect(roomStore.getState().roomMeta.has(ROOM)).toBe(false)

    // The bookmark now lands: the room (with message s2) appears in roomStore,
    // firing the rooms subscription, which drains the stashed seed marker. A
    // freshly-bookmarked room starts with no read position, so the drained
    // marker is what advances it (no lastSeenMessageId patch here).
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)])

    // The stashed marker was drained and applied to the room.
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m2')

    // And it must NOT cause an echo republish: lastKnownNodeStanzaId[ROOM] was
    // recorded during the seed, so consider() is echo-suppressed.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not re-publish the echo of a live incoming remote marker for a known room', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Known room with a settled local read position at m1 before the side effect
    // starts, so the seed snapshots m1 as the last considered position.
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)], 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // settle the async seed

    // A live remote marker for s2 arrives from a peer device. Mirror the binding:
    // apply the store advance FIRST (roomMeta subscription → consider() enqueues
    // s2 with no node value yet), THEN record the node high-water mark via the
    // read:displayed-synced event. Exercises the doPublish exact-equal skip.
    roomStore.getState().applyRemoteDisplayed(ROOM, 's2')
    client._emit('read:displayed-synced', { conversationId: ROOM, stanzaId: 's2' })

    await vi.advanceTimersByTimeAsync(2_000)

    // s2 is already on the node (it is the echo) → must NOT republish.
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('resolves the seen stanza-id from lastMessage when the resident array is evicted', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Backgrounded room: the resident array is evicted (memory windowing), but
    // the newest message survives on the lastMessage preview (both maps, as
    // mergeRoomMAMMessages maintains them).
    seedRoom(ROOM, [])
    const newest = rmsg(ROOM, 'm9', 's9', 9)
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, { ...meta.get(ROOM)!, lastMessage: newest })
      const rooms = new Map(s.rooms)
      rooms.set(ROOM, { ...rooms.get(ROOM)!, lastMessage: newest })
      return { roomMeta: meta, rooms }
    })

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // settle the async seed

    // Mark-all-read on a backgrounded room: the pointer advances to the newest
    // known message id with NO resident messages loaded to resolve it from.
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, { ...meta.get(ROOM)!, lastSeenMessageId: 'm9' })
      return { roomMeta: meta }
    })

    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's9', ROOM)
    cleanup()
  })

  // Spec §5 pin: this exercises the lastKnownNodeStanzaId EXACT-EQUAL SKIP in
  // doPublish directly, at the point where it actually matters — a publish
  // still sitting in the debounced dirty buffer, not yet flushed. It is
  // distinct from "does not re-publish the echo of a live incoming remote
  // marker for a known room" above: that test pins post-publish echo
  // suppression via consider()'s no-regressive-publish index guard (a
  // SEPARATE guard, driven by a fresh applyRemoteDisplayed advance
  // re-entering consider() after lastKnownNodeStanzaId is already current).
  // This test instead pins the doPublish flush-time skip: the buffered entry
  // is enqueued BEFORE the node value is recorded, and only doPublish's
  // `lastKnownNodeStanzaId.get(jid) === stanzaId` check (not consider()'s
  // index guard, which never re-runs here) prevents the flush from
  // publishing. Deleting either (a) that skip in doPublish, or (b) the
  // read:displayed-synced subscription's lastKnownNodeStanzaId.set(...), logs
  // a spurious second publish.
  it('buffered publish is skipped when the node already holds the same stanza-id (post-sync dedup — spec §5 no-loop pin)', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Resident m9/s9, read pointer BEHIND it (no lastSeenMessageId patch).
    seedRoom(ROOM, [rmsg(ROOM, 'm9', 's9', 9)])

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // Advance the pointer locally: consider() resolves s9 and buffers it in
    // the dirty coalescer with the debounce still pending. Do NOT advance
    // fake timers yet — the publish must still be sitting unflushed.
    roomStore.getState().updateLastSeenMessageId(ROOM, 'm9')
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()

    // Before the debounce fires, another device publishes the SAME position:
    // the read:displayed-synced subscription records
    // lastKnownNodeStanzaId[ROOM] = 's9'. This does not touch the dirty
    // buffer at all — s9 is still queued from the step above.
    client._emit('read:displayed-synced', { conversationId: ROOM, stanzaId: 's9' })

    // Now the debounce fires: doPublish flushes the buffered s9, hits the
    // exact-equal skip against the just-recorded node value, and publishes
    // nothing.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('retracts the MDS marker when a conversation is deleted while online+synced', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // seed completes → syncEnabled true, baseline built

    // a conversation exists (in conversationEntities), then is deleted
    addConversation(cid)
    await vi.advanceTimersByTimeAsync(0)
    chatStore.getState().deleteConversation(cid)
    await vi.advanceTimersByTimeAsync(0)

    expect(client.mds.retractDisplayed).toHaveBeenCalledWith(cid)
    cleanup()
  })

  it('does NOT retract on a wholesale clear (logout/reset)', async () => {
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    addConversation('a@x')
    addConversation('b@x')
    await vi.advanceTimersByTimeAsync(0)

    chatStore.getState().reset() // mass clear
    await vi.advanceTimersByTimeAsync(0)

    expect(client.mds.retractDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('migrates a legacy-format 1:1 seed marker by republishing it in spec format', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1', legacy: true }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Known 1:1 conversation entity → the seed can classify the JID and migrate.
    addConversation(cid)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')

    // Migration is one-shot: nothing further is pending or debounced.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('a failed legacy migration does not break the seed or later publishing', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1', legacy: true }])
    // The migration republish fails (e.g. transient IQ error)…
    client.mds.publishDisplayed = vi.fn().mockRejectedValueOnce(new Error('timeout'))
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    addConversation(cid)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1) // the failed migration

    // …and a later local read advance still publishes normally.
    client.mds.publishDisplayed = vi.fn().mockResolvedValue(undefined)
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')
    chatStore.getState().updateLastSeenMessageId(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    cleanup()
  })

  it('does NOT republish spec-format seed markers', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1' }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    addConversation(cid)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('migrates a legacy room marker when the room becomes known after the seed', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    client.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's2', legacy: true }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // Unknown JID at seed time (bookmarks not loaded, no conversation entity):
    // cannot classify → no migration yet.
    expect(client.mds.publishDisplayed).not.toHaveBeenCalled()

    // The bookmark lands: the room appears, the stashed marker drains, and the
    // legacy marker is republished in spec format with by = room JID.
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)])
    await vi.advanceTimersByTimeAsync(0)

    expect(client.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's2', ROOM)
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastSeenMessageId).toBe('m2')

    // And no echo republish on top of the migration.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does NOT retract while offline or before sync is enabled', async () => {
    const cid = 'c@x'
    const client = makeClient()
    connectionStore.setState({ status: 'connecting' } as never) // not online
    const cleanup = setupMdsSideEffects(client as never)

    addConversation(cid)
    await vi.advanceTimersByTimeAsync(0)
    chatStore.getState().deleteConversation(cid)
    await vi.advanceTimersByTimeAsync(0)

    expect(client.mds.retractDisplayed).not.toHaveBeenCalled()
    cleanup()
  })
})
