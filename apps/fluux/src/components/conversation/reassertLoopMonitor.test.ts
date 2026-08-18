import { describe, it, expect } from 'vitest'
import {
  createReassertLoopMonitor,
  reassertLoopSignal,
  type ReassertLoopWarning,
} from './reassertLoopMonitor'

/**
 * Pure, deterministic tests — timestamps are passed in explicitly so there is
 * no dependency on Date.now()/performance.now().
 */
describe('createReassertLoopMonitor', () => {
  it('stays silent for a single converged loop that writes only a few times', () => {
    const m = createReassertLoopMonitor({ writeThreshold: 40 })
    const loop = m.begin('prepend', 0)
    let last: ReassertLoopWarning | null = null
    // 60 frames, scroll write only on the first 3 (then converged/idle).
    for (let f = 0; f < 60; f++) last = loop.frame(f * 16, f < 3)
    loop.end()
    expect(last).toBeNull()
  })

  it('warns once when a single loop keeps writing past the threshold (non-converging)', () => {
    const m = createReassertLoopMonitor({ writeThreshold: 10, cooldownMs: 5000 })
    const loop = m.begin('prepend', 0)
    const out: (ReassertLoopWarning | null)[] = []
    // Writes on EVERY frame — the signature of a loop that never settles.
    for (let f = 0; f < 30; f++) out.push(loop.frame(f * 16, true))
    const warnings = out.filter((r): r is ReassertLoopWarning => r !== null)
    expect(warnings).toHaveLength(1) // cooldown outlasts the ~480ms span
    expect(warnings[0].message).toMatch(/prepend/)
    expect(warnings[0].message).toMatch(/reassert/i)

    // The structured view must agree with the prose, or the anomaly log and
    // fluux.log describe two different events.
    const w = warnings[0]
    expect(w.reason).toBe('non-converging')
    expect(w.reason === 'non-converging' && w.label).toBe('prepend')
    expect(w.reason === 'non-converging' && w.writes).toBe(11) // first frame past 10
    expect(w.threshold).toBe(10)
    expect(w.message).toContain('issued 11 scroll writes')
  })

  it('warns when two re-assert loops run concurrently (overlap), naming both', () => {
    const m = createReassertLoopMonitor()
    const a = m.begin('prepend', 0)
    a.frame(16, false) // active = 1, no overlap
    const b = m.begin('prepend', 20) // a second prepend before the first finished
    const w = b.frame(32, false)
    expect(w).not.toBeNull()
    expect(w!.message).toMatch(/overlap/i)
    // Both concurrent labels are surfaced so the log identifies the pair.
    expect(w!.message).toMatch(/prepend.*prepend|prepend x2|2 .*prepend/i)

    expect(w!.reason).toBe('overlap')
    expect(w!.reason === 'overlap' && w!.active).toBe(2)
    expect(w!.threshold).toBe(2)
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
    const out: (ReassertLoopWarning | null)[] = []
    for (let f = 0; f < 40; f++) {
      // Collect from BOTH loops — the single allowed warning may land on either,
      // since they share the monitor-wide overlap cooldown.
      out.push(a.frame(f * 16, false))
      out.push(b.frame(f * 16, false))
    }
    const warnings = out.filter((r): r is ReassertLoopWarning => r !== null)
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

describe('reassertLoopSignal', () => {
  it('routes an overlap to its own invariant', () => {
    expect(
      reassertLoopSignal({ message: 'ignored', reason: 'overlap', active: 3, threshold: 2 }),
    ).toEqual({ name: 'scroll/reassert-overlap', active: 3, threshold: 2 })
  })

  it('routes a non-converging loop to a different invariant, keeping its label', () => {
    // The two modes have different causes and different fixes, so collapsing them
    // into one id would make the log unable to tell them apart.
    expect(
      reassertLoopSignal({
        message: 'ignored',
        reason: 'non-converging',
        label: 'prepend',
        writes: 41,
        threshold: 40,
      }),
    ).toEqual({
      name: 'scroll/reassert-nonconverging',
      label: 'prepend',
      writes: 41,
      threshold: 40,
    })
  })

  it('does not carry the prose into the record', () => {
    // The overlap message names every concurrent loop; the record must carry
    // only the count.
    const signal = reassertLoopSignal({
      message: '[ScrollReassertLoop] 2 loops active concurrently (prepend, marker)',
      reason: 'overlap',
      active: 2,
      threshold: 2,
    })
    expect(JSON.stringify(signal)).not.toContain('ScrollReassertLoop')
  })
})

describe('non-converging threshold derived from the frame budget', () => {
  const writesOver = (frameBudget: number, writes: number) => {
    const m = createReassertLoopMonitor()
    const h = m.begin('marker', 0, frameBudget)
    let warned = false
    for (let i = 0; i < writes; i++) warned ||= h.frame(i, true)?.reason === 'non-converging'
    return warned
  }

  it('scales the line with the budget instead of applying one flat count', () => {
    // A third of the budget. A flat 40 was unreachable for the 30-frame explicit-target loop —
    // it would have had to write 41 times in 30 frames — and lenient for the 120-frame ones.
    expect(writesOver(30, 10)).toBe(false)
    expect(writesOver(30, 11)).toBe(true)
    expect(writesOver(90, 30)).toBe(false)
    expect(writesOver(90, 31)).toBe(true)
  })

  it('keeps the long-standing line for the budget it was tuned against', () => {
    // 120 frames was the case the flat 40 described, so that case must not move.
    expect(writesOver(120, 40)).toBe(false)
    expect(writesOver(120, 41)).toBe(true)
  })

  it('falls back to the flat threshold when no budget is given', () => {
    expect(writesOver(undefined as unknown as number, 40)).toBe(false)
    expect(writesOver(undefined as unknown as number, 41)).toBe(true)
  })
})
