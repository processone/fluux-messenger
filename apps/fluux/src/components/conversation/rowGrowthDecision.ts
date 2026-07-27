/**
 * What to do about a row that grew in place (a fastening, an attachment, a reaction, a correction).
 *
 * The distinction that matters is SKIP vs DEFER. A row-growth signature change is consumed exactly
 * once — nothing re-runs the effect for the same signature — so a guard that returns `skip` throws
 * the change away for good. That is right when the answer cannot change later (the reader is not at
 * the bottom; a navigation owns the position). It is WRONG for "a pin loop already owns the bottom",
 * which is a bet that the running loop absorbs the growth: if that loop was abandoned, its claim
 * lingers until it lapses and the growth is never pinned at all. That case must `defer` so the
 * caller can retry once the claim has lapsed.
 */
export type RowGrowthDecision = 'pin' | 'skip' | 'defer'

export interface RowGrowthFacts {
  /** Live distance from the bottom, measured AFTER the row grew. */
  distanceFromBottom: number
  /** How much the content grew, or 0 when there is no trustworthy baseline. */
  growth: number
  /** Distance within which the list counts as "following the bottom". */
  atBottomThreshold: number
  /** Sub-row tolerance: at or under this the bottom is already pinned, so a re-pin is pure cost. */
  pinnedTolerance: number
  /** A pin-bottom loop currently claims the bottom. */
  pinClaimHeld: boolean
  /** The controller is converging on a position the reader explicitly asked for. */
  navigationInFlight: boolean
  /** The reader has scrolled of their own accord since this growth was first seen. */
  readerTookOver: boolean
  /** Whether this is a retry of a previously deferred growth rather than the first attempt. */
  isRetry: boolean
  /**
   * Whether "the reader was at the bottom before the row grew" is ALREADY established and must not
   * be re-derived. Set on a retry: the deferral proved it, and by the time the retry runs the growth
   * has fired its own scroll event, which moves the baseline forward to the grown height. Re-deriving
   * then yields growth=0 and reads the card's own height as "the reader is scrolled up", so the
   * deferred growth is skipped forever — the deferral would have bought nothing.
   */
  eligibilityEstablished: boolean
}

export function decideRowGrowth(facts: RowGrowthFacts): RowGrowthDecision {
  // The reader moved after the growth was queued — their position wins, permanently.
  if (facts.readerTookOver) return 'skip'

  // Was the reader at the bottom BEFORE the row grew? The growth lands in the measured distance, so
  // it has to come back out; otherwise a card taller than the threshold reads as "scrolled away"
  // and the re-pin is refused in exactly the case it exists for. Skipped once established — see
  // eligibilityEstablished.
  if (
    !facts.eligibilityEstablished &&
    facts.distanceFromBottom - facts.growth >= facts.atBottomThreshold
  ) {
    return 'skip'
  }

  // A running loop re-reads the height every frame and absorbs this itself. DEFER, never skip: the
  // claim lapses on its own if that loop was abandoned, and the caller retries then.
  if (facts.pinClaimHeld) return 'defer'

  // Row growth is ambient — the reader did not ask for it, so it must not cancel a position they
  // did ask for (Home, jump-to-message, saved-position restore).
  if (facts.navigationInFlight) return 'skip'

  // On a RETRY only: the loop we deferred behind may have pinned the bottom already, so re-pinning
  // would buy nothing but a forced layout. This must not apply to the first attempt — the spacer
  // often has not taken the growth yet at that point, so a distance of ~0 there means "not measured
  // yet", not "already pinned", and skipping would drop the growth the loop never absorbed.
  if (facts.isRetry && facts.distanceFromBottom <= facts.pinnedTolerance) return 'skip'

  return 'pin'
}
