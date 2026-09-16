import type { ViewportGeometry } from './viewportSession'

/**
 * Pure interpretation of a scroll or wheel event.
 *
 * The handler reads geometry once and asks these functions what follows. Nothing here touches the
 * DOM, the controller, React state or timers, so every threshold and gate below is directly
 * testable — which the inline handler's dense boolean expressions were not.
 *
 * Movement evidence comes from ViewportSession. Loop ownership and content growth separately gate
 * presentation updates; see docs/2026-07-23-scroll-positioning-contract.md.
 */

/** Pixels away from an edge before the reader counts as having travelled away from it. */
export const TRAVEL_AWAY_THRESHOLD = 50
/** How recently a user intent must have landed for an at-bottom arrival to be theirs. */
export const RECENT_INTENT_WINDOW_MS = 1500

export interface ScrollEventFacts {
  scrollTop: number
  distanceFromBottom: number
  /** Loop ownership is separate from the viewport session's movement verdict. */
  controllerOwnsPixels: boolean
  /** Content grew under a running loop. */
  growthDrivenDuringControllerScroll: boolean
  /** The viewport session's verdict, covering scrollbar drags too. */
  genuineUserScroll: boolean
  userScrollGeometry: Pick<ViewportGeometry, 'top' | 'height' | 'client'> | null
  staticMode: boolean
  atBottomThreshold: number
  loadNewerThreshold: number
}

export interface ScrollEventPlan {
  /**
   * Whether the measured live-edge evidence may be rewritten. A growth-driven event under a loop
   * can report a transiently large distance; believing it flips the flag
   * false and makes the pin loop bail, stranding a send below the fold.
   */
  recordMeasuredAtBottom: boolean
  atBottom: boolean
  trackBottomVisibleMessage: boolean
  observeGenuineInput: boolean
  /**
   * A controller-owned animation can cross the top threshold too — Home's smooth trip from the
   * bottom most obviously — and that is not evidence of a pagination gesture.
   */
  markTravelAwayFromTop: boolean
  /** The bottom latch is deliberately NOT gated on the controller: growth alone moves this edge. */
  markTravelAwayFromBottom: boolean
  /**
   * A PASSIVE scroll reaching the top must only auto-load when the reader genuinely travelled up to
   * it. On entry the list briefly renders at scrollTop 0 before settling; loading there prepends a
   * batch and clears the at-bottom flag, breaking bottom-stick for the next arrival.
   */
  loadOlder: boolean
  loadNewer: boolean
}

export function planScrollEvent(facts: ScrollEventFacts): ScrollEventPlan {
  const atBottom = facts.distanceFromBottom < facts.atBottomThreshold
  return {
    recordMeasuredAtBottom: !facts.growthDrivenDuringControllerScroll,
    atBottom,
    trackBottomVisibleMessage: !facts.controllerOwnsPixels,
    observeGenuineInput: facts.genuineUserScroll,
    markTravelAwayFromTop:
      !facts.controllerOwnsPixels && facts.scrollTop > TRAVEL_AWAY_THRESHOLD,
    markTravelAwayFromBottom: facts.distanceFromBottom > TRAVEL_AWAY_THRESHOLD,
    loadOlder:
      facts.userScrollGeometry?.top === 0 && !facts.staticMode,
    loadNewer:
      facts.userScrollGeometry !== null && !facts.staticMode &&
      facts.userScrollGeometry.height - facts.userScrollGeometry.top - facts.userScrollGeometry.client <= facts.loadNewerThreshold,
  }
}

export interface WheelEventFacts {
  scrollTop: number
  distanceFromBottom: number
  deltaY: number
  staticMode: boolean
  loadNewerThreshold: number
}

export interface WheelEventPlan {
  loadOlder: boolean
  loadNewer: boolean
  markTravelAwayFromTop: boolean
  markTravelAwayFromBottom: boolean
}

export function planWheelEvent(facts: WheelEventFacts): WheelEventPlan {
  const wheelingUp = facts.deltaY < 0
  const wheelingDown = facts.deltaY > 0
  return {
    loadOlder: facts.scrollTop === 0 && wheelingUp && !facts.staticMode,
    loadNewer:
      facts.distanceFromBottom <= facts.loadNewerThreshold &&
      wheelingDown &&
      !facts.staticMode,
    markTravelAwayFromTop: facts.scrollTop === 0 && wheelingDown,
    markTravelAwayFromBottom:
      facts.distanceFromBottom > TRAVEL_AWAY_THRESHOLD && wheelingUp,
  }
}

/**
 * Is the unread divider scrolled ABOVE the viewport?
 *
 * Compares the marker's content-relative offset against live scrollTop, which works whether or not
 * the marker row is mounted. It deliberately does NOT compare virtual indexes: for a short or medium
 * conversation the rendered window can cover the ENTIRE item list, so the first rendered index stays
 * 0 regardless of scroll position and an index comparison would never fire.
 */
export function isMarkerAboveViewport(
  markerOffset: number | null | undefined,
  scrollTop: number,
): boolean {
  return markerOffset != null && markerOffset < scrollTop
}

export type MarkerClearAction = 'arm' | 'clear' | 'none'

export interface MarkerClearFacts {
  hasMarker: boolean
  canClear: boolean
  controllerOwnsPixels: boolean
  /** The reader has already produced one scroll since the marker appeared. */
  armed: boolean
  distanceFromBottom: number
  atBottomThreshold: number
  lastUserIntentAt: number
  now: number
}

/**
 * Decide whether this scroll retires the new-message divider.
 *
 * The first scroll after the marker appears only ARMS the clear, so the marker is never retired
 * before the reader can see it. The exception is an at-bottom arrival that follows a recent genuine
 * intent: that is the reader deliberately going to the present, so it may clear immediately.
 *
 * Only a read-through to the bottom clears. Scrolled-past and DOM-trimmed deliberately do not:
 * those are exactly the states where the jump-to-last-read pill must still show.
 */
export function decideMarkerClear(facts: MarkerClearFacts): MarkerClearAction {
  if (!facts.hasMarker || !facts.canClear || facts.controllerOwnsPixels) {
    return 'none'
  }
  const atBottom = facts.distanceFromBottom < facts.atBottomThreshold
  const recentUserScrollIntent =
    facts.lastUserIntentAt > 0 &&
    facts.now - facts.lastUserIntentAt < RECENT_INTENT_WINDOW_MS
  if (!facts.armed && !(atBottom && recentUserScrollIntent)) return 'arm'
  return atBottom ? 'clear' : 'none'
}
