// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { crumbForMeasure, watchPerfMeasures } from './perfMeasures'

const shown = (parts: ReturnType<typeof crumbForMeasure>) =>
  parts?.map((p) => (typeof p === 'object' && p !== null ? p.s : p))

class QueuedPerformanceObserver {
  static supportedEntryTypes = ['measure']
  static latest: QueuedPerformanceObserver | null = null

  private readonly callback: PerformanceObserverCallback
  private records: PerformanceEntry[] = []

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback
    QueuedPerformanceObserver.latest = this
  }

  observe(): void {}

  disconnect(): void {}

  takeRecords(): PerformanceEntry[] {
    return this.records.splice(0)
  }

  queue(name: string, duration: number): void {
    this.records.push({ name, duration } as PerformanceEntry)
  }

  deliver(): void {
    const entries = this.takeRecords()
    this.callback(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    )
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  performance.clearMeasures()
  QueuedPerformanceObserver.latest = null
})

describe('which store timings earn a crumb', () => {
  it('crumbs a slow persist under its constant, with the duration rounded', () => {
    expect(shown(crumbForMeasure('fluux:persist', 1402.7))).toEqual(['perf:persist', 1403])
  })

  it('crumbs a slow archive merge', () => {
    expect(shown(crumbForMeasure('fluux:mergeArchive', 220))).toEqual(['perf:merge-archive', 220])
  })

  it('ignores an operation that stayed inside its budget', () => {
    // Persistence runs on nearly every mutation. Crumbing each one would flush the
    // 100-slot ring in seconds and bury the switches and arrivals that give a stall
    // its shape — the ring would then describe itself rather than the app.
    expect(crumbForMeasure('fluux:persist', 12)).toBeNull()
    expect(crumbForMeasure('fluux:persist', 49.4)).toBeNull()
  })

  it('takes the threshold as inclusive, so the boundary is not a silent gap', () => {
    expect(crumbForMeasure('fluux:persist', 50)).not.toBeNull()
  })

  it('ignores a measure it does not mint a constant for', () => {
    // Any page can call performance.measure. An unmapped name reaching the ring
    // would put a free string in the log, which the registries exist to prevent.
    expect(crumbForMeasure('some-library:work', 5000)).toBeNull()
    expect(crumbForMeasure('toString', 5000)).toBeNull()
    expect(crumbForMeasure('constructor', 5000)).toBeNull()
  })

  it('rejects a non-finite duration rather than recording it', () => {
    expect(crumbForMeasure('fluux:persist', Number.POSITIVE_INFINITY)).toBeNull()
    expect(crumbForMeasure('fluux:persist', Number.NaN)).toBeNull()
  })
})

describe('performance measure watcher', () => {
  it('drains queued entries through the callback path exactly once', () => {
    vi.stubGlobal('PerformanceObserver', QueuedPerformanceObserver)
    const crumbs: unknown[][] = []
    const watch = watchPerfMeasures((parts) => crumbs.push(shown(parts) ?? []))

    QueuedPerformanceObserver.latest!.queue('fluux:persist', 1234)
    watch!.drain()
    QueuedPerformanceObserver.latest!.deliver()

    expect(crumbs).toEqual([['perf:persist', 1234]])
  })

  it('clears Fluux measures without deleting unrelated timings', () => {
    vi.stubGlobal('PerformanceObserver', QueuedPerformanceObserver)
    performance.measure('third-party:render')
    performance.measure('fluux:persist')
    const watch = watchPerfMeasures(() => {})

    QueuedPerformanceObserver.latest!.queue('third-party:render', 100)
    QueuedPerformanceObserver.latest!.queue('fluux:persist', 100)
    watch!.drain()

    expect(performance.getEntriesByName('fluux:persist')).toEqual([])
    expect(performance.getEntriesByName('third-party:render')).toHaveLength(1)
  })

  it('does not activate when measure entries are unsupported', () => {
    class UnsupportedPerformanceObserver extends QueuedPerformanceObserver {
      static supportedEntryTypes: string[] = []
    }
    vi.stubGlobal('PerformanceObserver', UnsupportedPerformanceObserver)

    expect(watchPerfMeasures(() => {})).toBeNull()
    expect(QueuedPerformanceObserver.latest).toBeNull()
  })
})

describe('a hostile User Timing host cannot break installation', () => {
  const realObserver = globalThis.PerformanceObserver

  afterEach(() => {
    globalThis.PerformanceObserver = realObserver
  })

  function withObserver(impl: unknown): void {
    ;(globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver = impl
  }

  it('returns null instead of throwing when the observer cannot be constructed', () => {
    // A partial or hardened host can advertise the constructor and still refuse
    // to build one. The module promises a missing diagnostic never breaks the
    // app, and installation is where that promise is most easily broken.
    class Hostile {
      static supportedEntryTypes = ['measure']
      constructor() {
        throw new Error('observers unavailable')
      }
    }
    withObserver(Hostile)

    expect(() => watchPerfMeasures(() => {})).not.toThrow()
    expect(watchPerfMeasures(() => {})).toBeNull()
  })

  it('does not throw when disconnecting on teardown fails', () => {
    // Cleanup runs while the page is going away, which is exactly when a host is
    // least cooperative — and an effect cleanup that throws takes the unmount
    // with it.
    class Flaky {
      static supportedEntryTypes = ['measure']
      observe(): void {}
      takeRecords(): unknown[] {
        return []
      }
      disconnect(): never {
        throw new Error('disconnect failed')
      }
    }
    withObserver(Flaky)

    const watch = watchPerfMeasures(() => {})
    expect(watch).not.toBeNull()
    expect(() => watch!.stop()).not.toThrow()
  })
})
