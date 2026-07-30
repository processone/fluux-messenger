import { describe, it, expect } from 'vitest'
import {
  createResizeLoopMonitor,
  resizeLoopSignal,
  type ResizeLoopWarning,
} from './resizeLoopMonitor'

/**
 * Pure, deterministic tests — timestamps are passed in explicitly so there is
 * no dependency on Date.now()/performance.now().
 */
describe('createResizeLoopMonitor', () => {
  it('stays silent while the fire rate is at or under the threshold', () => {
    const m = createResizeLoopMonitor({ threshold: 5, windowMs: 1000, cooldownMs: 5000 })
    let last: ResizeLoopWarning | null = null
    for (let i = 0; i < 5; i++) last = m.record(i * 100) // 5 fires across 400ms
    expect(last).toBeNull()
  })

  it('warns once when fires exceed the threshold inside the window', () => {
    const m = createResizeLoopMonitor({ threshold: 5, windowMs: 1000, cooldownMs: 5000 })
    const out: (ResizeLoopWarning | null)[] = []
    for (let i = 0; i < 9; i++) out.push(m.record(i * 40)) // 9 fires in 320ms
    const warnings = out.filter((r): r is ResizeLoopWarning => r !== null)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/resize/i)
  })

  it('rate-limits to one warning per cooldown during a sustained runaway', () => {
    const m = createResizeLoopMonitor({ threshold: 3, windowMs: 1000, cooldownMs: 5000 })
    const out: (ResizeLoopWarning | null)[] = []
    for (let i = 0; i < 40; i++) out.push(m.record(i * 50)) // 40 fires over 1950ms
    const warnings = out.filter((r): r is ResizeLoopWarning => r !== null)
    expect(warnings).toHaveLength(1) // cooldown (5000ms) outlasts the 1950ms span
  })

  it('does not warn for normal bursts spread across separate windows', () => {
    const m = createResizeLoopMonitor({ threshold: 10, windowMs: 1000, cooldownMs: 5000 })
    let last: ResizeLoopWarning | null = null
    for (let s = 0; s < 6; s++) {
      for (let k = 0; k < 3; k++) last = m.record(s * 1000 + k * 120) // 3 fires/sec
    }
    expect(last).toBeNull()
  })

  it('reports the numbers the prose quotes, so the fan-out need not re-parse it', () => {
    // The structured fields and the message are two views of one observation; if
    // they can disagree, the anomaly log and fluux.log describe different events.
    const m = createResizeLoopMonitor({ threshold: 5, windowMs: 1000, cooldownMs: 5000 })
    let warning: ResizeLoopWarning | null = null
    for (let i = 0; i < 9 && !warning; i++) warning = m.record(i * 40)

    expect(warning).not.toBeNull()
    expect(warning!.threshold).toBe(5)
    expect(warning!.fires).toBe(6) // the fire that first crossed the threshold
    expect(warning!.elapsedMs).toBe(200) // 6th fire at t=200, window opened at t=0
    expect(warning!.message).toContain(`fired ${warning!.fires} times`)
    expect(warning!.message).toContain(`in ${warning!.elapsedMs}ms`)
    expect(warning!.message).toContain(`threshold ${warning!.threshold}/1000ms`)
  })
})

describe('resizeLoopSignal', () => {
  it('carries the warning through without reordering the numbers', () => {
    // `fires`, `threshold` and `elapsedMs` are all plain numbers, so a swapped
    // pair typechecks and would silently invert what the anomaly log reports.
    expect(
      resizeLoopSignal({ message: 'ignored', fires: 340, threshold: 60, elapsedMs: 980 }),
    ).toEqual({
      name: 'scroll/resize-loop',
      fires: 340,
      threshold: 60,
      elapsedMs: 980,
    })
  })

  it('does not carry the prose into the record', () => {
    // The message is for fluux.log. Everything in a signal reaches the anomaly
    // record, where a free string has no admissible position.
    const signal = resizeLoopSignal({
      message: '[ScrollResizeLoop] anything at all',
      fires: 340,
      threshold: 60,
      elapsedMs: 980,
    })
    expect(JSON.stringify(signal)).not.toContain('ScrollResizeLoop')
  })
})
