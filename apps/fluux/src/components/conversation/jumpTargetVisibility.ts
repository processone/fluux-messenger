/**
 * Did a settled go-to-message actually put the row on screen?
 *
 * Lives with the scroll code rather than under `src/anomaly/`, for two reasons. It is
 * a scroll invariant — the same kind of pure decision as `fabVisibility.ts` — and its
 * only caller is `ExplicitTargetBrowserAdapter`, which ships in release builds and
 * therefore must not import the anomaly tree at all. A static import there would pull the
 * recorder and serializer into the production bundle even behind a dead branch.
 *
 * The check is not timed: the explicit-target executor has an exact settle point
 * (`complete()`), which already knows whether the position was applied and already
 * re-finds the row. There is nothing to wait for.
 *
 * DELIBERATELY NOT A CASE: the row not existing at all. That is a load or windowing
 * failure with a different cause and a different fix, and folding it in would give
 * one invariant id two meanings — so a review could not tell from the id what
 * went wrong. It is recorded as a non-case in the invariant registry.
 *
 * PURE: rectangles are passed in, so this is testable without a layout engine.
 *
 * @module Conversation/JumpTargetVisibility
 */
import type { ExplicitTargetCompletion } from './positioningController'

/** The part of a DOMRect this check needs. Vertical only — the list scrolls one way. */
export interface Bounds {
  top: number
  bottom: number
}

export interface JumpSample {
  outcome: ExplicitTargetCompletion
  /** Did the executor report that it applied a position. */
  applied: boolean
  /** The target row's bounds, or `null` when the row is not in the DOM. */
  target: Bounds | null
  /** The scroll viewport's bounds. */
  viewport: Bounds
}

export interface JumpVerdict {
  /**
   * How far off screen the row was, in px — negative when it sits above the
   * viewport, positive below. Zero is impossible: it would mean intersecting.
   */
  offBy: number
}

/**
 * Decide whether a settled jump missed.
 *
 * @returns a verdict when the jump claimed success but left the row outside the
 * viewport, else `null`.
 */
export function evaluateJumpTarget(sample: JumpSample): JumpVerdict | null {
  if (sample.outcome !== 'settled' && sample.outcome !== 'best-effort') return null

  // A jump that did not apply was superseded or aborted. Its target being off
  // screen is the expected outcome, not a miss.
  if (!sample.applied) return null

  // Not the case this invariant covers — see the module comment.
  if (sample.target === null) return null

  const { target, viewport } = sample

  // Any overlap counts as a hit. Partial visibility is a positioning imprecision,
  // not a miss: the user can see the row.
  const intersects = target.bottom > viewport.top && target.top < viewport.bottom
  if (intersects) return null

  const offBy =
    target.bottom <= viewport.top
      ? target.bottom - viewport.top // negative: above
      : target.top - viewport.bottom // positive: below
  return { offBy }
}
