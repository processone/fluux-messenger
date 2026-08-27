/**
 * Turn the SDK's store timings into breadcrumbs.
 *
 * `perf/main-thread-stall` reports that the main thread was blocked and for how
 * long, never by what. The SDK marks its two heaviest synchronous operations —
 * serialising and writing the stores, and merging an archive page — and this is
 * where a slow one becomes a crumb, so the next stall record carries the operation
 * that ran just before it and how long it took.
 *
 * The transport is `performance.measure` rather than a callback because the SDK may
 * not import this tree, and because the same entries then show up on a DevTools
 * timeline for a profile that needs no wiring at all.
 *
 * @module Anomaly/PerfMeasures
 */
import type { Scalar } from './serializer'
import { TAG, type Opaque } from './values'

/**
 * Only an operation that overran a frame budget by a wide margin.
 *
 * The ring holds 100 crumbs. Persistence runs on nearly every mutation, so crumbing
 * every write would flush the ring in seconds and bury the switches, arrivals and
 * focus changes that give a stall its shape. 50ms is three frames — far past
 * anything that could be mistaken for normal, and rare enough to stay readable.
 */
const SLOW_MS = 50

/**
 * Measure name to constant.
 *
 * A total record, so an SDK measure added without a constant here is a compile
 * error rather than a crumb naming a free string.
 */
const MEASURED: Readonly<Record<string, Opaque>> = Object.freeze({
  'fluux:persist': TAG.perfPersist,
  'fluux:mergeArchive': TAG.perfMergeArchive,
})

/**
 * The crumb a measure deserves, or null for one not worth a ring slot.
 *
 * Pure, so the threshold and the name mapping are testable without a
 * `PerformanceObserver` — jsdom has none, and the decision is the part with rules.
 */
export function crumbForMeasure(name: string, durationMs: number): Scalar[] | null {
  // `Object.hasOwn`, not a truthiness check: an entry named `toString` would
  // otherwise resolve to an inherited function and be crumbed as one.
  const tag = Object.hasOwn(MEASURED, name) ? MEASURED[name] : null
  if (!tag) return null
  if (!Number.isFinite(durationMs) || durationMs < SLOW_MS) return null
  return [tag, Math.round(durationMs)]
}

export interface PerfMeasureWatch {
  drain(): void
  stop(): void
}

/**
 * Watch for slow store operations, crumbing each one.
 *
 * Returns null where `PerformanceObserver` is absent — a jsdom test, an older
 * WebView — because a missing diagnostic must never be a missing app.
 */
export function watchPerfMeasures(crumb: (parts: Scalar[]) => void): PerfMeasureWatch | null {
  if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') return null

  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes('measure')) return null
  } catch {
    return null
  }

  const consume = (entries: PerformanceEntry[]): void => {
    const namesToClear = new Set<string>()
    for (const entry of entries) {
      if (!Object.hasOwn(MEASURED, entry.name)) continue
      namesToClear.add(entry.name)
      const parts = crumbForMeasure(entry.name, entry.duration)
      if (parts) crumb(parts)
    }
    for (const name of namesToClear) {
      try {
        performance.clearMeasures(name)
      } catch {
        continue
      }
    }
  }

  const observer = new PerformanceObserver((list) => {
    try {
      consume(list.getEntries())
    } catch {
      return
    }
  })

  try {
    observer.observe({ entryTypes: ['measure'] })
  } catch {
    observer.disconnect()
    return null
  }
  return {
    drain: () => {
      try {
        consume(observer.takeRecords())
      } catch {
        return
      }
    },
    stop: () => observer.disconnect(),
  }
}
