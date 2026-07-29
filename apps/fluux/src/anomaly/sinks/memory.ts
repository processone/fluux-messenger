/**
 * In-memory sink for demo mode, the web build and Playwright.
 *
 * Exposing the lines on `window.__fluuxAnomalies` is what lets the same detectors
 * later serve as CI oracles, and what the Dev-side build assertion polls.
 *
 * @module Anomaly/Sinks/Memory
 */
import type { Sink } from './sink'

/** Bounded so a long demo session cannot grow without limit. */
const MAX_RETAINED = 1000

export function createMemorySink(): Sink {
  const lines: string[] = []

  if (typeof window !== 'undefined') {
    // Publish the array itself, not a copy: Playwright polls this reference, so
    // replacing it on every write would make `expect.poll` read a stale snapshot.
    ;(window as unknown as Record<string, unknown>).__fluuxAnomalies = lines
  }

  return {
    write(line: string): void {
      lines.push(line)
      // Drop the OLDEST in place. `lines = lines.slice(...)` would rebind the local
      // and leave `window.__fluuxAnomalies` pointing at the original array.
      if (lines.length > MAX_RETAINED) lines.shift()
    },
    failureCount: () => 0,
    disabled: () => false,
  }
}
