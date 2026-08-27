/**
 * Diagnostic-only monitor for the message list's rAF-driven scroll re-assert
 * loops.
 *
 * Background: the message-list positioning executors keep the virtualized list
 * pinned to the right place by RE-ASSERTING a scroll target across several
 * frames as rows measure asynchronously — the live-edge executor (stick to
 * bottom), the controller-owned unread-marker reconciliation, and the
 * directional-history executor (anchor restore). Each is a `requestAnimationFrame` loop
 * that calls the virtualizer's `scrollToOffset`/`scrollToIndex`, which re-windows
 * and re-renders.
 *
 * In the happy path each loop writes the scroll position only a handful of times
 * (until the anchor stabilises) and then idles out its remaining frames. Two
 * failure modes produce a "scroll keeps looping" feel that the other monitors
 * miss — they are WebKit-only and frame-coupled, so neither the headless preview
 * harness nor `resizeLoopMonitor` (ResizeObserver frequency) nor
 * `renderLoopDetector` (a programmatic re-assert is not user input, so it never
 * arms the interaction grace) reliably surfaces them:
 *
 *  1. NON-CONVERGING — a single loop writes the scroll on (nearly) every frame
 *     instead of settling, e.g. two anchors disagree by more than the tolerance
 *     and it ping-pongs.
 *  2. OVERLAP — two re-assert loops are alive at the same time and fight over
 *     scrollTop. This historically happened when a second MAM prepend started an
 *     unleased loop against a different anchor while the first ~1s loop remained.
 *
 * Like resizeLoopMonitor/slowCorrectionMonitor this NEVER cancels or throttles a
 * loop; it only emits a single rate-limited log line so the loop class finally
 * shows up in `fluux.log` on the real Tauri/WebKitGTK build. Pure, O(1) per
 * frame, timestamps passed in so it is deterministic and unit-testable.
 */
import type { AnomalySignal } from '@/utils/anomalySignal'
import { countAnomalyMetric } from '@/utils/anomalyMetric'

/**
 * Every loop kind the message list can start.
 *
 * A closed union rather than `string`, so adding a tenth loop is a COMPILE error
 * everywhere the set matters — in particular the anomaly fan-out's label table.
 * Three of these labels reach `begin()` through a variable rather than a literal, so
 * a source grep cannot enumerate them; only the type can.
 */
export type ReassertLoopLabel =
  | 'pin-bottom'
  | 'media-anchor'
  | 'divider-anchor'
  | 'insertion-anchor'
  | 'prepend'
  | 'restore-anchor'
  | 'marker'
  | 'target'
  | 'resident-top'

/**
 * A detected loop failure.
 *
 * `message` is the prose line, assembled here so it stays byte-identical to what
 * `fluux.log` has always carried; the discriminated fields ride alongside so the
 * dev-only anomaly log can record the observation structurally rather than by
 * re-parsing the prose. See `src/utils/anomalySignal.ts`.
 */
export type ReassertLoopWarning =
  | {
      message: string
      reason: 'overlap'
      /** Loops alive at the same time, all fighting over scrollTop. */
      active: number
      threshold: number
    }
  | {
      message: string
      reason: 'non-converging'
      /** The loop kind that failed to settle. */
      label: ReassertLoopLabel
      /** Cumulative scroll writes issued by this one loop. */
      writes: number
      threshold: number
    }

export interface ReassertLoopHandle {
  /**
   * Record one frame of this loop at `now` (ms, monotonic e.g.
   * performance.now()). `wrote` is true when this frame issued a scroll write
   * (scrollToOffset/scrollToIndex). Returns a warning to log (overlap takes
   * priority over non-converging), or null.
   */
  frame(now: number, wrote: boolean): ReassertLoopWarning | null
  /** Mark this loop finished. Idempotent — a double call cannot drop a sibling. */
  end(): void
}

export interface ReassertLoopMonitor {
  /**
   * Register the start of a re-assert loop; `label` names the loop kind.
   *
   * `frameBudget` is how many frames this loop may run before it gives up. The
   * non-converging threshold is derived from it, because a fixed count cannot
   * mean the same thing to a loop bounded at 30 frames and one bounded at 120.
   * Omit it and the flat `writeThreshold` applies.
   */
  begin(
    label: ReassertLoopLabel,
    now: number,
    frameBudget?: number,
  ): ReassertLoopHandle
  /** Labels of the currently-active loops (for tests/diagnostics). */
  activeLabels(): string[]
}

export interface ReassertLoopMonitorOptions {
  /** Concurrent active loops at or above this count are an overlap. */
  overlapThreshold?: number
  /** Cumulative scroll writes by one loop above this count = non-converging. */
  writeThreshold?: number
  /** Minimum gap between two warnings (per kind), so a sustained issue logs once. */
  cooldownMs?: number
}

/**
 * A loop writing on more than this fraction of its frame budget is not converging.
 * One third reproduces the long-standing 40 for the 120-frame loops it was tuned
 * against, and carries the same meaning to the shorter ones.
 */
const WRITES_PER_FRAME_BUDGET = 3

export function createReassertLoopMonitor(
  opts: ReassertLoopMonitorOptions = {},
): ReassertLoopMonitor {
  // 2 concurrent loops is already an overlap (they fight over scrollTop).
  //
  // Non-converging is a RATIO, not a count: a healthy loop writes a few times and
  // then idles out its budget, so writing on more than a third of the frames it
  // was given means it never converged. A flat count could not say that for every
  // loop — the frame budgets span 30 to 120, so 40 was unreachable for the
  // 30-frame explicit-target loop and lenient for the 120-frame ones.
  const overlapThreshold = opts.overlapThreshold ?? 2
  const flatWriteThreshold = opts.writeThreshold ?? 40
  const cooldownMs = opts.cooldownMs ?? 5000

  // Active loops by monotonically-increasing id, so two loops sharing a label
  // (two concurrent prepends — the prime suspect) are still counted separately
  // and a double end() cannot remove the wrong one.
  const active = new Map<number, string>()
  let nextId = 1
  let lastOverlapWarnAt = Number.NEGATIVE_INFINITY

  return {
    begin(
      label: ReassertLoopLabel,
      _now: number,
      frameBudget?: number,
    ): ReassertLoopHandle {
      const writeThreshold =
        frameBudget === undefined
          ? flatWriteThreshold
          : Math.max(1, Math.ceil(frameBudget / WRITES_PER_FRAME_BUDGET))
      const id = nextId++
      active.set(id, label)
      // One loop IS one positioning operation — a live-edge stick, an anchor
      // restore, a jump. It is the denominator that makes the write count mean
      // something: twenty writes across twenty operations is healthy, and across one
      // is the non-converging loop this monitor already warns about.
      if (__FLUUX_ANOMALY__) countAnomalyMetric('scroll.positioningOps')
      let writeCount = 0
      let lastHotWarnAt = Number.NEGATIVE_INFINITY

      return {
        frame(now: number, wrote: boolean): ReassertLoopWarning | null {
          if (wrote) writeCount++
          // Counted here rather than at the scroll call sites: every re-assert write
          // passes through this frame hook, and the call sites are spread across a
          // dozen adapters that would each need their own seam.
          if (__FLUUX_ANOMALY__ && wrote) countAnomalyMetric('scroll.writes')

          // OVERLAP (checked first — a fight between loops is the worse signal).
          if (active.size >= overlapThreshold && now - lastOverlapWarnAt >= cooldownMs) {
            lastOverlapWarnAt = now
            const labels = Array.from(active.values()).sort().join(', ')
            return {
              message:
                `[ScrollReassertLoop] ${active.size} message-list scroll re-assert loops active ` +
                `concurrently (${labels}) — they fight over scrollTop. Likely a WebKit-only ` +
                `overlap (e.g. a second MAM prepend before the first re-assert finished). ` +
                `Diagnostic only; loops are not cancelled.`,
              reason: 'overlap',
              active: active.size,
              threshold: overlapThreshold,
            }
          }

          // NON-CONVERGING — one loop keeps writing instead of settling.
          if (writeCount > writeThreshold && now - lastHotWarnAt >= cooldownMs) {
            lastHotWarnAt = now
            return {
              message:
                `[ScrollReassertLoop] the '${label}' scroll re-assert loop has issued ` +
                `${writeCount} scroll writes without settling (threshold ${writeThreshold}) — ` +
                `it is not converging on a stable anchor. Diagnostic only; loop is not cancelled.`,
              reason: 'non-converging',
              label,
              writes: writeCount,
              threshold: writeThreshold,
            }
          }

          return null
        },
        end(): void {
          active.delete(id)
        },
      }
    },

    activeLabels(): string[] {
      return Array.from(active.values())
    },
  }
}

/**
 * Translate a warning into the signal the anomaly log records.
 *
 * The two failure modes are distinct invariants, so the branch belongs with the
 * monitor that knows them apart rather than at the call site, which is buried
 * inside a rAF loop and cannot be unit-tested.
 */
export function reassertLoopSignal(warning: ReassertLoopWarning): AnomalySignal {
  return warning.reason === 'overlap'
    ? {
        name: 'scroll/reassert-overlap',
        active: warning.active,
        threshold: warning.threshold,
      }
    : {
        name: 'scroll/reassert-nonconverging',
        label: warning.label,
        writes: warning.writes,
        threshold: warning.threshold,
      }
}
