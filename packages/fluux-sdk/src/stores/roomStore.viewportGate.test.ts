/**
 * SDK-owned generation-scoped viewport evidence gates the
 * on-arrival pointer advance. Room-side twin of chatStore.viewportGate.test.ts
 * — see that file for the shared mechanism's full rationale.
 *
 * Exercised against the REAL roomStore so the WIRING itself is under test:
 * `setActiveRoom` is the SOLE caller of `beginViewportGeneration`, and
 * `addMessage` derives `EntityContext.viewportAtLiveEdge` from
 * `currentViewportEvidence`.
 *
 * Acceptance scenarios 8 and 9 — see
 * docs/superpowers/specs/2026-07-23-read-state-unread-count-single-source-acceptance.md
 *
 * NOTE on `readPointer`: `roomStore.addMessage` now commits
 * `notifState.onMessageReceived`'s returned `readPointer` atomically with
 * `unreadCount`, in the SAME write (see roomStore.ts's `addMessage`, the
 * comment above `newRooms.set(roomJid, {...})`) — closing a pre-existing
 * chat/room parity gap where the room's read position never moved on an
 * outgoing/seen message, unlike chatStore.addMessage. Because the two are
 * one atomic commit, the tests below assert both: at the live edge the count
 * genuinely converges to 0 BECAUSE the pointer has genuinely advanced to the
 * arriving message, not in spite of a stale one left behind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { roomStore } from './roomStore'
import { connectionStore } from './connectionStore'
import type { Room, RoomMessage } from '../core/types'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import { _clearAllTransientForTesting } from './shared/transientUnread'
import type { ReadPointer } from './shared/readPointer'
import {
  currentViewportGeneration,
  currentViewportEvidence,
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
    messages: [],
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
 * Directly patch a distinguishing "prior read state" onto an
 * ALREADY-ACTIVATED room — see chatStore.viewportGate.test.ts's
 * `setPriorReadState` doc for why this has to happen AFTER `setActiveRoom`
 * (which itself marks-as-read via `onActivate` against the empty loaded-message
 * array in this lightweight test file).
 */
function setPriorReadState(jid: string, unreadCount: number, priorMessageId: string): void {
  const priorPointer: ReadPointer = { order: { role: 'floor', timestamp: new Date('2025-01-15T08:00:00Z').getTime() }, identity: { state: 'local', messageId: priorMessageId } }
  roomStore.setState((state) => {
    const meta = state.roomMeta.get(jid)
    const room = state.rooms.get(jid)
    const newMeta = new Map(state.roomMeta)
    newMeta.set(jid, {
      ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
      unreadCount,
      readPointer: priorPointer,
    })
    const newRooms = new Map(state.rooms)
    if (room) newRooms.set(jid, { ...room, unreadCount, readPointer: priorPointer })
    return { roomMeta: newMeta, rooms: newRooms }
  })
}

describe('roomStore viewport-evidence gate (Task 11)', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(), messages: new Map(), windowAtLiveEdge: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
      roomGaps: new Map(),
      roomCoverage: new Map(),
    })
    vi.clearAllMocks()
    _clearAllTransientForTesting()
    _clearAllViewportEvidenceForTesting()
    connectionStore.getState().setWindowVisible(true)
  })

  it('setActiveRoom begins a fresh generation SYNCHRONOUSLY (ordering requirement)', () => {
    roomStore.getState().addRoom(createRoom('lounge@conference.example.com'))
    expect(currentViewportGeneration(evidenceKey('lounge@conference.example.com'))).toBe(0)

    roomStore.getState().setActiveRoom('lounge@conference.example.com')

    expect(currentViewportGeneration(evidenceKey('lounge@conference.example.com'))).toBeGreaterThan(0)
  })

  describe('scenario 8: on-arrival pointer-advance precondition', () => {
    const PRIOR_MESSAGE_ID = 'prior-msg'

    function activateAndSeed(jid: string): void {
      roomStore.getState().addRoom(createRoom(jid))
      roomStore.getState().setActiveRoom(jid)
      setPriorReadState(jid, 4, PRIOR_MESSAGE_ID)
    }

    it('active + focused + SCROLLED UP (viewport reports "away"): unread increases', () => {
      activateAndSeed('lounge@conference.example.com')
      reportCurrent('lounge@conference.example.com', 'away')

      roomStore.getState().addMessage('lounge@conference.example.com', createMessage('lounge@conference.example.com', 'alice', 'incoming while scrolled up'))

      const room = roomStore.getState().rooms.get('lounge@conference.example.com')
      expect(room?.unreadCount).toBe(5)
    })

    it('active + focused + AT THE LIVE EDGE: count converges to 0 and the pointer advances to the arrival', () => {
      activateAndSeed('lounge@conference.example.com')
      reportCurrent('lounge@conference.example.com', 'at-edge')

      const msg = createMessage('lounge@conference.example.com', 'alice', 'incoming at the live edge')
      roomStore.getState().addMessage('lounge@conference.example.com', msg)

      const room = roomStore.getState().rooms.get('lounge@conference.example.com')
      expect(room?.unreadCount).toBe(0)
      expect(room?.readPointer?.identity.messageId).toBe(msg.id)
      expect(roomStore.getState().roomMeta.get('lounge@conference.example.com')?.unreadCount).toBe(0)
      expect(roomStore.getState().roomMeta.get('lounge@conference.example.com')?.readPointer?.identity.messageId).toBe(msg.id)
    })

    it('active + focused + UNKNOWN viewport (never reported): treated as not-at-edge, unread increases', () => {
      activateAndSeed('lounge@conference.example.com')
      // Deliberately no reportCurrent(...) call — evidence stays 'unknown'.

      roomStore.getState().addMessage('lounge@conference.example.com', createMessage('lounge@conference.example.com', 'alice', 'incoming, no report yet'))

      const room = roomStore.getState().rooms.get('lounge@conference.example.com')
      expect(room?.unreadCount).toBe(5)
    })

    it('window hidden (existing gate, unaffected by Task 11): unread still increases even with an at-edge report', () => {
      activateAndSeed('lounge@conference.example.com')
      reportCurrent('lounge@conference.example.com', 'at-edge')
      connectionStore.getState().setWindowVisible(false)

      roomStore.getState().addMessage('lounge@conference.example.com', createMessage('lounge@conference.example.com', 'alice', 'incoming while unfocused'))

      const room = roomStore.getState().rooms.get('lounge@conference.example.com')
      expect(room?.unreadCount).toBe(5)
    })
  })

  describe('scenario 9: viewport-evidence freshness across a room switch (switch-race)', () => {
    const PRIOR_A = 'prior-a'
    const PRIOR_B = 'prior-b'
    const ROOM_A = 'roomA@conference.example.com'
    const ROOM_B = 'roomB@conference.example.com'

    function setUpBoth(): void {
      roomStore.getState().addRoom(createRoom(ROOM_A))
      roomStore.getState().addRoom(createRoom(ROOM_B))
    }

    it("switching to B before B reports: an arrival in B increments unread (does not converge to 0)", () => {
      setUpBoth()

      roomStore.getState().setActiveRoom(ROOM_A)
      setPriorReadState(ROOM_A, 4, PRIOR_A)
      reportCurrent(ROOM_A, 'at-edge')

      // Switch to B — a NEW generation starts for B at 'unknown'.
      roomStore.getState().setActiveRoom(ROOM_B)
      setPriorReadState(ROOM_B, 4, PRIOR_B)

      roomStore.getState().addMessage(ROOM_B, createMessage(ROOM_B, 'bob', 'arrives before B reports'))

      const roomB = roomStore.getState().rooms.get(ROOM_B)
      expect(roomB?.unreadCount).toBe(5)
    })

    it("a late report carrying room A's key/generation never bleeds into B's evidence", () => {
      setUpBoth()

      roomStore.getState().setActiveRoom(ROOM_A)
      setPriorReadState(ROOM_A, 4, PRIOR_A)
      const aGeneration = currentViewportGeneration(evidenceKey(ROOM_A))

      roomStore.getState().setActiveRoom(ROOM_B)
      setPriorReadState(ROOM_B, 4, PRIOR_B)

      reportViewport(evidenceKey(ROOM_A), aGeneration, 'at-edge')

      roomStore.getState().addMessage(ROOM_B, createMessage(ROOM_B, 'bob', 'arrives after A (only) reports'))

      const roomB = roomStore.getState().rooms.get(ROOM_B)
      expect(roomB?.unreadCount).toBe(5)
      expect(currentViewportEvidence(evidenceKey(ROOM_B))).toBe('unknown')
    })

    it("after B reports at-edge on its OWN generation, a subsequent arrival in B converges unread to 0 and advances B's pointer", () => {
      setUpBoth()

      roomStore.getState().setActiveRoom(ROOM_A)
      reportCurrent(ROOM_A, 'at-edge')
      roomStore.getState().setActiveRoom(ROOM_B)
      setPriorReadState(ROOM_B, 4, PRIOR_B)

      reportCurrent(ROOM_B, 'at-edge')

      const msg = createMessage(ROOM_B, 'bob', 'arrives once B is genuinely at the edge')
      roomStore.getState().addMessage(ROOM_B, msg)

      const roomB = roomStore.getState().rooms.get(ROOM_B)
      expect(roomB?.unreadCount).toBe(0)
      expect(roomB?.readPointer?.identity.messageId).toBe(msg.id)
    })
  })

  describe('same-entity reactivation (Task 11 required test)', () => {
    const PRIOR = 'prior-msg'
    const ROOM = 'lounge@conference.example.com'

    it('activate A, report at-edge, deactivate, re-activate A: the previous generation report is rejected, the new one is accepted', () => {
      roomStore.getState().addRoom(createRoom(ROOM))

      roomStore.getState().setActiveRoom(ROOM)
      const firstGeneration = currentViewportGeneration(evidenceKey(ROOM))
      reportCurrent(ROOM, 'at-edge')

      // Deactivate, then re-activate the SAME room — a NEW generation begins.
      roomStore.getState().setActiveRoom(null)
      roomStore.getState().setActiveRoom(ROOM)
      const secondGeneration = currentViewportGeneration(evidenceKey(ROOM))
      expect(secondGeneration).not.toBe(firstGeneration)
      setPriorReadState(ROOM, 4, PRIOR)

      // A late report still carrying the FIRST (now stale) generation token must be rejected.
      reportViewport(evidenceKey(ROOM), firstGeneration, 'at-edge')
      roomStore.getState().addMessage(ROOM, createMessage(ROOM, 'alice', 'arrives after the stale re-activation report'))
      const roomAfterStaleReport = roomStore.getState().rooms.get(ROOM)
      expect(roomAfterStaleReport?.unreadCount).toBe(5)

      // A report on the NEW (current) generation is accepted.
      reportViewport(evidenceKey(ROOM), secondGeneration, 'at-edge')
      const msg = createMessage(ROOM, 'alice', 'arrives once the new generation reports at-edge')
      roomStore.getState().addMessage(ROOM, msg)
      const roomAfterFreshReport = roomStore.getState().rooms.get(ROOM)
      expect(roomAfterFreshReport?.unreadCount).toBe(0)
      expect(roomAfterFreshReport?.readPointer?.identity.messageId).toBe(msg.id)
    })
  })
})
