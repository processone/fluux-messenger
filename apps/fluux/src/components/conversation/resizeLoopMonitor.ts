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
 * (no `disconnect()`). Content and width corrections are frame-coalesced;
 * same-width viewport shrinks reconcile before paint. This monitor emits a
 * rate-limited log line for either path so feedback remains visible in `fluux.log`.
 *
 * Implemented as a pure, O(1)-per-fire fixed-window counter (no allocation on
 * the hot path — important, since it runs precisely when something is already
 * firing thousands of times per second). Timestamps are passed in so the logic
 * is deterministic and unit-testable.
 */
import type { AnomalySignal } from '@/utils/anomalySignal'

/**
 * A detected runaway.
 *
 * `message` is the prose line shared with `fluux.log`; the numeric fields ride
 * alongside it so the dev-only anomaly log can record the observation without re-parsing
 * the prose. See `src/utils/anomalySignal.ts`.
 */
export interface ResizeLoopWarning {
  message: string
  /** Observer fires counted in this window. */
  fires: number
  /** Count above which a window is a runaway. */
  threshold: number
  /** How long the counted window actually ran. */
  elapsedMs: number
}

export interface ResizeLoopMonitor {
  /**
   * Record one observer fire at `now` (ms, monotonic e.g. performance.now()).
   * Returns a warning once per cooldown when a runaway is detected, or null
   * otherwise.
   */
  record(now: number): ResizeLoopWarning | null
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
    record(now: number): ResizeLoopWarning | null {
      if (!started || now - windowStart > windowMs) {
        windowStart = now
        count = 0
        started = true
      }
      count++

      if (count > threshold && now - lastWarnAt >= cooldownMs) {
        lastWarnAt = now
        const elapsed = Math.max(1, Math.round(now - windowStart))
        return {
          message:
            `[ScrollResizeLoop] message-list ResizeObserver fired ${count} times in ${elapsed}ms ` +
            `(threshold ${threshold}/${windowMs}ms) — likely a WebKitGTK scroll-correction feedback loop. ` +
            `This log is a diagnostic only.`,
          fires: count,
          threshold,
          elapsedMs: elapsed,
        }
      }
      return null
    },
  }
}

/**
 * Translate a warning into the signal the anomaly log records.
 *
 * Lives here rather than at the call site because there are TWO observers using
 * this monitor — the content one and the scroller one — and a mapping written
 * twice is a mapping that can disagree with itself. This also lets the translation
 * have a unit test independent of the observers' scheduling and positioning work.
 */
export function resizeLoopSignal(warning: ResizeLoopWarning): AnomalySignal {
  return {
    name: 'scroll/resize-loop',
    fires: warning.fires,
    threshold: warning.threshold,
    elapsedMs: warning.elapsedMs,
  }
}
