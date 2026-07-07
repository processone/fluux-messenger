import { describe, it, expect } from 'vitest'
import { hasCapability } from './capabilities'

describe('hasCapability', () => {
  it('allows any command with no capability requirement', () => {
    expect(hasCapability(undefined, undefined)).toBe(true)
  })
  it('denies a gated command when self is unknown', () => {
    expect(hasCapability('moderator', undefined)).toBe(false)
  })
  it('moderator requires the moderator role', () => {
    expect(hasCapability('moderator', { role: 'moderator', affiliation: 'none' })).toBe(true)
    expect(hasCapability('moderator', { role: 'participant', affiliation: 'none' })).toBe(false)
  })
  it('admin accepts admin or owner affiliation', () => {
    expect(hasCapability('admin', { role: 'participant', affiliation: 'admin' })).toBe(true)
    expect(hasCapability('admin', { role: 'participant', affiliation: 'owner' })).toBe(true)
    expect(hasCapability('admin', { role: 'moderator', affiliation: 'member' })).toBe(false)
  })
  it('owner requires the owner affiliation', () => {
    expect(hasCapability('owner', { role: 'moderator', affiliation: 'owner' })).toBe(true)
    expect(hasCapability('owner', { role: 'moderator', affiliation: 'admin' })).toBe(false)
  })
})
