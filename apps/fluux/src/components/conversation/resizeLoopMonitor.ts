/**
 * Diagnostic-only monitor for a runaway ResizeObserver → scroll-correction
 * loop.
 *
 * Background: on WebKitGTK (Linux/Tauri) a `<video controls>` (or other
 * oscillating content) can change height continuously, firing the message
 * list's content ResizeObserver hundreds of times per second. That is a pure
 * main-thread loop with NO React render, so `renderLoopDetector` (React-only)
 * never sees it — the app just "freezes while reading", with nothing in the
 * logs.
 *
 * This monitor makes that failure mode VISIBLE. It does NOT break the loop
 * (no `disconnect()`); the rAF-coalescing of the correction already bounds the
 * expensive work to once per frame. It only emits a single, rate-limited log
 * line so the loop class finally shows up in `fluux.log`.
 *
 * Implemented as a pure, O(1)-per-fire fixed-window counter (no allocation on
 * the hot path — important, since it runs precisely when something is already
 * firing thousands of times per second). Timestamps are passed in so the logic
 * is deterministic and unit-testable.
 */
export interface ResizeLoopMonitor {
  /**
   * Record one observer fire at `now` (ms, monotonic e.g. performance.now()).
   * Returns a warning string to log once per cooldown when a runaway is
   * detected, or null otherwise.
   */
  record(now: number): string | null
}

export interface ResizeLoopMonitorOptions {
  /** Fires within `windowMs` above this count are considered a runaway. */
  threshold?: number
  /** Sliding-ish window length in ms. */
  windowMs?: number
  /** Minimum gap between two warnings, so a sustained loop logs once. */
  cooldownMs?: number
}

export function createResizeLoopMonitor(opts: ResizeLoopMonitorOptions = {}): ResizeLoopMonitor {
  // Defaults: >60 fires in 1s = sustained faster-than-one-per-frame churn,
  // which never happens during normal scrolling but is the signature of the
  // WebKitGTK feedback loop. Warn at most every 5s.
  const threshold = opts.threshold ?? 60
  const windowMs = opts.windowMs ?? 1000
  const cooldownMs = opts.cooldownMs ?? 5000

  let windowStart = 0
  let count = 0
  let started = false
  let lastWarnAt = Number.NEGATIVE_INFINITY

  return {
    record(now: number): string | null {
      if (!started || now - windowStart > windowMs) {
        windowStart = now
        count = 0
        started = true
      }
      count++

      if (count > threshold && now - lastWarnAt >= cooldownMs) {
        lastWarnAt = now
        const elapsed = Math.max(1, Math.round(now - windowStart))
        return (
          `[ScrollResizeLoop] message-list ResizeObserver fired ${count} times in ${elapsed}ms ` +
          `(threshold ${threshold}/${windowMs}ms) — likely a WebKitGTK scroll-correction feedback loop. ` +
          `Scroll correction is rAF-coalesced; this log is a diagnostic only.`
        )
      }
      return null
    },
  }
}
