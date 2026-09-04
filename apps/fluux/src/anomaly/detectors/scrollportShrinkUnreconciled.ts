/**
 * `scroll/scrollport-shrink-unreconciled` — the scrollport lost height under a reader who
 * was at the live edge, and the distance it opened was still there.
 *
 * This is the one direction with no engine backstop. A browser clamps `scrollTop` only
 * DOWNWARD, so growing the scrollport is self-correcting while shrinking it is not: the
 * reader is left exactly the lost height short of the bottom, and nothing — no later
 * render, no repaint, no peer who stopped typing — moves them back. Only the app's own
 * re-pin does, or the reader scrolling. The typing band mounting is this case, and so is
 * the composer growing to a second line.
 *
 * `live-edge-pin-short` cannot see it. That detector arms on a pin run that reaches
 * `settled` while short, and the failure here is that **no run happens at all**: no loop,
 * no write, no settle. The family's silence about a correction that never started is what
 * this detector exists to break.
 *
 * Two halves, the same division `live-edge-pin-short` makes:
 *
 * - The resize hook reports a FACT it has already measured — how much height the
 *   scrollport lost, the distance that left, and whether its re-pin ran. It adds no
 *   judgement.
 * - This detector holds the CONFIRMATION, because a single frame short of the bottom is
 *   ordinary: the re-pin is a frame away, the commit is a frame behind the DOM. The
 *   shortfall must still be there when the tick looks again.
 *
 * WHAT IT MUST NOT FIRE ON. A detector that reports supported behaviour is deleted rather
 * than tuned, so the exclusions are structural rather than tuned thresholds:
 *
 * - **A reader who deliberately scrolled up.** Their distance is not explained by this
 *   shrink. Arming requires the whole shortfall to fit inside `shrunkPx + tolerancePx`,
 *   so a reader parked anywhere further up never arms, whatever the band does.
 * - **A shrink with nothing to reconcile.** A reader already inside the tolerance arms
 *   nothing: there is no shortfall to report.
 * - **A correction the hook legitimately did not request.** Both reasons are the two
 *   cases above, and such an observation cannot arm a confirmable episode.
 * - **A reader who leaves during the hold.** The confirmation measures the distance to
 *   the content bottom captured at the shrink, so appended content cannot masquerade as
 *   reader movement. Only movement away from that original bottom drops the episode.
 * - **A resize still in progress.** Every shrink re-arms with fresh geometry, so a window
 *   being dragged smaller keeps resetting the clock instead of accumulating a hold.
 * - **A frozen WebView.** A sample gap larger than the tick's own budget abandons the
 *   episode rather than reporting a suspension as a defect.
 *
 * What remains, and why the severity is `suspect`: a reader who scrolls DOWN during the
 * hold window and stops just short of the bottom is indistinguishable from a shortfall
 * that persisted. `observed` is therefore always the distance measured AT THE SHRINK.
 *
 * PURE: every input is passed in, including the clock. The detector retains only the
 * current episode.
 *
 * @module Anomaly/Detectors/ScrollportShrinkUnreconciled
 */

/** What the resize hook already knows when the scrollport loses height. */
export interface ScrollportShrank {
  conversationId: string
  /** Height the scrollport lost. */
  shrunkPx: number
  /** Distance to the content bottom, after the shrink and before any re-pin. */
  distFromBottom: number
  /** Content height at the shrink, used to isolate later content growth. */
  scrollHeight: number
  /** Whether the requested re-pin ran, was refused, or was not needed. */
  repin: 'ran' | 'refused' | null
  /** The hook's own at-bottom tolerance, so the detector never invents one. */
  tolerancePx: number
}

/** Everything the confirmation depends on, sampled at one instant. */
export interface ShrinkSample {
  /** Active conversation, or null when none is open. */
  active: { kind: 'conversation' | 'room'; id: string } | null
  /** Independently measured distance to the content bottom, or null when unmeasurable. */
  distFromBottom: number | null
  /** Independently measured content height, or null when unmeasurable. */
  scrollHeight: number | null
  /**
   * Is the loaded message window at the tail of the archive.
   *
   * Required for the same reason the rest of the family requires it: with the window slid
   * up, the bottom of what is loaded is not the live edge, so sitting away from it is not
   * a failed correction.
   */
  windowAtLiveEdge: boolean
  /** Account / storage scope. A change means the store was rebuilt under us. */
  scopeKey: string
}

export interface ShrinkVerdict {
  /** The shortfall measured AT THE SHRINK, never a later drift the reader caused. */
  distFromBottom: number
  /** Height the scrollport lost, so a reader can see the shortfall is the band's. */
  shrunkPx: number
  /** Whether the positioning controller accepted or refused the re-pin. */
  repin: 'ran' | 'refused'
  heldMs: number
}

export interface ScrollportShrinkUnreconciledDetector {
  /**
   * The scrollport shrank. Arms an episode only when the shortfall it left is both real
   * and explained by this shrink.
   *
   * `scopeKey` is supplied by the caller in the anomaly layer, not by the hook: the hook
   * ships in release builds and has no business reading a store, and the scope has to be
   * pinned at ARMING so an account switch between the shrink and the confirmation voids
   * the episode instead of confirming it against a rebuilt store.
   */
  noteShrank(fact: ScrollportShrank, scopeKey: string, now: number): void
  /** At most one verdict per episode. */
  observe(sample: ShrinkSample, now: number): ShrinkVerdict | null
}

/**
 * How long the shortfall must survive.
 *
 * Matches `live-edge-pin-short` and `fab-at-live-edge`: during a normal correction a
 * fresh measurement and the position the loop is about to write legitimately disagree for
 * a few frames.
 */
const DEFAULT_HOLD_MS = 1000

/** Largest observed interval that still counts as continuous sampling. */
const DEFAULT_MAX_SAMPLE_GAP_MS = 5000

export interface ScrollportShrinkUnreconciledOptions {
  holdMs?: number
  maxSampleGapMs?: number
}

interface Episode {
  entityId: string
  scopeKey: string
  at: number
  distFromBottom: number
  scrollHeight: number
  shrunkPx: number
  repin: 'ran' | 'refused'
  tolerancePx: number
  lastSeenAt: number
}

export function createScrollportShrinkUnreconciledDetector(
  opts: ScrollportShrinkUnreconciledOptions = {},
): ScrollportShrinkUnreconciledDetector {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS
  const maxSampleGapMs = opts.maxSampleGapMs ?? DEFAULT_MAX_SAMPLE_GAP_MS

  let episode: Episode | null = null

  /** Is `distance` a shortfall this shrink alone accounts for. */
  function explainedByShrink(distance: number, shrunkPx: number, tolerancePx: number): boolean {
    return distance > tolerancePx && distance <= shrunkPx + tolerancePx
  }

  return {
    noteShrank(fact: ScrollportShrank, scopeKey: string, now: number): void {
      if (
        fact.repin === null ||
        !explainedByShrink(fact.distFromBottom, fact.shrunkPx, fact.tolerancePx)
      ) {
        // Either nothing to reconcile, or a reader who was already elsewhere. Drop any
        // episode in flight too: this shrink re-measured the same viewport, and the older
        // reading is no longer what the reader is looking at.
        episode = null
        return
      }
      episode = {
        entityId: fact.conversationId,
        scopeKey,
        at: now,
        distFromBottom: fact.distFromBottom,
        scrollHeight: fact.scrollHeight,
        shrunkPx: fact.shrunkPx,
        repin: fact.repin,
        tolerancePx: fact.tolerancePx,
        lastSeenAt: now,
      }
    },

    observe(sample: ShrinkSample, now: number): ShrinkVerdict | null {
      const current = episode
      if (!current) return null

      // A frozen WebView resumes with a huge apparent hold. Reporting it would turn a
      // suspension into a fabricated defect, so the episode is abandoned instead.
      const gap = now - current.lastSeenAt
      if (!Number.isFinite(gap) || gap < 0 || gap > maxSampleGapMs) {
        episode = null
        return null
      }
      current.lastSeenAt = now

      if (current.scopeKey !== sample.scopeKey) {
        episode = null
        return null
      }

      if (!sample.active || sample.active.id !== current.entityId) {
        episode = null
        return null
      }
      if (!sample.windowAtLiveEdge) {
        episode = null
        return null
      }

      // Unmeasurable is not evidence either way — an unmounted list, a view we do not
      // track. Keep waiting rather than guess in either direction.
      if (sample.distFromBottom === null || sample.scrollHeight === null) return null

      const contentGrowth = sample.scrollHeight - current.scrollHeight
      const shrinkDistance = sample.distFromBottom - contentGrowth

      // Recovered: something re-pinned, which is the whole point of the correction.
      if (shrinkDistance <= current.tolerancePx) {
        episode = null
        return null
      }
      // The reader moved further away than this shrink can account for, so whatever is
      // being measured now is no longer the shrink's doing.
      if (shrinkDistance > current.shrunkPx + current.tolerancePx) {
        episode = null
        return null
      }

      const heldMs = now - current.at
      if (heldMs < holdMs) return null

      episode = null
      return {
        distFromBottom: current.distFromBottom,
        shrunkPx: current.shrunkPx,
        repin: current.repin,
        heldMs,
      }
    },
  }
}
