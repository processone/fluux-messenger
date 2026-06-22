/**
 * Diagnostic-only probe for SLOW message-list renders.
 *
 * The stall sentinel (`stallSentinel.ts`) quantifies *that* the main thread
 * blocked, but cannot attribute the cost. On WebKitGTK the prime suspect for a
 * multi-second room-entry stall is mounting/laying out the non-virtualized
 * message backlog (up to 1000 rich rows). This probe brackets that work and
 * splits it into two halves so the next freeze in fluux.log says WHICH:
 *
 * - `react` — render-start → layout-effect: React reconciliation + commit
 *   (DOM mutation) of the message subtree. A render-window cap reduces this.
 * - `layoutPaint` — layout-effect → next rAF: the browser's layout/paint of
 *   the committed DOM. `content-visibility` reduces this; a render cap reduces
 *   both.
 *
 * Like the other monitors it never throttles or changes behaviour: it only
 * tells the caller "this render was slow enough to log", rate-limited so a
 * sustained slowdown produces one line per cooldown rather than one per render.
 * The caller assembles the context (row count, conversation) on the warn path
 * only.
 *
 * Pure threshold + cooldown logic, timestamps passed in, unit-testable.
 */
export interface RenderCostProbe {
  /**
   * Record one render whose total cost was `totalMs`, observed at `now` (ms,
   * monotonic e.g. performance.now()). Returns true when the caller should log
   * a diagnostic line (cost ≥ threshold and cooldown elapsed).
   */
  record(totalMs: number, now: number): boolean
}

export interface RenderCostProbeOptions {
  /** Renders taking at least this long are reportable. */
  thresholdMs?: number
  /** Minimum gap between two reports, so a sustained slowdown logs once. */
  cooldownMs?: number
}

// A list render over ~200ms is well past the frame budget and worth attributing;
// normal updates (typing, a single new message) stay far below it.
const DEFAULT_THRESHOLD_MS = 200
const DEFAULT_COOLDOWN_MS = 5000

export function createRenderCostProbe(
  opts: RenderCostProbeOptions = {}
): RenderCostProbe {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS

  let lastReportAt = Number.NEGATIVE_INFINITY

  return {
    record(totalMs: number, now: number): boolean {
      if (totalMs < thresholdMs) return false
      if (now - lastReportAt < cooldownMs) return false
      lastReportAt = now
      return true
    },
  }
}
