/**
 * What the room store's `mergeRoomMAMMessages` reports about the page it merged.
 *
 * The twin of `chatStore.archiveMerge.test.ts`. Rooms carry the same seam because
 * they carry the same risk: a room catch-up merges page after page, and a write
 * that silently failed is invisible from outside the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import {
  onArchiveMerge,
  resetArchiveMergeDiagnosticsForTesting,
  type ArchiveMergeReport,
} from './shared/archiveMergeDiagnostics'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { _resetForTesting as _resetThrottledStorageForTesting } from './shared/throttledStorage'
import type { Room, RoomMessage } from '../core/types'

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
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    saveRoomMessages: vi.fn().mockResolvedValue(true),
    getRoomMessages: vi.fn().mockResolvedValue([]),
  }
})
import * as messageCache from '../utils/messageCache'

/** A fresh room per test: one failed write poisons that room's save chain. */
let ROOM = 'general@conference.example.com'
let roomCounter = 0

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

function archiveMsg(id: string, ts: number): RoomMessage {
  return {
    type: 'groupchat',
    id,
    roomJid: ROOM,
    from: `${ROOM}/alice`,
    nick: 'alice',
    body: 'hi',
    timestamp: new Date(ts),
    isOutgoing: false,
    stanzaId: `stanza-${id}`,
  } as RoomMessage
}

/** Reports, handed out one at a time (see the chat twin for why a queue). */
function collector(): { pending: ArchiveMergeReport[]; next: () => Promise<ArchiveMergeReport> } {
  const pending: ArchiveMergeReport[] = []
  const waiters: Array<(r: ArchiveMergeReport) => void> = []
  onArchiveMerge((r) => {
    const waiter = waiters.shift()
    if (waiter) waiter(r)
    else pending.push(r)
  })
  return {
    pending,
    next: () =>
      new Promise<ArchiveMergeReport>((resolve) => {
        const queued = pending.shift()
        if (queued) return resolve(queued)
        waiters.push(resolve)
      }),
  }
}

beforeEach(() => {
  roomCounter++
  ROOM = `general-${roomCounter}@conference.example.com`
  localStorageMock.clear()
  _resetStorageScopeForTesting()
  _resetThrottledStorageForTesting()
  roomStore.setState({ rooms: new Map(), messages: new Map(), activeRoomJid: null })
  roomStore.getState().addRoom(createRoom(ROOM))
  vi.mocked(messageCache.saveRoomMessages).mockResolvedValue(true)
})

afterEach(() => {
  resetArchiveMergeDiagnosticsForTesting()
})

describe('mergeRoomMAMMessages reporting', () => {
  it('reports a durable page with every row accounted for', async () => {
    const { next } = collector()

    roomStore
      .getState()
      .mergeRoomMAMMessages(
        ROOM,
        [archiveMsg('r1', 1_000), archiveMsg('r2', 2_000)],
        { first: 'r1', last: 'r2', count: 2 },
        true,
        'backward'
      )

    expect(await next()).toMatchObject({
      entityKind: 'room',
      entityId: ROOM,
      direction: 'backward',
      complete: true,
      outcome: 'durable',
      returned: 2,
      retained: 2,
      deduplicated: 0,
      persistenceFailed: 0,
    })
  })

  it('counts a re-merged page as deduplicated for the room on screen', async () => {
    roomStore.setState({ activeRoomJid: ROOM })
    const { next } = collector()
    const page = [archiveMsg('r1', 1_000), archiveMsg('r2', 2_000)]

    roomStore
      .getState()
      .mergeRoomMAMMessages(ROOM, page, { first: 'r1', last: 'r2', count: 2 }, true, 'backward')
    await next()

    roomStore
      .getState()
      .mergeRoomMAMMessages(ROOM, page, { first: 'r1', last: 'r2', count: 2 }, true, 'backward')

    expect(await next()).toMatchObject({
      outcome: 'durable',
      returned: 2,
      retained: 0,
      deduplicated: 2,
    })
  })

  it('reports a failed write with its rows under persistenceFailed', async () => {
    vi.mocked(messageCache.saveRoomMessages).mockResolvedValue(false)
    const { next } = collector()

    roomStore
      .getState()
      .mergeRoomMAMMessages(
        ROOM,
        [archiveMsg('r1', 1_000)],
        { first: 'r1', last: 'r1', count: 1 },
        true,
        'forward'
      )

    expect(await next()).toMatchObject({
      outcome: 'failed',
      returned: 1,
      retained: 0,
      persistenceFailed: 1,
    })
  })

  it('waits for the write before reporting', async () => {
    let settle: (ok: boolean) => void = () => {}
    vi.mocked(messageCache.saveRoomMessages).mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve
      })
    )
    const { pending, next } = collector()

    roomStore
      .getState()
      .mergeRoomMAMMessages(
        ROOM,
        [archiveMsg('r1', 1_000)],
        { first: 'r1', last: 'r1', count: 1 },
        true,
        'backward'
      )
    await Promise.resolve()

    expect(pending).toEqual([])

    settle(true)
    expect((await next()).outcome).toBe('durable')
  })
})
