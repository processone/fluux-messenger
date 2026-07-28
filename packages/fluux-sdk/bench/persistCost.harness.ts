/**
 * Shared instrumentation for the persistence cost benchmark (issue #1138).
 *
 * Counts what the issue asks for, per storage key, and nothing else:
 * `JSON.stringify` invocations, `localStorage.setItem` invocations, bytes
 * written, and CPU time.
 *
 * `setItem` count is the serialization count on every path measured here —
 * both the throttle's `write()` and the simulated pre-#1133 write-through
 * evaluate the thunk exactly once per `setItem`. Total `JSON.stringify` calls
 * are counted separately as a cross-check, because a serializer that calls it
 * more than once per blob would otherwise hide inside the setItem count.
 *
 * @module Bench/PersistCost
 */

import { vi } from 'vitest'

export interface KeyMetrics {
  writes: number
  bytes: number
}

export interface Metrics {
  /** Per storage key, so a small side-key write is never confused with a blob. */
  byKey: Record<string, KeyMetrics>
  writes: number
  bytes: number
  stringifyCalls: number
  /** CPU milliseconds spent inside the measured region (fake timers do not move it). */
  cpuMs: number
}

/** Counting `localStorage` — an object mock, so the code under test is the
 *  production write path (design §5.5's fourth guard). */
function createCountingLocalStorage() {
  let store: Record<string, string> = {}
  const byKey: Record<string, KeyMetrics> = {}
  let recording = false

  return {
    mock: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
        if (recording) {
          const entry = (byKey[key] ??= { writes: 0, bytes: 0 })
          entry.writes += 1
          entry.bytes += value.length
        }
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        store = {}
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() {
        return Object.keys(store).length
      },
    },
    start(): void {
      for (const key of Object.keys(byKey)) delete byKey[key]
      recording = true
    },
    stop(): Record<string, KeyMetrics> {
      recording = false
      return JSON.parse(JSON.stringify(byKey)) as Record<string, KeyMetrics>
    },
    reset(): void {
      store = {}
    },
  }
}

export const countingStorage = createCountingLocalStorage()

/**
 * Implementation under measurement.
 *
 * - `legacy`      — pre-#1133: serialize and write on every mutation.
 * - `merged`      — #1133 as shipped: every coverage `bottomId` change forces a
 *   flush. Re-created over the shipped primitives (see the bench's mock), not
 *   checked out, so both variants exercise the same store code.
 * - `coverageThrottled` — the CEILING on any coverage-transition refinement
 *   (candidate 2): coverage is dropped from structural detection entirely, so
 *   no coverage transition ever forces a flush. Not a shippable rule — it
 *   loses the replacement/removal durability #1133 added — but it bounds the
 *   win, which is what the go/no-go needs before an implementation exists.
 * - `allThrottled` — no structural detection at all: a pure throttle. Bounds
 *   candidate 1 (a `flushKey` that leaves the window armed), which can only
 *   ever recover the WINDOW-CLOSING part of the structural cost, never the
 *   forced write itself.
 * - `optimized`   — the implementation actually shipped for #1138.
 */
export type Variant = 'legacy' | 'merged' | 'coverageThrottled' | 'allThrottled' | 'optimized'

let variant: Variant = 'merged'

export function setVariant(next: Variant): void {
  variant = next
}

export function getVariant(): Variant {
  return variant
}

/** Wrap `JSON.stringify` once, for the whole process. */
let stringifyCalls = 0
const realStringify = JSON.stringify.bind(JSON)
JSON.stringify = ((...args: Parameters<typeof realStringify>) => {
  stringifyCalls += 1
  return realStringify(...args)
}) as typeof JSON.stringify

/**
 * Run `body` under measurement.
 *
 * `body` is synchronous on purpose: every scenario drives store actions
 * directly and advances fake timers, so there is no real waiting to overlap
 * and `cpuMs` stays a clean measure of serialization + write cost.
 */
export function measure(body: () => void): Metrics {
  countingStorage.start()
  const stringifyBefore = stringifyCalls
  const t0 = performance.now()
  body()
  const cpuMs = performance.now() - t0
  const byKey = countingStorage.stop()

  let writes = 0
  let bytes = 0
  for (const entry of Object.values(byKey)) {
    writes += entry.writes
    bytes += entry.bytes
  }
  return { byKey, writes, bytes, stringifyCalls: stringifyCalls - stringifyBefore, cpuMs }
}

/**
 * Install the counting storage and the variant-aware module mocks.
 *
 * Called from the bench file's top level (before the store imports), because
 * `chatStore` resolves `localStorage` and its persistence modules at import.
 */
export function installStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', { value: countingStorage.mock, writable: true })
}

/** Simulated pre-#1133 write-through: serialize and write, absorbing errors. */
export function legacyWrite(key: string, produce: () => string): void {
  try {
    localStorage.setItem(key, produce())
  } catch {
    // Every replaced call site swallowed storage errors and continued.
  }
}

export { vi }
