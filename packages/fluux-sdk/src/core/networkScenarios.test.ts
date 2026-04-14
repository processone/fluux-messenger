/**
 * Network Scenario Journey Tests
 *
 * Multi-step tests that validate state consistency across network transitions.
 * Each scenario simulates a realistic sequence of events (connect → disconnect →
 * SM resume / fresh session) and verifies that room and chat state remains correct.
 *
 * These tests exercise the integration between connection events, side effects,
 * and store mutations — unlike unit tests that test each layer in isolation.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock messageCache to prevent IndexedDB operations
vi.mock('../utils/messageCache', () => ({
  saveRoomMessage: vi.fn().mockResolvedValue(undefined),
  saveRoomMessages: vi.fn().mockResolvedValue(undefined),
  getRoomMessages: vi.fn().mockResolvedValue([]),
  getRoomMessage: vi.fn().mockResolvedValue(null),
  getRoomMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  saveMessages: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]),
  getMessage: vi.fn().mockResolvedValue(null),
  getMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
  clearAllMessages: vi.fn().mockResolvedValue(undefined),
  isMessageCacheAvailable: vi.fn().mockReturnValue(false),
  getOldestMessageTimestamp: vi.fn().mockResolvedValue(null),
  getOldestRoomMessageTimestamp: vi.fn().mockResolvedValue(null),
  getMessageCount: vi.fn().mockResolvedValue(0),
  getRoomMessageCount: vi.fn().mockResolvedValue(0),
}))

import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import {
  createMockClient,
  seedRooms,
  simulateDisconnect,
  simulateSmResumptionWithRejoin,
  simulateFreshSessionWithRejoin,
  snapshotRoomStates,
  settle,
  type ScenarioMockClient,
} from './networkScenario.testHelpers'
import { setupRoomSideEffects } from './roomSideEffects'

describe('Network Scenario Journey Tests', () => {
  let client: ScenarioMockClient
  let cleanup: () => void

  beforeEach(() => {
    roomStore.getState().reset()
    connectionStore.getState().reset()
    client = createMockClient()
  })

  afterEach(() => {
    cleanup?.()
  })

  // =========================================================================
  // Scenario 1: Disconnect during room join → SM Resume unsticks room
  // =========================================================================
  describe('Scenario 1: Disconnect during room join → SM Resume', () => {
    it('should unstick room that was isJoining before disconnect', async () => {
      // Room was mid-join when connection dropped
      seedRooms([
        { jid: 'room@conference.example.com', isJoining: true, joined: false },
      ], 'room@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      // SM resume + rejoin
      await simulateSmResumptionWithRejoin(client, ['room@conference.example.com'])

      // Room should be joined, not stuck in isJoining
      const snapshot = snapshotRoomStates(['room@conference.example.com'])
      expect(snapshot.get('room@conference.example.com')).toEqual(
        expect.objectContaining({ joined: true, isJoining: false })
      )

      // No redundant MAM (SM resume marked it in fetchInitiated)
      expect(client.chat.queryRoomMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 2: Joined room → Disconnect → SM Resume restores join
  // =========================================================================
  describe('Scenario 2: Joined room → Disconnect → SM Resume', () => {
    it('should re-join room after SM resume resets and rejoins', async () => {
      seedRooms([
        { jid: 'room@conference.example.com', joined: true, supportsMAM: true },
      ], 'room@conference.example.com')

      cleanup = setupRoomSideEffects(client)

      // Disconnect
      simulateDisconnect(client, { clearMocks: true })

      // SM resume + rejoin
      await simulateSmResumptionWithRejoin(client, ['room@conference.example.com'])

      // Room should be joined again
      const room = roomStore.getState().rooms.get('room@conference.example.com')
      expect(room?.joined).toBe(true)
      expect(room?.isJoining).toBeFalsy()

      // No MAM on SM resume
      expect(client.chat.queryRoomMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 3: Multiple rooms in different states → SM Resume
  // =========================================================================
  describe('Scenario 3: Multiple rooms in different states → SM Resume', () => {
    it('should re-join previously joined rooms and leave unjoined rooms alone', async () => {
      seedRooms([
        { jid: 'roomA@conference.example.com', joined: true, supportsMAM: true },
        { jid: 'roomB@conference.example.com', isJoining: true, joined: false, supportsMAM: true },
        { jid: 'roomC@conference.example.com', joined: false, supportsMAM: true },
      ], 'roomA@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      // SM resume: rejoin A and B (they were previously joined/joining), NOT C
      await simulateSmResumptionWithRejoin(client, [
        'roomA@conference.example.com',
        'roomB@conference.example.com',
      ])

      const snapshots = snapshotRoomStates([
        'roomA@conference.example.com',
        'roomB@conference.example.com',
        'roomC@conference.example.com',
      ])

      // A: was joined → re-joined
      expect(snapshots.get('roomA@conference.example.com')).toEqual(
        expect.objectContaining({ joined: true, isJoining: false })
      )
      // B: was isJoining → now properly joined (unstuck)
      expect(snapshots.get('roomB@conference.example.com')).toEqual(
        expect.objectContaining({ joined: true, isJoining: false })
      )
      // C: was never joined → stays not-joined (markAllRoomsNotJoined cleared flags but no rejoin)
      expect(snapshots.get('roomC@conference.example.com')).toEqual(
        expect.objectContaining({ joined: false, isJoining: false })
      )

      // No MAM for any room
      expect(client.chat.queryRoomMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 4: Active room → SM Resume → No redundant MAM
  // =========================================================================
  describe('Scenario 4: Active room → SM Resume → No redundant MAM', () => {
    it('should not trigger MAM for any room on SM resume', async () => {
      seedRooms([
        { jid: 'roomA@conference.example.com', joined: true, supportsMAM: true },
        { jid: 'roomB@conference.example.com', joined: true, supportsMAM: true },
      ], 'roomA@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      await simulateSmResumptionWithRejoin(client, [
        'roomA@conference.example.com',
        'roomB@conference.example.com',
      ])

      // Neither room should trigger MAM — SM replay handles message delivery
      expect(client.chat.queryRoomMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 5: Fresh session fallback (SM failed) → Full reset + MAM
  // =========================================================================
  describe('Scenario 5: Fresh session after SM failure', () => {
    it('should reset all rooms, rejoin, and trigger MAM on fresh session', async () => {
      seedRooms([
        { jid: 'room@conference.example.com', joined: true, supportsMAM: true },
      ], 'room@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      // Fresh session (SM failed) — unlike SM resume, this clears fetchInitiated
      await simulateFreshSessionWithRejoin(client, ['room@conference.example.com'])

      // Room should be joined
      const room = roomStore.getState().rooms.get('room@conference.example.com')
      expect(room?.joined).toBe(true)

      // MAM SHOULD be triggered on fresh session (fetchInitiated was cleared by 'online' handler)
      await vi.waitFor(() => {
        expect(client.chat.queryRoomMAM).toHaveBeenCalledWith(
          expect.objectContaining({ roomJid: 'room@conference.example.com' })
        )
      })
    })
  })

  // =========================================================================
  // Scenario 6: Rapid disconnect/reconnect cycles
  // =========================================================================
  describe('Scenario 6: Rapid disconnect/reconnect', () => {
    it('should maintain consistent state after rapid disconnect/reconnect', async () => {
      seedRooms([
        { jid: 'room@conference.example.com', joined: true, supportsMAM: true },
      ], 'room@conference.example.com')

      cleanup = setupRoomSideEffects(client)

      // Rapid cycle: disconnect → SM resume → disconnect → SM resume
      simulateDisconnect(client)
      await simulateSmResumptionWithRejoin(client, ['room@conference.example.com'])

      simulateDisconnect(client, { clearMocks: true })
      await simulateSmResumptionWithRejoin(client, ['room@conference.example.com'])

      // Final state should be consistent
      const room = roomStore.getState().rooms.get('room@conference.example.com')
      expect(room?.joined).toBe(true)
      expect(room?.isJoining).toBeFalsy()

      // No MAM on either SM resume
      expect(client.chat.queryRoomMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 7: SM Resume → Switch room → MAM behavior
  // =========================================================================
  describe('Scenario 7: SM Resume → Switch room', () => {
    it('should NOT trigger MAM when switching to a previously joined room after SM resume', async () => {
      seedRooms([
        { jid: 'roomA@conference.example.com', joined: true, supportsMAM: true },
        { jid: 'roomB@conference.example.com', joined: true, supportsMAM: true },
      ], 'roomA@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      // SM resume marks both rooms in fetchInitiated
      await simulateSmResumptionWithRejoin(client, [
        'roomA@conference.example.com',
        'roomB@conference.example.com',
      ])

      vi.mocked(client.chat.queryRoomMAM).mockClear()

      // Switch to room B — should NOT trigger MAM because SM resume marked it
      roomStore.getState().setActiveRoom('roomB@conference.example.com')
      await settle()

      expect(client.chat.queryRoomMAM).not.toHaveBeenCalled()
    })

    it('should trigger MAM when switching to a room after fresh session', async () => {
      seedRooms([
        { jid: 'roomA@conference.example.com', joined: true, supportsMAM: true },
        { jid: 'roomB@conference.example.com', joined: true, supportsMAM: true },
      ], 'roomA@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      // Fresh session — only the active room (A) gets fetchInitiated via the 'online' handler
      await simulateFreshSessionWithRejoin(client, [
        'roomA@conference.example.com',
        'roomB@conference.example.com',
      ])

      vi.mocked(client.chat.queryRoomMAM).mockClear()

      // Switch to room B — should trigger MAM (fresh session only protected active room)
      roomStore.getState().setActiveRoom('roomB@conference.example.com')

      await vi.waitFor(() => {
        expect(client.chat.queryRoomMAM).toHaveBeenCalledWith(
          expect.objectContaining({ roomJid: 'roomB@conference.example.com' })
        )
      })
    })
  })
})
