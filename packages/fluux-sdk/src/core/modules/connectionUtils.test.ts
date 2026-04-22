import { describe, it, expect, vi } from 'vitest'
import {
  withTimeout,
  forceDestroyClient,
  isDeadSocketError,
  computeNetworkSettleMs,
  computePostWakeSettleMs,
  didTimerSleepThrough,
  CLIENT_STOP_TIMEOUT_MS,
  RECONNECT_ATTEMPT_TIMEOUT_MS,
} from './connectionUtils'

describe('connectionUtils', () => {
  describe('withTimeout', () => {
    it('should resolve with the promise value when it resolves before timeout', async () => {
      const result = await withTimeout(Promise.resolve('done'), 1000)
      expect(result).toBe('done')
    })

    it('should resolve with void when the timeout fires first', async () => {
      vi.useFakeTimers()
      const slow = new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 5000))
      const race = withTimeout(slow, 100)
      vi.advanceTimersByTime(100)
      const result = await race
      expect(result).toBeUndefined()
      vi.useRealTimers()
    })

    it('should propagate rejection if the promise rejects before timeout', async () => {
      await expect(withTimeout(Promise.reject(new Error('fail')), 1000)).rejects.toThrow('fail')
    })
  })

  describe('isDeadSocketError', () => {
    it.each([
      'socket.write is not a function',
      "null is not an object (evaluating 'socket.send')",
      'Cannot read properties of null (reading send)',
      'socket is null',
      'Socket not available',
      'WebSocket is not open: readyState 3',
    ])('should return true for "%s"', (msg) => {
      expect(isDeadSocketError(msg)).toBe(true)
    })

    it('should return false for unrelated errors', () => {
      expect(isDeadSocketError('Connection refused')).toBe(false)
      expect(isDeadSocketError('timeout')).toBe(false)
      expect(isDeadSocketError('ECONNRESET')).toBe(false)
    })
  })

  describe('forceDestroyClient', () => {
    it('should remove all listeners and close socket via end()', () => {
      const endFn = vi.fn()
      const client = {
        removeAllListeners: vi.fn(),
        socket: { end: endFn },
      }
      forceDestroyClient(client)
      expect(client.removeAllListeners).toHaveBeenCalled()
      expect(endFn).toHaveBeenCalled()
    })

    it('should fall back to native WebSocket close()', () => {
      const closeFn = vi.fn()
      const client = {
        removeAllListeners: vi.fn(),
        socket: { socket: { close: closeFn } },
      }
      forceDestroyClient(client)
      expect(client.removeAllListeners).toHaveBeenCalled()
      expect(closeFn).toHaveBeenCalled()
    })

    it('should handle null socket gracefully', () => {
      const client = {
        removeAllListeners: vi.fn(),
        socket: null,
      }
      expect(() => forceDestroyClient(client)).not.toThrow()
      expect(client.removeAllListeners).toHaveBeenCalled()
    })

    it('should handle missing removeAllListeners gracefully', () => {
      const endFn = vi.fn()
      const client = { socket: { end: endFn } }
      expect(() => forceDestroyClient(client)).not.toThrow()
      expect(endFn).toHaveBeenCalled()
    })

    it('should handle end() throwing gracefully', () => {
      const client = {
        removeAllListeners: vi.fn(),
        socket: {
          end: () => { throw new Error('already closed') },
        },
      }
      expect(() => forceDestroyClient(client)).not.toThrow()
    })

    it('should handle removeAllListeners throwing gracefully', () => {
      const endFn = vi.fn()
      const client = {
        removeAllListeners: () => { throw new Error('broken') },
        socket: { end: endFn },
      }
      expect(() => forceDestroyClient(client)).not.toThrow()
      expect(endFn).toHaveBeenCalled()
    })
  })

  describe('computePostWakeSettleMs', () => {
    it('returns 0 when no wake has been recorded', () => {
      expect(computePostWakeSettleMs(0, 100_000, 2_000)).toBe(0)
    })

    it('returns 0 when the wake happened long before the settle window', () => {
      expect(computePostWakeSettleMs(1_000, 100_000, 2_000)).toBe(0)
    })

    it('returns the remaining delay when wake is mid-window', () => {
      expect(computePostWakeSettleMs(100_000, 100_500, 2_000)).toBe(1_500)
    })

    it('returns the full delay when the wake just happened', () => {
      expect(computePostWakeSettleMs(100_000, 100_000, 2_000)).toBe(2_000)
    })

    it('returns 0 once past the upper slack bound', () => {
      expect(computePostWakeSettleMs(100_000, 103_000, 2_000)).toBe(0)
    })
  })

  describe('computeNetworkSettleMs', () => {
    it('returns the default 2000ms when no sleep duration is known', () => {
      // Undefined comes through for wake sources that don't report a
      // duration (e.g. a heartbeat without a prior system-will-sleep).
      expect(computeNetworkSettleMs(undefined)).toBe(2_000)
    })

    it('returns 0 for sub-threshold sleeps that are really just throttling', () => {
      expect(computeNetworkSettleMs(0)).toBe(0)
      expect(computeNetworkSettleMs(5_000)).toBe(0)
      expect(computeNetworkSettleMs(29_999)).toBe(0)
    })

    it('returns 500ms for short sleeps (30s–3min)', () => {
      expect(computeNetworkSettleMs(30_000)).toBe(500)
      expect(computeNetworkSettleMs(120_000)).toBe(500)
      expect(computeNetworkSettleMs(179_999)).toBe(500)
    })

    it('returns 1500ms for medium sleeps (3min–15min)', () => {
      expect(computeNetworkSettleMs(180_000)).toBe(1_500)
      expect(computeNetworkSettleMs(600_000)).toBe(1_500)
      expect(computeNetworkSettleMs(899_999)).toBe(1_500)
    })

    it('returns 3000ms for long sleeps (>= 15min, capped)', () => {
      expect(computeNetworkSettleMs(900_000)).toBe(3_000)
      expect(computeNetworkSettleMs(3_600_000)).toBe(3_000)
      expect(computeNetworkSettleMs(8 * 60 * 60 * 1000)).toBe(3_000)
    })
  })

  describe('didTimerSleepThrough', () => {
    it('returns false when the timer fires near the scheduled delay', () => {
      expect(didTimerSleepThrough(30_000, 30_000)).toBe(false)
      expect(didTimerSleepThrough(40_000, 30_000)).toBe(false)
    })

    it('returns true when elapsed clearly exceeds 1.5x the scheduled delay', () => {
      expect(didTimerSleepThrough(46_000, 30_000)).toBe(true)
      expect(didTimerSleepThrough(1_059_000, 30_000)).toBe(true)
    })
  })

  describe('constants', () => {
    it('should export expected timeout values', () => {
      expect(CLIENT_STOP_TIMEOUT_MS).toBe(2000)
      expect(RECONNECT_ATTEMPT_TIMEOUT_MS).toBe(30_000)
    })
  })
})
