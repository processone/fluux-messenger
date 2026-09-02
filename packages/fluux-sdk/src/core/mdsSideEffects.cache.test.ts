/**
 * Tests for cache-resolved MDS (XEP-0490) read positions (#1175).
 *
 * A backgrounded entity keeps NO resident message array — `setActiveConversation`
 * deletes the entry — so `resolveSeenStanzaId` had nothing to scan and the
 * position stayed unresolved until something re-triggered it. These tests pin
 * the IndexedDB-cache resolution that closes that gap, for BOTH the exact
 * pointer row and the at-or-behind fallback #1189 added.
 *
 * They also pin the concurrency contract the async conversion forces:
 * a LATEST-WINS SERIAL DRAIN per JID (at most one resolution in flight, the
 * newest pending position re-run on completion), plus a revalidation of every
 * input the in-flight resolution was computed against.
 *
 * This does NOT and cannot address the 1:1 own-send case: a message we sent in
 * a 1:1 never acquires a stanza-id, in RAM and in IndexedDB alike. #1189's
 * at-or-behind fallback owns that; here it is only extended to read the cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock localStorage before importing stores (chatStore persist middleware).
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Only the read paths the publisher uses are stubbed; every other cache export
// stays real so chatStore's own persistence calls behave normally.
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    // happy-dom has no IndexedDB; report the cache as present so the publisher
    // takes the path a real browser/Tauri runtime takes.
    isMessageCacheAvailable: vi.fn(() => true),
    getMessage: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    getRoomMessage: vi.fn(async () => null),
  }
})

import { setupMdsSideEffects } from './mdsSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { roomStore } from '../stores/roomStore'
import * as messageCache from '../utils/messageCache'
import { setStorageScopeJid, _resetStorageScopeForTesting } from '../utils/storageScope'
import type { Message } from './types/chat'
import type { Room, RoomMessage } from './types/room'
import { getLocalPart } from './jid'
import type { ReadPointer } from '../stores/shared/readPointer'

const CID = 'juliet@capulet.example'
const OWN_JID = 'romeo@montague.example/phone'
const OWN_BARE = 'romeo@montague.example'
const ROOM = 'tech@conference.example'

const getMessage = messageCache.getMessage as unknown as ReturnType<typeof vi.fn>
const getMessages = messageCache.getMessages as unknown as ReturnType<typeof vi.fn>
const getRoomMessage = messageCache.getRoomMessage as unknown as ReturnType<typeof vi.fn>

/** Deterministic per-id timestamp: 'm3' → base + 3s (mirrors mdsSideEffects.test.ts). */
const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime()
function timeFor(id: string): Date {
  return new Date(BASE_TIME + (Number(id.replace(/\D/g, '')) || 0) * 1000)
}

/**
 * A read pointer as `makeReadPointer` builds one: the named message's own
 * timestamp AND its cache order key. A pointer without a key is the
 * pre-#1081 migrated shape, covered separately in mdsSideEffects.test.ts.
 */
function pointerAt(id: string): ReadPointer {
  return {
    order: { role: 'exact', timestamp: timeFor(id).getTime(), tiebreak: { kind: 'chat', id } },
    identity: { state: 'local', messageId: id },
  }
}

function roomPointerAt(id: string, from = `${ROOM}/alice`, occupantId?: string): ReadPointer {
  return {
    order: { role: 'exact', timestamp: timeFor(id).getTime(), tiebreak: { kind: 'room', from, id } },
    identity: occupantId
      ? { state: 'local', messageId: id, occupantId }
      : { state: 'local', messageId: id },
  }
}

/**
 * The same positions, ADDRESSABLE: minted from a message that already carried an
 * archive id. This is what every peer message and every MUC reflection produces.
 */
function addressablePointerAt(id: string, archiveId: string): ReadPointer {
  return {
    order: { role: 'exact', timestamp: timeFor(id).getTime(), tiebreak: { kind: 'chat', id } },
    identity: { state: 'addressable', messageId: id, archiveId },
  }
}

function addressableRoomPointerAt(id: string, archiveId: string, from = `${ROOM}/alice`): ReadPointer {
  return {
    order: { role: 'exact', timestamp: timeFor(id).getTime(), tiebreak: { kind: 'room', from, id } },
    identity: { state: 'addressable', messageId: id, archiveId },
  }
}

/** A cached (IndexedDB) 1:1 row, incoming so it carries a server stanza-id. */
function cachedMsg(id: string, stanzaId: string | undefined): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    conversationId: CID,
    from: CID,
    body: id,
    timestamp: timeFor(id),
    isOutgoing: false,
  } as Message
}

/** A cached row for one of OUR OWN 1:1 sends — never assigned a stanza-id. */
function cachedOwnMsg(id: string): Message {
  return {
    type: 'chat',
    id,
    originId: `origin-${id}`,
    conversationId: CID,
    from: OWN_BARE,
    body: id,
    timestamp: timeFor(id),
    isOutgoing: true,
  } as Message
}

function cachedRoomMsg(
  id: string,
  stanzaId: string | undefined,
  from = `${ROOM}/alice`,
  occupantId?: string,
): RoomMessage {
  return {
    type: 'groupchat',
    id,
    stanzaId,
    roomJid: ROOM,
    from,
    nick: getLocalPart(from),
    body: id,
    timestamp: timeFor(id),
    isOutgoing: false,
    occupantId,
  } as RoomMessage
}

/**
 * A BACKGROUNDED 1:1 conversation: it has meta (and therefore a read pointer),
 * but no resident `messages` entry and no `lastMessage` preview to fall back to.
 * This is exactly the state `setActiveConversation` leaves behind.
 */
function seedBackgroundedConversation(pointerId?: string): void {
  const readPointer = pointerId === undefined ? undefined : pointerAt(pointerId)
  chatStore.setState((state) => {
    const meta = new Map(state.conversationMeta)
    meta.set(CID, { unreadCount: 0, readPointer })
    const convs = new Map(state.conversations)
    convs.set(CID, { id: CID, name: CID, type: 'chat', unreadCount: 0, readPointer })
    const messages = new Map(state.messages)
    messages.delete(CID)
    return { conversationMeta: meta, conversations: convs, messages }
  })
}

function patchMeta(
  patch: Partial<{ readPointer: ReturnType<typeof pointerAt>; unreadCount: number }>
): void {
  chatStore.setState((state) => {
    const meta = new Map(state.conversationMeta)
    meta.set(CID, { ...meta.get(CID)!, ...patch })
    return { conversationMeta: meta }
  })
}

/** A backgrounded room: joined and known, but its runtime message array is empty. */
function seedBackgroundedRoom(pointerId?: string, pointerFrom = `${ROOM}/alice`): void {
  const room: Room = {
    jid: ROOM,
    name: getLocalPart(ROOM),
    nickname: 'testuser',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
  roomStore.getState().addRoom(room)
  if (pointerId !== undefined) {
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, { ...meta.get(ROOM)!, readPointer: roomPointerAt(pointerId, pointerFrom) })
      return { roomMeta: meta }
    })
  }
}

function setConvMamState(
  patch: Partial<{ isLoading: boolean; hasQueried: boolean; isCaughtUpToLive: boolean; error: string | null }>
): void {
  chatStore.setState((state) => {
    const next = new Map(state.mamQueryStates)
    next.set(CID, {
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
    fetchAllDisplayedResult: vi.fn().mockResolvedValue({ status: 'authoritative' as const, markers: [] }),
    retractDisplayed: vi.fn().mockResolvedValue(undefined),
  }
  return {
    subscribe: register,
    _emit: (ev: string, p?: unknown) => (handlers[ev] || []).forEach((h) => h(p)),
    internal: { on: register, mds },
  }
}

/** A promise whose settlement the test controls, to hold a resolution in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Let queued microtasks (the resolution chain) run without advancing the debounce. */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function armedPublisher() {
  const client = makeClient()
  connectionStore.setState({ status: 'online', jid: OWN_JID } as never)
  const cleanup = setupMdsSideEffects(client as never)
  client._emit('online')
  await vi.runOnlyPendingTimersAsync()
  return { client, cleanup }
}

describe('mdsSideEffects — cache-resolved read positions (#1175)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    connectionStore.getState().reset()
    chatStore.getState().reset()
    roomStore.getState().reset()
    localStorageMock.clear()
    _resetStorageScopeForTesting()
    getMessage.mockReset().mockResolvedValue(null)
    getMessages.mockReset().mockResolvedValue([])
    getRoomMessage.mockReset().mockResolvedValue(null)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    _resetStorageScopeForTesting()
  })

  // ==========================================================================
  // Acceptance 1 — a backgrounded conversation resolves and publishes.
  // ==========================================================================

  it('resolves a backgrounded conversation pointer from the cache and publishes it', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedConversation()
    // The pointer's own row is the newest thing at or behind itself, so the
    // bounded cache window resolves the EXACT position when it is cached.
    getMessages.mockResolvedValue([cachedMsg('m1', 's1'), cachedMsg('m7', 's7')])
    patchMeta({ readPointer: pointerAt('m7') })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getMessages).toHaveBeenCalledTimes(1)
    expect(getMessages).toHaveBeenCalledWith(CID, {
      after: new Date(0),
      before: new Date(timeFor('m7').getTime() + 1),
      limit: 50,
    })
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    cleanup()
  })

  it('does not read the cache when the resident slice already resolves the pointer', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedConversation()
    chatStore.setState((state) => {
      const messages = new Map(state.messages)
      messages.set(CID, [cachedMsg('m1', 's1'), cachedMsg('m2', 's2')])
      return { messages }
    })
    patchMeta({ readPointer: pointerAt('m2') })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's2', OWN_BARE)
    expect(getMessage).not.toHaveBeenCalled()
    expect(getMessages).not.toHaveBeenCalled()
    cleanup()
  })

  // ==========================================================================
  // Acceptance 2 — the at-or-behind fallback resolves from the cache too.
  // ==========================================================================

  it('falls back to the newest cached stanza-id at or behind a backgrounded pointer on our own send', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedConversation()
    // The pointer rests on one of OUR sends: cached, but with no stanza-id, in
    // RAM and in IndexedDB alike. Only the at-or-behind fallback can resolve it.
    getMessages.mockResolvedValue([cachedMsg('m1', 's1'), cachedMsg('m3', 's3'), cachedOwnMsg('m4')])
    patchMeta({ readPointer: pointerAt('m4') })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's3', OWN_BARE)
    cleanup()
  })

  it('never publishes a cached position ahead of the read pointer', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedConversation()
    // m5/m6 arrived after our own m4 and are UNREAD. The cache window may hand
    // them over; the at-or-behind ordering must reject them.
    getMessages.mockResolvedValue([
      cachedMsg('m1', 's1'),
      cachedOwnMsg('m4'),
      cachedMsg('m5', 's5'),
      cachedMsg('m6', 's6'),
    ])
    patchMeta({ readPointer: pointerAt('m4') })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's1', OWN_BARE)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(CID, 's5', OWN_BARE)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(CID, 's6', OWN_BARE)
    cleanup()
  })

  it('publishes nothing when the cache holds nothing resolvable at or behind the pointer', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedConversation()
    getMessages.mockResolvedValue([cachedOwnMsg('m2'), cachedOwnMsg('m4')])
    patchMeta({ readPointer: pointerAt('m4') })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  // ==========================================================================
  // The latest-wins serial drain — BOTH properties, not one (#1142's lesson).
  // ==========================================================================

  it('keeps at most one resolution in flight per JID and publishes once under interleaving', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValue(gate.promise)

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()
    expect(getMessages).toHaveBeenCalledTimes(1)

    // Unrelated meta churn re-considers the SAME position while the first
    // resolution is still in flight: it must not start a second one.
    patchMeta({ unreadCount: 3 })
    patchMeta({ unreadCount: 4 })
    await flushMicrotasks()
    expect(getMessages).toHaveBeenCalledTimes(1)

    gate.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    cleanup()
  })

  it('publishes the newest pointer that arrived while an earlier resolution was in flight', async () => {
    const { client, cleanup } = await armedPublisher()
    const first = deferred<Message[]>()
    getMessages.mockReturnValueOnce(first.promise).mockResolvedValue([cachedMsg('m8', 's8')])

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()
    expect(getMessages).toHaveBeenCalledTimes(1)

    // A NEWER position lands mid-flight. Suppressing it (a bare in-flight guard)
    // would lose it forever — the exact failure #1142 fixed.
    patchMeta({ readPointer: pointerAt('m8') })
    await flushMicrotasks()

    first.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's8', OWN_BARE)
    // The superseded position must never be published: the pointer moved.
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    cleanup()
  })

  // ==========================================================================
  // Post-await revalidation — every input the resolution was computed against.
  // ==========================================================================

  it('discards a resolution the pointer has already moved past, even across a full debounce', async () => {
    const { client, cleanup } = await armedPublisher()
    const first = deferred<Message[]>()
    const second = deferred<Message[]>()
    getMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()

    patchMeta({ readPointer: pointerAt('m8') })
    await flushMicrotasks()

    // The superseded resolution lands, and a whole debounce window elapses
    // before the current one does — so an unrevalidated result would have
    // reached the node on its own, not merely been coalesced away.
    first.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    second.resolve([cachedMsg('m8', 's8')])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's8', OWN_BARE)
    cleanup()
  })

  it('discards a resolution whose account storage scope changed mid-flight', async () => {
    const { client, cleanup } = await armedPublisher()
    setStorageScopeJid(OWN_BARE)
    const gate = deferred<Message[]>()
    getMessages.mockReturnValue(gate.promise)

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()

    setStorageScopeJid('other@account.example')
    gate.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('discards a resolution whose connected account changed mid-flight', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValue(gate.promise)

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()

    connectionStore.setState({ jid: 'someone@else.example/desktop' } as never)
    gate.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('discards a resolution whose session ended mid-flight', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValue(gate.promise)

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()

    connectionStore.setState({ status: 'disconnected' } as never)
    gate.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('discards a resolution that spans a reconnect, even though publishing is armed again', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValueOnce(gate.promise).mockResolvedValue([])

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()

    // Drop and come back: a new session re-seeds the node, so a value resolved
    // against the OLD session's node state must not be published into the new one.
    connectionStore.setState({ status: 'disconnected' } as never)
    connectionStore.setState({ status: 'online', jid: OWN_JID } as never)
    client._emit('online')
    await vi.runOnlyPendingTimersAsync()

    gate.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    cleanup()
  })

  it('retries a discarded cache resolution after SM resume without store churn', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValueOnce(gate.promise).mockResolvedValue([cachedMsg('m7', 's7')])

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()
    expect(getMessages).toHaveBeenCalledTimes(1)

    connectionStore.setState({ status: 'disconnected' } as never)
    connectionStore.setState({ status: 'online', jid: OWN_JID } as never)
    client._emit('resumed')

    gate.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    cleanup()
  })

  it('retries a buffered cache resolution after SM resume without store churn', async () => {
    const { client, cleanup } = await armedPublisher()
    getMessages.mockResolvedValue([cachedMsg('m7', 's7')])

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()

    expect(getMessages).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    connectionStore.setState({ status: 'disconnected' } as never)
    connectionStore.setState({ status: 'online', jid: OWN_JID } as never)
    client._emit('resumed')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    cleanup()
  })

  it('discards a resolution whose archive stopped being trustworthy mid-flight, and retries later', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValueOnce(gate.promise).mockResolvedValue([cachedMsg('m7', 's7')])

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()
    const idleTimers = vi.getTimerCount()

    // A catch-up starts during the resolution: the publish must never speak
    // from an archive we know is partial.
    setConvMamState({ hasQueried: true, isLoading: true })
    gate.resolve([cachedMsg('m7', 's7')])
    await flushMicrotasks()

    // Not merely dropped at flush time by the existing gate — never enqueued at
    // all, so no debounce window is armed for it.
    expect(vi.getTimerCount()).toBe(idleTimers)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    // The position stayed UNHANDLED, so catch-up completing republishes it
    // without needing a further local read advance (#1142).
    setConvMamState({ hasQueried: true, isCaughtUpToLive: true })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    cleanup()
  })

  it('discards a resolution whose JID became a known room mid-flight', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValue(gate.promise)

    // A bookmarked room's JID can still be sitting in chat state when the
    // resolution starts; classifying it as a room later changes both the
    // resolver and the XEP-0359 `by` we would publish under.
    chatStore.setState((state) => {
      const meta = new Map(state.conversationMeta)
      meta.set(ROOM, { unreadCount: 0, readPointer: pointerAt('m7') })
      return { conversationMeta: meta }
    })
    await flushMicrotasks()

    // The room arrives carrying the SAME pointer, so classification is the only
    // input that changed — the chat-resolved value must still be discarded.
    seedBackgroundedRoom('m7')
    gate.resolve([cachedMsg('m7', 's7')])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not publish a resolution that completes after teardown', async () => {
    const { client, cleanup } = await armedPublisher()
    const gate = deferred<Message[]>()
    getMessages.mockReturnValue(gate.promise)

    seedBackgroundedConversation()
    patchMeta({ readPointer: pointerAt('m7') })
    await flushMicrotasks()

    cleanup()
    await flushMicrotasks()
    const timersAfterTeardown = vi.getTimerCount()

    gate.resolve([cachedMsg('m7', 's7')])
    await flushMicrotasks()

    // Nothing new is even SCHEDULED: a resolution completing after teardown must
    // not arm a fresh debounce timer on a torn-down side effect.
    expect(vi.getTimerCount()).toBe(timersAfterTeardown)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
  })

  // ==========================================================================
  // Rooms — cache-resolved exactly, and still WITHOUT the at-or-behind fallback.
  // ==========================================================================

  it('resolves a backgrounded room pointer from the cache and publishes it', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedRoom()
    getRoomMessage.mockResolvedValue(cachedRoomMsg('r5', 'rs5'))
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, { ...meta.get(ROOM)!, readPointer: roomPointerAt('r5') })
      return { roomMeta: meta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getRoomMessage).toHaveBeenCalledWith(ROOM, 'r5', `${ROOM}/alice`)
    // Rooms publish under the room's own archive (XEP-0359 `by`).
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 'rs5', ROOM)
    cleanup()
  })

  it('resolves a colliding room client id for the pointer sender only', async () => {
    const { client, cleanup } = await armedPublisher()
    const alice = `${ROOM}/alice`
    const bob = `${ROOM}/bob`
    getRoomMessage.mockImplementation(async (_roomJid: string, id: string, from?: string) =>
      from === alice ? cachedRoomMsg(id, 'alice-stanza', alice) : cachedRoomMsg(id, 'bob-stanza', bob)
    )

    seedBackgroundedRoom('shared-id', alice)
    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        lastMessage: cachedRoomMsg('shared-id', 'bob-stanza', bob),
      })
      return { roomMeta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getRoomMessage).toHaveBeenCalledWith(ROOM, 'shared-id', alice)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 'alice-stanza', ROOM)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(ROOM, 'bob-stanza', ROOM)
    cleanup()
  })

  it('resolves a cached same-id same-nick row for the pointer occupant', async () => {
    const { client, cleanup } = await armedPublisher()
    const from = `${ROOM}/alice`
    getRoomMessage.mockImplementation(
      async (_roomJid: string, id: string, _from?: string, occupantId?: string) =>
        occupantId === 'occupant-b'
          ? cachedRoomMsg(id, 'newcomer-stanza', from, 'occupant-b')
          : cachedRoomMsg(id, 'departed-stanza', from, 'occupant-a'),
    )

    seedBackgroundedRoom()
    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: roomPointerAt('shared-id', from, 'occupant-b'),
      })
      return { roomMeta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(
      ROOM,
      'newcomer-stanza',
      ROOM,
    )
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(
      ROOM,
      'departed-stanza',
      ROOM,
    )
    cleanup()
  })

  it('does not publish an occupant-less cached row for a qualified pointer', async () => {
    const { client, cleanup } = await armedPublisher()
    const from = `${ROOM}/alice`
    getRoomMessage.mockResolvedValue(
      cachedRoomMsg('shared-id', 'ambiguous-stanza', from),
    )

    seedBackgroundedRoom()
    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: roomPointerAt('shared-id', from, 'occupant-b'),
      })
      return { roomMeta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getRoomMessage).toHaveBeenCalledWith(
      ROOM,
      'shared-id',
      from,
      'occupant-b',
    )
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(
      ROOM,
      'ambiguous-stanza',
      ROOM,
    )
    cleanup()
  })

  it('discards an in-flight resolution after the pointer moves between same-id occupants', async () => {
    const { client, cleanup } = await armedPublisher()
    const from = `${ROOM}/alice`
    const first = deferred<RoomMessage | null>()
    getRoomMessage
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(cachedRoomMsg('shared-id', 'newcomer-stanza', from, 'occupant-b'))

    seedBackgroundedRoom()
    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: roomPointerAt('shared-id', from, 'occupant-a'),
      })
      return { roomMeta }
    })
    await flushMicrotasks()

    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: roomPointerAt('shared-id', from, 'occupant-b'),
      })
      return { roomMeta }
    })
    await flushMicrotasks()

    first.resolve(cachedRoomMsg('shared-id', 'departed-stanza', from, 'occupant-a'))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getRoomMessage).toHaveBeenCalledTimes(2)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(
      ROOM,
      'newcomer-stanza',
      ROOM,
    )
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalledWith(
      ROOM,
      'departed-stanza',
      ROOM,
    )
    cleanup()
  })

  it('discards a room resolution after the pointer moves between same-id senders', async () => {
    const { client, cleanup } = await armedPublisher()
    const alice = `${ROOM}/alice`
    const bob = `${ROOM}/bob`
    const first = deferred<RoomMessage | null>()
    const second = deferred<RoomMessage | null>()
    getRoomMessage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    seedBackgroundedRoom('shared-id', alice)
    await flushMicrotasks()

    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: roomPointerAt('shared-id', bob),
      })
      return { roomMeta }
    })
    await flushMicrotasks()

    first.resolve(cachedRoomMsg('shared-id', 'alice-stanza', alice))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()

    second.resolve(cachedRoomMsg('shared-id', 'bob-stanza', bob))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 'bob-stanza', ROOM)
    cleanup()
  })

  it('publishes a same-id room pointer from a new sender after the prior pointer completed', async () => {
    const { client, cleanup } = await armedPublisher()
    const alice = `${ROOM}/alice`
    const bob = `${ROOM}/bob`
    getRoomMessage.mockImplementation(async (_roomJid: string, id: string, from?: string) =>
      from === alice ? cachedRoomMsg(id, 'alice-stanza', alice) : cachedRoomMsg(id, 'bob-stanza', bob)
    )

    seedBackgroundedRoom('shared-id', alice)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 'alice-stanza', ROOM)

    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: roomPointerAt('shared-id', bob),
      })
      return { roomMeta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getRoomMessage).toHaveBeenCalledWith(ROOM, 'shared-id', bob)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledTimes(2)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 'bob-stanza', ROOM)
    cleanup()
  })

  it('refuses to guess a room cache row for a keyless pointer', async () => {
    const { client, cleanup } = await armedPublisher()
    getRoomMessage.mockResolvedValue(cachedRoomMsg('shared-id', 'guessed-stanza', `${ROOM}/bob`))

    seedBackgroundedRoom()
    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: { order: { role: 'floor', timestamp: new Date(timeFor('shared-id')).getTime() }, identity: { state: 'local', messageId: 'shared-id' } },
      })
      return { roomMeta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getRoomMessage).not.toHaveBeenCalled()
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })

  it('does NOT give rooms an at-or-behind cache fallback', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedRoom()
    // Our own groupchat message, not yet reflected back with a room stanza-id.
    getRoomMessage.mockResolvedValue({ ...cachedRoomMsg('r5', undefined), isOutgoing: true })
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, { ...meta.get(ROOM)!, readPointer: roomPointerAt('r5') })
      return { roomMeta: meta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    // The deliberate asymmetry (#1189): MUC reflection supplies the exact
    // stanza-id shortly, so an approximation would degrade a working path.
    expect(client.internal.mds.publishDisplayed).not.toHaveBeenCalled()
    cleanup()
  })
  // ==========================================================================
  // What the IDENTITY VARIANT does — and does NOT — remove from the machinery
  // above.
  //
  // The design note that produced this shape predicted #1175 would "dissolve":
  // with the archive id on the pointer, the publisher would need no lookup, so
  // the async / serial-drain / revalidate constraint list would disappear WITH
  // the lookup. That is only half right, and the half it gets wrong is why every
  // test above still exists.
  //
  //  - `addressable` pointers: correct. Resolution is a field read. No resident
  //    slice, no `lastMessage`, no IndexedDB, no await that could span a session
  //    boundary. Every peer message and every MUC reflection mints one.
  //  - `local` pointers: WRONG. The archive id genuinely does not exist yet, so
  //    the only way to find one is still to read the archive — and the `local`
  //    population is precisely the case #1175 and #1189 were opened for (a 1:1
  //    resting on the user's own send, whose row may never acquire an id at all).
  //
  // So the machinery is SCOPED, not deleted. These three cases pin that split so
  // nobody deletes it on the strength of the prediction.
  // ==========================================================================

  it('an ADDRESSABLE pointer publishes with no lookup of any kind', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedConversation()
    patchMeta({ readPointer: addressablePointerAt('m7', 's7') })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's7', OWN_BARE)
    // The whole #1175 apparatus is skipped: nothing touched the cache, and
    // nothing needed the resident slice either.
    expect(getMessages).not.toHaveBeenCalled()
    expect(getMessage).not.toHaveBeenCalled()
    expect(getRoomMessage).not.toHaveBeenCalled()
    cleanup()
  })

  it('an addressable ROOM pointer likewise skips the room cache lookup', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedRoom()
    roomStore.setState((s) => {
      const meta = new Map(s.roomMeta)
      meta.set(ROOM, { ...meta.get(ROOM)!, readPointer: addressableRoomPointerAt('r5', 'rs5') })
      return { roomMeta: meta }
    })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(ROOM, 'rs5', ROOM)
    expect(getRoomMessage).not.toHaveBeenCalled()
    cleanup()
  })

  it('a LOCAL pointer still needs the cache — the machinery cannot be deleted', async () => {
    const { client, cleanup } = await armedPublisher()

    seedBackgroundedConversation()
    // The 1:1 resting state: the pointer names our own send, which carries no
    // archive id, so the position is `local` and unresolvable from the pointer
    // alone. Without the cache read there is nothing to publish at all.
    getMessages.mockResolvedValue([cachedMsg('m1', 's1'), cachedMsg('m7', undefined)])
    patchMeta({ readPointer: pointerAt('m7') })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(getMessages).toHaveBeenCalledTimes(1)
    expect(client.internal.mds.publishDisplayed).toHaveBeenCalledWith(CID, 's1', OWN_BARE)
    cleanup()
  })
})
