import { describe, it, expect } from 'vitest'
import { createFabAtLiveEdgeDetector, type FabSample } from './fabAtLiveEdge'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'

/** The failing condition: FAB up while the viewport is already at the bottom. */
function bad(overrides: Partial<FabSample> = {}): FabSample {
  return { fabShown: true, distFromBottom: 10, windowAtLiveEdge: true, ...overrides }
}

describe('fabAtLiveEdge — fires', () => {
  it('reports once the disagreement has held for the full window', () => {
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    expect(d.observe(bad(), 0)).toBeNull()
    expect(d.observe(bad(), 999)).toBeNull()
    const v = d.observe(bad(), 1000)

    expect(v).not.toBeNull()
    expect(v!.distFromBottom).toBe(10)
    expect(v!.heldMs).toBe(1000)
  })

  it('fires immediately below the at-bottom threshold', () => {
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    d.observe(bad({ distFromBottom: AT_BOTTOM_THRESHOLD - 0.5 }), 0)
    expect(d.observe(bad({ distFromBottom: AT_BOTTOM_THRESHOLD - 0.5 }), 1000)).not.toBeNull()
  })

  it('reports once per episode', () => {
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    d.observe(bad(), 0)
    const verdicts = [1000, 2000, 3000].map((t) => d.observe(bad(), t))
    expect(verdicts.filter(Boolean)).toHaveLength(1)
  })
})

describe('fabAtLiveEdge — stays silent', () => {
  it('when the FAB is hidden', () => {
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    d.observe(bad({ fabShown: false }), 0)
    expect(d.observe(bad({ fabShown: false }), 5000)).toBeNull()
  })

  it('when the viewport is genuinely scrolled up', () => {
    for (const distance of [AT_BOTTOM_THRESHOLD, AT_BOTTOM_THRESHOLD + 1]) {
      const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
      expect(d.observe(bad({ distFromBottom: distance }), 0)).toBeNull()
      expect(d.observe(bad({ distFromBottom: distance }), 5000)).toBeNull()
    }
  })

  it('while the loaded window has slid up, where the FAB means "jump to latest"', () => {
    // The case that fired on every healthy demo session before `windowAtLiveEdge`
    // was part of the sample. `fabVisible` is `showScrollToBottom || windowSlidUp`,
    // so a slid-up window legitimately shows the button with the viewport at the
    // bottom of what is loaded.
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    d.observe(bad({ windowAtLiveEdge: false }), 0)
    expect(d.observe(bad({ windowAtLiveEdge: false }), 5000)).toBeNull()
  })

  it('when no viewport could be measured', () => {
    // An unmounted list or an untracked view. Guessing would invent a verdict from
    // an absence of evidence.
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    d.observe(bad({ distFromBottom: null }), 0)
    expect(d.observe(bad({ distFromBottom: null }), 5000)).toBeNull()
  })

  it('during a settle shorter than the hold window', () => {
    // THE false-positive case this detector must survive: React state lands a
    // commit behind the DOM, so the two disagree for a few frames on every scroll
    // back to the bottom.
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    d.observe(bad(), 0)
    d.observe(bad(), 200)
    expect(d.observe(bad({ fabShown: false }), 400)).toBeNull()
    expect(d.observe(bad(), 1200)).toBeNull() // clock restarted, not resumed
  })

  it('when the user scrolls away and back inside one window', () => {
    const d = createFabAtLiveEdgeDetector({ holdMs: 1000 })
    d.observe(bad(), 0)
    d.observe(bad({ distFromBottom: AT_BOTTOM_THRESHOLD }), 500)
    d.observe(bad(), 900)
    expect(d.observe(bad(), 1500)).toBeNull() // only 600ms of held condition
  })
})
