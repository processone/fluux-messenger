import { describe, it, expect, beforeEach } from 'vitest'
import { isFeatureEnabled } from './featureFlags'

describe('isFeatureEnabled', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to false when the flag is unset', () => {
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })

  it('is true only when the stored value is exactly "true"', () => {
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(true)
    localStorage.setItem('fluux:flags:enableMessageVirtualization', '1')
    expect(isFeatureEnabled('enableMessageVirtualization')).toBe(false)
  })
})
