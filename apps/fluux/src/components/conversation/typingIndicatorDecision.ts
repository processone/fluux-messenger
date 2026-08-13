/**
 * What to do when the typing indicator appears.
 *
 * The indicator is a band BELOW the scrollport, so showing it shrinks the scroller by the band's
 * height and leaves a reader who was glued to the bottom that many pixels short of it. The
 * scroller's own ResizeObserver catches this too, but a frame later; deciding here, in the commit
 * that mounts the band, avoids that frame of visible drift.
 *
 * The twin of {@link decideRowGrowth}: both are ambient re-pins triggered by content changing size
 * under a reader who did not ask for it.
 */
export type TypingIndicatorDecision = 'pin' | 'skip'

export interface TypingIndicatorFacts {
  /** The list is rendered without a positioning owner (previews, selection surfaces). */
  staticMode: boolean
  /** The previous render was the SAME conversation, so its indicator state is comparable. */
  sameConversation: boolean
  /** The indicator is showing now. */
  hasTypingIndicator: boolean
  /** The indicator was showing at the previous render. */
  hadTypingIndicator: boolean
  /**
   * Live distance from the bottom, measured now.
   *
   * Deliberately live geometry rather than a latched at-bottom flag: the flag can outlive the
   * reader leaving the bottom, and re-pinning someone who has scrolled up is the harmful direction.
   */
  distanceFromBottom: number
  /** Distance within which the list counts as "following the bottom". */
  atBottomThreshold: number
}

export function decideTypingIndicator(facts: TypingIndicatorFacts): TypingIndicatorDecision {
  if (facts.staticMode) return 'skip'

  // A conversation switch rebaselines: the indicator state carried over from the conversation being
  // left is not evidence about this one.
  if (!facts.sameConversation) return 'skip'

  // Only the off -> on edge shrinks the scrollport. Typing STOPPING grows it back, and the browser
  // clamps scrollTop for that on its own — the same reason a measured shrink skips in row growth.
  if (!facts.hasTypingIndicator) return 'skip'
  if (facts.hadTypingIndicator) return 'skip'

  if (facts.distanceFromBottom >= facts.atBottomThreshold) return 'skip'

  return 'pin'
}
