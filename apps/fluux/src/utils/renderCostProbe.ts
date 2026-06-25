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
   *
   * `spannedHidden` flags that the measurement window crossed a page-hidden /
   * OS-sleep boundary, where the render→commit wall clock measures idle time,
   * not render work (e.g. ~18min for 50 rows after a laptop sleep). Such a
   * sample is always discarded, and — being meaningless — does not consume the
   * cooldown, so it never masks the next genuine slow render.
   */
  record(totalMs: number, now: number, spannedHidden?: boolean): boolean
}

export interface RenderCostProbeOptions {
  /** Renders taking at least this long are reportable. */
  thresholdMs?: number
  /** Minimum gap between two reports, so a sustained slowdown logs once. */
  cooldownMs?: number
}

/**
 * App-backgrounding state sampled when a measurement completes. The caller reads
 * these from the DOM (`document.hidden`, `document.hasFocus()`) and tracks
 * `lastBoundaryAt` as the most recent `performance.now()` of any backgrounding
 * transition (`visibilitychange`, window `blur`, or window `focus`).
 */
export interface IdleWindowSample {
  /** performance.now() of the most recent visibility/focus/blur transition. */
  lastBoundaryAt: number
  /** document.hidden at sample time (tab hidden, minimized). */
  isHidden: boolean
  /** document.hasFocus() at sample time (window holds OS focus). */
  hasFocus: boolean
}

/**
 * True when a render's measurement window `[renderStart, sample]` overlapped a
 * period where the app was backgrounded, so the render→commit wall clock counts
 * throttled / suspended idle time (App Nap, window occlusion, OS sleep) rather
 * than render work. Such samples are meaningless and must be discarded.
 *
 * Three ways the window can be tainted:
 * - the page is hidden at sample time (tab switch / minimize), or
 * - the window is unfocused at sample time (another app is in front), or
 * - a visibility/focus/blur transition landed at/after `renderStart` — e.g. the
 *   user blurred mid-render and refocused (focus is back by sample time, so the
 *   boundary timestamp is the only remaining signal).
 *
 * `visibilitychange` alone is insufficient: switching apps on desktop blurs the
 * window WITHOUT hiding the page, so it fires `blur`/`focus` but not
 * `visibilitychange` and leaves `document.hidden` false.
 */
export function spansIdleWindow(renderStart: number, sample: IdleWindowSample): boolean {
  return sample.isHidden || !sample.hasFocus || sample.lastBoundaryAt >= renderStart
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
    record(totalMs: number, now: number, spannedHidden = false): boolean {
      if (spannedHidden) return false
      if (totalMs < thresholdMs) return false
      if (now - lastReportAt < cooldownMs) return false
      lastReportAt = now
      return true
    },
  }
}
