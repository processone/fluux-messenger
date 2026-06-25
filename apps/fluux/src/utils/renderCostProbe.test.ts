import { describe, it, expect } from 'vitest'
import { createRenderCostProbe, spansIdleWindow } from './renderCostProbe'

describe('createRenderCostProbe', () => {
  it('does not report renders below the threshold', () => {
    const probe = createRenderCostProbe({ thresholdMs: 200, cooldownMs: 5000 })
    expect(probe.record(50, 1000)).toBe(false)
    expect(probe.record(199, 2000)).toBe(false)
  })

  it('reports a render at or above the threshold', () => {
    const probe = createRenderCostProbe({ thresholdMs: 200, cooldownMs: 5000 })
    expect(probe.record(200, 1000)).toBe(true)
  })

  it('suppresses repeat reports within the cooldown window', () => {
    const probe = createRenderCostProbe({ thresholdMs: 200, cooldownMs: 5000 })
    expect(probe.record(300, 1000)).toBe(true)
    // Still slow, but within cooldown — one line per sustained slowdown, not per render.
    expect(probe.record(300, 3000)).toBe(false)
    expect(probe.record(300, 5999)).toBe(false)
  })

  it('reports again once the cooldown has elapsed', () => {
    const probe = createRenderCostProbe({ thresholdMs: 200, cooldownMs: 5000 })
    expect(probe.record(300, 1000)).toBe(true)
    expect(probe.record(300, 6000)).toBe(true)
  })

  it('discards a measurement whose window spanned a hidden/sleep period', () => {
    const probe = createRenderCostProbe({ thresholdMs: 200, cooldownMs: 5000 })
    // An OS sleep makes the render→commit wall clock huge (e.g. ~18min for 50
    // rows). Such a span is not render cost — never report it.
    expect(probe.record(1_117_261, 1_117_261, true)).toBe(false)
  })

  it('does not consume the cooldown when discarding a spanned measurement', () => {
    const probe = createRenderCostProbe({ thresholdMs: 200, cooldownMs: 5000 })
    // A bogus spanned render must not block the next genuine slow render.
    expect(probe.record(300, 1000, true)).toBe(false)
    expect(probe.record(300, 1000, false)).toBe(true)
  })
})

describe('spansIdleWindow', () => {
  // A focused, visible app with no backgrounding transition during the window —
  // the only case where the wall-clock measurement reflects real render work.
  it('keeps a sample when focused, visible, and no recent boundary', () => {
    expect(
      spansIdleWindow(1000, { lastBoundaryAt: 500, isHidden: false, hasFocus: true }),
    ).toBe(false)
  })

  it('discards a sample taken while the page is hidden (tab switch / minimize)', () => {
    expect(
      spansIdleWindow(1000, { lastBoundaryAt: 500, isHidden: true, hasFocus: true }),
    ).toBe(true)
  })

  // App switch on desktop: the window loses OS focus but stays visible, so
  // document.hidden is false and no visibilitychange fires. The OS throttles /
  // App-Naps the unfocused window, so the render→commit wall clock is idle time.
  it('discards a sample taken while the window is unfocused (app switch)', () => {
    expect(
      spansIdleWindow(1000, { lastBoundaryAt: 500, isHidden: false, hasFocus: false }),
    ).toBe(true)
  })

  // Blurred then refocused within the window: by sample time focus is back and the
  // page was never hidden, so the focus/blur boundary timestamp is the only signal.
  it('discards a sample whose window contained a focus/blur boundary at or after renderStart', () => {
    expect(
      spansIdleWindow(1000, { lastBoundaryAt: 1000, isHidden: false, hasFocus: true }),
    ).toBe(true)
    expect(
      spansIdleWindow(1000, { lastBoundaryAt: 4000, isHidden: false, hasFocus: true }),
    ).toBe(true)
  })

  it('ignores a boundary that landed strictly before the render started', () => {
    expect(
      spansIdleWindow(1000, { lastBoundaryAt: 999, isHidden: false, hasFocus: true }),
    ).toBe(false)
  })
})
