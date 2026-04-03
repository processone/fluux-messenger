/**
 * Race condition tests for reconnection after sleep/wake.
 *
 * These tests target specific timing-dependent races that have caused
 * production deadlocks. Each test uses timeline-based scheduling to
 * simulate interleaved async operations (stale timeouts, duplicate wake
 * events, auth/timeout ordering).
 *
 * The tests complement the pure state machine tests (connectionMachine.test.ts)
 * and the standard connection tests (Connection.test.ts) by verifying that
 * the state machine + Connection module work correctly together under race
 * conditions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import { RECONNECT_ATTEMPT_TIMEOUT_MS, WAKE_VERIFY_TIMEOUT_MS } from './connectionTimeouts'
import { SM_SESSION_TIMEOUT_MS } from '../connectionMachine'
import {
  createMockXmppClient,
  createMockStores,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

let mockXmppClientInstance: MockXmppClient

const { mockClientFactory } = vi.hoisted(() => {
  let clientInstance: MockXmppClient | null = null
  return {
    mockClientFactory: Object.assign(
      vi.fn(() => clientInstance),
      {
        _setInstance: (instance: MockXmppClient) => { clientInstance = instance },
      }
    ),
  }
})

vi.mock('@xmpp/client', () => ({
  client: mockClientFactory,
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

const { mockDiscoverWebSocket } = vi.hoisted(() => ({
  mockDiscoverWebSocket: vi.fn(),
}))

const { mockFlushPendingRoomMessages } = vi.hoisted(() => ({
  mockFlushPendingRoomMessages: vi.fn(),
}))

vi.mock('../../utils/websocketDiscovery', () => ({
  discoverWebSocket: mockDiscoverWebSocket,
}))

vi.mock('../../utils/messageCache', async () => {
  const actual = await vi.importActual<typeof import('../../utils/messageCache')>('../../utils/messageCache')
  return {
    ...actual,
    flushPendingRoomMessages: mockFlushPendingRoomMessages,
  }
})

vi.mock('../fastTokenStorage', () => ({
  fetchFastToken: vi.fn().mockReturnValue(null),
  saveFastToken: vi.fn(),
  deleteFastToken: vi.fn(),
  hasFastToken: vi.fn(),
}))

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Connect the client and return it in connected.healthy state. */
async function connectAndGoOnline(
  xmppClient: XMPPClient,
  mockClient: MockXmppClient,
) {
  const p = xmppClient.connect({
    jid: 'user@example.com',
    password: 'secret',
    server: 'example.com',
    skipDiscovery: true,
  })
  mockClient._emit('online')
  await p
}

/** Get the current state machine value via the connection store mock. */
function getStatus(mockStores: MockStoreBindings): string {
  const calls = vi.mocked(mockStores.connection.setStatus).mock.calls
  return calls.length > 0 ? calls[calls.length - 1][0] : 'unknown'
}

/** Get the machine state from the Connection module (via internal access). */
function getMachineState(xmppClient: XMPPClient): unknown {
  return (xmppClient.connection as any).getMachineState()
}

/** Check if the internal xmpp client reference is non-null. */
function hasActiveClient(xmppClient: XMPPClient): boolean {
  return (xmppClient.connection as any).xmpp != null
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Connection race conditions', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockDiscoverWebSocket.mockClear()
    mockDiscoverWebSocket.mockResolvedValue(null)
    mockFlushPendingRoomMessages.mockClear()
    mockFlushPendingRoomMessages.mockResolvedValue(undefined)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    xmppClient.cancelReconnect()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Race 1: Stale timeout fires after WAKE triggers fresh attempt
  //
  // Timeline:
  //   T=0:     SOCKET_DIED → reconnecting
  //   T=1000:  attempting, client_A created, 30s timeout set
  //   T=60000: WAKE arrives, cleanupClient destroys client_A,
  //            machine resets to waiting(delay=0) → attempting, client_B created
  //   T=60000+: Stale 30s timeout from client_A fires
  //   Assert:  client_B is still alive — stale timeout didn't destroy it
  // ─────────────────────────────────────────────────────────────────────────

  describe('Race 1: stale timeout after wake triggers fresh attempt', () => {
    it('should not destroy the new client when stale timeout fires', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)

      // Enter reconnecting via disconnect
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      // Prepare client_A for the first reconnect attempt
      const clientA = createMockXmppClient()
      mockClientFactory._setInstance(clientA)
      mockClientFactory.mockClear()

      // Machine reaches attempting after backoff delay (1s for first attempt)
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
      expect(getMachineState(xmppClient)).toEqual({ reconnecting: 'attempting' })

      // Prepare client_B for the fresh attempt after wake
      const clientB = createMockXmppClient()
      mockClientFactory._setInstance(clientB)
      mockClientFactory.mockClear()

      // Simulate WAKE (like system waking from sleep)
      // This should: cleanupClient(client_A), WAKE → waiting(delay=0) → attempting, create client_B
      await xmppClient.connection.notifySystemState('awake', 30_000)
      // Flush: after:reconnectDelay(0) timer → attempting entry
      await vi.advanceTimersByTimeAsync(0)
      // Flush: attemptReconnect's waitForNetworkReady + network settle delay (2s) + client creation
      await vi.advanceTimersByTimeAsync(3000)

      // client_B should be created for the fresh attempt
      expect(mockClientFactory).toHaveBeenCalledTimes(1)
      expect(hasActiveClient(xmppClient)).toBe(true)

      // Complete clientB's connection before the stale timeout fires.
      // In production this simulates: wake → fresh attempt → auth succeeds.
      clientB._emit('online')
      await vi.advanceTimersByTimeAsync(0)

      // Should be connected now
      expect(getStatus(mockStores)).toBe('online')

      // Advance past the stale 30s timeout from client_A — it should be
      // harmless because clientB already connected and cleared the timeout.
      await vi.advanceTimersByTimeAsync(RECONNECT_ATTEMPT_TIMEOUT_MS)

      // Still connected — stale timeout didn't interfere
      expect(getStatus(mockStores)).toBe('online')
      expect(hasActiveClient(xmppClient)).toBe(true)
    })

    it('should reject stale timeout with "superseded" error', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      const clientA = createMockXmppClient()
      mockClientFactory._setInstance(clientA)
      mockClientFactory.mockClear()
      await vi.advanceTimersByTimeAsync(1000)

      const clientB = createMockXmppClient()
      mockClientFactory._setInstance(clientB)

      await xmppClient.connection.notifySystemState('awake', 30_000)
      await vi.advanceTimersByTimeAsync(0)

      // Advance past stale timeout — machine should NOT go to terminal/error state
      await vi.advanceTimersByTimeAsync(RECONNECT_ATTEMPT_TIMEOUT_MS)

      // Machine should still be in reconnecting (not terminal/disconnected)
      const state = getMachineState(xmppClient)
      expect(state).not.toBe('disconnected')
      expect(state).not.toEqual(expect.objectContaining({ terminal: expect.anything() }))
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Race 2: Duplicate WAKE events (Tauri system-did-wake + heartbeat gap)
  //
  // Timeline:
  //   T=0:   connected.healthy
  //   T=0:   First handleAwake(30s) → WAKE → connected.verifying, verifyConnection starts
  //   T=100: Second handleAwake(30s) → WAKE sent (ignored by machine in verifying)
  //          but handleAwake code still runs verifyConnection
  //   Assert: Only one reconnect cycle, no double SOCKET_DIED
  // ─────────────────────────────────────────────────────────────────────────

  describe('Race 2: duplicate WAKE events', () => {
    it('should not trigger double reconnect from concurrent wake events', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)

      // Make verify fail: IQ ping hangs (simulates dead socket after sleep)
      mockXmppClientInstance.iqCaller.request.mockImplementation(
        () => new Promise(() => {}) // Never resolves — simulates dead socket
      )

      // Both WAKEs fire almost simultaneously (as happens with Tauri + heartbeat)
      const wake1 = xmppClient.connection.notifySystemState('awake', 30_000)
      const wake2 = xmppClient.connection.notifySystemState('awake', 30_000)

      // Let verify timeout expire (worst case: both verifications fail)
      await vi.advanceTimersByTimeAsync(WAKE_VERIFY_TIMEOUT_MS + 1000)
      await wake1
      await wake2

      // Machine should be in reconnecting, not in a broken state
      const state = getMachineState(xmppClient)
      const isReconnecting = typeof state === 'object' && state !== null && 'reconnecting' in state
      expect(isReconnecting).toBe(true)

      // Attempt counter should be reasonable (1 or 2, not 3+)
      const reconnectCalls = vi.mocked(mockStores.connection.setReconnectState).mock.calls
      const lastAttempt = reconnectCalls.length > 0
        ? reconnectCalls[reconnectCalls.length - 1][0]
        : 0
      expect(lastAttempt).toBeLessThanOrEqual(2)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Race 3: Reconnect timeout fires, then stale 'online' from destroyed client
  //
  // Timeline:
  //   T=0:     attempting, client_A created
  //   T=30000: timeout fires → abortHandlers, cleanupClient(client_A)
  //   T=30500: client_A._emit('online') — stale event from destroyed client
  //   Assert:  Machine in reconnecting.waiting (not connected.healthy)
  //            removeAllListeners prevents the stale event from reaching handlers
  // ─────────────────────────────────────────────────────────────────────────

  describe('Race 3: timeout vs belated auth success', () => {
    it('should not transition to connected from stale online event after timeout', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      const reconnectClient = createMockXmppClient()
      mockClientFactory._setInstance(reconnectClient)
      mockClientFactory.mockClear()

      // Trigger reconnect attempt
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Advance past timeout — client is cleaned up
      await vi.advanceTimersByTimeAsync(RECONNECT_ATTEMPT_TIMEOUT_MS)

      // removeAllListeners should have been called on the destroyed client
      expect(reconnectClient.removeAllListeners).toHaveBeenCalled()
      expect(reconnectClient._hasHandlers('online')).toBe(false)

      // Simulate stale 'online' from destroyed client
      mockStores.connection.setStatus.mockClear()
      reconnectClient._emit('online')

      // Machine must NOT be in connected state
      const statusCalls = vi.mocked(mockStores.connection.setStatus).mock.calls
      expect(statusCalls.some(c => c[0] === 'online')).toBe(false)
    })

    it('should continue reconnect loop after timeout', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      const clientA = createMockXmppClient()
      mockClientFactory._setInstance(clientA)
      mockClientFactory.mockClear()
      await vi.advanceTimersByTimeAsync(1000)

      // Timeout fires → CONNECTION_ERROR → waiting
      await vi.advanceTimersByTimeAsync(RECONNECT_ATTEMPT_TIMEOUT_MS)

      // Prepare next client
      const clientB = createMockXmppClient()
      mockClientFactory._setInstance(clientB)
      mockClientFactory.mockClear()

      // Backoff delay for attempt 2 (2s)
      await vi.advanceTimersByTimeAsync(2000)

      // New attempt should have started
      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Completing connection should succeed
      clientB._emit('online')
      await vi.advanceTimersByTimeAsync(0)

      expect(getStatus(mockStores)).toBe('online')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Race 4: Old attemptReconnect catch block fires CONNECTION_ERROR after
  //         WAKE already started a new attempt
  //
  // Timeline:
  //   T=0:     attempting, attemptReconnect_1 running with client_A
  //   T=60000: WAKE → cleanupClient(client_A), machine resets → attempting,
  //            attemptReconnect_2 starts with client_B
  //   T=60001: client_A's destruction resolves attemptReconnect_1's promise rejection
  //            → catch block sends CONNECTION_ERROR
  //   Assert:  CONNECTION_ERROR should NOT disrupt client_B's attempt
  // ─────────────────────────────────────────────────────────────────────────

  describe('Race 4: stale CONNECTION_ERROR from old attemptReconnect', () => {
    it('should not disrupt new attempt when old catch block fires', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      // Start first reconnect attempt
      const clientA = createMockXmppClient()
      mockClientFactory._setInstance(clientA)
      mockClientFactory.mockClear()
      await vi.advanceTimersByTimeAsync(1000)
      expect(getMachineState(xmppClient)).toEqual({ reconnecting: 'attempting' })

      // Prepare client_B
      const clientB = createMockXmppClient()
      mockClientFactory._setInstance(clientB)
      mockClientFactory.mockClear()

      // WAKE arrives — cleanups client_A, triggers fresh attempt with client_B
      await xmppClient.connection.notifySystemState('awake', 30_000)
      // Flush: network settle delay (2s) + client creation
      await vi.advanceTimersByTimeAsync(3000)

      expect(mockClientFactory).toHaveBeenCalledTimes(1)

      // Let any stale promise rejections propagate
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      // client_B's attempt should still be in progress
      expect(hasActiveClient(xmppClient)).toBe(true)

      // Complete client_B's connection
      clientB._emit('online')
      await vi.advanceTimersByTimeAsync(0)

      // Should be connected now
      expect(getStatus(mockStores)).toBe('online')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Race 5: Disconnect fires during verifyConnection SM ack wait
  //
  // Timeline:
  //   T=0:   connected.verifying after wake, verifyConnection sends SM request
  //   T=500: disconnect event fires — handleDeadSocket, SOCKET_DIED, cleanupClient
  //   Assert: handleDeadSocket processes once, machine enters reconnecting
  // ─────────────────────────────────────────────────────────────────────────

  describe('Race 5: disconnect during verifyConnection', () => {
    it('should transition cleanly to reconnecting when disconnect fires during verify', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)

      // Add SM so verification uses SM ack path
      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      // Trigger wake → verifying
      const wakePromise = xmppClient.connection.notifySystemState('awake', 30_000)

      // Short pause to let verify start
      await vi.advanceTimersByTimeAsync(100)

      // Disconnect fires mid-verify (socket dies)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      // Let verify timeout expire
      await vi.advanceTimersByTimeAsync(WAKE_VERIFY_TIMEOUT_MS)
      await wakePromise

      // Machine should be in reconnecting (from the disconnect, not from a double-fire)
      const state = getMachineState(xmppClient)
      const isReconnecting = typeof state === 'object' && state !== null && 'reconnecting' in state
      expect(isReconnecting).toBe(true)
    })

    it('should not double-increment attempt counter from concurrent disconnect + verify timeout', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)

      mockXmppClientInstance.streamManagement = {
        id: 'sm-123',
        inbound: 5,
        outbound: 0,
        enabled: true,
        on: vi.fn(),
      }

      const wakePromise = xmppClient.connection.notifySystemState('awake', 30_000)
      await vi.advanceTimersByTimeAsync(100)

      // Disconnect fires → SOCKET_DIED → reconnecting (attempt 1)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      // Verify timeout also fires later — should NOT cause another increment
      await vi.advanceTimersByTimeAsync(WAKE_VERIFY_TIMEOUT_MS)
      await wakePromise

      // Attempt counter should be reasonable (1, not 2+)
      const reconnectCalls = vi.mocked(mockStores.connection.setReconnectState).mock.calls
      if (reconnectCalls.length > 0) {
        const lastAttempt = reconnectCalls[reconnectCalls.length - 1][0]
        expect(lastAttempt).toBeLessThanOrEqual(2)
      }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Integration: WAKE with long sleep during reconnecting should mark SM
  //              resume as not viable
  // ─────────────────────────────────────────────────────────────────────────

  describe('SM resume viability after sleep during reconnect', () => {
    it('should mark SM resume not viable when WAKE during reconnecting exceeds SM timeout', async () => {
      await connectAndGoOnline(xmppClient, mockXmppClientInstance)
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(0)

      const clientA = createMockXmppClient()
      mockClientFactory._setInstance(clientA)
      mockClientFactory.mockClear()
      await vi.advanceTimersByTimeAsync(1000)

      // Long sleep (> SM_SESSION_TIMEOUT_MS) during reconnecting
      const clientB = createMockXmppClient()
      mockClientFactory._setInstance(clientB)

      await xmppClient.connection.notifySystemState('awake', SM_SESSION_TIMEOUT_MS + 60_000)
      await vi.advanceTimersByTimeAsync(0)

      // Check smResumeViable via machine context
      const snapshot = (xmppClient.connection as any).connectionActor.getSnapshot()
      expect(snapshot.context.smResumeViable).toBe(false)
    })
  })
})
