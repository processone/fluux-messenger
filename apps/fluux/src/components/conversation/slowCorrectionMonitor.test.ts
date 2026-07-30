import { describe, it, expect } from 'vitest'
import { createSlowCorrectionMonitor, slowCorrectionSignal } from './slowCorrectionMonitor'

describe('slowCorrectionMonitor', () => {
  it('stays silent for corrections under the threshold', () => {
    const monitor = createSlowCorrectionMonitor({ thresholdMs: 32, cooldownMs: 5000 })
    expect(monitor.record(0, 1000)).toBeNull()
    expect(monitor.record(31, 2000)).toBeNull()
  })

  it('reports a correction at or above the threshold', () => {
    const monitor = createSlowCorrectionMonitor({ thresholdMs: 32, cooldownMs: 5000 })
    expect(monitor.record(32, 1000)).not.toBeNull()
  })

  it('rate-limits reports within the cooldown window', () => {
    const monitor = createSlowCorrectionMonitor({ thresholdMs: 32, cooldownMs: 5000 })
    expect(monitor.record(100, 1000)).not.toBeNull()
    expect(monitor.record(100, 2000)).toBeNull() // within cooldown
    expect(monitor.record(100, 6001)).not.toBeNull() // cooldown elapsed
  })

  it('uses defaults when no options given', () => {
    const monitor = createSlowCorrectionMonitor()
    expect(monitor.record(31, 0)).toBeNull()
    expect(monitor.record(33, 0)).not.toBeNull()
  })

  it('reports the threshold it actually applied, not the default', () => {
    // The caller cannot know an overridden threshold, and the anomaly record's
    // `expected` is exactly that number. Hardcoding the default at the call site
    // would silently misreport every configured monitor.
    const monitor = createSlowCorrectionMonitor({ thresholdMs: 80, cooldownMs: 5000 })
    expect(monitor.record(100, 1000)?.thresholdMs).toBe(80)

    const defaulted = createSlowCorrectionMonitor()
    expect(defaulted.record(100, 1000)?.thresholdMs).toBe(32)
  })
})

describe('slowCorrectionSignal', () => {
  it('combines the monitor threshold with the caller measurements', () => {
    // Duration and rows are the caller's; the threshold is the monitor's. A
    // signal built with two of the three swapped still typechecks.
    expect(slowCorrectionSignal({ thresholdMs: 32 }, 210, 1840)).toEqual({
      name: 'scroll/slow-correction',
      durationMs: 210,
      thresholdMs: 32,
      rows: 1840,
    })
  })

  it('reports the observed duration, not the threshold that let it through', () => {
    // Control: a mapping that reported thresholdMs for both would pass the shape
    // check above if the two happened to match.
    const signal = slowCorrectionSignal({ thresholdMs: 32 }, 210, 1840)
    expect(signal).toMatchObject({ durationMs: 210, thresholdMs: 32 })
    expect(signal.name).toBe('scroll/slow-correction')
  })
})
