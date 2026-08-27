import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schedule, _resetForTesting } from './throttledStorage'
import { setMeasurementEnabled } from '../../utils/measure'
import { mergeArchive } from './messageTimeline'

/**
 * The call sites, not the helper.
 *
 * `measure.test.ts` proves `measured` emits an entry. These prove the two heaviest
 * store operations actually call it — a distinction with teeth, because the app-side
 * observer is verified end to end with a measure the page emits itself, and stays
 * green with the SDK wiring removed entirely.
 */
const store = new Map<string, string>()

beforeEach(() => {
  _resetForTesting()
  store.clear()
  // The SDK runs its tests without a DOM, so the store's one storage dependency is
  // supplied explicitly rather than by an environment.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  })
  performance.clearMeasures()
  setMeasurementEnabled(true)
})

afterEach(() => {
  setMeasurementEnabled(false)
  _resetForTesting()
})

const measures = () => performance.getEntriesByType('measure').map((e) => e.name)

describe('persistence is measured at its chokepoint', () => {
  it('times the serialization and the write together', () => {
    // Both halves block, and a caller cannot separate them: `produce()` runs inside
    // `setItem`'s argument list. Timing the pair is the honest span.
    schedule('k', () => JSON.stringify({ a: 1 }))
    expect(measures()).toContain('fluux:persist')
  })

  it('emits nothing when measurement is off, which is the default for consumers', () => {
    setMeasurementEnabled(false)
    performance.clearMeasures()
    schedule('k2', () => '{}')
    expect(measures()).toEqual([])
  })

  it('still persists the value — measuring must not change the write', () => {
    schedule('k3', () => JSON.stringify({ kept: true }))
    expect(store.get('k3')).toBe('{"kept":true}')
  })
})

describe('archive merging is measured at its boundary', () => {
  it('includes archive-id backfill in the reported duration', () => {
    interface Message {
      id: string
      originId: string
      stanzaId?: string
      from: string
      timestamp: Date
    }
    const resident: Message[] = [
      {
        id: 'm1',
        originId: 'origin-1',
        from: 'peer@example.com',
        timestamp: new Date('2026-08-27T08:00:00Z'),
      },
    ]
    const archived: Message[] = [{ ...resident[0], stanzaId: 'archive-1' }]
    let calls = 0
    const getKeys = (message: Message): string[] => {
      calls++
      if (calls === 1) {
        const until = performance.now() + 25
        while (performance.now() < until) JSON.stringify(message)
      }
      return [`origin:${message.originId}`]
    }

    mergeArchive(resident, archived, 'forward', {
      getKeys,
      kind: 'chat',
      windowSize: 10,
    })

    const measure = performance.getEntriesByName('fluux:mergeArchive').at(-1)
    expect(measure?.duration).toBeGreaterThanOrEqual(20)
  })
})
