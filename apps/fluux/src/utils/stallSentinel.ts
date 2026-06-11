/**
 * Main-thread stall sentinel.
 *
 * A heartbeat interval compares the expected tick gap against the wall clock.
 * When the main thread is blocked (long reflow, sync loop, render storm), the
 * timer fires late — the overshoot IS the blocked duration. This catches ANY
 * freeze class, including ones with no React render and no observer involved,
 * and turns "the app half-froze" reports into quantified events in fluux.log:
 * how long, how often, and on which route.
 *
 * Background throttling guard: browsers clamp timers in hidden windows, which
 * looks exactly like a stall. Ticks while hidden are ignored, and the first
 * visible tick only re-baselines.
 *
 * Pure tick logic (timestamps and visibility passed in) for unit testing;
 * `startStallSentinel` wires it to setInterval + document.hidden.
 */
export interface StallSentinel {
  /**
   * Record one heartbeat at `now` (ms, monotonic). Returns a log line when a
   * stall is detected (rate-limited), null otherwise.
   */
  tick(now: number, hidden: boolean): string | null
}

export interface StallSentinelOptions {
  /** Heartbeat period. */
  intervalMs?: number
  /** Overshoot beyond the period that counts as a stall. */
  stallThresholdMs?: number
  /** Minimum gap between two reports. */
  cooldownMs?: number
  /** Returns extra context appended to the log line (e.g. active route). */
  getContext?: () => string
}

const DEFAULT_INTERVAL_MS = 500
const DEFAULT_STALL_THRESHOLD_MS = 1000
const DEFAULT_COOLDOWN_MS = 5000

export function createStallSentinel(opts: StallSentinelOptions = {}): StallSentinel {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const getContext = opts.getContext

  let lastTickAt: number | null = null
  let needsRebaseline = false
  let lastReportAt = Number.NEGATIVE_INFINITY

  return {
    tick(now: number, hidden: boolean): string | null {
      if (hidden) {
        // Timer clamping in hidden windows mimics a stall — don't evaluate,
        // and make the next visible tick re-baseline instead of comparing
        // against a pre-hide timestamp.
        lastTickAt = now
        needsRebaseline = true
        return null
      }

      if (lastTickAt === null || needsRebaseline) {
        lastTickAt = now
        needsRebaseline = false
        return null
      }

      const gap = now - lastTickAt
      lastTickAt = now

      const blockedMs = gap - intervalMs
      if (blockedMs < stallThresholdMs) return null
      if (now - lastReportAt < cooldownMs) return null
      lastReportAt = now

      const context = getContext ? ` (${getContext()})` : ''
      return (
        `[MainThreadStall] main thread blocked ~${Math.round(blockedMs)}ms` +
        `${context} — heartbeat expected every ${intervalMs}ms, fired after ${Math.round(gap)}ms`
      )
    },
  }
}

/**
 * Start the sentinel on a real interval. Returns a stop function.
 * Log-only: one rate-limited console.warn per detected stall (the Tauri
 * console forwarder ships it to fluux.log).
 */
export function startStallSentinel(opts: StallSentinelOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const sentinel = createStallSentinel({
    getContext: () => `route: ${window.location.hash || '/'}`,
    ...opts,
  })

  const id = setInterval(() => {
    const warning = sentinel.tick(performance.now(), document.hidden)
    if (warning) console.warn(warning)
  }, intervalMs)

  return () => clearInterval(id)
}
