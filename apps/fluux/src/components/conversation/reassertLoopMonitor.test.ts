import { describe, it, expect } from 'vitest'
import { createReassertLoopMonitor } from './reassertLoopMonitor'

/**
 * Pure, deterministic tests — timestamps are passed in explicitly so there is
 * no dependency on Date.now()/performance.now().
 */
describe('createReassertLoopMonitor', () => {
  it('stays silent for a single converged loop that writes only a few times', () => {
    const m = createReassertLoopMonitor({ writeThreshold: 40 })
    const loop = m.begin('prepend', 0)
    let last: string | null = 'x'
    // 60 frames, scroll write only on the first 3 (then converged/idle).
    for (let f = 0; f < 60; f++) last = loop.frame(f * 16, f < 3)
    loop.end()
    expect(last).toBeNull()
  })

  it('warns once when a single loop keeps writing past the threshold (non-converging)', () => {
    const m = createReassertLoopMonitor({ writeThreshold: 10, cooldownMs: 5000 })
    const loop = m.begin('prepend', 0)
    const out: (string | null)[] = []
    // Writes on EVERY frame — the signature of a loop that never settles.
    for (let f = 0; f < 30; f++) out.push(loop.frame(f * 16, true))
    const warnings = out.filter((r): r is string => r !== null)
    expect(warnings).toHaveLength(1) // cooldown outlasts the ~480ms span
    expect(warnings[0]).toMatch(/prepend/)
    expect(warnings[0]).toMatch(/reassert/i)
  })

  it('warns when two re-assert loops run concurrently (overlap), naming both', () => {
    const m = createReassertLoopMonitor()
    const a = m.begin('prepend', 0)
    a.frame(16, false) // active = 1, no overlap
    const b = m.begin('prepend', 20) // a second prepend before the first finished
    const w = b.frame(32, false)
    expect(w).not.toBeNull()
    expect(w).toMatch(/overlap/i)
    // Both concurrent labels are surfaced so the log identifies the pair.
    expect(w).toMatch(/prepend.*prepend|prepend x2|2 .*prepend/i)
  })

  it('does not warn for loops that run sequentially (no temporal overlap)', () => {
    const m = createReassertLoopMonitor()
    const a = m.begin('pin-bottom', 0)
    a.frame(16, false)
    a.end()
    const b = m.begin('marker', 32)
    const w = b.frame(48, false)
    expect(w).toBeNull()
  })

  it('rate-limits overlap warnings to one per cooldown during sustained overlap', () => {
    const m = createReassertLoopMonitor({ cooldownMs: 5000 })
    const a = m.begin('prepend', 0)
    const b = m.begin('marker', 0)
    const out: (string | null)[] = []
    for (let f = 0; f < 40; f++) {
      // Collect from BOTH loops — the single allowed warning may land on either,
      // since they share the monitor-wide overlap cooldown.
      out.push(a.frame(f * 16, false))
      out.push(b.frame(f * 16, false))
    }
    const warnings = out.filter((r): r is string => r !== null)
    expect(warnings).toHaveLength(1) // 40 frames ≈ 640ms < 5000ms cooldown
  })

  it('tracks active labels across begin/end', () => {
    const m = createReassertLoopMonitor()
    expect(m.activeLabels()).toEqual([])
    const a = m.begin('prepend', 0)
    expect(m.activeLabels()).toEqual(['prepend'])
    const b = m.begin('pin-bottom', 0)
    expect(m.activeLabels().sort()).toEqual(['pin-bottom', 'prepend'])
    a.end()
    expect(m.activeLabels()).toEqual(['pin-bottom'])
    b.end()
    expect(m.activeLabels()).toEqual([])
  })

  it('end() is idempotent and does not drop a different concurrent loop', () => {
    const m = createReassertLoopMonitor()
    const a = m.begin('prepend', 0)
    const b = m.begin('prepend', 0)
    a.end()
    a.end() // double end must not remove b
    expect(m.activeLabels()).toEqual(['prepend'])
    b.end()
    expect(m.activeLabels()).toEqual([])
  })
})
