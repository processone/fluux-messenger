/**
 * The neutral counting seam into the dev-only anomaly runtime.
 *
 * Separate from `anomalySignal` on purpose. A signal is a VERDICT — the anomaly side
 * maps each case to an invariant id with its own severity, expected and observed —
 * while these are quantities with no opinion attached. Folding them into one union
 * would put entries in it that no record can be built from, and every new signal
 * case would have to explain why it is not one.
 *
 * Same inversion as that seam, for the same reason: the call sites ship in every
 * build, so they must never import anything under `src/anomaly/`. A release build
 * registers nothing and `countAnomalyMetric` is a null check — and the hot call
 * sites additionally guard on `__FLUUX_ANOMALY__`, so the call itself is eliminated
 * rather than merely cheap.
 *
 * @module Utils/AnomalyMetric
 */

/**
 * A metric the app can count.
 *
 * A closed union rather than a string: these become counter names in the log, and
 * the registries exist so a free string can never become one. Held in parity with
 * the `METRIC` constants by a test, since this module may not import `values.ts`.
 */
export type AnomalyMetricName = 'render.MessageList' | 'scroll.writes' | 'scroll.positioningOps'

type Handler = (metric: AnomalyMetricName, by: number) => void

let handler: Handler | null = null

export function setAnomalyMetricHandler(next: Handler): void {
  handler = next
}

export function clearAnomalyMetricHandler(): void {
  handler = null
}

/** Count one occurrence. Never throws — a counting fault must not break a render. */
export function countAnomalyMetric(metric: AnomalyMetricName, by = 1): void {
  if (!handler) return
  try {
    handler(metric, by)
  } catch {
    // Swallowed for the same reason as `signalAnomaly`: these call sites sit in the
    // render path and the scroll frame loop, and a diagnostic that can break either
    // is worse than no diagnostic. The recorder surfaces its own faults by counter.
  }
}
