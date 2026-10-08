/**
 * `scroll/fab-at-live-edge` — the scroll-to-bottom affordance offering to do
 * something already done.
 *
 * NOT a check on `shouldShowScrollToBottomFab`. That function shows the FAB only
 * at or beyond `AT_BOTTOM_THRESHOLD`, outside the live-edge following band. This detector
 * compares the rendered affordance with independently measured geometry instead.
 *
 * The bug is STALENESS. `showScrollToBottom` is React state written from the scroll
 * handler; if the handler stops firing after the list returns to the bottom, the FAB
 * stays up over a viewport that is already at the live edge.
 *
 * Catching that requires a measurement the scroll hook had no part in — hence
 * `utils/viewportScroller.ts` rather than the hook's own `isAtBottomRef`. A detector
 * reading the suspect value cannot disagree with it, and would fall silent exactly
 * when the bug is present.
 *
 * PURE: the measurement is passed in.
 *
 * @module Anomaly/Detectors/FabAtLiveEdge
 */

import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'

export interface FabSample {
  /** Is the FAB actually offered to the user — rendered AND not inert. */
  fabShown: boolean
  /**
   * Independently measured distance to the content bottom, or `null` when no
   * viewport could be measured — an unmounted list, or a view we do not track.
   */
  distFromBottom: number | null
  /**
   * Is the LOADED WINDOW at the tail of the archive.
   *
   * Required, because the FAB means two things. `fabVisible` is
   * `showScrollToBottom || windowSlidUp` (`MessageList.tsx`): when the window has
   * slid up, the button offers "jump to the latest", which is a real and useful
   * affordance even though the viewport sits at the bottom of what is loaded.
   *
   * Only when the window is at the live edge does a shown FAB mean nothing is left to
   * scroll to.
   */
  windowAtLiveEdge: boolean
}

/*
 * The pin claim is internal to the scroll hook, so this detector has no pinning input.
 * The hook clears the FAB when bottom intent is remembered; the hold window also lets
 * a normal pin settle. A FAB still shown after that window while the viewport is below
 * the following threshold is stale, even if a pin loop is running.
 */

export interface FabVerdict {
  distFromBottom: number
  heldMs: number
}

export interface FabAtLiveEdgeDetector {
  observe(sample: FabSample, now: number): FabVerdict | null
}

/**
 * How long the disagreement must persist.
 *
 * During a normal settle the rendered FAB and a fresh measurement legitimately
 * disagree for a few frames — React state lands a commit behind the DOM. Reporting
 * that would make the detector fire on healthy scrolling, and by the design's own
 * rule a detector that cries wolf gets deleted rather than tuned.
 */
const DEFAULT_HOLD_MS = 1000

export interface FabAtLiveEdgeOptions {
  atBottomPx?: number
  holdMs?: number
}

export function createFabAtLiveEdgeDetector(
  opts: FabAtLiveEdgeOptions = {},
): FabAtLiveEdgeDetector {
  const atBottomPx = opts.atBottomPx ?? AT_BOTTOM_THRESHOLD
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS

  let since: number | null = null
  let reported = false

  return {
    observe(sample: FabSample, now: number): FabVerdict | null {
      const holds =
        sample.fabShown &&
        sample.windowAtLiveEdge &&
        sample.distFromBottom !== null &&
        sample.distFromBottom < atBottomPx

      if (!holds || sample.distFromBottom === null) {
        since = null
        reported = false
        return null
      }

      if (since === null) {
        since = now
        return null
      }

      const heldMs = now - since
      if (heldMs < holdMs) return null
      if (reported) return null

      reported = true
      return { distFromBottom: sample.distFromBottom, heldMs }
    },
  }
}
