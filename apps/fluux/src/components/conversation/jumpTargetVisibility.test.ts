import { describe, it, expect } from 'vitest'
import { evaluateJumpTarget } from './jumpTargetVisibility'

const VIEWPORT = { top: 100, bottom: 700 }

describe('jumpTargetMiss — fires', () => {
  it('reports a row left above the viewport, with the distance', () => {
    const v = evaluateJumpTarget({
      outcome: 'settled',
      applied: true,
      target: { top: -60, bottom: 20 },
      viewport: VIEWPORT,
    })
    expect(v).not.toBeNull()
    expect(v!.offBy).toBe(-80) // target.bottom 20 - viewport.top 100
  })

  it('reports a row left below the viewport', () => {
    const v = evaluateJumpTarget({
      outcome: 'best-effort',
      applied: true,
      target: { top: 900, bottom: 980 },
      viewport: VIEWPORT,
    })
    expect(v!.offBy).toBe(200) // target.top 900 - viewport.bottom 700
  })

  it('signs the distance so a review can tell which way it missed', () => {
    // Overshoot and undershoot have different causes; one number that could not
    // distinguish them would send a reader looking in the wrong place.
    const above = evaluateJumpTarget({
      outcome: 'settled',
      applied: true,
      target: { top: -100, bottom: -20 },
      viewport: VIEWPORT,
    })
    const below = evaluateJumpTarget({
      outcome: 'settled',
      applied: true,
      target: { top: 800, bottom: 880 },
      viewport: VIEWPORT,
    })
    expect(above!.offBy).toBeLessThan(0)
    expect(below!.offBy).toBeGreaterThan(0)
  })
})

describe('jumpTargetMiss — stays silent', () => {
  it('when the row is fully visible', () => {
    expect(
      evaluateJumpTarget({
        outcome: 'settled',
        applied: true,
        target: { top: 300, bottom: 380 },
        viewport: VIEWPORT,
      }),
    ).toBeNull()
  })

  it('when the row is only partly visible', () => {
    // Partial visibility is imprecise positioning, not a miss — the user can see it.
    expect(
      evaluateJumpTarget({
        outcome: 'settled',
        applied: true,
        target: { top: 650, bottom: 760 },
        viewport: VIEWPORT,
      }),
    ).toBeNull()
    expect(
      evaluateJumpTarget({
        outcome: 'settled',
        applied: true,
        target: { top: 40, bottom: 160 },
        viewport: VIEWPORT,
      }),
    ).toBeNull()
  })

  it('when the row touches the viewport edge by a single pixel', () => {
    // The boundary of "intersects". A strict-inequality slip here would report
    // every jump that landed a row exactly at the edge.
    expect(
      evaluateJumpTarget({
        outcome: 'settled',
        applied: true,
        target: { top: 20, bottom: 101 },
        viewport: VIEWPORT,
      }),
    ).toBeNull()
    expect(
      evaluateJumpTarget({
        outcome: 'settled',
        applied: true,
        target: { top: 699, bottom: 800 },
        viewport: VIEWPORT,
      }),
    ).toBeNull()
  })

  it('when the jump did not apply', () => {
    // Superseded or aborted. Its target being off screen is the expected outcome.
    expect(
      evaluateJumpTarget({
        outcome: 'settled',
        applied: false,
        target: { top: 900, bottom: 980 },
        viewport: VIEWPORT,
      }),
    ).toBeNull()
  })

  it('when the user takes over after a position was applied', () => {
    expect(
      evaluateJumpTarget({
        outcome: 'user-takeover',
        applied: true,
        target: { top: 900, bottom: 980 },
        viewport: VIEWPORT,
      }),
    ).toBeNull()
  })

  it('when the row is not in the DOM at all', () => {
    // DELIBERATE non-case: a load/windowing failure with a different cause. Folding
    // it in would give one invariant id two meanings. See the invariant registry.
    expect(
      evaluateJumpTarget({
        outcome: 'settled',
        applied: true,
        target: null,
        viewport: VIEWPORT,
      }),
    ).toBeNull()
  })
})
