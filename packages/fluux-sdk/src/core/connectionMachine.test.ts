/**
 * Tests for the connection state machine.
 *
 * These tests verify:
 * 1. State transitions are correct for all lifecycle paths
 * 2. Context is properly updated (backoff, countdown, errors)
 * 3. Impossible states are prevented (events ignored in wrong states)
 * 4. Terminal states block auto-recovery but allow fresh CONNECT
 * 5. Exponential backoff computation is correct
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createActor } from 'xstate'
import {
  connectionMachine,
  getConnectionStatusFromState,
  isTerminalState,
  getReconnectInfoFromContext,
  INITIAL_RECONNECT_DELAY,
  MAX_RECONNECT_DELAY,
  RECONNECT_MULTIPLIER,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  SM_SESSION_TIMEOUT_MS,
} from './connectionMachine'

describe('connectionMachine', () => {
  describe('initial state', () => {
    it('should start in idle state', () => {
      const actor = createActor(connectionMachine).start()
      expect(actor.getSnapshot().value).toBe('idle')
      actor.stop()
    })

    it('should have default context', () => {
      const actor = createActor(connectionMachine).start()
      const { context } = actor.getSnapshot()
      expect(context.reconnectAttempt).toBe(0)
      expect(context.maxReconnectAttempts).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS)
      expect(context.nextRetryDelayMs).toBe(0)
      expect(context.reconnectTargetTime).toBeNull()
      expect(context.lastError).toBeNull()
      actor.stop()
    })
  })

  describe('happy path: idle → connecting → connected.healthy', () => {
    it('should transition through the happy path', () => {
      const actor = createActor(connectionMachine).start()

      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')

      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })

      actor.stop()
    })

    it('should clear error on CONNECT', () => {
      const actor = createActor(connectionMachine).start()

      // First: fail to get an error
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'some error' })
      expect(actor.getSnapshot().context.lastError).toBe('some error')

      // CONNECT from terminal should clear error and go directly to connecting
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')
      expect(actor.getSnapshot().context.lastError).toBeNull()

      actor.stop()
    })
  })

  describe('manual disconnect', () => {
    it('should transition from connected.healthy to disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })

      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      actor.stop()
    })

    it('should transition from connecting to disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')

      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      actor.stop()
    })

    it('should reset reconnect state on disconnect', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      // Now in reconnecting.waiting with attempt=1
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)

      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      expect(actor.getSnapshot().context.reconnectTargetTime).toBeNull()
      actor.stop()
    })

    it('should allow reconnect after disconnect via CONNECT', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')

      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')
      actor.stop()
    })
  })

  describe('wake verification', () => {
    let actor: ReturnType<typeof createActor<typeof connectionMachine>>

    beforeEach(() => {
      actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
    })

    it('should transition to verifying on WAKE with short sleep', () => {
      actor.send({ type: 'WAKE', sleepDurationMs: 30_000 })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })
      actor.stop()
    })

    it('should transition to verifying on WAKE with no sleep duration', () => {
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })
      actor.stop()
    })

    it('should return to healthy on VERIFY_SUCCESS', () => {
      actor.send({ type: 'WAKE', sleepDurationMs: 30_000 })
      actor.send({ type: 'VERIFY_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      actor.stop()
    })

    it('should transition to reconnecting on VERIFY_FAILED', () => {
      actor.send({ type: 'WAKE', sleepDurationMs: 30_000 })
      actor.send({ type: 'VERIFY_FAILED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      actor.stop()
    })

    it('should skip verification on WAKE with long sleep (exceeds SM timeout)', () => {
      const longSleep = SM_SESSION_TIMEOUT_MS + 1000
      actor.send({ type: 'WAKE', sleepDurationMs: longSleep })
      // Should go directly to reconnecting, skipping verifying
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      actor.stop()
    })

    it('should verify (not skip) on WAKE at exactly SM timeout boundary', () => {
      // Guard is: sleepDurationMs > SM_SESSION_TIMEOUT_MS (strictly greater)
      // At exactly the threshold, should still verify
      actor.send({ type: 'WAKE', sleepDurationMs: SM_SESSION_TIMEOUT_MS })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })
      actor.stop()
    })

    it('should handle SOCKET_DIED while verifying', () => {
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      actor.stop()
    })

    it('should handle DISCONNECT while verifying', () => {
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      actor.stop()
    })

    it('should handle CONFLICT while verifying', () => {
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

      actor.send({ type: 'CONFLICT' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
      expect(actor.getSnapshot().context.lastError).toBe('Session replaced by another client')
      actor.stop()
    })

    it('should handle AUTH_ERROR while verifying', () => {
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

      actor.send({ type: 'AUTH_ERROR' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
      expect(actor.getSnapshot().context.lastError).toBe('Authentication failed')
      actor.stop()
    })

    it('should handle SLEEP while verifying (re-sleep before verification completes)', () => {
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

      actor.send({ type: 'SLEEP' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'sleeping' })
      expect(actor.getSnapshot().context.sleepStartTime).not.toBeNull()
      actor.stop()
    })

    it('should handle full re-sleep/wake cycle from verifying state', () => {
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

      // Re-sleep while verifying
      actor.send({ type: 'SLEEP' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'sleeping' })

      // Wake again with long sleep — should go to reconnecting
      const longSleep = SM_SESSION_TIMEOUT_MS + 1000
      actor.send({ type: 'WAKE', sleepDurationMs: longSleep })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      actor.stop()
    })

    it('should auto-transition to reconnecting after verifyTimeout (safety net)', () => {
      vi.useFakeTimers()
      try {
        actor.send({ type: 'WAKE' })
        expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

        // Advance past the 15s verifyTimeout
        vi.advanceTimersByTime(15_000)

        expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      } finally {
        vi.useRealTimers()
        actor.stop()
      }
    })

    it('should cancel verifyTimeout when VERIFY_SUCCESS arrives before timeout', () => {
      vi.useFakeTimers()
      try {
        actor.send({ type: 'WAKE' })
        expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

        // Verify succeeds before timeout
        vi.advanceTimersByTime(2_000)
        actor.send({ type: 'VERIFY_SUCCESS' })
        expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })

        // Advance past the original timeout — should NOT transition
        vi.advanceTimersByTime(20_000)
        expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      } finally {
        vi.useRealTimers()
        actor.stop()
      }
    })
  })

  describe('socket death', () => {
    it('should transition from connected.healthy to reconnecting.waiting', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })

      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      actor.stop()
    })

    it('should compute first backoff delay correctly', () => {
      const before = Date.now()
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })

      const { context } = actor.getSnapshot()
      expect(context.nextRetryDelayMs).toBe(INITIAL_RECONNECT_DELAY) // 1000ms for attempt 1
      // reconnectTargetTime is an absolute timestamp (Date.now() + delay)
      expect(context.reconnectTargetTime).toBeGreaterThanOrEqual(before + INITIAL_RECONNECT_DELAY)
      expect(context.reconnectTargetTime).toBeLessThanOrEqual(Date.now() + INITIAL_RECONNECT_DELAY)
      actor.stop()
    })
  })

  describe('reconnection cycle', () => {
    let actor: ReturnType<typeof createActor<typeof connectionMachine>>

    beforeEach(() => {
      actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      // Now in reconnecting.waiting, attempt=1
    })

    it('should transition to attempting automatically after reconnect delay', async () => {
      vi.useFakeTimers()
      try {
        const timedActor = createActor(connectionMachine).start()
        timedActor.send({ type: 'CONNECT' })
        timedActor.send({ type: 'CONNECTION_SUCCESS' })
        timedActor.send({ type: 'SOCKET_DIED' })
        expect(timedActor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
        await vi.advanceTimersByTimeAsync(INITIAL_RECONNECT_DELAY)
        expect(timedActor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
        timedActor.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('should transition to attempting on TRIGGER_RECONNECT', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      expect(actor.getSnapshot().context.reconnectTargetTime).toBeNull()
      actor.stop()
    })

    it('should transition to connected.healthy on successful reconnect', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      // Should reset reconnect state
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      expect(actor.getSnapshot().context.lastError).toBeNull()
      actor.stop()
    })

    it('should go back to waiting on failed reconnect attempt', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'timeout' })

      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      // Attempt should be incremented (was 1, now 2)
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(2)
      expect(actor.getSnapshot().context.lastError).toBe('timeout')
      actor.stop()
    })

    it('should handle TRIGGER_RECONNECT by skipping wait', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      actor.stop()
    })

    it('should handle WAKE while waiting by skipping to attempting', () => {
      actor.send({ type: 'WAKE', sleepDurationMs: 5000 })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      actor.stop()
    })

    it('should reset backoff counter on WAKE while waiting', () => {
      // Build up backoff: attempt 1 → fail → attempt 2 → fail → attempt 3
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(2)

      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(4000)

      // WAKE should reset backoff so next failure starts at attempt 1
      actor.send({ type: 'WAKE', sleepDurationMs: 5000 })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)

      // Failure after WAKE-reset should use attempt 1 delay (1s)
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(INITIAL_RECONNECT_DELAY)
      actor.stop()
    })

    it('should transition to waiting on WAKE during active attempt (abort stale attempt)', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)

      // Start an attempt and send WAKE during it
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      actor.send({ type: 'WAKE', sleepDurationMs: 5000 })
      // WAKE transitions to waiting (with nextRetryDelayMs=0, so the after
      // timer fires immediately back to attempting for a fresh attempt)
      // Counter is reset so backoff starts fresh
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(0)
      actor.stop()
    })

    it('should mark SM resume not viable on WAKE with long sleep during active attempt', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)

      // WAKE with sleep exceeding SM timeout
      actor.send({ type: 'WAKE', sleepDurationMs: SM_SESSION_TIMEOUT_MS + 1000 })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      actor.stop()
    })

    it('should handle CONNECTION_SUCCESS in waiting state (stale attempt succeeds)', () => {
      // WAKE during attempting moves to waiting
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'WAKE', sleepDurationMs: 5000 })

      // The stale attempt's connection may succeed while in waiting
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      actor.stop()
    })

    it('should mark SM resume not viable on WAKE with long sleep while waiting', () => {
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)

      // WAKE with sleep exceeding SM timeout while waiting
      actor.send({ type: 'WAKE', sleepDurationMs: SM_SESSION_TIMEOUT_MS + 1000 })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      actor.stop()
    })

    it('should ignore TRIGGER_RECONNECT during active attempt', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      const attemptBefore = actor.getSnapshot().context.reconnectAttempt

      // Sending TRIGGER_RECONNECT while already attempting should be a no-op
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(attemptBefore)
      actor.stop()
    })

    it('should handle VISIBLE while waiting by skipping to attempting', () => {
      actor.send({ type: 'VISIBLE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      actor.stop()
    })

    it('should handle SOCKET_DIED during attempting (canReconnect)', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(2)
      actor.stop()
    })

    it('should keep retrying and cap attempt growth on repeated SOCKET_DIED failures', () => {
      // We start at attempt 1 from beforeEach (SOCKET_DIED from connected)
      for (let i = 0; i < 30; i++) {
        actor.send({ type: 'TRIGGER_RECONNECT' })
        actor.send({ type: 'SOCKET_DIED' })
      }

      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(MAX_RECONNECT_DELAY)
      actor.stop()
    })
  })

  describe('exponential backoff', () => {
    it('should double the delay with each attempt', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })

      // Attempt 1: 1000ms
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(1000)

      // Fail and check attempt 2: 2000ms
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(2000)

      // Fail and check attempt 3: 4000ms
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(4000)

      // Fail and check attempt 4: 8000ms
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(8000)

      actor.stop()
    })

    it('should cap delay at MAX_RECONNECT_DELAY', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })

      // Run through enough attempts to exceed the cap
      for (let i = 0; i < 9; i++) {
        actor.send({ type: 'TRIGGER_RECONNECT' })
        actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      }

      // At this point delay should be capped
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBeLessThanOrEqual(MAX_RECONNECT_DELAY)
      actor.stop()
    })

    it('should set reconnectTargetTime as absolute timestamp', () => {
      const before = Date.now()
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })

      // Attempt 1: delay=1000ms → targetTime ≈ now + 1000
      const target1 = actor.getSnapshot().context.reconnectTargetTime!
      expect(target1).toBeGreaterThanOrEqual(before + INITIAL_RECONNECT_DELAY)

      // Fail: attempt 2: delay=2000ms → targetTime ≈ now + 2000
      const beforeAttempt2 = Date.now()
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      const target2 = actor.getSnapshot().context.reconnectTargetTime!
      expect(target2).toBeGreaterThanOrEqual(beforeAttempt2 + 2000)

      actor.stop()
    })
  })

  describe('terminal states', () => {
    describe('resource conflict', () => {
      it('should transition from connected to terminal.conflict', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })

        actor.send({ type: 'CONFLICT' })
        expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
        expect(actor.getSnapshot().context.lastError).toBe('Session replaced by another client')
        actor.stop()
      })

      it('should transition from reconnecting.waiting to terminal.conflict', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'SOCKET_DIED' })
        expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

        actor.send({ type: 'CONFLICT' })
        expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
        // Should reset reconnect state when going terminal from reconnecting
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
        actor.stop()
      })

      it('should transition from reconnecting.attempting to terminal.conflict', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'SOCKET_DIED' })
        actor.send({ type: 'TRIGGER_RECONNECT' })
        expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

        actor.send({ type: 'CONFLICT' })
        expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
        actor.stop()
      })

      it('should allow CONNECT from terminal.conflict', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'CONFLICT' })

        actor.send({ type: 'CONNECT' })
        expect(actor.getSnapshot().value).toBe('connecting')
        actor.stop()
      })
    })

    describe('authentication error', () => {
      it('should transition from connected to terminal.authFailed', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })

        actor.send({ type: 'AUTH_ERROR' })
        expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
        expect(actor.getSnapshot().context.lastError).toBe('Authentication failed')
        actor.stop()
      })

      it('should transition from reconnecting.waiting to terminal.authFailed', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'SOCKET_DIED' })
        expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

        actor.send({ type: 'AUTH_ERROR' })
        expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
        expect(actor.getSnapshot().context.lastError).toBe('Authentication failed')
        actor.stop()
      })

      it('should transition from reconnecting.attempting to terminal.authFailed', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'SOCKET_DIED' })
        actor.send({ type: 'TRIGGER_RECONNECT' })
        expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

        actor.send({ type: 'AUTH_ERROR' })
        expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
        actor.stop()
      })

      it('should allow CONNECT from terminal.authFailed', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'AUTH_ERROR' })
        expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })

        actor.send({ type: 'CONNECT' })
        expect(actor.getSnapshot().value).toBe('connecting')
        expect(actor.getSnapshot().context.lastError).toBeNull()
        actor.stop()
      })
    })

    describe('capped backoff retries', () => {
      it('should keep retrying after many failures and cap delay growth', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'SOCKET_DIED' })

        for (let i = 0; i < 30; i++) {
          actor.send({ type: 'TRIGGER_RECONNECT' })
          actor.send({ type: 'CONNECTION_ERROR', error: `fail ${i + 1}` })
        }

        expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS)
        expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(MAX_RECONNECT_DELAY)
        expect(actor.getSnapshot().context.lastError).toBe('fail 30')
        actor.stop()
      })

      it('should allow successful recovery after long failure streak', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        actor.send({ type: 'SOCKET_DIED' })

        for (let i = 0; i < 20; i++) {
          actor.send({ type: 'TRIGGER_RECONNECT' })
          actor.send({ type: 'CONNECTION_ERROR', error: `fail` })
        }

        expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS)

        actor.send({ type: 'TRIGGER_RECONNECT' })
        actor.send({ type: 'CONNECTION_SUCCESS' })
        expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
        expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
        actor.stop()
      })
    })

    describe('initial failure', () => {
      it('should transition to terminal.initialFailure on first connect error', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_ERROR', error: 'Server unreachable' })

        expect(actor.getSnapshot().value).toEqual({ terminal: 'initialFailure' })
        expect(actor.getSnapshot().context.lastError).toBe('Server unreachable')
        actor.stop()
      })

      it('should allow CONNECT from terminal.initialFailure', () => {
        const actor = createActor(connectionMachine).start()
        actor.send({ type: 'CONNECT' })
        actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })

        actor.send({ type: 'CONNECT' })
        expect(actor.getSnapshot().value).toBe('connecting')
        expect(actor.getSnapshot().context.lastError).toBeNull()
        actor.stop()
      })
    })
  })

  describe('cancel reconnect', () => {
    it('should transition from reconnecting.waiting to disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      actor.send({ type: 'CANCEL_RECONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      actor.stop()
    })

    it('should transition from reconnecting.attempting to disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

      actor.send({ type: 'CANCEL_RECONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      actor.stop()
    })
  })

  describe('event ignoring (impossible transitions)', () => {
    it('should ignore SOCKET_DIED in idle', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toBe('idle')
      actor.stop()
    })

    it('should ignore CONNECTION_SUCCESS in idle', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toBe('idle')
      actor.stop()
    })

    it('should ignore VERIFY_SUCCESS in connected.healthy', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'VERIFY_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      actor.stop()
    })

    it('should ignore DISCONNECT in idle', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('idle')
      actor.stop()
    })

    it('should ignore WAKE in idle', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'WAKE' })
      expect(actor.getSnapshot().value).toBe('idle')
      actor.stop()
    })

    it('should ignore VISIBLE in connected.healthy (no action needed)', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'VISIBLE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      actor.stop()
    })

    it('should ignore CONFLICT in disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      actor.send({ type: 'CONFLICT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      actor.stop()
    })

    it('should ignore SOCKET_DIED in terminal', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'initialFailure' })
      actor.stop()
    })

    it('should ignore DISCONNECT in disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      actor.stop()
    })

    it('should ignore CANCEL_RECONNECT in connected.healthy', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'CANCEL_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      actor.stop()
    })

    it('should ignore TRIGGER_RECONNECT in connected.healthy', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      actor.stop()
    })

    it('should ignore CONNECTION_ERROR in connected.healthy', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'stale error' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      // Error should NOT be stored
      expect(actor.getSnapshot().context.lastError).toBeNull()
      actor.stop()
    })

    it('should ignore CONNECT in connecting', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')
      actor.stop()
    })

    it('should ignore VISIBLE in disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      actor.send({ type: 'VISIBLE' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      actor.stop()
    })

    it('should ignore WAKE in disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      actor.send({ type: 'WAKE', sleepDurationMs: 5000 })
      expect(actor.getSnapshot().value).toBe('disconnected')
      actor.stop()
    })

    it('should ignore TRIGGER_RECONNECT in terminal', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'initialFailure' })
      actor.stop()
    })
  })

  describe('VISIBLE event', () => {
    it('should trigger immediate attempt from reconnecting.waiting', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      actor.send({ type: 'VISIBLE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      actor.stop()
    })

    it('should be ignored in connected.healthy', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'VISIBLE' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      actor.stop()
    })

    it('should be ignored in reconnecting.attempting (already reconnecting)', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

      actor.send({ type: 'VISIBLE' })
      // Should stay in attempting (VISIBLE only matters in waiting)
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      actor.stop()
    })
  })

  describe('full reconnection lifecycle', () => {
    it('should handle connect → disconnect → reconnect → success', () => {
      const actor = createActor(connectionMachine).start()

      // Connect
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })

      // Socket dies
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      // Timer expires, attempt reconnect
      actor.send({ type: 'TRIGGER_RECONNECT' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

      // First attempt fails
      actor.send({ type: 'CONNECTION_ERROR', error: 'timeout' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(2)

      // Second attempt succeeds
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)

      actor.stop()
    })

    it('should handle wake → verify → fail → reconnect → success', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })

      // Wake with short sleep
      actor.send({ type: 'WAKE', sleepDurationMs: 5000 })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })

      // Verification fails
      actor.send({ type: 'VERIFY_FAILED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      // Reconnect succeeds
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })

      actor.stop()
    })

    it('should go directly from disconnected to connecting (not via idle)', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')

      // CONNECT from disconnected goes directly to connecting (skips idle)
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')
      actor.stop()
    })

    it('should clear error when reconnecting from disconnected', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      // Now has reconnect context (attempt=1, error from prior state)
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)

      // Fail the reconnect to get an error
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'network down' })
      expect(actor.getSnapshot().context.lastError).toBe('network down')

      // Cancel → disconnected (resets reconnect state via entry action + transition action)
      actor.send({ type: 'CANCEL_RECONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      expect(actor.getSnapshot().context.lastError).toBeNull()

      // CONNECT from disconnected clears error
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().context.lastError).toBeNull()
      actor.stop()
    })

    it('should reset context fully after successful reconnect from capped backoff state', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })

      // Drive many failures to hit capped backoff
      for (let i = 0; i < 25; i++) {
        actor.send({ type: 'TRIGGER_RECONNECT' })
        actor.send({ type: 'CONNECTION_ERROR', error: `fail ${i}` })
      }
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(MAX_RECONNECT_DELAY)

      // Successful reconnect resets everything
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(0)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(0)
      expect(actor.getSnapshot().context.reconnectTargetTime).toBeNull()
      expect(actor.getSnapshot().context.lastError).toBeNull()
      actor.stop()
    })

    it('should handle multiple disconnect/reconnect cycles', () => {
      const actor = createActor(connectionMachine).start()

      // Cycle 1: connect and disconnect
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')

      // Cycle 2: reconnect
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })

      // Socket dies and reconnects
      actor.send({ type: 'SOCKET_DIED' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })

      // Cycle 3: manual disconnect again
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')

      actor.stop()
    })
  })

  describe('helper functions', () => {
    describe('getConnectionStatusFromState', () => {
      it('should map idle to disconnected', () => {
        expect(getConnectionStatusFromState('idle')).toBe('disconnected')
      })

      it('should map connecting to connecting', () => {
        expect(getConnectionStatusFromState('connecting')).toBe('connecting')
      })

      it('should map connected.healthy to online', () => {
        expect(getConnectionStatusFromState({ connected: 'healthy' })).toBe('online')
      })

      it('should map connected.verifying to online (suppresses UI flicker)', () => {
        expect(getConnectionStatusFromState({ connected: 'verifying' })).toBe('online')
      })

      it('should map reconnecting.waiting to reconnecting', () => {
        expect(getConnectionStatusFromState({ reconnecting: 'waiting' })).toBe('reconnecting')
      })

      it('should map reconnecting.attempting to connecting', () => {
        expect(getConnectionStatusFromState({ reconnecting: 'attempting' })).toBe('connecting')
      })

      it('should map all terminal states to error', () => {
        expect(getConnectionStatusFromState({ terminal: 'conflict' })).toBe('error')
        expect(getConnectionStatusFromState({ terminal: 'authFailed' })).toBe('error')
        expect(getConnectionStatusFromState({ terminal: 'maxRetries' })).toBe('error')
        expect(getConnectionStatusFromState({ terminal: 'initialFailure' })).toBe('error')
      })

      it('should map disconnected to disconnected', () => {
        expect(getConnectionStatusFromState('disconnected')).toBe('disconnected')
      })
    })

    describe('isTerminalState', () => {
      it('should return true for terminal states', () => {
        expect(isTerminalState({ terminal: 'conflict' })).toBe(true)
        expect(isTerminalState({ terminal: 'authFailed' })).toBe(true)
        expect(isTerminalState({ terminal: 'maxRetries' })).toBe(true)
        expect(isTerminalState({ terminal: 'initialFailure' })).toBe(true)
      })

      it('should return false for non-terminal states', () => {
        expect(isTerminalState('idle')).toBe(false)
        expect(isTerminalState('connecting')).toBe(false)
        expect(isTerminalState({ connected: 'healthy' })).toBe(false)
        expect(isTerminalState({ reconnecting: 'waiting' })).toBe(false)
        expect(isTerminalState('disconnected')).toBe(false)
      })
    })

    describe('getReconnectInfoFromContext', () => {
      it('should return attempt and target time from context', () => {
        const targetTime = Date.now() + 4000
        const context = {
          reconnectAttempt: 3,
          maxReconnectAttempts: 10,
          nextRetryDelayMs: 4000,
          reconnectTargetTime: targetTime,
          lastError: 'some error',
          smResumeViable: true,
          sleepStartTime: null,
          retryInitialFailure: false,
        }
        const info = getReconnectInfoFromContext(context)
        expect(info.attempt).toBe(3)
        expect(info.reconnectTargetTime).toBe(targetTime)
      })

      it('should return null target time when not reconnecting', () => {
        const context = {
          reconnectAttempt: 0,
          maxReconnectAttempts: 10,
          nextRetryDelayMs: 0,
          reconnectTargetTime: null,
          lastError: null,
          smResumeViable: true,
          sleepStartTime: null,
          retryInitialFailure: false,
        }
        const info = getReconnectInfoFromContext(context)
        expect(info.attempt).toBe(0)
        expect(info.reconnectTargetTime).toBeNull()
      })
    })
  })

  describe('sleep awareness (connected.sleeping)', () => {
    let actor: ReturnType<typeof createActor<typeof connectionMachine>>

    beforeEach(() => {
      actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
    })

    it('should transition to connected.sleeping on SLEEP', () => {
      actor.send({ type: 'SLEEP' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'sleeping' })
      expect(actor.getSnapshot().context.sleepStartTime).toEqual(expect.any(Number))
      actor.stop()
    })

    it('should map connected.sleeping to online status', () => {
      expect(getConnectionStatusFromState({ connected: 'sleeping' })).toBe('online')
    })

    it('should transition to verifying on WAKE (short sleep) from sleeping', () => {
      actor.send({ type: 'SLEEP' })
      actor.send({ type: 'WAKE', sleepDurationMs: 30_000 })
      expect(actor.getSnapshot().value).toEqual({ connected: 'verifying' })
      expect(actor.getSnapshot().context.sleepStartTime).toBeNull()
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)
      actor.stop()
    })

    it('should transition to reconnecting on WAKE (long sleep) from sleeping with smResumeViable false', () => {
      actor.send({ type: 'SLEEP' })
      actor.send({ type: 'WAKE', sleepDurationMs: SM_SESSION_TIMEOUT_MS + 1000 })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      expect(actor.getSnapshot().context.sleepStartTime).toBeNull()
      actor.stop()
    })

    it('should set smResumeViable true on SOCKET_DIED from sleeping (short sleep)', () => {
      vi.useFakeTimers()
      actor.send({ type: 'SLEEP' })
      // Advance 2 minutes (short, within SM timeout)
      vi.advanceTimersByTime(2 * 60 * 1000)
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)
      expect(actor.getSnapshot().context.sleepStartTime).toBeNull()
      vi.useRealTimers()
      actor.stop()
    })

    it('should set smResumeViable false on SOCKET_DIED from sleeping (long sleep)', () => {
      vi.useFakeTimers()
      actor.send({ type: 'SLEEP' })
      // Advance 17 minutes (exceeds SM timeout)
      vi.advanceTimersByTime(17 * 60 * 1000)
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      expect(actor.getSnapshot().context.sleepStartTime).toBeNull()
      vi.useRealTimers()
      actor.stop()
    })

    it('should handle DISCONNECT from sleeping', () => {
      actor.send({ type: 'SLEEP' })
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      expect(actor.getSnapshot().context.sleepStartTime).toBeNull()
      actor.stop()
    })

    it('should handle CONFLICT from sleeping', () => {
      actor.send({ type: 'SLEEP' })
      actor.send({ type: 'CONFLICT' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
      actor.stop()
    })

    it('should reset smResumeViable on CONNECTION_SUCCESS', () => {
      // Force smResumeViable to false via long sleep → reconnect
      actor.send({ type: 'SLEEP' })
      actor.send({ type: 'WAKE', sleepDurationMs: SM_SESSION_TIMEOUT_MS + 1000 })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)

      // Reconnect succeeds
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)
      actor.stop()
    })

    it('should set smResumeViable true on normal SOCKET_DIED from healthy (not sleep-related)', () => {
      // No SLEEP event — this is a normal socket death
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)
      actor.stop()
    })

    it('should set smResumeViable false on long WAKE from healthy (no prior SLEEP event)', () => {
      // WAKE without prior SLEEP (e.g., web mode time-gap detection)
      actor.send({ type: 'WAKE', sleepDurationMs: SM_SESSION_TIMEOUT_MS + 1000 })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      actor.stop()
    })
  })

  describe('sleep/wake race conditions', () => {
    let actor: ReturnType<typeof createActor<typeof connectionMachine>>

    beforeEach(() => {
      actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
    })

    it('long sleep: stream error before wake → smResumeViable false', () => {
      vi.useFakeTimers()
      actor.send({ type: 'SLEEP' })
      // 17 minutes pass (simulates system sleep)
      vi.advanceTimersByTime(17 * 60 * 1000)
      // Stream error fires first (before wake detection)
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      vi.useRealTimers()
      actor.stop()
    })

    it('long sleep: wake arrives before stream error → smResumeViable false', () => {
      actor.send({ type: 'SLEEP' })
      // Wake detection fires first with known duration
      actor.send({ type: 'WAKE', sleepDurationMs: 17 * 60 * 1000 })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      actor.stop()
    })

    it('short sleep: stream error → smResumeViable true', () => {
      vi.useFakeTimers()
      actor.send({ type: 'SLEEP' })
      // 2 minutes pass (within SM timeout)
      vi.advanceTimersByTime(2 * 60 * 1000)
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)
      vi.useRealTimers()
      actor.stop()
    })

    it('SLEEP event is ignored when not in connected state', () => {
      // Go to reconnecting
      actor.send({ type: 'SOCKET_DIED' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      // SLEEP should be ignored (machine is not in connected state)
      actor.send({ type: 'SLEEP' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.sleepStartTime).toBeNull()
      actor.stop()
    })

    it('both outcomes converge: regardless of event order, long sleep → smResumeViable false', () => {
      // Scenario A: SOCKET_DIED first
      vi.useFakeTimers()
      actor.send({ type: 'SLEEP' })
      vi.advanceTimersByTime(15 * 60 * 1000)
      actor.send({ type: 'SOCKET_DIED' })
      const resultA = actor.getSnapshot().context.smResumeViable
      vi.useRealTimers()
      actor.stop()

      // Scenario B: WAKE first (fresh actor)
      const actor2 = createActor(connectionMachine).start()
      actor2.send({ type: 'CONNECT' })
      actor2.send({ type: 'CONNECTION_SUCCESS' })
      actor2.send({ type: 'SLEEP' })
      actor2.send({ type: 'WAKE', sleepDurationMs: 15 * 60 * 1000 })
      const resultB = actor2.getSnapshot().context.smResumeViable
      actor2.stop()

      // Both paths should agree
      expect(resultA).toBe(false)
      expect(resultB).toBe(false)
    })
  })

  describe('constants', () => {
    it('should have correct default values', () => {
      expect(INITIAL_RECONNECT_DELAY).toBe(1000)
      expect(MAX_RECONNECT_DELAY).toBe(120_000)
      expect(RECONNECT_MULTIPLIER).toBe(2)
      expect(DEFAULT_MAX_RECONNECT_ATTEMPTS).toBe(10)
      expect(SM_SESSION_TIMEOUT_MS).toBe(600_000)
    })
  })

  describe('retryInitialFailure (auto-retry transient transport errors during connecting)', () => {
    it('should default retryInitialFailure to false', () => {
      const actor = createActor(connectionMachine).start()
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(false)
      actor.stop()
    })

    it('should go to terminal.initialFailure on CONNECTION_ERROR when retryInitialFailure=false (default)', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')

      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'initialFailure' })
      expect(actor.getSnapshot().context.lastError).toBe('ECONNERROR')
      actor.stop()
    })

    it('should go to reconnecting.waiting on CONNECTION_ERROR when retryInitialFailure=true', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(true)

      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.lastError).toBe('ECONNERROR')
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(INITIAL_RECONNECT_DELAY)
      expect(actor.getSnapshot().context.reconnectTargetTime).not.toBeNull()
      actor.stop()
    })

    it('should still reach connected on a subsequent CONNECTION_SUCCESS after retry path', () => {
      vi.useFakeTimers()
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      // Advance through the backoff timer to reach attempting
      vi.advanceTimersByTime(INITIAL_RECONNECT_DELAY + 10)
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      // Flag should have been reset on successful connect
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(false)
      actor.stop()
      vi.useRealTimers()
    })

    it('should reset retryInitialFailure on DISCONNECT from the retry path', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(false)
      actor.stop()
    })

    it('should still honor AUTH_ERROR as terminal during retry path', () => {
      vi.useFakeTimers()
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      actor.send({ type: 'AUTH_ERROR' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
      actor.stop()
      vi.useRealTimers()
    })

    it('should not affect first-time login when flag is explicitly set to false', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'SET_RETRY_INITIAL', retry: false })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'bad password' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'initialFailure' })
      actor.stop()
    })

    it('should reset the flag when transitioning to connected (via resetReconnectState)', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(false)
      actor.stop()
    })

    it('should still honor CONFLICT as terminal during retry path', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })

      actor.send({ type: 'CONFLICT' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
      actor.stop()
    })

    it('should grow backoff across repeated CONNECTION_ERRORs in the retry loop', () => {
      vi.useFakeTimers()
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })

      // First failure: attempt 1, delay 1s
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(INITIAL_RECONNECT_DELAY)

      // Fire the waiting timer to reach attempting
      vi.advanceTimersByTime(INITIAL_RECONNECT_DELAY + 10)
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })

      // Second failure (in reconnecting.attempting): attempt 2, delay 2s
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(2)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(INITIAL_RECONNECT_DELAY * RECONNECT_MULTIPLIER)

      // Third failure: attempt 3, delay 4s
      vi.advanceTimersByTime(INITIAL_RECONNECT_DELAY * RECONNECT_MULTIPLIER + 10)
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(INITIAL_RECONNECT_DELAY * RECONNECT_MULTIPLIER * RECONNECT_MULTIPLIER)

      actor.stop()
      vi.useRealTimers()
    })

    it('should clear retryInitialFailure when DISCONNECT fires during connecting before any error', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(true)

      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(false)
      actor.stop()
    })

    it('should allow SET_RETRY_INITIAL from disconnected state (reconnect scenario)', () => {
      const actor = createActor(connectionMachine).start()
      // Get into disconnected state
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')

      // Set flag from disconnected
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(true)

      // CONNECT and fail — should retry
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      actor.stop()
    })

    it('should preserve retryInitialFailure when set AFTER CONNECT from terminal (Connection.ts pattern)', () => {
      // Verifies the order Connection.ts actually uses:
      //   sendMachineEvent({ CONNECT })
      //   sendMachineEvent({ SET_RETRY_INITIAL, retry: true })
      //   <later> sendMachineEvent({ CONNECTION_ERROR })
      // This is the order that survives terminal.CONNECT's resetReconnectState.
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'first' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'initialFailure' })

      // User retries with retry enabled: CONNECT first (clobbers flag via
      // resetReconnectState), then SET_RETRY_INITIAL (restores flag)
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      expect(actor.getSnapshot().value).toBe('connecting')
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(true)

      // A transient failure should now route to reconnecting
      actor.send({ type: 'CONNECTION_ERROR', error: 'ECONNERROR' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      actor.stop()
    })
  })

  describe('CONFLICT / AUTH_ERROR during connecting', () => {
    it('should go to terminal.conflict on CONFLICT during connecting (even with retry flag)', () => {
      // Without this transition, the retryInitialFailure path would infinitely
      // retry on a resource conflict: stream-error handler fires CONFLICT, it
      // was previously ignored in `connecting`, then start()'s rejection
      // triggered CONNECTION_ERROR → reconnecting.waiting → same conflict loop.
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')

      actor.send({ type: 'CONFLICT' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
      expect(actor.getSnapshot().context.lastError).toBe('Session replaced by another client')
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(false)
      actor.stop()
    })

    it('should go to terminal.authFailed on AUTH_ERROR during connecting (even with retry flag)', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      expect(actor.getSnapshot().value).toBe('connecting')

      actor.send({ type: 'AUTH_ERROR' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
      expect(actor.getSnapshot().context.lastError).toBe('Authentication failed')
      expect(actor.getSnapshot().context.retryInitialFailure).toBe(false)
      actor.stop()
    })

    it('should go to terminal.conflict on CONFLICT during connecting without retry flag', () => {
      // First-time login path: conflict during initial connect should
      // surface as conflict (not the generic terminal.initialFailure).
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONFLICT' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
      actor.stop()
    })

    it('should go to terminal.authFailed on AUTH_ERROR during connecting without retry flag', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'AUTH_ERROR' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
      actor.stop()
    })

    it('should ignore CONNECTION_ERROR after CONFLICT already transitioned to terminal', () => {
      // Simulates the real flow: stream-error handler fires CONFLICT
      // synchronously, then start()'s rejection triggers CONNECTION_ERROR.
      // CONNECTION_ERROR should be a no-op because we're already terminal.
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONFLICT' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })

      actor.send({ type: 'CONNECTION_ERROR', error: 'transport error' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'conflict' })
      actor.stop()
    })

    it('should ignore CONNECTION_ERROR after AUTH_ERROR already transitioned to terminal', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'SET_RETRY_INITIAL', retry: true })
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'AUTH_ERROR' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })

      actor.send({ type: 'CONNECTION_ERROR', error: 'transport error' })
      expect(actor.getSnapshot().value).toEqual({ terminal: 'authFailed' })
      actor.stop()
    })
  })
})
