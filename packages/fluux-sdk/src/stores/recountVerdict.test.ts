/**
 * What an unread recount reports about itself.
 *
 * This replaces an agreement test. The archive-derived count used to be produced a
 * SECOND time, outside the store, and the test's real job was to keep that traversal
 * from drifting from the recount's own gate chain. There is one traversal now, so
 * agreement is not a property that can be asserted — what can be asserted, and is
 * what the consumer actually depends on, is COMPLETENESS:
 *
 * 1. Every reachable exit of the recount publishes a verdict, and names the guard it
 *    stood down on.
 * 2. A verdict is published EXACTLY once per invocation, so a consumer counting
 *    deferrals cannot double-count and cannot miss one.
 * 3. A `counted` verdict carries the count the store committed and the badge it
 *    replaced, both from the same `set` turn.
 *
 * Real `fake-indexeddb` and the real `countUnreadInArchive`, like
 * `chatStore.archiveUnread.test.ts`: a mocked archive counter would let this pass
 * while measuring nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import { clearTransientScope } from './shared/transientUnread'
import {
  beginViewportGeneration,
  reportViewport,
  _clearAllViewportEvidenceForTesting,
} from './shared/viewportEvidence'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import {
  resetDiagnosticsForTesting,
  subscribeDiagnostics,
  type RecountDeferralReason,
  type UnreadClearedDiagnostic,
  type UnreadRecountDiagnostic,
} from '../diagnostics/channel'
import type { Conversation, Message, Room, RoomMessage } from '../core/types'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
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

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    countUnreadInArchive: vi.fn(actual.countUnreadInArchive),
    countRoomUnreadInArchive: vi.fn(actual.countRoomUnreadInArchive),
  }
})
import * as messageCache from '../utils/messageCache'

const countUnreadImplementation = vi.mocked(messageCache.countUnreadInArchive).getMockImplementation()!
const countRoomUnreadImplementation = vi.mocked(messageCache.countRoomUnreadInArchive).getMockImplementation()!

const CID = 'carol@example.com'
const ROOM = 'general@conference.example.com'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

function createConversation(id: string): Conversation {
  return { id, name: id, type: 'chat', unreadCount: 0 }
}

function createRoom(jid: string): Room {
  return {
    jid,
    name: jid,
    nickname: 'me',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

function archiveMsg(id: string, ts: number, overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id,
    conversationId: CID,
    from: CID,
    body: 'hi',
    timestamp: new Date(ts),
    isOutgoing: false,
    ...overrides,
  }
}

function roomMsg(id: string, ts: number, overrides: Partial<RoomMessage> = {}): RoomMessage {
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
  } as RoomMessage
}

function seedCoverage(bottomId: string): void {
  chatStore.setState((state) => {
    const mamQueryStates = new Map(state.mamQueryStates)
    mamQueryStates.set(CID, {
      isLoading: false,
      error: null,
      hasQueried: true,
      isHistoryComplete: true,
      isCaughtUpToLive: true,
    })
    const conversationCoverage = new Map(state.conversationCoverage)
    conversationCoverage.set(CID, { bottomId })
    return { mamQueryStates, conversationCoverage }
  })
}

function setMeta(patch: Record<string, unknown>): void {
  chatStore.setState((state) => {
    const meta = new Map(state.conversationMeta)
    meta.set(CID, { ...(meta.get(CID) ?? { unreadCount: 0 }), ...patch } as never)
    return { conversationMeta: meta }
  })
}

/** A pointer at `ts` naming `id`, in the shape the store writes. */
function pointerAt(ts: number, id: string): Record<string, unknown> {
  return {
    order: { role: 'exact', timestamp: new Date(ts).getTime(), tiebreak: { kind: 'chat', id } },
    identity: { state: 'local', messageId: id },
  }
}

function roomPointerAt(ts: number, id: string, occupantId?: string): Record<string, unknown> {
  return {
    order: {
      role: 'exact',
      timestamp: ts,
      tiebreak: {
        kind: 'room',
        from: `${ROOM}/alice`,
        id,
        ...(occupantId ? { occupantId } : {}),
      },
    },
    identity: { state: 'local', messageId: id, ...(occupantId ? { occupantId } : {}) },
  }
}

/** The archive, the pointer and the coverage record of a healthy conversation. */
async function seedHealthyConversation(badge: number): Promise<void> {
  await messageCache.saveMessages([
    archiveMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
    archiveMsg('p0', 1000),
    archiveMsg('u1', 1001),
    archiveMsg('u2', 1002),
    archiveMsg('u3', 1003),
  ])
  setMeta({ unreadCount: badge, readPointer: pointerAt(1000, 'p0') })
  seedCoverage('anchor-stanza')
}

async function seedHealthyRoom(badge: number): Promise<void> {
  roomStore.getState().addRoom(createRoom(ROOM))
  await messageCache.saveRoomMessages([
    roomMsg('anchor', 500, { stanzaId: 'anchor-stanza' }),
    roomMsg('p0', 1000),
    roomMsg('u1', 1001),
    roomMsg('u2', 1002),
  ])
  roomStore.setState((state) => {
    const roomMeta = new Map(state.roomMeta)
    roomMeta.set(ROOM, {
      ...(roomMeta.get(ROOM) ?? { unreadCount: 0 }),
      unreadCount: badge,
      readPointer: roomPointerAt(1000, 'p0'),
    } as never)
    const mamQueryStates = new Map(state.mamQueryStates)
    mamQueryStates.set(ROOM, {
      isLoading: false,
      error: null,
      hasQueried: true,
      isHistoryComplete: true,
      isCaughtUpToLive: true,
    })
    const roomCoverage = new Map(state.roomCoverage)
    roomCoverage.set(ROOM, { bottomId: 'anchor-stanza' })
    return { roomMeta, mamQueryStates, roomCoverage }
  })
}

/** Collect the read-state verdicts published while the test runs. */
function collectVerdicts(): {
  recounts: UnreadRecountDiagnostic[]
  clears: UnreadClearedDiagnostic[]
} {
  const recounts: UnreadRecountDiagnostic[] = []
  const clears: UnreadClearedDiagnostic[] = []
  subscribeDiagnostics((event) => {
    if (event.kind === 'unread-recount') recounts.push(event)
    if (event.kind === 'unread-cleared') clears.push(event)
  })
  return { recounts, clears }
}

beforeEach(async () => {
  _resetStorageScopeForTesting()
  globalThis.indexedDB = new IDBFactory()
  ;(messageCache as unknown as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
  localStorageMock.clear()
  chatStore.getState().reset()
  roomStore.getState().reset()
  resetDiagnosticsForTesting()
  chatStore.getState().addConversation(createConversation(CID))
  vi.mocked(messageCache.countUnreadInArchive).mockReset()
  vi.mocked(messageCache.countUnreadInArchive).mockImplementation(countUnreadImplementation)
  vi.mocked(messageCache.countRoomUnreadInArchive).mockReset()
  vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementation(countRoomUnreadImplementation)
  clearTransientScope(getStorageScopeJid() ?? '')
  _clearAllViewportEvidenceForTesting()
})

describe('the conversation recount reports what it committed', () => {
  it('publishes the count it wrote and the badge it replaced', async () => {
    await seedHealthyConversation(99)
    const seen = collectVerdicts()

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(seen.recounts).toEqual([
      {
        kind: 'unread-recount',
        entityKind: 'chat',
        entityId: CID,
        verdict: { status: 'counted', count: 3, previousCount: 99 },
      },
    ])
    // The count in the verdict IS the badge from here. Reading the badge separately
    // is what the pull-shaped diagnostic had to do, and what could pair two numbers
    // that were never true at the same instant.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  it('still reports a commit when the badge already held the count', async () => {
    await seedHealthyConversation(3)
    const seen = collectVerdicts()

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // No write happened, and that is not the same as declining: the number went
    // through every gate, so a consumer may treat it as the archive truth.
    expect(seen.recounts.map((event) => event.verdict)).toEqual([
      { status: 'counted', count: 3, previousCount: 3 },
    ])
  })
})

describe('every reachable guard names itself', () => {
  const gates: Array<{ name: string; reason: RecountDeferralReason; arrange: () => Promise<void> }> = [
    {
      name: 'no coverage record',
      reason: 'coverage-missing',
      arrange: async () => {
        await messageCache.saveMessages([archiveMsg('u1', 1001)])
        setMeta({ unreadCount: 1, readPointer: pointerAt(1000, 'p0') })
        chatStore.setState((state) => {
          const mamQueryStates = new Map(state.mamQueryStates)
          mamQueryStates.set(CID, {
            isLoading: false,
            error: null,
            hasQueried: true,
            isHistoryComplete: true,
            isCaughtUpToLive: true,
          })
          return { mamQueryStates }
        })
      },
    },
    {
      name: 'history not caught up',
      reason: 'history-not-caught-up',
      arrange: async () => {
        await seedHealthyConversation(3)
        chatStore.setState((state) => {
          const mamQueryStates = new Map(state.mamQueryStates)
          mamQueryStates.set(CID, {
            isLoading: false,
            error: null,
            hasQueried: true,
            isHistoryComplete: false,
            isCaughtUpToLive: false,
          })
          return { mamQueryStates }
        })
      },
    },
    {
      name: 'a pointerless entity showing a count',
      reason: 'pointerless-defer',
      arrange: async () => {
        await messageCache.saveMessages([archiveMsg('u1', 1001)])
        setMeta({ unreadCount: 4, readPointer: undefined, historyFloor: undefined })
        seedCoverage('anchor-stanza')
      },
    },
    {
      name: 'a remote XEP-0490 position still being resolved',
      reason: 'pending-remote-displayed',
      arrange: async () => {
        await seedHealthyConversation(3)
        setMeta({ pendingRemoteDisplayedStanzaId: 'remote-1' })
      },
    },
    {
      name: 'neither a pointer nor a history floor to count from',
      reason: 'no-floor',
      arrange: async () => {
        await seedHealthyConversation(3)
        setMeta({ unreadCount: 0, readPointer: undefined, historyFloor: undefined })
      },
    },
  ]

  for (const gate of gates) {
    it(`declines with ${gate.reason} — ${gate.name}`, async () => {
      await gate.arrange()
      const seen = collectVerdicts()

      await chatStore.getState().recomputeUnreadForConversation(CID)

      expect(seen.recounts.map((event) => event.verdict)).toEqual([
        { status: 'deferred', reason: gate.reason },
      ])
    })
  }

  it('declines with no-meta for an entity the store does not know', async () => {
    const seen = collectVerdicts()

    await chatStore.getState().recomputeUnreadForConversation('nobody@example.com', {
      allowActive: true,
    })

    expect(seen.recounts).toEqual([
      {
        kind: 'unread-recount',
        entityKind: 'chat',
        entityId: 'nobody@example.com',
        verdict: { status: 'deferred', reason: 'no-meta' },
      },
    ])
  })

  it('declines with active-skipped without the caller opting in', async () => {
    await seedHealthyConversation(3)
    chatStore.setState({ activeConversationId: CID })
    const seen = collectVerdicts()

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // "Skipped because active" and "counted and committed" both leave the badge
    // alone, and telling them apart is the whole point of the verdict.
    expect(seen.recounts.map((event) => event.verdict)).toEqual([
      { status: 'deferred', reason: 'active-skipped' },
    ])
  })

  it('declines with input-version-changed when a message arrives mid-count', async () => {
    await seedHealthyConversation(3)
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(async (...args) => {
      chatStore.getState().addMessage(archiveMsg('live', 2000))
      return countUnreadImplementation(...args)
    })
    const seen = collectVerdicts()

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // A trailing retry follows this reason, so only the FIRST verdict belongs to
    // the invocation under test.
    expect(seen.recounts[0]?.verdict).toEqual({
      status: 'deferred',
      reason: 'input-version-changed',
    })
  })

  it('declines with pointer-changed when the pointer moves mid-count', async () => {
    await seedHealthyConversation(3)
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(async (...args) => {
      setMeta({ unreadCount: 0, readPointer: pointerAt(1003, 'u3') })
      return countUnreadImplementation(...args)
    })
    const seen = collectVerdicts()

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(seen.recounts.map((event) => event.verdict)).toEqual([
      { status: 'deferred', reason: 'pointer-changed' },
    ])
  })

  it('declines with recount-superseded when a newer recount overtakes it', async () => {
    await seedHealthyConversation(99)
    const gate = deferred()
    let countCalls = 0
    vi.mocked(messageCache.countUnreadInArchive).mockImplementation(async (...args) => {
      countCalls++
      if (countCalls === 1) await gate.promise
      return countUnreadImplementation(...args)
    })
    const seen = collectVerdicts()

    const slow = chatStore.getState().recomputeUnreadForConversation(CID)
    await vi.waitFor(() => expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(1))
    await chatStore.getState().recomputeUnreadForConversation(CID)
    gate.resolve()
    await slow

    expect(seen.recounts.map((event) => event.verdict)).toEqual([
      { status: 'counted', count: 3, previousCount: 99 },
      { status: 'deferred', reason: 'recount-superseded' },
    ])
  })
})

describe('one verdict per invocation', () => {
  it('publishes exactly one verdict however the recount ends', async () => {
    await seedHealthyConversation(99)
    const seen = collectVerdicts()

    await chatStore.getState().recomputeUnreadForConversation(CID)
    await chatStore.getState().recomputeUnreadForConversation(CID)
    await chatStore.getState().recomputeUnreadForConversation('nobody@example.com')

    // Three invocations, three verdicts. A consumer counting deferrals per window
    // depends on this: a guard that reported twice would inflate its own rate.
    expect(seen.recounts).toHaveLength(3)
  })

  it('builds nothing for an unsubscribed build', async () => {
    await seedHealthyConversation(99)
    resetDiagnosticsForTesting()

    await chatStore.getState().recomputeUnreadForConversation(CID)

    // Nothing to assert on the payload, which is the point — the recount still did
    // its job.
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
  })

  it('gives each subscriber its own verdict object', async () => {
    await seedHealthyConversation(99)
    const first: UnreadRecountDiagnostic[] = []
    const second: UnreadRecountDiagnostic[] = []
    subscribeDiagnostics((event) => {
      if (event.kind === 'unread-recount') first.push(event)
    })
    subscribeDiagnostics((event) => {
      if (event.kind === 'unread-recount') second.push(event)
    })

    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(first[0]).toEqual(second[0])
    expect(first[0]).not.toBe(second[0])
    expect(first[0]?.verdict).not.toBe(second[0]?.verdict)
  })
})

describe('a count-only mark-read is named', () => {
  it('reports the badge cleared with the pointer left where it was', async () => {
    await seedHealthyConversation(3)
    // Above the live edge: `markAsRead` cannot know which message was reached, so it
    // clears the counts only (#1076).
    chatStore.setState((state) => {
      const windowAtLiveEdge = new Map(state.windowAtLiveEdge)
      windowAtLiveEdge.set(CID, false)
      return { windowAtLiveEdge }
    })
    const pointerBefore = chatStore.getState().conversationMeta.get(CID)?.readPointer
    const seen = collectVerdicts()

    chatStore.getState().markAsRead(CID)

    expect(seen.clears).toEqual([
      { kind: 'unread-cleared', entityKind: 'chat', entityId: CID, previousCount: 3 },
    ])
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(0)
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBe(pointerBefore)
  })

  it('names the clear when the pointer is reallocated onto the same message', async () => {
    await seedHealthyConversation(3)
    // At the live edge with the pointer already on the newest resident message:
    // `onMarkAsRead` builds a FRESH pointer naming that same message, so an
    // object-identity test would miss a clear that moved no read position.
    chatStore.getState().addMessage(archiveMsg('newest', 1004))
    setMeta({ unreadCount: 3, readPointer: pointerAt(1004, 'newest') })
    const key = { accountScope: getStorageScopeJid() ?? '', kind: 'chat' as const, entityId: CID }
    reportViewport(key, beginViewportGeneration(key), 'at-edge')
    const seen = collectVerdicts()

    chatStore.getState().markAsRead(CID)

    expect(seen.clears.map((event) => event.previousCount)).toEqual([3])
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe(
      'newest'
    )
  })

  it('says nothing when the read position actually advanced', async () => {
    await seedHealthyConversation(3)
    chatStore.getState().addMessage(archiveMsg('newest', 1004))
    // Pointer behind the newest resident message, and the viewport genuinely at the
    // live edge: an ordinary read-through, and the derived count moves with it. This
    // transition needs no name, and naming it would excuse the anomaly too.
    setMeta({ unreadCount: 3, readPointer: pointerAt(1000, 'p0') })
    const key = { accountScope: getStorageScopeJid() ?? '', kind: 'chat' as const, entityId: CID }
    reportViewport(key, beginViewportGeneration(key), 'at-edge')
    const seen = collectVerdicts()

    chatStore.getState().markAsRead(CID)

    expect(seen.clears).toEqual([])
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer?.identity.messageId).toBe(
      'newest'
    )
  })

  it('says nothing when the badge was already clear', async () => {
    await seedHealthyConversation(0)
    chatStore.setState((state) => {
      const windowAtLiveEdge = new Map(state.windowAtLiveEdge)
      windowAtLiveEdge.set(CID, false)
      return { windowAtLiveEdge }
    })
    const seen = collectVerdicts()

    chatStore.getState().markAsRead(CID)

    expect(seen.clears).toEqual([])
  })
})

describe('the room recount reports the same way', () => {
  it('publishes the count it committed for a room', async () => {
    await seedHealthyRoom(99)
    const seen = collectVerdicts()

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(seen.recounts).toEqual([
      {
        kind: 'unread-recount',
        entityKind: 'room',
        entityId: ROOM,
        verdict: { status: 'counted', count: 2, previousCount: 99 },
      },
    ])
  })

  it('declines with no-meta for a room the store does not know', async () => {
    const seen = collectVerdicts()

    await roomStore.getState().recomputeUnreadForRoom('nowhere@conference.example.com', {
      allowActive: true,
    })

    expect(seen.recounts.map((event) => event.verdict)).toEqual([
      { status: 'deferred', reason: 'no-meta' },
    ])
  })

  it('declines with pointer-changed when a room pointer moves mid-count', async () => {
    await seedHealthyRoom(2)
    vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementationOnce(async (...args) => {
      roomStore.setState((state) => {
        const roomMeta = new Map(state.roomMeta)
        roomMeta.set(ROOM, {
          ...roomMeta.get(ROOM)!,
          unreadCount: 0,
          readPointer: roomPointerAt(1002, 'u2'),
        } as never)
        return { roomMeta }
      })
      return countRoomUnreadImplementation(...args)
    })
    const seen = collectVerdicts()

    await roomStore.getState().recomputeUnreadForRoom(ROOM)

    expect(seen.recounts.map((event) => event.verdict)).toEqual([
      { status: 'deferred', reason: 'pointer-changed' },
    ])
  })

  it('names a count-only mark-read for a room', async () => {
    await seedHealthyRoom(2)
    roomStore.setState((state) => {
      const windowAtLiveEdge = new Map(state.windowAtLiveEdge)
      windowAtLiveEdge.set(ROOM, false)
      return { windowAtLiveEdge }
    })
    const seen = collectVerdicts()

    roomStore.getState().markAsRead(ROOM)

    expect(seen.clears).toEqual([
      { kind: 'unread-cleared', entityKind: 'room', entityId: ROOM, previousCount: 2 },
    ])
  })

  it('does not name a pointer advance between reused-nick rows as a clear', () => {
    roomStore.getState().addRoom(createRoom(ROOM))
    const first = roomMsg('shared-id', 1001, { occupantId: 'occupant-a' })
    const second = roomMsg('shared-id', 1002, { occupantId: 'occupant-b' })
    roomStore.setState((state) => {
      const messages = new Map(state.messages)
      messages.set(ROOM, [first, second])
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        unreadCount: 1,
        readPointer: roomPointerAt(1001, 'shared-id', 'occupant-a'),
      } as never)
      return { messages, roomMeta }
    })
    const key = { accountScope: getStorageScopeJid() ?? '', kind: 'room' as const, entityId: ROOM }
    reportViewport(key, beginViewportGeneration(key), 'at-edge')
    const seen = collectVerdicts()

    roomStore.getState().markAsRead(ROOM)

    expect(seen.clears).toEqual([])
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.occupantId).toBe(
      'occupant-b'
    )
  })

  it('does not name a mention-only reset as an unread clear', () => {
    roomStore.getState().addRoom(createRoom(ROOM))
    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        unreadCount: 0,
        mentionsCount: 2,
      })
      const windowAtLiveEdge = new Map(state.windowAtLiveEdge)
      windowAtLiveEdge.set(ROOM, false)
      return { roomMeta, windowAtLiveEdge }
    })
    const seen = collectVerdicts()

    roomStore.getState().markAsRead(ROOM)

    expect(seen.clears).toEqual([])
    expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(0)
  })
})
