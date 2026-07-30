/**
 * Diagnostic-only monitor for SLOW message-list scroll corrections.
 *
 * Complements `resizeLoopMonitor` (which counts fire FREQUENCY): on WebKitGTK
 * with a large non-virtualized backlog, each correction's scrollHeight read
 * forces a reflow of the whole message tree, so the observer fires only a few
 * times per second — far under the frequency threshold — while each fire blows
 * the frame budget. That failure mode is invisible to a rate counter; this one
 * measures DURATION instead.
 *
 * Like resizeLoopMonitor it never throttles or disconnects anything: it only
 * tells the caller "this correction was slow enough to log" (rate-limited so a
 * sustained slowdown produces one line per cooldown, not one per frame). The
 * caller assembles the log context (row count, scrollHeight, conversation)
 * lazily — those reads are not free, so they must happen only on the warn path.
 *
 * Pure fixed-window logic, timestamps passed in, unit-testable.
 */
import type { AnomalySignal } from '@/utils/anomalySignal'

/**
 * A reportable correction.
 *
 * Unlike the other monitors this one does NOT carry the prose: the log line needs
 * the row count, the scrollHeight and the conversation, and those reads are not
 * free, so they stay on the caller's warn path where they have always been. What
 * travels back is the threshold that was crossed, which the caller cannot
 * otherwise know once it has been overridden.
 */
export interface SlowCorrectionReport {
  /** The duration at or above which a correction became reportable. */
  thresholdMs: number
}

export interface SlowCorrectionMonitor {
  /**
   * Record one correction that took `durationMs`, finishing at `now` (ms,
   * monotonic e.g. performance.now()). Returns a report when the caller should
   * log a diagnostic line (duration ≥ threshold and cooldown elapsed), else null.
   */
  record(durationMs: number, now: number): SlowCorrectionReport | null
}

export interface SlowCorrectionMonitorOptions {
  /** Corrections taking at least this long are reportable. */
  thresholdMs?: number
  /** Minimum gap between two reports, so a sustained slowdown logs once. */
  cooldownMs?: number
}

// ~2 frames at 60fps: one slow frame happens (GC, decode); two is a pattern.
const DEFAULT_THRESHOLD_MS = 32
const DEFAULT_COOLDOWN_MS = 5000

export function createSlowCorrectionMonitor(
  opts: SlowCorrectionMonitorOptions = {}
): SlowCorrectionMonitor {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS

  let lastReportAt = Number.NEGATIVE_INFINITY

  return {
    record(durationMs: number, now: number): SlowCorrectionReport | null {
      if (durationMs < thresholdMs) return null
      if (now - lastReportAt < cooldownMs) return null
      lastReportAt = now
      return { thresholdMs }
    },
  }
}

/**
 * Translate a report into the signal the anomaly log records.
 *
 * Takes the caller's numbers too, because unlike the other monitors this one
 * never sees them: the duration is measured around the correction and the row
 * count is a warn-path DOM read. Kept here anyway so the mapping is unit-tested
 * rather than living only inside a rAF callback.
 */
export function slowCorrectionSignal(
  report: SlowCorrectionReport,
  durationMs: number,
  rows: number,
): AnomalySignal {
  return {
    name: 'scroll/slow-correction',
    durationMs,
    thresholdMs: report.thresholdMs,
    rows,
  }
}
