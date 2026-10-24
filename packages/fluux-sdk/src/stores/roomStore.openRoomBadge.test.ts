import { describe, it, expect, beforeEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import * as messageCache from '../utils/messageCache'
import { connectionStore } from './connectionStore'
import type { Room, RoomMessage } from '../core/types'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import { _clearAllTransientForTesting } from './shared/transientUnread'
import {
  currentViewportGeneration,
  reportViewport,
  _clearAllViewportEvidenceForTesting,
  type EvidenceKey,
} from './shared/viewportEvidence'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    saveRoomMessage: vi.fn().mockResolvedValue(undefined),
    saveRoomMessageWithResult: vi.fn().mockResolvedValue(true),
    saveRoomMessages: vi.fn().mockResolvedValue(true),
    getRoomMessages: vi.fn().mockResolvedValue([]),
    getRoomMessagesAround: vi.fn().mockResolvedValue([]),
    updateRoomMessage: vi.fn().mockResolvedValue(undefined),
    deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  }
})

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
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

function createRoom(jid: string): Room {
  return {
    jid,
    name: getLocalPart(jid),
    nickname: 'testuser',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

let msgCounter = 0
function createMessage(roomJid: string, nick: string, body: string): RoomMessage {
  msgCounter += 1
  return {
    type: 'groupchat',
    id: `msg-${msgCounter}`,
    stanzaId: undefined, originId: undefined, occupantId: undefined,
    roomJid,
    from: `${roomJid}/${nick}`,
    nick,
    body,
    timestamp: new Date(`2025-01-15T09:${String(msgCounter).padStart(2, '0')}:00Z`),
    isOutgoing: false,
  }
}

function evidenceKey(roomJid: string): EvidenceKey {
  return { kind: 'room', entityId: roomJid, accountScope: getStorageScopeJid() ?? '' }
}

/** Simulate the view's `reportLiveEdge` callback, reporting against the CURRENT generation. */
function reportCurrent(roomJid: string, evidence: 'at-edge' | 'away'): void {
  const key = evidenceKey(roomJid)
  reportViewport(key, currentViewportGeneration(key), evidence)
}

/**
 * A room opened after a message arrived, then focused and at the bottom, must
 * clear its badge even when the "seen newest row" report reaches the store
 * before the "at the live edge" measurement (twin of chatStore.openChatBadge.test.ts).
 */
describe('open room at the bottom: the badge clears once the newest message is read', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(),
      messages: new Map(), windowAtLiveEdge: new Map(), activeRoomJid: null, drafts: new Map(),
      mamQueryStates: new Map(), roomGaps: new Map(), roomCoverage: new Map(),
      firstNewMessageMarkers: new Map(), firstNewMessageCounts: new Map(), lastArrivedMessage: new Map(),
    })
    vi.clearAllMocks()
    _clearAllTransientForTesting()
    _clearAllViewportEvidenceForTesting()
    connectionStore.getState().setWindowVisible(true)
  })

  it.each([
    ['seen report first, live-edge report second', true],
    ['live-edge report first, seen report second', false],
  ])('%s', async (_name, seenFirst) => {
    const ROOM = 'tech@conference.example.com'
    const OTHER = 'ops@conference.example.com'
    roomStore.getState().addRoom(createRoom(ROOM))
    roomStore.getState().addRoom(createRoom(OTHER))

    roomStore.getState().setActiveRoom(ROOM)
    reportCurrent(ROOM, 'at-edge')
    const history = createMessage(ROOM, 'alice', 'already read')
    roomStore.getState().addMessage(ROOM, history)
    roomStore.getState().setActiveRoom(OTHER)
    const reply = createMessage(ROOM, 'alice', 'one new message')
    roomStore.getState().addMessage(ROOM, reply)
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(1)

    vi.mocked(messageCache.getRoomMessages).mockResolvedValueOnce([history, reply] as never)
    await roomStore.getState().activateRoom(ROOM)
    const row = { id: reply.id }
    if (seenFirst) {
      roomStore.getState().advanceReadPointer(ROOM, row)
      reportCurrent(ROOM, 'at-edge')
    } else {
      reportCurrent(ROOM, 'at-edge')
      roomStore.getState().advanceReadPointer(ROOM, row)
    }
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(roomStore.getState().activeRoomJid).toBe(ROOM)
    expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
  })
})
