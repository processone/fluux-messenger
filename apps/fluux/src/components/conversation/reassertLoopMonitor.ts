/**
 * Diagnostic-only monitor for the message list's rAF-driven scroll re-assert
 * loops.
 *
 * Background: useMessageListScroll keeps the virtualized list pinned to the
 * right place by RE-ASSERTING a scroll target across several frames as rows
 * measure asynchronously — the live-edge executor (stick to bottom), the
 * controller-owned unread-marker reconciliation, and the directional-history
 * executor (anchor restore). Each is a `requestAnimationFrame` loop
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
export interface ReassertLoopHandle {
  /**
   * Record one frame of this loop at `now` (ms, monotonic e.g.
   * performance.now()). `wrote` is true when this frame issued a scroll write
   * (scrollToOffset/scrollToIndex). Returns a warning string to log (overlap
   * takes priority over non-converging), or null.
   */
  frame(now: number, wrote: boolean): string | null
  /** Mark this loop finished. Idempotent — a double call cannot drop a sibling. */
  end(): void
}

export interface ReassertLoopMonitor {
  /** Register the start of a re-assert loop; `label` names the loop kind. */
  begin(label: string, now: number): ReassertLoopHandle
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

export function createReassertLoopMonitor(
  opts: ReassertLoopMonitorOptions = {},
): ReassertLoopMonitor {
  // Defaults: 2 concurrent loops is already an overlap (they fight over
  // scrollTop). A healthy loop writes only a few times before it settles, so >40
  // cumulative writes (it runs at most ~120 frames) means it never converged.
  const overlapThreshold = opts.overlapThreshold ?? 2
  const writeThreshold = opts.writeThreshold ?? 40
  const cooldownMs = opts.cooldownMs ?? 5000

  // Active loops by monotonically-increasing id, so two loops sharing a label
  // (two concurrent prepends — the prime suspect) are still counted separately
  // and a double end() cannot remove the wrong one.
  const active = new Map<number, string>()
  let nextId = 1
  let lastOverlapWarnAt = Number.NEGATIVE_INFINITY

  return {
    begin(label: string, _now: number): ReassertLoopHandle {
      const id = nextId++
      active.set(id, label)
      let writeCount = 0
      let lastHotWarnAt = Number.NEGATIVE_INFINITY

      return {
        frame(now: number, wrote: boolean): string | null {
          if (wrote) writeCount++

          // OVERLAP (checked first — a fight between loops is the worse signal).
          if (active.size >= overlapThreshold && now - lastOverlapWarnAt >= cooldownMs) {
            lastOverlapWarnAt = now
            const labels = Array.from(active.values()).sort().join(', ')
            return (
              `[ScrollReassertLoop] ${active.size} message-list scroll re-assert loops active ` +
              `concurrently (${labels}) — they fight over scrollTop. Likely a WebKit-only ` +
              `overlap (e.g. a second MAM prepend before the first re-assert finished). ` +
              `Diagnostic only; loops are not cancelled.`
            )
          }

          // NON-CONVERGING — one loop keeps writing instead of settling.
          if (writeCount > writeThreshold && now - lastHotWarnAt >= cooldownMs) {
            lastHotWarnAt = now
            return (
              `[ScrollReassertLoop] the '${label}' scroll re-assert loop has issued ` +
              `${writeCount} scroll writes without settling (threshold ${writeThreshold}) — ` +
              `it is not converging on a stable anchor. Diagnostic only; loop is not cancelled.`
            )
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
