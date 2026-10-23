import { describe, it, expect, beforeEach, vi } from 'vitest'
import { roomStore } from './roomStore'
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
 * FLM-114: an open room's badge and its "new messages" divider must agree.
 * Captain's report: "The badge count can be wrong." — badge 4 beside "1 nouveau message".
 */
describe('open room: badge matches the divider after the divider is dismissed while unfocused', () => {
  const ROOM = 'tech@conference.example.com'

  beforeEach(() => {
    msgCounter = 0
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

  it('a message arriving while unfocused after the divider was scrolled away is not the only one the divider counts', async () => {
    roomStore.getState().addRoom(createRoom(ROOM))
    roomStore.getState().setActiveRoom(ROOM)
    reportCurrent(ROOM, 'at-edge')
    // Read and at the live edge: the arrival advances the pointer.
    await roomStore.getState().addMessage(ROOM, createMessage(ROOM, 'jerome', 'checking if we need to update version'))
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(0)

    // The captain switches to another app; the room stays open on screen.
    connectionStore.getState().setWindowVisible(false)
    await roomStore.getState().addMessage(ROOM, createMessage(ROOM, 'prefiks', 'whatever you preffer'))
    await roomStore.getState().addMessage(ROOM, createMessage(ROOM, 'jerome', "Let's just call the image 26.09.1"))
    await roomStore.getState().addMessage(ROOM, createMessage(ROOM, 'prefiks', 'ok'))
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(3)
    expect(roomStore.getState().firstNewMessageCounts.get(ROOM)?.counted.length).toBe(3)

    // Scrolling the unfocused window back to the bottom dismisses the divider (MessageList's
    // MARKER CLEAR); the read report it also makes is ignored while the window is unfocused.
    roomStore.getState().clearFirstNewMessageId(ROOM)
    roomStore.getState().advanceReadPointer(ROOM, { id: roomStore.getState().messages.get(ROOM)!.at(-1)!.id })

    await roomStore.getState().addMessage(ROOM, createMessage(ROOM, 'prefiks', 'i will just tag 26.09.1 with same commit as 26.09'))

    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)?.id).toBe('msg-2')
    expect(roomStore.getState().rooms.get(ROOM)?.readPointer?.identity).toMatchObject({ messageId: 'msg-1' })
    const badge = roomStore.getState().rooms.get(ROOM)?.unreadCount
    const divider = roomStore.getState().firstNewMessageCounts.get(ROOM)?.counted.length
    expect({ badge, divider }).toEqual({ badge: 4, divider: 4 })
  })
})
