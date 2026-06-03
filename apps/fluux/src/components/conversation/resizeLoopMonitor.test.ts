import { describe, it, expect } from 'vitest'
import { createResizeLoopMonitor } from './resizeLoopMonitor'

/**
 * Pure, deterministic tests — timestamps are passed in explicitly so there is
 * no dependency on Date.now()/performance.now().
 */
describe('createResizeLoopMonitor', () => {
  it('stays silent while the fire rate is at or under the threshold', () => {
    const m = createResizeLoopMonitor({ threshold: 5, windowMs: 1000, cooldownMs: 5000 })
    let last: string | null = 'x'
    for (let i = 0; i < 5; i++) last = m.record(i * 100) // 5 fires across 400ms
    expect(last).toBeNull()
  })

  it('warns once when fires exceed the threshold inside the window', () => {
    const m = createResizeLoopMonitor({ threshold: 5, windowMs: 1000, cooldownMs: 5000 })
    const out: (string | null)[] = []
    for (let i = 0; i < 9; i++) out.push(m.record(i * 40)) // 9 fires in 320ms
    const warnings = out.filter((r): r is string => r !== null)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/resize/i)
  })

  it('rate-limits to one warning per cooldown during a sustained runaway', () => {
    const m = createResizeLoopMonitor({ threshold: 3, windowMs: 1000, cooldownMs: 5000 })
    const out: (string | null)[] = []
    for (let i = 0; i < 40; i++) out.push(m.record(i * 50)) // 40 fires over 1950ms
    const warnings = out.filter((r): r is string => r !== null)
    expect(warnings).toHaveLength(1) // cooldown (5000ms) outlasts the 1950ms span
  })

  it('does not warn for normal bursts spread across separate windows', () => {
    const m = createResizeLoopMonitor({ threshold: 10, windowMs: 1000, cooldownMs: 5000 })
    let last: string | null = 'x'
    for (let s = 0; s < 6; s++) {
      for (let k = 0; k < 3; k++) last = m.record(s * 1000 + k * 120) // 3 fires/sec
    }
    expect(last).toBeNull()
  })
})
