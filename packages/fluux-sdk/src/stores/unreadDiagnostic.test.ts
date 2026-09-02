/**
 * The archive-derived unread count beside the badge.
 *
 * Two things are tested here, and the second matters more than the first:
 *
 * 1. The diagnostic reports what it says it reports.
 * 2. It **agrees with the real recount**. It is a second traversal of the same
 *    gates, side-effect free, so nothing but a test keeps the two from drifting —
 *    and a diagnostic that declined where the recount counted (or counted where the
 *    recount declined) would report ordinary catch-up as a bug.
 *
 * Real `fake-indexeddb` and the real `countUnreadInArchive`, like
 * `chatStore.archiveUnread.test.ts`: a mocked archive counter would let the
 * diagnostic pass while measuring nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { chatStore, chatUnreadDiagnostic } from './chatStore'
import { roomStore, roomUnreadDiagnostic } from './roomStore'
import { clearTransientScope } from './shared/transientUnread'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import {
  readRecountDeferrals,
  resetRecountDeferralsForTesting,
  type RecountDeferralReason,
} from './shared/recountDiagnostics'
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

function roomPointerAt(ts: number, id: string): Record<string, unknown> {
  return {
    order: {
      role: 'exact',
      timestamp: ts,
      tiebreak: { kind: 'room', from: `${ROOM}/alice`, id },
    },
    identity: { state: 'local', messageId: id },
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

/** Which reason the REAL recount declined for, read from its own tally. */
async function recountDeferralReason(): Promise<RecountDeferralReason | undefined> {
  resetRecountDeferralsForTesting()
  await chatStore.getState().recomputeUnreadForConversation(CID)
  // Keys are `<kind>:<reason>` and the tallies are cumulative for the process,
  // which is why this resets them first.
  const entries = Object.entries(readRecountDeferrals()).filter(
    ([k, count]) => k.startsWith('chat:') && count > 0,
  )
  return entries.length > 0
    ? (entries[0][0].slice('chat:'.length) as RecountDeferralReason)
    : undefined
}

beforeEach(async () => {
  _resetStorageScopeForTesting()
  globalThis.indexedDB = new IDBFactory()
  ;(messageCache as unknown as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
  localStorageMock.clear()
  chatStore.getState().reset()
  roomStore.getState().reset()
  resetRecountDeferralsForTesting()
  chatStore.getState().addConversation(createConversation(CID))
  vi.mocked(messageCache.countUnreadInArchive).mockReset()
  vi.mocked(messageCache.countUnreadInArchive).mockImplementation(countUnreadImplementation)
  vi.mocked(messageCache.countRoomUnreadInArchive).mockReset()
  vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementation(countRoomUnreadImplementation)
  clearTransientScope(getStorageScopeJid() ?? '')
})

describe('chatUnreadDiagnostic', () => {
  it('returns both counts from one snapshot when the archive can be counted', async () => {
    await seedHealthyConversation(3)

    const result = await chatUnreadDiagnostic(CID)

    expect(result).toEqual({ status: 'exact', archiveCount: 3, badgeCount: 3 })
  })

  it('reports a disagreement without judging it', async () => {
    await seedHealthyConversation(99)

    const result = await chatUnreadDiagnostic(CID)

    // The diagnostic hands back what it found. Deciding that 99 against 3 is a bug
    // is the detector's job, and keeping that decision out of the SDK is what lets
    // the store's own recount fix the badge without the seam taking a view.
    expect(result).toEqual({ status: 'exact', archiveCount: 3, badgeCount: 99 })
  })

  it('defers, rather than guessing, when there is no coverage record', async () => {
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

    expect(await chatUnreadDiagnostic(CID)).toEqual({
      status: 'deferred',
      reason: 'coverage-missing',
    })
  })

  it('defers while history is not caught up', async () => {
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

    expect((await chatUnreadDiagnostic(CID)).reason).toBe('history-not-caught-up')
  })

  it('defers for an entity the store does not know', async () => {
    expect(await chatUnreadDiagnostic('nobody@example.com')).toEqual({
      status: 'deferred',
      reason: 'no-meta',
    })
  })

  it('reports stale when the inputs move mid-count', async () => {
    await seedHealthyConversation(3)
    vi.mocked(messageCache.countUnreadInArchive).mockImplementation(async (...args) => {
      // A live arrival lands while the archive is being counted: the two numbers
      // would no longer describe the same instant.
      chatStore.getState().addMessage(archiveMsg('live', 2000))
      return countUnreadImplementation(...args)
    })

    expect((await chatUnreadDiagnostic(CID)).status).toBe('stale')
  })

  it('reports stale when the read pointer changes without a version bump', async () => {
    await seedHealthyConversation(3)
    vi.mocked(messageCache.countUnreadInArchive).mockImplementationOnce(async (...args) => {
      setMeta({ unreadCount: 0, readPointer: pointerAt(1003, 'u3') })
      return countUnreadImplementation(...args)
    })

    expect(await chatUnreadDiagnostic(CID)).toEqual({ status: 'stale' })
  })

  it('writes nothing', async () => {
    await seedHealthyConversation(99)
    const metaBefore = chatStore.getState().conversationMeta.get(CID)
    const coverageBefore = chatStore.getState().conversationCoverage

    await chatUnreadDiagnostic(CID)

    // An observer that repaired the badge would hide the very defect it exists to
    // report, and would make the log's evidence unreproducible.
    expect(chatStore.getState().conversationMeta.get(CID)).toBe(metaBefore)
    expect(chatStore.getState().conversationCoverage).toBe(coverageBefore)
  })

  it('reports stale while an earlier recount is still in flight', async () => {
    await seedHealthyConversation(99)
    const gate = deferred()
    let countCalls = 0
    vi.mocked(messageCache.countUnreadInArchive).mockImplementation(async (...args) => {
      countCalls++
      if (countCalls === 1) await gate.promise
      return countUnreadImplementation(...args)
    })

    const recount = chatStore.getState().recomputeUnreadForConversation(CID)
    await vi.waitFor(() => expect(messageCache.countUnreadInArchive).toHaveBeenCalledTimes(1))

    expect(await chatUnreadDiagnostic(CID)).toEqual({ status: 'stale' })

    gate.resolve()
    await recount

    expect(readRecountDeferrals()['chat:recount-superseded'] ?? 0).toBe(0)
    expect(chatStore.getState().conversationMeta.get(CID)?.unreadCount).toBe(3)
    expect(await chatUnreadDiagnostic(CID)).toEqual({
      status: 'exact',
      archiveCount: 3,
      badgeCount: 3,
    })
  })
})

describe('agreement with the real recount', () => {
  it('counts exactly what the recount commits', async () => {
    await seedHealthyConversation(99)

    const diagnostic = await chatUnreadDiagnostic(CID)
    await chatStore.getState().recomputeUnreadForConversation(CID)

    expect(diagnostic.archiveCount).toBe(chatStore.getState().conversationMeta.get(CID)?.unreadCount)
  })

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
  ]

  for (const gate of gates) {
    it(`declines with ${gate.reason} where the recount does — ${gate.name}`, async () => {
      await gate.arrange()

      const diagnostic = await chatUnreadDiagnostic(CID)
      const recount = await recountDeferralReason()

      expect(diagnostic.status).toBe('deferred')
      expect(diagnostic.reason).toBe(gate.reason)
      expect(recount).toBe(gate.reason)
    })
  }
})

describe('roomUnreadDiagnostic', () => {
  it('returns both counts for a room whose archive can be counted', async () => {
    await seedHealthyRoom(2)

    const result = await roomUnreadDiagnostic(ROOM)

    expect(result.status).toBe('exact')
    expect(result.badgeCount).toBe(2)
    expect(result.archiveCount).toBe(2)
  })

  it('reports stale when the room pointer changes without a version bump', async () => {
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

    expect(await roomUnreadDiagnostic(ROOM)).toEqual({ status: 'stale' })
  })

  it('reports stale while an earlier room recount is still in flight', async () => {
    await seedHealthyRoom(99)
    const gate = deferred()
    let countCalls = 0
    vi.mocked(messageCache.countRoomUnreadInArchive).mockImplementation(async (...args) => {
      countCalls++
      if (countCalls === 1) await gate.promise
      return countRoomUnreadImplementation(...args)
    })

    const recount = roomStore.getState().recomputeUnreadForRoom(ROOM)
    await vi.waitFor(() => expect(messageCache.countRoomUnreadInArchive).toHaveBeenCalledTimes(1))

    expect(await roomUnreadDiagnostic(ROOM)).toEqual({ status: 'stale' })

    gate.resolve()
    await recount
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(2)
    expect(await roomUnreadDiagnostic(ROOM)).toEqual({
      status: 'exact',
      archiveCount: 2,
      badgeCount: 2,
    })
  })

  it('defers for a room the store does not know', async () => {
    expect(await roomUnreadDiagnostic('nowhere@conference.example.com')).toEqual({
      status: 'deferred',
      reason: 'no-meta',
    })
  })
})
