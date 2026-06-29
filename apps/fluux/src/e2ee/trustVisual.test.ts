import { describe, it, expect } from 'vitest'
import { trustVisual } from './trustVisual'

describe('trustVisual', () => {
  it('maps verified to the teal encryption token', () => {
    expect(trustVisual('verified')).toEqual({ colorClass: 'text-fluux-encryption', tone: 'verified' })
  })
  it('maps trusted (tofu) to calm gray', () => {
    expect(trustVisual('trusted')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('CALMS keyLocked to gray (own un-entered passphrase is not a threat)', () => {
    expect(trustVisual('keyLocked')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('maps decryptFailed and keyChanged to the warning token', () => {
    expect(trustVisual('decryptFailed').colorClass).toBe('text-fluux-yellow')
    expect(trustVisual('decryptFailed').tone).toBe('warning')
    expect(trustVisual('keyChanged')).toEqual({ colorClass: 'text-fluux-yellow', tone: 'warning' })
  })
  it('maps rejected to the error token', () => {
    expect(trustVisual('rejected')).toEqual({ colorClass: 'text-fluux-error', tone: 'danger' })
  })
  it('maps plaintext and checking to calm gray', () => {
    expect(trustVisual('plaintext')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
    expect(trustVisual('checking')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
})
