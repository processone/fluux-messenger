// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isMemoryProbeEnabled, usedHeapMB, buildMemoryProbeLine, startMemoryProbe } from './memoryProbe'

describe('memoryProbe', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('isMemoryProbeEnabled', () => {
    it('is false by default', () => {
      expect(isMemoryProbeEnabled()).toBe(false)
    })
    it('is true only when the flag is exactly "1"', () => {
      localStorage.setItem('fluux:mem-probe', '1')
      expect(isMemoryProbeEnabled()).toBe(true)
    })
    it('is false for any other flag value', () => {
      localStorage.setItem('fluux:mem-probe', 'true')
      expect(isMemoryProbeEnabled()).toBe(false)
    })
  })

  describe('buildMemoryProbeLine', () => {
    it('formats pool size, heap, and resume count', () => {
      expect(buildMemoryProbeLine(42, 128, 7)).toBe(
        '[MemProbe] avatarBlobPool=42 usedHeap=128MB smResumes=7'
      )
    })
    it('renders heap as n/a when unavailable (WebKit has no performance.memory)', () => {
      expect(buildMemoryProbeLine(42, null, 7)).toBe(
        '[MemProbe] avatarBlobPool=42 usedHeap=n/a smResumes=7'
      )
    })
  })

  describe('usedHeapMB', () => {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } }
    afterEach(() => {
      delete perf.memory
    })
    it('returns null when performance.memory is unavailable', () => {
      delete perf.memory
      expect(usedHeapMB()).toBeNull()
    })
    it('returns megabytes when performance.memory is present', () => {
      perf.memory = { usedJSHeapSize: 5 * 1048576 }
      expect(usedHeapMB()).toBe(5)
    })
  })

  describe('startMemoryProbe', () => {
    afterEach(() => {
      vi.useRealTimers()
    })
    it('is a no-op when disabled (no sampling, stop is safe to call)', () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const stop = startMemoryProbe()
      expect(info).not.toHaveBeenCalled()
      expect(() => stop()).not.toThrow()
      info.mockRestore()
    })
    it('samples immediately and every 30s when enabled, until stopped', () => {
      localStorage.setItem('fluux:mem-probe', '1')
      vi.useFakeTimers()
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})

      const stop = startMemoryProbe()
      expect(info).toHaveBeenCalledTimes(1) // immediate first sample

      vi.advanceTimersByTime(30_000)
      expect(info).toHaveBeenCalledTimes(2)

      stop()
      vi.advanceTimersByTime(90_000)
      expect(info).toHaveBeenCalledTimes(2) // no further samples after stop

      info.mockRestore()
    })
  })
})
