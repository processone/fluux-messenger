import { describe, it, expect } from 'vitest'
import * as main from '../index'
import * as react from './index'

/**
 * Guard against entry-point barrel drift: every React hook exported from the
 * main entry (`@fluux/sdk`) must also be exported from `@fluux/sdk/react`,
 * otherwise "React-only bundle" users silently get a smaller API.
 * (The reverse is not required: /react additionally exports the store hooks
 * that are deliberately kept out of the main entry.)
 */
describe('entry-point barrel parity', () => {
  it('exports every main-entry React hook from @fluux/sdk/react', () => {
    const mainHooks = Object.keys(main).filter((key) => /^use[A-Z]/.test(key))
    expect(mainHooks.length).toBeGreaterThan(0)

    const reactKeys = new Set(Object.keys(react))
    const missing = mainHooks.filter((key) => !reactKeys.has(key))
    expect(missing).toEqual([])
  })
})
