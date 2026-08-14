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
import { makeReadPointer, type ReadPointer } from '../stores/shared/readPointer'

// Deterministic per-id timestamp: 'm3' → base + 3s. A read pointer carries the
// timestamp of the message it names (#1081), so `pointerAt` can build one from
// an id alone.
const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime()
function timeFor(id: string): Date {
  return new Date(BASE_TIME + (Number(id.replace(/\D/g, '')) || 0) * 1000)
}

/**
 * The read pointer naming `id`, carrying that message's own timestamp — but as a
 * FLOOR, i.e. the pre-#1081 migrated shape with no tie-break. The exact variant
 * is covered in mdsSideEffects.cache.test.ts.
 */
function pointerAt(id: string): ReadPointer {
  return { order: { role: 'floor', timestamp: timeFor(id).getTime() }, identity: { state: 'local', messageId: id } }
}

function msg(id: string, stanzaId: string | undefined): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    conversationId: 'juliet@capulet.example',
    from: 'juliet@capulet.example',
    body: id,
    timestamp: timeFor(id),
    isOutgoing: false,
  } as Message
}

/**
 * Our OWN 1:1 message. The server does not reflect these back the way a MUC
 * does, so an own send carries only a client `originId` and never acquires a
 * server `stanzaId` — the state the at-or-behind fallback exists for.
 */
function ownMsg(id: string, stanzaId: string | undefined): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    originId: `origin-${id}`,
    conversationId: 'juliet@capulet.example',
    from: 'romeo@montague.example',
    body: id,
    timestamp: timeFor(id),
    isOutgoing: true,
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
 * Seed a conversationMeta entry so advanceReadPointer is allowed to advance.
 * advanceReadPointer early-returns when no meta entry exists.
 */
function seedMeta(cid: string, seenMessageId?: string): void {
  const readPointer = seenMessageId === undefined ? undefined : pointerAt(seenMessageId)
  chatStore.setState((state) => {
    const newMeta = new Map(state.conversationMeta)
    newMeta.set(cid, { unreadCount: 0, readPointer })
    const newConvs = new Map(state.conversations)
    newConvs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer })
    return { conversationMeta: newMeta, conversations: newConvs }
  })
}

/** Patch a conversationMeta entry in place (fires the conversationMeta subscription). */
function patchMeta(
  cid: string,
  patch: Partial<{ readPointer: ReadPointer; unreadCount: number }>
): void {
  chatStore.setState((state) => {
    const newMeta = new Map(state.conversationMeta)
    newMeta.set(cid, { ...newMeta.get(cid)!, ...patch })
    return { conversationMeta: newMeta }
  })
}

/** Build a RoomMessage (mirrors roomStore.mds.test.ts rmsg helper). */
function rmsg(room: string, id: string, stanzaId: string | undefined, t: number): RoomMessage {
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

/** Our own groupchat message — outgoing, and (until reflected) without a stanza-id. */
function ownRoomMsg(room: string, id: string, stanzaId: string | undefined, t: number): RoomMessage {
  return {
    type: 'groupchat',
    id,
    stanzaId,
    originId: `origin-${id}`,
    roomJid: room,
    from: `${room}/testuser`,
    nick: 'testuser',
    body: id,
    timestamp: new Date(t),
    isOutgoing: true,
  } as RoomMessage
}

/**
 * Seed a room into roomStore via the real addRoom idiom (mirrors roomStore.mds.test.ts).
 * addRoom populates rooms, roomEntities, roomMeta, and roomRuntime from one Room object,
 * so isRoom()/routing and message lookup work. An optional read pointer (named by
 * message id, carrying that message's own timestamp) is patched in.
 */
function seedRoom(jid: string, messages: RoomMessage[], seenMessageId?: string): void {
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
  if (seenMessageId !== undefined) {
    const seen = messages.find((m) => m.id === seenMessageId)
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      const existing = meta.get(jid)!
      meta.set(jid, {
        ...existing,
        readPointer: {
          order: seen
            ? { role: 'exact', timestamp: seen.timestamp.getTime(), tiebreak: { kind: 'room', from: seen.from, id: seenMessageId } }
            : { role: 'floor', timestamp: 0 },
          identity: { state: 'local', messageId: seenMessageId },
        },
      })
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
  const mds = {
    publishDisplayed: vi.fn().mockResolvedValue(undefined),
    fetchAllDisplayed: vi.fn().mockResolvedValue([]),
    fetchAllDisplayedResult: vi.fn(),
    retractDisplayed: vi.fn().mockResolvedValue(undefined),
  }
  mds.fetchAllDisplayedResult.mockImplementation(async () => {
    try {
      return {
        status: 'authoritative' as const,
        markers: await mds.fetchAllDisplayed(),
      }
    } catch {
      return { status: 'unknown' as const }
    }
  })

  return {
    // Connection lifecycle events ('online'/'resumed') use client.on(...).
    // SDK events ('read:displayed-synced') use client.subscribe(...).
    subscribe: register,
    _emit: (ev: string, p?: unknown) => (handlers[ev] || []).forEach((h) => h(p)),
    internal: { on: register, mds },
  }
}

/** Add a 1:1 conversation entity via the real addConversation store action. */
function addConversation(id: string): void {
  chatStore.getState().addConversation({ id, name: id, type: 'chat', unreadCount: 0 })
}

/** Force a conversation's MAM query state (catch-up gate input). */
function setConvMamState(
  cid: string,
  patch: Partial<{
    isLoading: boolean
    hasQueried: boolean
    isCaughtUpToLive: boolean
    error: string | null
  }>
): void {
  chatStore.setState((state) => {
    const next = new Map(state.mamQueryStates)
    next.set(cid, {
      isLoading: false,
      hasQueried: false,
      error: null,
      isHistoryComplete: false,
      isCaughtUpToLive: false,
      ...patch,
    } as never)
    return { mamQueryStates: next }
  })
}

/** Force a room's MAM query state (catch-up gate input, room twin). */
function setRoomMamState(
  jid: string,
  patch: Partial<{
    isLoading: boolean
    hasQueried: boolean
    isCaughtUpToLive: boolean
    error: string | null
  }>
): void {
  roomStore.setState((state) => {
    const next = new Map(state.mamQueryStates)
    next.set(jid, {
      isLoading: false,
      hasQueried: false,
      error: null,
      isHistoryComplete: false,
      isCaughtUpToLive: false,
      ...patch,
    } as never)
    return { mamQueryStates: next }
  })
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
    chatStore.getState().advanceReadPointer(cid, 'm2')

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled() // still debouncing
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    // 1:1 → by is our own bare JID (the archive that assigned the stanza-id).
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
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
    chatStore.getState().advanceReadPointer(cid, 'm1')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  // ==========================================================================
  // The at-or-behind fallback for a pointer naming our own unarchived 1:1 send.
  //
  // The test directly above passes for BOTH behaviours: its fixture holds a
  // single stanza-id-less message, so there is nothing at-or-behind to fall back
  // to either way. That made it an accidental rather than a deliberate pin, so
  // the contract is stated explicitly here — in both directions.
  // ==========================================================================

  it('publishes the newest resolvable position at or behind a pointer naming our own unarchived 1:1 send', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // 1:1 sends are never reflected back, so ours carries no stanza-id — ever.
    seedMessages(cid, [msg('m1', 's1'), ownMsg('m2', undefined)])
    // Start POINTERLESS: an initial pointer on m1 would resolve to s1 on its own
    // and this would pass without the fallback ever running.
    seedMeta(cid)
    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m2')
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')
    cleanup()
  })

  it('does not publish when nothing at or behind the pointer is resolvable', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // Every candidate at-or-behind is our own, unarchived: nothing to fall back
    // to, and the fallback must not invent one.
    seedMessages(cid, [ownMsg('m1', undefined), ownMsg('m2', undefined)])
    seedMeta(cid)
    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('never publishes a position ahead of the read pointer', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // m3 arrived AFTER our own m2 and has NOT been read. The fallback walks
    // back from the pointer, so it must never reach forward to s3.
    seedMessages(cid, [msg('m1', 's1'), ownMsg('m2', undefined), msg('m3', 's3')])
    seedMeta(cid)
    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(chatStore.getState().conversationMeta.get(cid)?.readPointer?.identity.messageId).toBe('m2')
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(cid, 's3', 'romeo@montague.example')
    cleanup()
  })

  it('uses the pointer cache-order key to reject an unread same-millisecond sibling', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // IndexedDB orders equal-timestamp chat messages by id. The pointer names
    // m2, so m3 is still ahead even though all three messages share a timestamp.
    const sameTimestamp = new Date('2026-01-01T00:00:02Z')
    seedMessages(cid, [
      { ...msg('m1', 's1'), timestamp: sameTimestamp },
      { ...ownMsg('m2', undefined), timestamp: sameTimestamp },
      { ...msg('m3', 's3'), timestamp: sameTimestamp },
    ])
    seedMeta(cid)
    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(
      chatStore.getState().conversationMeta.get(cid)?.readPointer?.order
    ).toEqual({ role: 'exact', timestamp: timeFor('m2').getTime(), tiebreak: { kind: 'chat', id: 'm2' } })
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(cid, 's3', 'romeo@montague.example')
    cleanup()
  })

  it('keeps a keyless legacy-migrated pointer conservative, ordering by its lastReadAt alone', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    seedMessages(cid, [msg('m1', 's1'), msg('m3', 's3'), ownMsg('m4', undefined)])
    seedMeta(cid)
    // A pointer migrated from the pre-#1081 lastSeenMessageId + lastReadAt pair
    // has NO tiebreak, and its timestamp is lastReadAt — documented as at
    // or behind the message it names (readPointer.ts). Ordering by it therefore
    // under-advances: m3 sits past lastReadAt=2s and must not be selected.
    patchMeta(cid, { readPointer: { order: { role: 'floor', timestamp: new Date(timeFor('m2')).getTime() }, identity: { state: 'local', messageId: 'm4' } } })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(cid, 's3', 'romeo@montague.example')
    cleanup()
  })

  it('does not publish when the pointer is off-slice and every resident message is newer', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // The resident window is a NEWER slice; the pointed-at message was evicted.
    // Ordering against the pointer keeps the fallback from over-advancing onto
    // the window (the shape issue #1175 describes).
    seedMessages(cid, [msg('m9', 's9'), msg('m10', 's10')])
    seedMeta(cid)
    patchMeta(cid, { readPointer: { order: { role: 'floor', timestamp: new Date(timeFor('m2')).getTime() }, identity: { state: 'local', messageId: 'evicted-m2' } } })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not re-assert an unchanged fallback as further own sends advance the pointer', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    seedMessages(cid, [msg('m1', 's1'), ownMsg('m2', undefined)])
    seedMeta(cid)
    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)

    // A further own send advances the pointer, but resolves to the same
    // fallback: the exact-equal skip must suppress a redundant publish.
    seedMessages(cid, [msg('m1', 's1'), ownMsg('m2', undefined), ownMsg('m4', undefined)])
    chatStore.getState().advanceReadPointer(cid, 'm4')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does NOT apply the fallback to rooms, whose own messages are reflected with a stanza-id', async () => {
    const room = 'tech@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // Our own groupchat message, momentarily before the room reflects it back.
    seedRoom(room, [rmsg(room, 'r1', 'rs1', 1_000), ownRoomMsg(room, 'r2', undefined, 2_000)], 'r2')
    setRoomMamState(room, { hasQueried: true, isCaughtUpToLive: true })
    await vi.advanceTimersByTimeAsync(2_000)

    // Deliberate asymmetry: the room branch keeps the exact-position contract.
    // It is safe because the wait is transient — MUC reflection supplies the
    // stanza-id — and it avoids degrading a path that already reports the true
    // position. A room that never injected stanza-ids would have nothing
    // resolvable at-or-behind either, so a fallback could not help it.
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    // The reflection lands and backfills the stanza-id; #1142's retry then
    // publishes the TRUE position rather than an approximation of it.
    roomStore.setState((s) => {
      const runtime = new Map(s.roomRuntime)
      const entry = runtime.get(room)!
      runtime.set(room, {
        ...entry,
        messages: entry.messages.map((m) => (m.id === 'r2' ? { ...m, stanzaId: 'rs2' } : m)),
      })
      return { roomRuntime: runtime }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(room, 'rs2', room)
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
    chatStore.getState().advanceReadPointer(cid, 'm1')
    connectionStore.setState({ status: 'connecting' } as never) // disconnect
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not re-publish the echo of a live incoming remote marker', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Conversation already exists with a SETTLED local read position at m1: the
    // node holds that same position, so the seed has nothing left to publish for
    // it and the test isolates the echo of the s2 marker that follows.
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1' }])
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
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('publishes the room-archive stanza-id on a local room read advance, debounced', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Seed the room (rooms + roomRuntime + roomMeta) so isRoom()/routing works.
    // The node already holds the settled position m1/s1, so the only publish the
    // test can observe is the m2 advance below.
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's1' }])
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)], 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync() // let the async seed settle

    roomStore.getState().advanceReadPointer(ROOM, 'm2')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled() // still debouncing
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    // MUC → by is the room JID (the room's archive assigned the stanza-id).
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's2', ROOM)
    cleanup()
  })

  it('seeds a room marker from the node into roomStore', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's2' }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // roomStore.rooms must contain ROOM with its messages so the seed routes to
    // the room and applyRemoteDisplayed can resolve the stanza-id to a local id.
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)], 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m2')
    cleanup()
  })

  it('re-applies a seed marker to a room that becomes known after the seed', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    // The node holds a marker for a room that is NOT yet in roomStore.rooms at
    // seed time (bookmarks load after the online seed on a cold start).
    client.internal.mds.fetchAllDisplayed = vi
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
    // marker is what advances it (no read-pointer patch here).
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)])

    // The stashed marker was drained and applied to the room.
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m2')

    // And it must NOT cause an echo republish: lastKnownNodeStanzaId[ROOM] was
    // recorded during the seed, so consider() is echo-suppressed.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not re-publish the echo of a live incoming remote marker for a known room', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Known room with a SETTLED local read position at m1 — the node holds that
    // same position, so the seed has nothing left to publish for it.
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's1' }])
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
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
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
      meta.set(ROOM, {
        ...meta.get(ROOM)!,
        readPointer: { order: { role: 'exact', timestamp: new Date(newest.timestamp).getTime(), tiebreak: { kind: 'room', from: newest.from, id: newest.id } }, identity: { state: 'local', messageId: newest.id } },
      })
      return { roomMeta: meta }
    })

    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's9', ROOM)
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

    // Resident m9/s9, read pointer BEHIND it (no read-pointer patch).
    seedRoom(ROOM, [rmsg(ROOM, 'm9', 's9', 9)])

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // Advance the pointer locally: consider() resolves s9 and buffers it in
    // the dirty coalescer with the debounce still pending. Do NOT advance
    // fake timers yet — the publish must still be sitting unflushed.
    roomStore.getState().advanceReadPointer(ROOM, 'm9')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    // Before the debounce fires, another device publishes the SAME position:
    // the read:displayed-synced subscription records
    // lastKnownNodeStanzaId[ROOM] = 's9'. This does not touch the dirty
    // buffer at all — s9 is still queued from the step above.
    client._emit('read:displayed-synced', { conversationId: ROOM, stanzaId: 's9' })

    // Now the debounce fires: doPublish flushes the buffered s9, hits the
    // exact-equal skip against the just-recorded node value, and publishes
    // nothing.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  // #1142: consider() used to commit its de-dup key BEFORE resolving the
  // stanza-id, so a position that failed to resolve once short-circuited every
  // later consider() on the equality check and was never published. The key must
  // mean "this position is handled", not merely "we have seen this position".
  it('re-considers a 1:1 read position that could not be resolved when it first advanced', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    seedMeta(cid)
    seedMessages(cid, [msg('m2', undefined)])
    chatStore.setState({ activeConversationId: cid })

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    patchMeta(cid, { readPointer: pointerAt('m2') })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    chatStore.getState().mergeMAMMessages(cid, [msg('m2', 's2')], {}, true, 'forward')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')

    // …and once handled it stays handled: further meta churn must not republish.
    patchMeta(cid, { unreadCount: 2 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('re-considers a room read position that could not be resolved when it first advanced', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    seedRoom(ROOM, [rmsg(ROOM, 'm2', undefined, 2)])
    roomStore.setState({ activeRoomJid: ROOM })

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, {
        ...meta.get(ROOM)!,
        readPointer: { order: { role: 'exact', timestamp: new Date(2).getTime(), tiebreak: { kind: 'room', from: `${ROOM}/alice`, id: 'm2' } }, identity: { state: 'local', messageId: 'm2' } },
      })
      return { roomMeta: meta }
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    roomStore.getState().mergeRoomMAMMessages(
      ROOM,
      [rmsg(ROOM, 'm2', 's2', 2)],
      {},
      true,
      'forward'
    )
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's2', ROOM)

    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, { ...meta.get(ROOM)!, unreadCount: 1 })
      return { roomMeta: meta }
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('re-arms a position dropped when the publishing JID is temporarily unavailable', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: undefined } as never)

    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    connectionStore.setState({
      status: 'online',
      jid: 'romeo@montague.example/phone',
    } as never)
    patchMeta(cid, { unreadCount: 1 })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(
      cid,
      's2',
      'romeo@montague.example'
    )

    patchMeta(cid, { unreadCount: 2 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  // #1145: the fresh-session seed used to clear `lastConsideredSeenId` and then
  // immediately re-fill it from the current read pointers, re-recording a position
  // that was never published as already handled. consider() then short-circuited
  // on it for the whole session, and only a FURTHER local read advance could ever
  // recover it — so the user's other devices never learned the position.
  it('publishes a read position left unpublished by the previous session, with no further read advance', async () => {
    const cid = 'juliet@capulet.example'

    // --- Session 1: the position advances but never resolves to a stanza-id, so
    // it is never published (the #1142 shape, now retried rather than silenced).
    const first = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    seedMeta(cid)
    seedMessages(cid, [msg('m2', undefined)])

    const stopFirst = setupMdsSideEffects(first as never)
    first._emit('online')
    await vi.runOnlyPendingTimersAsync()

    patchMeta(cid, { readPointer: pointerAt('m2') })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(first.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    connectionStore.setState({ status: 'offline' } as never)
    stopFirst()

    // --- Session 2 (restart): the read pointer survives in localStorage, and the
    // reloaded slice now names a stanza-id for it. The node still holds an OLDER
    // marker for this conversation, which is the ordinary shape once any position
    // has ever been published — the seed must not treat that as "handled".
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    const second = makeClient()
    second.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1' }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    const stopSecond = setupMdsSideEffects(second as never)
    second._emit('online')
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2_000)

    // No local read advance happened in session 2 — the seed itself must publish.
    expect(second.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(second.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    stopSecond()
  })

  // #1145, the other half: dropping the seed snapshot must NOT open a regressive
  // publish. The seed's applyRemoteDisplayed resolves as `stash-pending` when the
  // loaded slice cannot order the node's marker against the local pointer, and the
  // local pointer may then be BEHIND the node. MDS positions are forward-only, so
  // publishing there would move every other device backward unrecoverably.
  it('does not publish a local position while the node holds a marker it cannot order (stash-pending)', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    // The node is ahead at s9, whose message is NOT in the loaded slice → the seed
    // can only stash it as pendingRemoteDisplayedStanzaId.
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's9' }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    seedMessages(cid, [msg('m1', 's1')])
    seedMeta(cid, 'm1')
    // Active, so the merge below keeps a resident array (memory windowing evicts
    // every other conversation's) and can resolve the stashed marker.
    chatStore.setState({ activeConversationId: cid })

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2_000)

    // Publishing s1 here would walk every other device back from s9 to s1.
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s9')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    // It is a HOLD, not a silence: once the merge brings s9 into the slice the
    // marker resolves, the pointer advances onto it, and there is nothing to send…
    chatStore.getState().mergeMAMMessages(
      cid,
      [msg('m1', 's1'), msg('m9', 's9'), msg('m10', 's10')],
      {},
      true,
      'forward'
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    // …and a genuine advance past the node's position publishes normally.
    chatStore.getState().advanceReadPointer(cid, 'm10')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's10', 'romeo@montague.example')
    cleanup()
  })

  // Same protection for a marker that stashes AFTER the seed: a peer device
  // publishes a position we cannot order, and our own (behind) position must not
  // be published over it on the next metadata change.
  it('does not publish over a live remote marker it cannot order', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2_000)

    // The empty node learns our position m1/s1 from the seed sweep.
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')

    // A peer device publishes s9, off-slice → the binding can only stash it.
    chatStore.getState().applyRemoteDisplayed(cid, 's9')
    client._emit('read:displayed-synced', { conversationId: cid, stanzaId: 's9' })
    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s9')

    // A local advance to m2 is still BEHIND s9, and nothing here can prove
    // otherwise — publishing it would regress the peer.
    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  // Cold-start burst shape (#1145). The seed's sweep is what makes an unpublished
  // position recoverable, so its cost is one publish IQ per entity whose position
  // the node does NOT already hold — and nothing for the ones it does. That is
  // what keeps the burst a one-time migration rather than a per-launch cost:
  // after the first pass the node holds every marker and the next start sweeps
  // for free. `doPublish` awaits each IQ in turn, so these are serial, never a
  // concurrent flood.
  it('sweeps a cold-start roster with one publish per position the node lacks', async () => {
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Five conversations, each read to its newest message. No resident arrays —
    // memory windowing is the realistic cold-start shape. Each pointer was minted
    // from a peer message, so it is ADDRESSABLE and resolves by a field read
    // rather than by looking anything up; what this case pins is the SWEEP (one
    // publish per position the node lacks), not the resolution mechanism. The
    // degraded `local` resolution — resident slice, then lastMessage preview,
    // then the cache — is covered by the cases above and in
    // `mdsSideEffects.cache.test.ts`.
    const jids = Array.from({ length: 5 }, (_, i) => `contact${i}@example.com`)
    chatStore.setState((state) => {
      const meta = new Map(state.conversationMeta)
      const convs = new Map(state.conversations)
      for (const cid of jids) {
        const newest = { ...msg('m2', `${cid}-s2`), id: `${cid}-m2`, conversationId: cid }
        const readPointer = makeReadPointer(newest, 'chat')
        meta.set(cid, { unreadCount: 0, readPointer, lastMessage: newest } as never)
        convs.set(cid, { id: cid, name: cid, type: 'chat', unreadCount: 0, readPointer } as never)
      }
      return { conversationMeta: meta, conversations: convs }
    })

    // The node already holds the first two positions.
    client.internal.mds.fetchAllDisplayed = vi.fn().mockResolvedValue(
      jids.slice(0, 2).map((cid) => ({ conversationJid: cid, stanzaId: `${cid}-s2` }))
    )

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2_000)

    const published = client.internal.mds.publishDisplayed.mock.calls.map((c) => c[0])
    expect(published.sort()).toEqual(jids.slice(2))

    // Second start against the now-complete node: nothing left to publish.
    cleanup()
    client.internal.mds.publishDisplayed.mockClear()
    client.internal.mds.fetchAllDisplayed = vi.fn().mockResolvedValue(
      jids.map((cid) => ({ conversationJid: cid, stanzaId: `${cid}-s2` }))
    )
    const restarted = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    restarted()
  })

  it('does not sweep local positions when the node fetch fails', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.internal.mds.fetchAllDisplayed = vi.fn().mockRejectedValue(new Error('timeout'))
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    seedMessages(cid, [msg('m1', 's1')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not publish over a prior-session marker after a reconnect fetch fails', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.advanceTimersByTimeAsync(0)

    chatStore.getState().advanceReadPointer(cid, 'm1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')

    connectionStore.setState({ status: 'offline' } as never)
    client.internal.mds.fetchAllDisplayed = vi.fn().mockRejectedValue(new Error('timeout'))
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    client._emit('online')
    await vi.advanceTimersByTimeAsync(0)

    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('rechecks a queued position when a peer marker arrives during the debounce', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    seedMessages(cid, [msg('m1', 's1')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.advanceTimersByTimeAsync(0)

    chatStore.getState().applyRemoteDisplayed(cid, 's9')
    client._emit('read:displayed-synced', { conversationId: cid, stanzaId: 's9' })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s9')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('publishes a local position removed from the node between fresh sessions', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValueOnce([{ conversationJid: cid, stanzaId: 's1' }])
      .mockResolvedValueOnce([])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    seedMessages(cid, [msg('m1', 's1')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    connectionStore.setState({ status: 'offline' } as never)
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    client._emit('online')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')
    cleanup()
  })

  it('preserves a live marker that arrives while the node seed is in flight', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    let resolveFetch!: (markers: Array<{ conversationJid: string; stanzaId: string }>) => void
    client.internal.mds.fetchAllDisplayed = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve
      })
    )
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    seedMessages(cid, [msg('m1', 's1')])
    seedMeta(cid, 'm1')

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.advanceTimersByTimeAsync(0)

    chatStore.getState().applyRemoteDisplayed(cid, 's9')
    client._emit('read:displayed-synced', { conversationId: cid, stanzaId: 's9' })
    resolveFetch([{ conversationJid: cid, stanzaId: 's5' }])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(chatStore.getState().conversationMeta.get(cid)?.pendingRemoteDisplayedStanzaId).toBe('s9')
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
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

    expect(client.internal.mds.retractDisplayed).toHaveBeenCalledWith(cid)
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

    expect(client.internal.mds.retractDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('migrates a legacy-format 1:1 seed marker by republishing it in spec format', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1', legacy: true }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    // Known 1:1 conversation entity → the seed can classify the JID and migrate.
    addConversation(cid)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's1', 'romeo@montague.example')

    // Migration is one-shot: nothing further is pending or debounced.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('a failed legacy migration does not break the seed or later publishing', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1', legacy: true }])
    // The migration republish fails (e.g. transient IQ error)…
    client.internal.mds.publishDisplayed = vi.fn().mockRejectedValueOnce(new Error('timeout'))
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    addConversation(cid)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1) // the failed migration

    // …and a later local read advance still publishes normally.
    client.internal.mds.publishDisplayed = vi.fn().mockResolvedValue(undefined)
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')
    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    cleanup()
  })

  it('does NOT republish spec-format seed markers', async () => {
    const cid = 'juliet@capulet.example'
    const client = makeClient()
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: cid, stanzaId: 's1' }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    addConversation(cid)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('migrates a legacy room marker when the room becomes known after the seed', async () => {
    const ROOM = 'room@conference.example'
    const client = makeClient()
    client.internal.mds.fetchAllDisplayed = vi
      .fn()
      .mockResolvedValue([{ conversationJid: ROOM, stanzaId: 's2', legacy: true }])
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)

    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    // Unknown JID at seed time (bookmarks not loaded, no conversation entity):
    // cannot classify → no migration yet.
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    // The bookmark lands: the room appears, the stashed marker drains, and the
    // legacy marker is republished in spec format with by = room JID.
    seedRoom(ROOM, [rmsg(ROOM, 'm1', 's1', 1), rmsg(ROOM, 'm2', 's2', 2)])
    await vi.advanceTimersByTimeAsync(0)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 's2', ROOM)
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m2')

    // And no echo republish on top of the migration.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
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

    expect(client.internal.mds.retractDisplayed).not.toHaveBeenCalled()
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Catch-up gate — Gajim's `if not MAM.is_catch_up_finished(contact): return`.
//
// Publishing a read position derived from a half-downloaded archive broadcasts a
// wrong "read up to here" to every other device, and MDS positions are
// forward-only — the real position is then unrecoverable. Wait until the archive
// for that entity is actually caught up before speaking for the user.
// ---------------------------------------------------------------------------

describe('setupMdsSideEffects catch-up gate', () => {
  const cid = 'juliet@capulet.example'

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

  async function armed() {
    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: 'romeo@montague.example/phone' } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()
    seedMessages(cid, [msg('m1', 's1'), msg('m2', 's2')])
    seedMeta(cid, 'm1')
    return { client, cleanup }
  }

  it('does not publish while a MAM query is still in flight', async () => {
    const { client, cleanup } = await armed()
    setConvMamState(cid, { isLoading: true, hasQueried: true })

    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not publish when the archive was queried but is not caught up to live', async () => {
    const { client, cleanup } = await armed()
    setConvMamState(cid, { hasQueried: true, isCaughtUpToLive: false })

    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('publishes once the archive is caught up to live', async () => {
    const { client, cleanup } = await armed()
    setConvMamState(cid, { hasQueried: true, isCaughtUpToLive: true })

    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    cleanup()
  })

  // #1143: the gate is re-checked at FLUSH time, by which point the entry has
  // already left the coalescer and consider() has marked the position handled.
  // Dropping it there used to strand it — nothing could ever put it back.
  it('re-arms a position dropped by the flush-time catch-up gate', async () => {
    const { client, cleanup } = await armed()
    setConvMamState(cid, { hasQueried: true, isCaughtUpToLive: true })

    // Enqueued while the archive is trustworthy…
    chatStore.getState().advanceReadPointer(cid, 'm2')
    // …but a catch-up starts inside the 1500ms debounce window, so the flush
    // must refuse to speak from the now-partial archive.
    setConvMamState(cid, { isLoading: true, hasQueried: true })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    chatStore.getState().mergeMAMMessages(cid, [], {}, true, 'forward')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    cleanup()
  })

  it('does not publish after a failed first query and recovers after a successful merge', async () => {
    const { client, cleanup } = await armed()
    setConvMamState(cid, { error: 'timeout' })

    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    chatStore.getState().mergeMAMMessages(cid, [], {}, true, 'forward')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    cleanup()
  })

  // No-regression guarantee: an entity that never ran a MAM query (a conversation
  // created live, mid-session) has no incomplete archive to misreport, so the gate
  // must not silence it — that would break read sync for new conversations.
  it('publishes for an entity that has never run a MAM query', async () => {
    const { client, cleanup } = await armed()

    chatStore.getState().advanceReadPointer(cid, 'm2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(cid, 's2', 'romeo@montague.example')
    cleanup()
  })
})
