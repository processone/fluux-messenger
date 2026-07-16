import { describe, it, expect } from 'vitest'
import { trustStateVisual, trustLabel } from './trustVisual'
import type { TrustState } from '@fluux/sdk'

describe('trustStateVisual', () => {
  it('verified → teal encryption brand', () => {
    expect(trustStateVisual('verified')).toEqual({ colorClass: 'text-fluux-encryption', tone: 'verified' })
  })
  it('tofu → calm gray', () => {
    expect(trustStateVisual('tofu')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('introduced → calm gray', () => {
    expect(trustStateVisual('introduced')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('unknown → calm gray', () => {
    expect(trustStateVisual('unknown')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('untrusted → danger error token', () => {
    expect(trustStateVisual('untrusted')).toEqual({ colorClass: 'text-fluux-error', tone: 'danger' })
  })
})

describe('trustLabel', () => {
  it('returns the namespaced i18n key for each TrustState', () => {
    const states: TrustState[] = ['verified', 'introduced', 'tofu', 'untrusted', 'unknown']
    for (const s of states) {
      expect(trustLabel(s)).toBe(`contacts.encryption.trust.${s}`)
    }
  })
})
