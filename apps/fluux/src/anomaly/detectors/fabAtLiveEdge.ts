/**
 * `scroll/fab-at-live-edge` — the scroll-to-bottom affordance offering to do
 * something already done.
 *
 * NOT a check on `shouldShowScrollToBottomFab`. That function cannot produce this
 * state: it shows the FAB above `FAB_THRESHOLD` (300px) while "at the bottom" means
 * under `AT_BOTTOM_THRESHOLD` (150px), so the two are separated by a dead band and a
 * detector comparing them would be unfalsifiable.
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
   * `showScrollToBottom || windowSlidUp` (`MessageList.tsx:735`): when the window has
   * slid up, the button offers "jump to the latest", which is a real and useful
   * affordance even though the viewport sits at the bottom of what is loaded.
   *
   * Omitting this fired on every healthy demo session — the control test caught it.
   * Only when the window IS at the live edge does a shown FAB mean nothing is left to
   * scroll to.
   */
  windowAtLiveEdge: boolean
}

/*
 * On the pin-to-bottom loop, deliberately absent.
 *
 * An earlier draft took a `pinningToBottom` flag, mirroring the suppression inside
 * `shouldShowScrollToBottomFab`. It is not publicly observable — the claim lives in a
 * hook-internal ref — and hardcoding `false` at the only real call site would ship a
 * tested branch that nothing exercises, which is hollow by a different route.
 *
 * Two guards cover it instead. The hook's `rememberBottomIntent` callback clears the FAB EAGERLY
 * when a pin loop lands at the bottom, and the hold window below outlasts
 * the few frames a loop spends approaching from beyond the FAB threshold to inside the
 * at-bottom one. And on reflection the suppression was never quite right: a FAB still
 * shown a full second after the viewport reached the bottom IS the staleness this
 * detector is for, whether or not a loop is running.
 *
 * If real logs show false positives here, exposing the pin claim is the first move.
 */

export interface FabVerdict {
  distFromBottom: number
  heldMs: number
}

export interface FabAtLiveEdgeDetector {
  observe(sample: FabSample, now: number): FabVerdict | null
}

/**
 * How close counts as the live edge. Matches `AT_BOTTOM_THRESHOLD` rather than
 * `FAB_THRESHOLD`: the claim is "the user is already at the newest message", which is
 * the same question the rest of the app answers with this number.
 */
const AT_BOTTOM_PX = 150
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
  const atBottomPx = opts.atBottomPx ?? AT_BOTTOM_PX
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS

  let since: number | null = null
  let reported = false

  return {
    observe(sample: FabSample, now: number): FabVerdict | null {
      const holds =
        sample.fabShown &&
        sample.windowAtLiveEdge &&
        sample.distFromBottom !== null &&
        sample.distFromBottom <= atBottomPx

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
