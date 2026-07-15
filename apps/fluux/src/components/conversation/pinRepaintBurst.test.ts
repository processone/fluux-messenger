import { describe, it, expect } from 'vitest'
import { createPinRepaintBurst, pinBurstProbeLine, PIN_BURST_WINDOW_MS } from './pinRepaintBurst'

describe('createPinRepaintBurst', () => {
  it('does NOT suppress an isolated single arrival (snappy common case)', () => {
    const b = createPinRepaintBurst()
    b.note(1000)
    expect(b.suppress(1000)).toBe(false) // first arrival always paints
    expect(b.owed()).toBe(false)
  })

  it('suppresses once a second arrival lands within the window', () => {
    const b = createPinRepaintBurst({ windowMs: 200 })
    b.note(1000)
    expect(b.suppress(1000)).toBe(false)
    b.note(1100) // 100ms later → burst
    expect(b.suppress(1100)).toBe(true)
    expect(b.suppress(1200)).toBe(true) // still inside window (1200 - 1100 < 200)
  })

  it('stops suppressing once the window elapses with no further arrival', () => {
    const b = createPinRepaintBurst({ windowMs: 200 })
    b.note(1000)
    b.note(1100)
    expect(b.suppress(1100)).toBe(true)
    expect(b.suppress(1301)).toBe(false) // 1301 - 1100 = 201 >= 200 → window expired
  })

  it('collapses a burst of N repaints to one owed trailing repaint', () => {
    const b = createPinRepaintBurst({ windowMs: 200 })
    let suppressed = 0
    // Simulate 6 arrivals ~30ms apart, each of which would have painted.
    for (let i = 0; i < 6; i++) {
      const now = 1000 + i * 30
      b.note(now)
      const wouldPaint = true
      if (wouldPaint && b.suppress(now)) {
        b.markSuppressed()
        suppressed++
      }
    }
    // First arrival painted (not suppressed); the other five were coalesced.
    expect(suppressed).toBe(5)
    expect(b.owed()).toBe(true)
    const summary = b.settle()
    expect(summary.triggers).toBe(6)
    expect(summary.suppressedRepaints).toBe(5)
    expect(summary.spanMs).toBe(150)
    expect(b.owed()).toBe(false) // settle consumed the debt
  })

  it('a fresh burst after a quiet gap starts a new count', () => {
    const b = createPinRepaintBurst({ windowMs: 200 })
    b.note(1000)
    b.note(1050)
    b.settle()
    b.note(5000) // long gap → new burst
    expect(b.suppress(5000)).toBe(false)
    b.note(5050)
    expect(b.suppress(5050)).toBe(true)
  })

  it('reset drops all state', () => {
    const b = createPinRepaintBurst()
    b.note(1000)
    b.note(1050)
    b.markSuppressed()
    expect(b.owed()).toBe(true)
    b.reset()
    expect(b.owed()).toBe(false)
    expect(b.suppress(1050)).toBe(false)
  })

  it('exports a sane default window', () => {
    expect(PIN_BURST_WINDOW_MS).toBeGreaterThanOrEqual(133) // above the 8-frame settle
  })

  it('probe line reports the coalesced burst', () => {
    const line = pinBurstProbeLine('new-message', { triggers: 10, suppressedRepaints: 9, spanMs: 280 })
    expect(line).toContain('[PinBurstProbe]')
    expect(line).toContain('trigger=new-message')
    expect(line).toContain('arrivals=10')
    expect(line).toContain('suppressedRepaints=9')
    expect(line).toContain('spanMs=280')
  })
})
