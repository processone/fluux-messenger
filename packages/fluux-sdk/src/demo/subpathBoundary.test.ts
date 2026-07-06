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
})
