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
 * A scrollport losing height is the same shape: the resize hook measures the loss and
 * the distance it left behind, and only a clock can tell a frame of settling from a
 * shortfall nothing came back for.
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
 * source owns what "at the bottom" means, and a detector inventing its own number
 * would judge it against a rule it does not follow.
 */
export type AnomalyObservation =
  | {
      kind: 'live-edge-pin-settled'
      conversationId: string
      /** Distance still remaining when the run reached `settled`. */
      distFromBottom: number
      /** The executor's own at-bottom threshold. */
      thresholdPx: number
    }
  | {
      /**
       * The scrollport lost height — the typing band mounting or wrapping, the composer
       * growing, the window shrinking.
       *
       * This direction has no engine backstop: the browser's clamp only ever LOWERS
       * `scrollTop`, so a reader who was at the live edge is left exactly this far short
       * of it and stays there until the app re-pins or the reader scrolls. A settle
       * cannot report it because in the failing case no run starts at all.
       */
      kind: 'scrollport-shrank'
      conversationId: string
      /** Height the scrollport lost in this resize. */
      shrunkPx: number
      /** Distance to the content bottom, measured after the shrink and before any re-pin. */
      distFromBottom: number
      /** Content height at the shrink, used to isolate later content growth. */
      scrollHeight: number
      /** Whether the requested re-pin ran, was refused, or was not needed. */
      repin: 'ran' | 'refused' | null
      /** The hook's own at-bottom tolerance, so the detector never invents one. */
      tolerancePx: number
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
