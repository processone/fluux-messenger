/**
 * The seam between the always-present diagnostic sentinels and the dev-only
 * anomaly tree.
 *
 * The sentinels live in production code — `useMessageListScroll` and
 * `stallSentinel` ship in every build, because their `console.warn` prose is the
 * troubleshooting path in `fluux.log`. They must therefore never import anything
 * under `src/anomaly/`: a static import would put the recorder, the serializer and
 * the token layer into the release bundle, which is precisely what the build audit
 * forbids.
 *
 * So the direction is INVERTED. This module holds a nullable handler that the
 * anomaly runtime installs into. In a release build nothing ever registers, so
 * `signalAnomaly` is a null check on a path that is already rate-limited to once
 * per five seconds — and no anomaly module is reachable from here.
 *
 * This is fan-out, not re-pointing: every caller emits its prose exactly as before
 * and signals IN ADDITION. Nothing is removed from `fluux.log`.
 *
 * @module Utils/AnomalySignal
 */

/**
 * One observation, as the sentinel that made it describes it.
 *
 * A discriminated union rather than a bag of optional fields: the anomaly side
 * must map each case to a specific invariant id with the right `expected` and
 * `observed`, and a shared shape would let a new case silently arrive with
 * neither.
 *
 * `name` is deliberately the invariant id verbatim. It is not the id CONSTANT —
 * that lives in `values.ts`, which this module may not import — so the two are
 * held in parity by a test rather than by construction.
 */
export type AnomalySignal =
  | {
      name: 'scroll/reassert-overlap'
      /** Concurrently active re-assert loops. */
      active: number
      /** Count at or above which the monitor reports. */
      threshold: number
    }
  | {
      name: 'scroll/reassert-nonconverging'
      /** The loop's kind, e.g. `prepend`. Mapped to a TAG constant, or dropped. */
      label: string
      /** Cumulative scroll writes by this one loop. */
      writes: number
      threshold: number
    }
  | {
      name: 'scroll/resize-loop'
      /** Observer fires counted in the window. */
      fires: number
      threshold: number
      /** Length of the window the fires were counted over. */
      elapsedMs: number
    }
  | {
      name: 'scroll/slow-correction'
      durationMs: number
      thresholdMs: number
      /** Rendered rows — the reflow cost scales with them, so this is the driver. */
      rows: number
    }
  | {
      name: 'perf/main-thread-stall'
      /** How long the main thread was blocked, beyond the expected tick gap. */
      blockedMs: number
      thresholdMs: number
    }

export type AnomalySignalHandler = (signal: AnomalySignal) => void

let handler: AnomalySignalHandler | null = null

/**
 * Route signals to the anomaly runtime.
 *
 * Last registration wins. The runtime is a module-level singleton installed
 * behind a refcount, so a StrictMode remount re-registers the same handler rather
 * than stacking two.
 */
export function setAnomalySignalHandler(fn: AnomalySignalHandler): void {
  handler = fn
}

/** Stop routing. Signals become no-ops again. */
export function clearAnomalySignalHandler(): void {
  handler = null
}

/**
 * Report one observation, if anything is listening.
 *
 * Never throws: a detector bug on the anomaly side must not take down the scroll
 * loop that reported it, and the resulting silence is visible anyway — the
 * recorder's own `rejected-value` counter is the intended channel for a malformed
 * record, and a thrown handler is a strictly worse version of the same bug.
 */
export function signalAnomaly(signal: AnomalySignal): void {
  if (!handler) return
  try {
    handler(signal)
  } catch (err) {
    console.warn(`[Anomaly] signal handler threw: ${String(err)}`)
  }
}

/** Test-only: is anything listening? */
export function hasAnomalySignalHandler(): boolean {
  return handler !== null
}
