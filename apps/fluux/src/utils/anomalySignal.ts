/**
 * The neutral observation seam into the dev-only anomaly runtime.
 *
 * The sentinels live in production code — the message-list scroll subsystem and
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
 * For the always-shipped monitors this is fan-out, not re-pointing: each still emits
 * its prose and signals in addition. Dev-only detectors use the same seam after
 * reaching their own verdicts.
 *
 * @module Utils/AnomalySignal
 */

/**
 * One observation, as its source describes it.
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
  | {
      name: 'recorder/entity-warm-failing'
      /** How many warms in a row had failed when this was reported. */
      consecutiveFailures: number
    }
  | {
      name: 'read-state/unread-survives-focus'
      /** Which conversation, so the record adapter can use the right token namespace. */
      kind: 'conversation' | 'room'
      id: string
      unreadCount: number
      heldMs: number
    }
  | {
      name: 'read-state/unread-persists'
      kind: 'conversation' | 'room'
      id: string
      /** How long it had held when it proved persistent. */
      heldMs: number
      peakUnread: number
    }
  | {
      name: 'read-state/unread-focus-cleared'
      kind: 'conversation' | 'room'
      id: string
      /** How long the episode actually lasted, end to end. */
      heldMs: number
      /** The worst unread count reached while it ran. */
      peakUnread: number
    }
  | {
      name: 'scroll/fab-at-live-edge'
      /** Independently measured — NOT the scroll hook's own at-bottom state. */
      distFromBottom: number
      heldMs: number
    }
  | {
      name: 'scroll/live-edge-pin-short'
      /** The shortfall as the settle measured it, not a later drift. */
      distFromBottom: number
      /** How long it was still there when the tick confirmed it. */
      heldMs: number
    }
  | {
      name: 'scroll/scrollport-shrink-unreconciled'
      /** The shortfall as the shrink measured it, not a later drift. */
      distFromBottom: number
      /** Height the scrollport lost, so the shortfall can be attributed to it. */
      shrunkPx: number
      /** Whether the positioning controller accepted or refused the re-pin. */
      repin: 'ran' | 'refused'
      /** How long it was still there when the tick confirmed it. */
      heldMs: number
    }
  | {
      name: 'scroll/jump-target-miss'
      /** Signed px outside the viewport: negative above, positive below. */
      offBy: number
      /** The target message id, mapped to a session-local ref by the record adapter. */
      messageId: string
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
