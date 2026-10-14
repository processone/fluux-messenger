/**
 * Main-thread stall sentinel.
 *
 * A heartbeat interval compares the expected tick gap against the wall clock.
 * Focused gaps beyond the threshold are reported as main-thread stalls. Hidden
 * ticks are ignored, and the first visible tick only re-baselines.
 *
 * A visible but unfocused window keeps `document.hidden === false`, yet macOS
 * may defer its timers (#1482). Gaps that started unfocused are informational
 * timer-gap records. Focus alone cannot prove throttling: genuine blocks while
 * unfocused are excluded from main-thread stall anomalies too.
 *
 * Pure tick logic (timestamps and visibility passed in) for unit testing;
 * `startStallSentinel` wires it to setInterval, document.hidden and document.hasFocus().
 */
import { signalAnomaly } from './anomalySignal'

/**
 * A detected late heartbeat.
 *
 * The prose carries the active route, which may contain a conversation JID and
 * must never travel into a structured record.
 */
export interface StallWarning {
  message: string
  /** Heartbeat overshoot beyond the expected tick gap, in milliseconds. */
  blockedMs: number
  /** Overshoot at or above which a late tick is reported. */
  thresholdMs: number
  /**
   * Whether the window held focus when the stalled gap STARTED — the tick before this one,
   * not now. A stall that ends as the reader clicks back in began while unfocused, and it is
   * the beginning that says whether the OS had reason to defer the timer.
   */
  focusedAtStallStart: boolean
}

export interface StallSentinel {
  /**
   * Record one heartbeat at `now` (ms, monotonic). Returns a late-heartbeat
   * report (rate-limited per focus class), null otherwise.
   */
  tick(now: number, hidden: boolean, focused: boolean): StallWarning | null
}

export interface StallSentinelOptions {
  /** Heartbeat period. */
  intervalMs?: number
  /** Overshoot beyond the period that triggers a report. */
  stallThresholdMs?: number
  /** Minimum gap between two reports in the same focus class. */
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
  let lastFocused = true
  let needsRebaseline = false
  const lastReportAt = { focused: Number.NEGATIVE_INFINITY, unfocused: Number.NEGATIVE_INFINITY }

  return {
    tick(now: number, hidden: boolean, focused: boolean): StallWarning | null {
      // Captured before any early return: every path below leaves this as the focus state the
      // NEXT gap started from.
      const focusedAtStallStart = lastFocused
      lastFocused = focused

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
      const reportClass = focusedAtStallStart ? 'focused' : 'unfocused'
      if (now - lastReportAt[reportClass] < cooldownMs) return null
      lastReportAt[reportClass] = now

      const context = getContext ? ` (${getContext()})` : ''
      const prefix = focusedAtStallStart
        ? '[MainThreadStall] main thread blocked'
        : '[UnfocusedTimerGap] heartbeat delayed'
      return {
        message:
          `${prefix} ~${Math.round(blockedMs)}ms` +
          `${context} — heartbeat expected every ${intervalMs}ms, fired after ${Math.round(gap)}ms`,
        blockedMs: Math.round(blockedMs),
        thresholdMs: stallThresholdMs,
        focusedAtStallStart,
      }
    },
  }
}

/**
 * Start the sentinel on a real interval. Returns a stop function.
 * Log-only: rate-limited warnings for focused stalls and informational lines for
 * unfocused timer gaps (the Tauri console forwarder ships them to fluux.log).
 */
export function startStallSentinel(opts: StallSentinelOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const sentinel = createStallSentinel({
    getContext: () => `route: ${window.location.hash || '/'}`,
    ...opts,
  })

  const id = setInterval(() => {
    const warning = sentinel.tick(performance.now(), document.hidden, document.hasFocus())
    if (!warning) return
    if (warning.focusedAtStallStart) console.warn(warning.message)
    else console.info(warning.message)
    // The structured record excludes the route carried by the prose.
    if (__FLUUX_ANOMALY__) {
      signalAnomaly({
        name: warning.focusedAtStallStart ? 'perf/main-thread-stall' : 'perf/unfocused-timer-gap',
        blockedMs: warning.blockedMs,
        thresholdMs: warning.thresholdMs,
        focused: warning.focusedAtStallStart,
      })
    }
  }, intervalMs)

  return () => clearInterval(id)
}
