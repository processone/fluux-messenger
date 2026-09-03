/**
 * `scroll/live-edge-pin-short` — a pin to the live edge that settled short of it.
 *
 * The rest of the `scroll/` family watches loud failures: two re-assert loops fighting
 * over `scrollTop`, a loop that will not converge, a `ResizeObserver` storm, a
 * correction that took too long. Every one of them needs pathological ACTIVITY, or an
 * action that completed and landed wrong.
 *
 * A correction that quietly does not happen produces none of that. When a resident row
 * grows in place — a reaction, a link preview, a decrypted attachment, a correction —
 * the growth must be absorbed above so the newest message stays on screen. If it is
 * not, there is no loop, no write, no resize, no slow frame: the reader is simply left
 * short of the bottom, and every existing detector reports health. That silence is
 * what this detector exists to break.
 *
 * Two halves, because neither is trustworthy alone:
 *
 * - The executor reports a FACT it has already measured — a live-edge run reached
 *   `settled` with the viewport still beyond its own at-bottom threshold. It adds no
 *   measurement: the settle path already reads that distance for `setMeasuredAtBottom`.
 * - This detector holds the CONFIRMATION. A single settle short of the bottom is
 *   ordinary: a smooth scroll is still animating, a commit lands a frame behind the
 *   DOM, a message arrived during the settle and a later run will absorb it. Reporting
 *   that would fire on healthy scrolling, and by the design's own rule a detector that
 *   cries wolf is deleted rather than tuned. So the shortfall must still be there when
 *   the tick looks again.
 *
 * PURE: every input is passed in, including the clock. The detector retains only the
 * current episode.
 *
 * @module Anomaly/Detectors/LiveEdgePinShort
 */

/** What the executor already knows when a live-edge run settles. */
export interface PinSettledShort {
  conversationId: string
  /** Distance still remaining, as the settle path measured it. */
  distFromBottom: number
  /** The executor's own at-bottom threshold, so the detector never invents one. */
  thresholdPx: number
}

/*
 * On the pin TRIGGER, deliberately absent.
 *
 * `trigger` is an open string at the executor (`row-growth`, `new-message`, `switch`,
 * …), and the record layer only accepts a closed table — an unmapped label must lose
 * the detail rather than pass a raw string into a record. Rather than freeze a table
 * that the next trigger silently falls out of, the trigger stays where it already is:
 * the `PIN completed` and `[PinLoopProbe]` lines in `fluux.log`, the same division
 * `perf/main-thread-stall` makes with the route.
 */

/** Everything the confirmation depends on, sampled at one instant. */
export interface PinShortSample {
  /** Active conversation, or null when none is open. */
  active: { kind: 'conversation' | 'room'; id: string } | null
  /** Independently measured distance to the content bottom, or null when unmeasurable. */
  distFromBottom: number | null
  /**
   * Is the loaded message window at the tail of the archive.
   *
   * Required for the same reason `fab-at-live-edge` requires it: with the window slid
   * up, the bottom of what is loaded is not the live edge, so sitting away from it is
   * not a failed pin.
   */
  windowAtLiveEdge: boolean
  /** Account / storage scope. A change means the store was rebuilt under us. */
  scopeKey: string
}

export interface PinShortVerdict {
  /** The shortfall measured AT THE SETTLE, never a later drift the reader caused. */
  distFromBottom: number
  heldMs: number
}

export interface LiveEdgePinShortDetector {
  /**
   * A live-edge run settled. Arms an episode only when it settled short.
   *
   * `scopeKey` is supplied by the caller in the anomaly layer, not by the executor:
   * the executor ships in release builds and has no business reading a store, but the
   * scope has to be pinned at ARMING. Adopting it from the first sample instead would
   * let an account switch land between the settle and the confirmation and then be
   * confirmed against a store that had already been rebuilt.
   */
  noteSettledShort(settle: PinSettledShort, scopeKey: string, now: number): void
  /** At most one verdict per episode. */
  observe(sample: PinShortSample, now: number): PinShortVerdict | null
}

/**
 * How long the shortfall must survive.
 *
 * Matches `fab-at-live-edge`: during a normal settle a fresh measurement and the
 * position the loop just wrote legitimately disagree for a few frames.
 */
const DEFAULT_HOLD_MS = 1000

/** Largest observed interval that still counts as continuous sampling. */
const DEFAULT_MAX_SAMPLE_GAP_MS = 5000

export interface LiveEdgePinShortOptions {
  holdMs?: number
  maxSampleGapMs?: number
}

interface Episode {
  entityId: string
  scopeKey: string
  at: number
  distFromBottom: number
  thresholdPx: number
  lastSeenAt: number
}

export function createLiveEdgePinShortDetector(
  opts: LiveEdgePinShortOptions = {},
): LiveEdgePinShortDetector {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS
  const maxSampleGapMs = opts.maxSampleGapMs ?? DEFAULT_MAX_SAMPLE_GAP_MS

  let episode: Episode | null = null

  return {
    noteSettledShort(settle: PinSettledShort, scopeKey: string, now: number): void {
      // The executor reports every settle; deciding what counts as short is the
      // detector's job, so the threshold travels with the fact rather than being
      // duplicated here.
      if (settle.distFromBottom < settle.thresholdPx) return
      episode = {
        entityId: settle.conversationId,
        scopeKey,
        at: now,
        distFromBottom: settle.distFromBottom,
        thresholdPx: settle.thresholdPx,
        lastSeenAt: now,
      }
    },

    observe(sample: PinShortSample, now: number): PinShortVerdict | null {
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
      if (sample.distFromBottom === null) return null

      if (sample.distFromBottom < current.thresholdPx) {
        episode = null
        return null
      }

      const heldMs = now - current.at
      if (heldMs < holdMs) return null

      episode = null
      return {
        distFromBottom: current.distFromBottom,
        heldMs,
      }
    },
  }
}
