/**
 * What to do about a row that grew in place (a fastening, an attachment, a reaction, a correction).
 *
 * A row-growth signature change is consumed exactly once — nothing re-runs the effect for the same
 * signature — so every `skip` is final.
 *
 * KNOWN GAP, accepted deliberately: when a pin loop already claims the bottom we skip, betting that
 * the loop absorbs the growth itself. If that loop was abandoned without releasing its claim, the
 * bet is wrong and this growth is never pinned. The claim self-expires, so the window in which that
 * can happen is bounded — but expiry only stops FUTURE growths being suppressed; it does not replay
 * the one already consumed. Recovering that growth needs the reader to move, or another growth to
 * arrive after the claim lapses. The underlying defect is the controller path that can abandon a
 * frame loop without calling finish(); fixing that closes this gap at the source.
 */
export type RowGrowthDecision = 'pin' | 'skip'

export interface RowGrowthFacts {
  /** Live distance from the bottom, measured AFTER the row grew. */
  distanceFromBottom: number
  /** How much the content grew, or 0 when there is no trustworthy baseline. */
  growth: number
  /** Distance within which the list counts as "following the bottom". */
  atBottomThreshold: number
  /** A pin-bottom loop currently claims the bottom. */
  pinClaimHeld: boolean
  /** The controller is converging on a position the reader explicitly asked for. */
  navigationInFlight: boolean
}

export function decideRowGrowth(facts: RowGrowthFacts): RowGrowthDecision {
  // Was the reader at the bottom BEFORE the row grew? The growth lands in the measured distance, so
  // it has to come back out; otherwise a card taller than the threshold reads as "scrolled away"
  // and the re-pin is refused in exactly the case it exists for.
  if (facts.distanceFromBottom - facts.growth >= facts.atBottomThreshold) return 'skip'

  // A running loop re-reads the height every frame and absorbs this itself — see the known gap above.
  if (facts.pinClaimHeld) return 'skip'

  // Row growth is ambient — the reader did not ask for it, so it must not cancel a position they
  // did ask for (Home, jump-to-message, saved-position restore).
  if (facts.navigationInFlight) return 'skip'

  return 'pin'
}
