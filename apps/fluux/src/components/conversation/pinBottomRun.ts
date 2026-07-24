/**
 * Per-run browser-work helpers for the controller-owned live-edge executor.
 *
 * On WebKitGTK the pin's forced layouts (`flushTailLayout`) and forced repaints
 * (`forceRepaint`'s overflow toggle) are the dominant main-thread cost in busy
 * rooms — RenderCostProbe shows layoutPaint 189–359ms with react as low as 2ms.
 * These helpers make the pin loop (a) converge and stop early instead of always
 * burning its full frame budget, (b) skip the full-scroller repaint when the pin
 * did not actually move scrollTop, and (c) attribute the remaining forced work in
 * fluux.log with a single `[PinLoopProbe]` line per costly run.
 *
 * Pure logic — timestamps and storage are passed in, unit-testable.
 */

/**
 * Consecutive stable (non-write) frames before a pin run is declared settled and
 * its rAF loop stops. Matches the marker/restore stability precedent
 * (MARKER_STABLE_FRAMES / RESTORE_STABLE_FRAMES = 8): flushTailLayout forces
 * WebKit's late row measurements through on every frame, so 8 frames with no
 * height change and the list at the bottom means layout has genuinely settled.
 */
const PIN_SETTLED_FRAMES = 8

/**
 * When to force the full-scroller repaint (the `overflowY` toggle) after a pin:
 * - 'on-write' (default): only when the pin actually moved scrollTop — the WebKit
 *   stale-paint bug is specific to programmatic scrolls, so a no-op pin needs no
 *   repaint and skipping it removes the most expensive step on WebKitGTK.
 * - 'always' / 'off': on-device A/B escape hatches (localStorage
 *   `fluux:pin-repaint`) to validate the gating on the real Linux build.
 *
 * `suppressForBackgroundLoad` additionally skips the repaint while a MAM catch-up (or
 * "load older") query is in flight for the conversation. A catch-up can page in dozens of
 * merges over 1-2s, each moving scrollTop; forcing a repaint on every single one is the
 * forced-layout/repaint storm PR #860 already had to cut down for the measurement-settle
 * case. WebKit isn't painting those intermediate positions anyway without the forced
 * toggle, so nothing visible is lost — the caller is responsible for forcing one final
 * repaint once the load completes. 'always' still wins (on-device A/B must stay unconditional).
 */
export type PinRepaintMode = 'on-write' | 'always' | 'off'

export function readPinRepaintMode(
  storage: Pick<Storage, 'getItem'> | undefined
): PinRepaintMode {
  try {
    const value = storage?.getItem('fluux:pin-repaint')
    if (value === 'always' || value === 'off') return value
  } catch {
    // storage unavailable (privacy mode) — fall through to the default
  }
  return 'on-write'
}

export function shouldForceRepaint(
  scrollTopMoved: boolean,
  mode: PinRepaintMode,
  suppressForBackgroundLoad = false
): boolean {
  if (mode === 'always') return true
  if (mode === 'off') return false
  return scrollTopMoved && !suppressForBackgroundLoad
}

/** Forced-work categories a pin run accumulates for the probe line. */
export type PinWorkKind = 'flush' | 'scroll' | 'repaint'

export interface PinRunTracker {
  /**
   * Record one loop frame. `wrote` is true when the frame re-pinned (height
   * moved or the list was measurably off the bottom). Returns 'settled' once
   * the run has been stable for the configured number of consecutive frames.
   */
  frame(wrote: boolean): 'continue' | 'settled'
  /** Accumulate forced-work time (ms) of one kind. */
  addMs(kind: PinWorkKind, ms: number): void
  /** Total forced-work ms across all kinds. */
  totalForcedMs(): number
  /** One fluux.log line attributing this run's forced work. */
  summaryLine(trigger: string): string
}

export function createPinRunTracker(
  opts: { settledFrames?: number } = {}
): PinRunTracker {
  const settledFrames = opts.settledFrames ?? PIN_SETTLED_FRAMES

  let frames = 0
  let writes = 0
  let stableStreak = 0
  const ms: Record<PinWorkKind, number> = { flush: 0, scroll: 0, repaint: 0 }
  const totalForcedMs = () => ms.flush + ms.scroll + ms.repaint

  return {
    frame(wrote: boolean): 'continue' | 'settled' {
      frames++
      if (wrote) {
        writes++
        stableStreak = 0
        return 'continue'
      }
      stableStreak++
      return stableStreak >= settledFrames ? 'settled' : 'continue'
    },

    addMs(kind: PinWorkKind, value: number): void {
      ms[kind] += value
    },

    totalForcedMs,

    summaryLine(trigger: string): string {
      return (
        `[PinLoopProbe] pin-bottom run: trigger=${trigger} frames=${frames} writes=${writes} ` +
        `flush=${Math.round(ms.flush)}ms scroll=${Math.round(ms.scroll)}ms ` +
        `repaint=${Math.round(ms.repaint)}ms total=${Math.round(totalForcedMs())}ms`
      )
    },
  }
}
