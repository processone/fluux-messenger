import { describe, it, expect } from 'vitest'
import { createRenderCostProbe } from './renderCostProbe'

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
})
