/**
 * The neutral seam for a raw OBSERVATION, as opposed to a verdict.
 *
 * `anomalySignal.ts` carries verdicts: every case is named for the invariant id it
 * becomes, and `signalRecords.ts` translates it with no decision of its own. That
 * contract is worth keeping, and it does not fit a fact that still needs confirming.
 *
 * A live-edge pin settling short of the bottom is such a fact. The executor knows it
 * and has already measured it, but a single short settle is ordinary — a smooth scroll
 * still animating, a commit a frame behind the DOM. Only a dev-only detector holding a
 * clock can tell that apart, so what crosses here is the measurement, not a claim.
 *
 * Same inversion and same cost as the verdict seam: the executor ships in release
 * builds and must never import anything under `src/anomaly/`, so this module holds a
 * nullable handler that the anomaly runtime installs into. In a release build nothing
 * ever registers and `observeAnomaly` is a null check.
 *
 * @module Utils/AnomalyObservation
 */

/**
 * One measured fact, as its source measured it.
 *
 * Thresholds travel WITH the fact rather than being restated on the anomaly side: the
 * executor owns what "at the bottom" means, and a detector inventing its own number
 * would judge the executor against a rule the executor does not follow.
 */
export type AnomalyObservation = {
  kind: 'live-edge-pin-settled'
  conversationId: string
  /** Distance still remaining when the run reached `settled`. */
  distFromBottom: number
  /** The executor's own at-bottom threshold. */
  thresholdPx: number
}

export type AnomalyObservationHandler = (observation: AnomalyObservation) => void

let handler: AnomalyObservationHandler | null = null

/** Last registration wins, matching the verdict seam's refcounted install. */
export function setAnomalyObservationHandler(fn: AnomalyObservationHandler): void {
  handler = fn
}

/** Stop routing. Observations become no-ops again. */
export function clearAnomalyObservationHandler(): void {
  handler = null
}

/**
 * Is anything listening.
 *
 * Exported so a caller can skip BUILDING an observation, not merely skip delivering
 * one. `observeAnomaly` alone would still cost the argument's allocation on every
 * settled pin run — which is every message that lands while the reader is at the
 * bottom. In a release build this is a constant `false`.
 */
export function hasAnomalyObservationHandler(): boolean {
  return handler !== null
}

/**
 * Report one measurement, if anything is listening.
 *
 * Never throws: a detector bug on the anomaly side must not take down the pin loop
 * that reported it.
 */
export function observeAnomaly(observation: AnomalyObservation): void {
  if (!handler) return
  try {
    handler(observation)
  } catch {
    // Swallowed on purpose — see above.
  }
}
