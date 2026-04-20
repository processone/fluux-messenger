import { describe, it, expect } from 'vitest'
import { CapabilityCache } from './CapabilityCache'

describe('CapabilityCache', () => {
  it('returns null before any entry is stored', () => {
    const cache = new CapabilityCache()
    expect(cache.get('openpgp', 'bob@example.com')).toBeNull()
  })

  it('stores and retrieves entries until they expire', () => {
    let now = 1_000_000
    const cache = new CapabilityCache({ now: () => now })
    cache.put('openpgp', 'bob@example.com', { supported: true, ttl: 60 })

    expect(cache.get('openpgp', 'bob@example.com')).toMatchObject({ supported: true })

    now += 59 * 1000
    expect(cache.get('openpgp', 'bob@example.com')).not.toBeNull()

    now += 2 * 1000 // 61s total
    expect(cache.get('openpgp', 'bob@example.com')).toBeNull()
  })

  it('isolates entries by protocol id', () => {
    const cache = new CapabilityCache()
    cache.put('openpgp', 'bob@example.com', { supported: true, ttl: 60 })
    cache.put('omemo:2', 'bob@example.com', { supported: false, ttl: 60 })
    expect(cache.get('openpgp', 'bob@example.com')?.supported).toBe(true)
    expect(cache.get('omemo:2', 'bob@example.com')?.supported).toBe(false)
  })

  it('does not cache when ttl is zero', () => {
    const cache = new CapabilityCache()
    cache.put('openpgp', 'bob@example.com', { supported: true, ttl: 0 })
    expect(cache.get('openpgp', 'bob@example.com')).toBeNull()
  })

  it('clamps ttl to the configured maximum', () => {
    let now = 0
    const cache = new CapabilityCache({ now: () => now, maxTtlSeconds: 10 })
    cache.put('openpgp', 'bob@example.com', { supported: true, ttl: 3600 })
    now = 11 * 1000 // beyond max
    expect(cache.get('openpgp', 'bob@example.com')).toBeNull()
  })

  it('invalidates a specific entry', () => {
    const cache = new CapabilityCache()
    cache.put('openpgp', 'bob@example.com', { supported: true, ttl: 60 })
    cache.invalidate('openpgp', 'bob@example.com')
    expect(cache.get('openpgp', 'bob@example.com')).toBeNull()
  })

  it('invalidates every entry for a peer', () => {
    const cache = new CapabilityCache()
    cache.put('openpgp', 'bob@example.com', { supported: true, ttl: 60 })
    cache.put('omemo:2', 'bob@example.com', { supported: true, ttl: 60 })
    cache.put('openpgp', 'alice@example.com', { supported: true, ttl: 60 })

    cache.invalidatePeer('bob@example.com')

    expect(cache.get('openpgp', 'bob@example.com')).toBeNull()
    expect(cache.get('omemo:2', 'bob@example.com')).toBeNull()
    expect(cache.get('openpgp', 'alice@example.com')).not.toBeNull()
  })
})
