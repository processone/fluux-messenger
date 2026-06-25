import { describe, it, expect, beforeEach } from 'vitest'
import { isFeatureEnabled } from './featureFlags'

describe('isFeatureEnabled', () => {
  beforeEach(() => localStorage.clear())

  it('enableMessageVirtualization defaults to false (OFF) when unset', () => {
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })

  it('an explicit "true" enables it (opt-in)', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(true)
  })

  it('an explicit "false" keeps it disabled', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })

  it('any other stored value falls back to the default (OFF)', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', '1')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })
})
