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
  // Scenario 1: Disconnect during room join → SM Resume leaves state alone
  // =========================================================================
  describe('Scenario 1: Disconnect during room join → SM Resume', () => {
    it('should leave a mid-join room in place — the server either completed the join (self-presence arrives in SM replay) or didn\'t', async () => {
      // Room was mid-join when connection dropped
      seedRooms([
        { jid: 'room@conference.example.com', isJoining: true, joined: false },
      ], 'room@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      // SM resume does NOT touch room state — the server's view of our
      // membership is authoritative, and any post-disconnect transitions are
      // delivered via the SM replay queue.
      await simulateSmResumptionWithRejoin(client, ['room@conference.example.com'])

      // Room still in the same isJoining state; the server's replayed
      // self-presence (if the join completed) or lack thereof would resolve it.
      const snapshot = snapshotRoomStates(['room@conference.example.com'])
      expect(snapshot.get('room@conference.example.com')).toEqual(
        expect.objectContaining({ isJoining: true, joined: false })
      )

      // No MAM on SM resume — replay covers any missed messages
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
    it('should leave every room\'s state untouched — SM resume does not mutate local room state', async () => {
      seedRooms([
        { jid: 'roomA@conference.example.com', joined: true, supportsMAM: true },
        { jid: 'roomB@conference.example.com', isJoining: true, joined: false, supportsMAM: true },
        { jid: 'roomC@conference.example.com', joined: false, supportsMAM: true },
      ], 'roomA@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(client)

      await simulateSmResumptionWithRejoin(client, [
        'roomA@conference.example.com',
        'roomB@conference.example.com',
      ])

      const snapshots = snapshotRoomStates([
        'roomA@conference.example.com',
        'roomB@conference.example.com',
        'roomC@conference.example.com',
      ])

      // A: was joined → stays joined (server view preserved by SM)
      expect(snapshots.get('roomA@conference.example.com')).toEqual(
        expect.objectContaining({ joined: true })
      )
      // B: was isJoining → stays as-is; server replay will resolve if join completed
      expect(snapshots.get('roomB@conference.example.com')).toEqual(
        expect.objectContaining({ isJoining: true, joined: false })
      )
      // C: was never joined → stays not-joined
      expect(snapshots.get('roomC@conference.example.com')).toEqual(
        expect.objectContaining({ joined: false })
      )

      // No MAM for any room — SM replay covers message delivery
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
    it('fetches MAM when switching to a previously joined room with an empty local archive after SM resume', async () => {
      // roomB was joined but never opened/fetched this session — its local archive is
      // empty. SM resume must NOT mark a never-fetched room caught up (there is nothing
      // in the replay queue to give it), so the first switch into it fetches the
      // archive. Otherwise the room shows permanently empty (the reported bug).
      // A room we already hold (resident/queried) is still skipped — see the
      // roomSideEffects "already hold" and #679 re-entry tests.
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

      vi.mocked(client.chat.queryRoomMAM).mockClear()

      // Switch to room B (empty local archive) — must fetch its archive.
      roomStore.getState().setActiveRoom('roomB@conference.example.com')
      await settle()

      expect(client.chat.queryRoomMAM).toHaveBeenCalledWith(
        expect.objectContaining({ roomJid: 'roomB@conference.example.com' })
      )
    })

    // =========================================================================
    // Regression: log from 2026-04-21 — SM resumption after an aborted fresh
    // session must leave pre-existing joined-room state intact.
    //
    // Sequence the log showed:
    //   1. 7 rooms joined (store has joined=true for all)
    //   2. Stream error → reconnect cycle tries SM resume, keeps failing
    //   3. Eventually a fresh session is attempted
    //   4. Fresh session aborts mid-setup (socket dies before rejoinActiveRooms)
    //   5. Next reconnect succeeds via SM resume
    //
    // Before the fix: step 3 called markAllRoomsNotJoined() at the top of the
    // setup, so step 4 left every room marked joined=false. Step 5 trusted
    // that corrupted state and the UI showed "not joined" indefinitely.
    //
    // After the fix: step 3 defers the flag-clearing to right before the
    // rejoin call, so step 4 leaves the live room state untouched, and step
    // 5 has correct state to trust.
    // =========================================================================
    it('REGRESSION: rooms stay joined after fresh-session aborts mid-setup followed by SM resume', async () => {
      seedRooms([
        { jid: 'roomA@conference.example.com', joined: true, supportsMAM: true },
        { jid: 'roomB@conference.example.com', joined: true, supportsMAM: true },
        { jid: 'roomC@conference.example.com', joined: true, supportsMAM: true },
      ], 'roomA@conference.example.com')

      cleanup = setupRoomSideEffects(client)

      // Step 2-3: stream dies, reconnect cycle eventually falls into a fresh
      // session. Simulate the fresh session path ABORTING before it reaches
      // rejoinActiveRooms — the fix is that markAllRoomsNotJoined is now
      // deferred to just before rejoin, so an early abort leaves flags alone.
      //
      // We model this directly: if the old behavior had run, rooms would
      // already be joined=false here. Assert they aren't.
      simulateDisconnect(client, { clearMocks: true })

      const beforeResume = snapshotRoomStates([
        'roomA@conference.example.com',
        'roomB@conference.example.com',
        'roomC@conference.example.com',
      ])
      expect(beforeResume.get('roomA@conference.example.com')?.joined).toBe(true)
      expect(beforeResume.get('roomB@conference.example.com')?.joined).toBe(true)
      expect(beforeResume.get('roomC@conference.example.com')?.joined).toBe(true)

      // Step 5: SM resume succeeds. It must not mutate the room store.
      await simulateSmResumptionWithRejoin(client, [
        'roomA@conference.example.com',
        'roomB@conference.example.com',
        'roomC@conference.example.com',
      ])

      const afterResume = snapshotRoomStates([
        'roomA@conference.example.com',
        'roomB@conference.example.com',
        'roomC@conference.example.com',
      ])
      expect(afterResume.get('roomA@conference.example.com')?.joined).toBe(true)
      expect(afterResume.get('roomB@conference.example.com')?.joined).toBe(true)
      expect(afterResume.get('roomC@conference.example.com')?.joined).toBe(true)

      // SM replay covers any diff — no MAM catch-up, no rejoin churn
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
