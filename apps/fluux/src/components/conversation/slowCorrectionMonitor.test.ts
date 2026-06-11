import { describe, it, expect } from 'vitest'
import { createSlowCorrectionMonitor } from './slowCorrectionMonitor'

describe('slowCorrectionMonitor', () => {
  it('stays silent for corrections under the threshold', () => {
    const monitor = createSlowCorrectionMonitor({ thresholdMs: 32, cooldownMs: 5000 })
    expect(monitor.record(0, 1000)).toBe(false)
    expect(monitor.record(31, 2000)).toBe(false)
  })

  it('reports a correction at or above the threshold', () => {
    const monitor = createSlowCorrectionMonitor({ thresholdMs: 32, cooldownMs: 5000 })
    expect(monitor.record(32, 1000)).toBe(true)
  })

  it('rate-limits reports within the cooldown window', () => {
    const monitor = createSlowCorrectionMonitor({ thresholdMs: 32, cooldownMs: 5000 })
    expect(monitor.record(100, 1000)).toBe(true)
    expect(monitor.record(100, 2000)).toBe(false) // within cooldown
    expect(monitor.record(100, 6001)).toBe(true) // cooldown elapsed
  })

  it('uses defaults when no options given', () => {
    const monitor = createSlowCorrectionMonitor()
    expect(monitor.record(31, 0)).toBe(false)
    expect(monitor.record(33, 0)).toBe(true)
  })
})
