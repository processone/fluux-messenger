/**
 * Opt-in timing for the store operations heavy enough to block a frame.
 *
 * The client's anomaly log can say WHEN the main thread stalled and for how long,
 * never what ran. These marks close that gap for the operations most able to cause
 * one: serialising and writing the stores, and merging an archive page.
 *
 * Emitted as `performance.measure` rather than through a callback so this stays
 * free of any dependency on the consuming app — the SDK cannot import it — and so
 * the same marks appear on a DevTools timeline, where a profile can attribute them
 * without any of this being wired up.
 *
 * Off by default. A consumer embedding the SDK gets no marks and no buffer growth
 * until it asks; `setMeasurementEnabled` is the only way in.
 *
 * @module Utils/Measure
 */

let enabled = false

/** Turn store timing on. Off by default, and safe to call repeatedly. */
export function setMeasurementEnabled(on: boolean): void {
  enabled = on
}

/**
 * Time `fn`, returning whatever it returns.
 *
 * Synchronous on purpose: what matters is the span that BLOCKS the main thread, and
 * awaiting would measure wall-clock across yields the thread was free during.
 */
export function measured<T>(name: string, fn: () => T): T {
  // Node without the global, a hardened embedder, a test that removed it: a
  // diagnostic must never be the reason a store write fails.
  if (!enabled || typeof performance === 'undefined') return fn()

  const startMark = `fluux:${name}:start`
  let marked = false
  try {
    performance.mark(startMark)
    marked = true
  } catch {
    // A dropped mark is not worth a failed store operation.
  }
  try {
    return fn()
  } finally {
    // Only against a mark THIS call made. A previous invocation whose `clearMarks`
    // also failed can leave one behind under the same name, and measuring from it
    // reports a span belonging to neither operation — a diagnostic that lies is
    // worse than one that is absent.
    //
    // In `finally`, so an operation that throws is still measured — a persistence
    // write failing on quota is exactly the slow case worth seeing.
    try {
      if (marked) performance.measure(`fluux:${name}`, startMark)
    } catch {
      // A dropped measure is not worth a thrown store write.
    }
    // The mark has done its job. Measures are cleared by whoever observes them;
    // marks have no reader, so leaving them would grow the buffer for the session.
    try {
      performance.clearMarks(startMark)
    } catch {
      // A leaked mark is bounded by the host and cannot replace the operation result.
    }
  }
}
