import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  clearAnomalySignalHandler,
  hasAnomalySignalHandler,
  setAnomalySignalHandler,
  signalAnomaly,
  type AnomalySignal,
} from './anomalySignal'

const STALL: AnomalySignal = {
  name: 'perf/main-thread-stall',
  blockedMs: 2500,
  thresholdMs: 1000,
}

describe('anomalySignal', () => {
  beforeEach(() => {
    clearAnomalySignalHandler()
  })

  afterEach(() => {
    clearAnomalySignalHandler()
    vi.restoreAllMocks()
  })

  it('is a no-op with nothing registered', () => {
    // The release-build state. Sentinels signal unconditionally at their call
    // sites once the gate is on; with no runtime attached this must be inert.
    expect(hasAnomalySignalHandler()).toBe(false)
    expect(() => signalAnomaly(STALL)).not.toThrow()
  })

  it('delivers the signal verbatim to a registered handler', () => {
    const seen: AnomalySignal[] = []
    setAnomalySignalHandler((s) => seen.push(s))

    signalAnomaly(STALL)

    expect(seen).toEqual([STALL])
  })

  it('stops delivering once cleared', () => {
    const handler = vi.fn()
    setAnomalySignalHandler(handler)
    signalAnomaly(STALL)
    clearAnomalySignalHandler()
    signalAnomaly(STALL)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('replaces the handler rather than stacking them', () => {
    // A StrictMode remount re-registers. Stacking would double every record and
    // the per-id cooldown would turn the duplicate into a phantom suppression
    // rather than a visible fault.
    const first = vi.fn()
    const second = vi.fn()
    setAnomalySignalHandler(first)
    setAnomalySignalHandler(second)

    signalAnomaly(STALL)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('contains a throwing handler instead of taking down the caller', () => {
    // The callers are a rAF scroll loop and a heartbeat interval. A detector bug
    // must never break the scrolling it was watching.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setAnomalySignalHandler(() => {
      throw new Error('detector bug')
    })

    expect(() => signalAnomaly(STALL)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signal handler threw'))
  })

  it('keeps routing after a handler throws', () => {
    // Control for the case above: containment must not silently disconnect the
    // seam, or one bad signal would end recording for the rest of the session.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    setAnomalySignalHandler(() => {
      calls++
      if (calls === 1) throw new Error('detector bug')
    })

    signalAnomaly(STALL)
    signalAnomaly(STALL)

    expect(calls).toBe(2)
  })
})
