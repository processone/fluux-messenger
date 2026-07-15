/**
 * Cross-run burst coalescing for `pinVirtualizedBottom`'s forced repaint.
 *
 * WHY THIS EXISTS
 * ---------------
 * The pin's `forceRepaint()` (an `overflowY` toggle → forced reflow) is the
 * dominant main-thread cost on WebKitGTK — a full scroller re-layout + repaint,
 * ~50–150ms each (near-free on Chromium / WKWebView-macOS). PR #860 made each
 * INDIVIDUAL pin run converge, but the `new-message` trigger is ungated: every
 * arriving message supersedes the running loop and starts a fresh run whose first
 * `writePin` forces a repaint. A BURST of new content — live group chatter, a
 * reaction storm, images decoding, or a reconnect flushing queued messages —
 * therefore fires one forced WebKitGTK repaint per message/per frame, saturating
 * the main thread for hundreds of ms: the "half-freeze" testers hit only while new
 * content is arriving (never while merely scrolling or switching rooms, which add
 * no bottom row).
 *
 * WHAT IT DOES
 * ------------
 * This generalizes the MAM-catch-up suppression (`shouldForceRepaint`'s
 * `suppressForBackgroundLoad`) to LIVE bursts: while content-arrival pins keep
 * firing within a short window, intermediate forced repaints are suppressed (the
 * scroll position is still written, so the layout stays correct — only the paint
 * is deferred, exactly as during a catch-up). Once arrival quiesces, the pin loop's
 * convergence forces exactly ONE trailing repaint. A burst of N repaints collapses
 * to ~1, turning a multi-hundred-ms freeze into a single paint.
 *
 * The state lives OUTSIDE any single pin run (a burst spans many superseded runs),
 * so it is owned by the hook and passed timestamps — pure and unit-testable, like
 * `pinBottomRun.ts`.
 */

/**
 * Two content-arrival pins landing within this window count as a burst; while a
 * burst is live, forced repaints are suppressed. Sized a touch above the pin
 * loop's settle time (8 frames ≈ 133ms) so that "arrival stopped long enough for
 * the loop to converge" reliably implies "burst window expired", letting the
 * convergence own the single trailing repaint.
 */
export const PIN_BURST_WINDOW_MS = 200

/** Summary of a coalesced burst, emitted on the trailing repaint for fluux.log. */
export interface PinBurstSummary {
  /** Content-arrival pins observed during the burst (the first one still painted). */
  triggers: number
  /** Forced repaints suppressed by the burst — each ~50–150ms of WebKitGTK freeze avoided. */
  suppressedRepaints: number
  /** Wall-clock span from the first to the last arrival in the burst. */
  spanMs: number
}

export interface PinRepaintBurst {
  /**
   * Record a content-arrival pin (new-message / content-growth / media-load /
   * reaction / mam-catchup-complete). Call at the top of `pinVirtualizedBottom`
   * for those triggers — BEFORE it supersedes the running loop — so every arrival
   * is counted even though its run may be immediately replaced.
   */
  note(now: number): void
  /**
   * Should this frame's forced repaint be suppressed because a burst is in
   * progress? True once ≥2 arrivals have landed within {@link PIN_BURST_WINDOW_MS}
   * and the most recent is still inside the window. The very first arrival of a
   * burst is NOT suppressed, so an isolated single message still paints promptly.
   */
  suppress(now: number): boolean
  /** Note that a forced repaint was skipped due to the burst (a trailing paint is now owed). */
  markSuppressed(): void
  /** Whether a trailing repaint is owed (repaints were suppressed since the last settle). */
  owed(): boolean
  /**
   * Consume the owed trailing repaint: clears the owed flag and returns the burst
   * summary for the probe line. Call from the pin loop's convergence / frames-
   * exhausted path right before forcing the one final repaint.
   */
  settle(): PinBurstSummary
  /** Drop all burst state (conversation switch, user-scroll takeover). */
  reset(): void
}

export function createPinRepaintBurst(
  opts: { windowMs?: number } = {}
): PinRepaintBurst {
  const windowMs = opts.windowMs ?? PIN_BURST_WINDOW_MS

  let firstNoteAt: number | null = null
  let lastNoteAt: number | null = null
  let triggers = 0
  let suppressedRepaints = 0
  let owedRepaint = false

  const active = (now: number): boolean =>
    lastNoteAt !== null && triggers >= 2 && now - lastNoteAt < windowMs

  return {
    note(now: number): void {
      if (lastNoteAt !== null && now - lastNoteAt >= windowMs) {
        // The previous burst went quiet long enough to end; this arrival starts a
        // fresh one. (A trailing repaint owed by the old burst is left owed for the
        // converging loop to flush.)
        firstNoteAt = now
        triggers = 1
      } else {
        if (firstNoteAt === null) firstNoteAt = now
        triggers++
      }
      lastNoteAt = now
    },

    suppress(now: number): boolean {
      return active(now)
    },

    markSuppressed(): void {
      suppressedRepaints++
      owedRepaint = true
    },

    owed(): boolean {
      return owedRepaint
    },

    settle(): PinBurstSummary {
      const summary: PinBurstSummary = {
        triggers,
        suppressedRepaints,
        spanMs:
          firstNoteAt !== null && lastNoteAt !== null
            ? Math.round(lastNoteAt - firstNoteAt)
            : 0,
      }
      firstNoteAt = null
      lastNoteAt = null
      triggers = 0
      suppressedRepaints = 0
      owedRepaint = false
      return summary
    },

    reset(): void {
      firstNoteAt = null
      lastNoteAt = null
      triggers = 0
      suppressedRepaints = 0
      owedRepaint = false
    },
  }
}

/** One fluux.log line attributing a coalesced burst (emitted on the trailing repaint). */
export function pinBurstProbeLine(trigger: string, summary: PinBurstSummary): string {
  return (
    `[PinBurstProbe] burst settled: trigger=${trigger} arrivals=${summary.triggers} ` +
    `suppressedRepaints=${summary.suppressedRepaints} spanMs=${summary.spanMs} trailingRepaint=1`
  )
}
