import { describe, it, expect, vi } from 'vitest'
import {
  withTimeout,
  isDeadSocketError,
  CLIENT_STOP_TIMEOUT_MS,
  RECONNECT_ATTEMPT_TIMEOUT_MS,
  PROXY_RESTART_TIMEOUT_MS,
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

  describe('constants', () => {
    it('should export expected timeout values', () => {
      expect(CLIENT_STOP_TIMEOUT_MS).toBe(2000)
      expect(RECONNECT_ATTEMPT_TIMEOUT_MS).toBe(30_000)
      expect(PROXY_RESTART_TIMEOUT_MS).toBe(10_000)
    })
  })
})
