import { describe, expect, it } from 'vitest'
import { resolveAnomalyGate } from './gate'

/**
 * The gate matrix, asserted directly against the single function both
 * `vite.config.ts` and `vitest.config.ts` call — rather than trusting the two
 * configs and two shell scripts to agree with each other.
 */
describe('resolveAnomalyGate', () => {
  it('is off for a production build with no override', () => {
    expect(resolveAnomalyGate('production', {})).toBe(false)
  })

  it('is on for the dev server', () => {
    expect(resolveAnomalyGate('development', {})).toBe(true)
  })

  it('is on for a production build with FLUUX_ANOMALY=1 (the Dev bundle)', () => {
    // `tauri build` runs the PRODUCTION vite build, so this is the only signal that
    // distinguishes `Fluux Messenger Dev` from a release build.
    expect(resolveAnomalyGate('production', { FLUUX_ANOMALY: '1' })).toBe(true)
  })

  it('is off when explicitly disabled, even in development', () => {
    // The escape hatch for ruling the instrumentation out while chasing a
    // performance regression in the Dev build itself.
    expect(resolveAnomalyGate('development', { FLUUX_ANOMALY: '0' })).toBe(false)
  })

  it('ignores a value that is neither "1" nor "0"', () => {
    expect(resolveAnomalyGate('production', { FLUUX_ANOMALY: 'true' })).toBe(false)
    expect(resolveAnomalyGate('development', { FLUUX_ANOMALY: 'yes' })).toBe(true)
  })

  it('exposes the constant to application code at runtime', () => {
    expect(typeof __FLUUX_ANOMALY__).toBe('boolean')
  })
})
