import { describe, it, expect, beforeEach } from 'vitest'
import { isFeatureEnabled } from './featureFlags'

describe('isFeatureEnabled', () => {
  beforeEach(() => localStorage.clear())

  it('enableMessageVirtualization defaults to true (ON) when unset', () => {
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(true)
  })

  it('is disabled only when the stored value is exactly "false"', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })

  it('an explicit "true" keeps it enabled', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(true)
  })

  it('any other stored value falls back to the default (ON)', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', '1')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(true)
  })
})
