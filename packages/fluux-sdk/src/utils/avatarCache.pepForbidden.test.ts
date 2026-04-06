import { describe, it, expect, beforeEach } from 'vitest'
import {
  isPepForbiddenDomain,
  markPepForbiddenDomain,
  clearAllPepForbiddenDomains,
  _resetPepForbiddenDomainsForTesting,
} from './avatarCache'

describe('PEP-forbidden domain cache', () => {
  beforeEach(() => {
    _resetPepForbiddenDomainsForTesting()
  })

  it('should return false for unknown domains', () => {
    expect(isPepForbiddenDomain('example.com')).toBe(false)
  })

  it('should return true after marking a domain', async () => {
    await markPepForbiddenDomain('disroot.org')
    expect(isPepForbiddenDomain('disroot.org')).toBe(true)
  })

  it('should not affect other domains', async () => {
    await markPepForbiddenDomain('disroot.org')
    expect(isPepForbiddenDomain('jabber.org')).toBe(false)
  })

  it('should handle multiple domains', async () => {
    await markPepForbiddenDomain('disroot.org')
    await markPepForbiddenDomain('yax.im')
    await markPepForbiddenDomain('monocles.de')

    expect(isPepForbiddenDomain('disroot.org')).toBe(true)
    expect(isPepForbiddenDomain('yax.im')).toBe(true)
    expect(isPepForbiddenDomain('monocles.de')).toBe(true)
    expect(isPepForbiddenDomain('process-one.net')).toBe(false)
  })

  it('should clear all domains', async () => {
    await markPepForbiddenDomain('disroot.org')
    await markPepForbiddenDomain('yax.im')

    await clearAllPepForbiddenDomains()

    expect(isPepForbiddenDomain('disroot.org')).toBe(false)
    expect(isPepForbiddenDomain('yax.im')).toBe(false)
  })

  it('should be idempotent when marking the same domain twice', async () => {
    await markPepForbiddenDomain('disroot.org')
    await markPepForbiddenDomain('disroot.org')
    expect(isPepForbiddenDomain('disroot.org')).toBe(true)
  })
})
