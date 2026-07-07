import { describe, it, expect } from 'vitest'
import * as mainEntry from '../index'
import * as demoEntry from './index'

/**
 * Demo mode is a dev-only tool and must not ship from the production main
 * entry (`@fluux/sdk`) — it belongs on the `@fluux/sdk/demo` subpath so it
 * is tree-shaken out of production app bundles. This guard pins that split.
 */
describe('demo subpath boundary', () => {
  const demoSymbols = [
    'DemoClient',
    'DemoData',
    'DemoSelf',
    'DemoPresence',
    'DemoOwnResource',
    'DemoRoomData',
    'DemoAnimationStep',
    'StressScenario',
    'minutesAgo',
    'hoursAgo',
    'daysAgo',
  ]

  it('does not export demo runtime symbols from the main entry', () => {
    const leaked = Object.keys(mainEntry).filter((k) => demoSymbols.includes(k))
    expect(leaked).toEqual([])
  })

  it('exports the demo runtime symbols from the /demo subpath', () => {
    // Types erase at runtime; assert the value exports are all present.
    expect(typeof (demoEntry as Record<string, unknown>).DemoClient).toBe('function')
    for (const fn of ['minutesAgo', 'hoursAgo', 'daysAgo']) {
      expect(typeof (demoEntry as Record<string, unknown>)[fn]).toBe('function')
    }
  })

  it('moves the resident-window dev seam off the main entry onto /demo', () => {
    // getResidentWindowSize/setResidentWindowSize are a dev/test-only seam
    // whose sole app consumer is the demo — they don't belong on the product API.
    const main = mainEntry as Record<string, unknown>
    const demo = demoEntry as Record<string, unknown>
    expect(main.getResidentWindowSize).toBeUndefined()
    expect(main.setResidentWindowSize).toBeUndefined()
    expect(typeof demo.getResidentWindowSize).toBe('function')
    expect(typeof demo.setResidentWindowSize).toBe('function')
  })

  it('does not export the generic keyed-coalescer util from the main entry', () => {
    // A generic, non-XMPP primitive: the app owns its notification coalescer,
    // the SDK keeps an internal copy for side effects.
    expect((mainEntry as Record<string, unknown>).createKeyedCoalescer).toBeUndefined()
  })
})
