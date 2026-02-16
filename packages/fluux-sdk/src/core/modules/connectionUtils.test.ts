import { describe, it, expect, vi } from 'vitest'
import {
  withTimeout,
  forceDestroyClient,
  isDeadSocketError,
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

  describe('constants', () => {
    it('should export expected timeout values', () => {
      expect(CLIENT_STOP_TIMEOUT_MS).toBe(2000)
      expect(RECONNECT_ATTEMPT_TIMEOUT_MS).toBe(30_000)
    })
  })
})
