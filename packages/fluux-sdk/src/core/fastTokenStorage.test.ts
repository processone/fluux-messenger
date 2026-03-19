import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  saveFastToken,
  fetchFastToken,
  deleteFastToken,
  hasFastToken,
} from './fastTokenStorage'

describe('fastTokenStorage', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    const localStorageMock = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value }),
      removeItem: vi.fn((key: string) => { delete store[key] }),
      clear: vi.fn(() => { store = {} }),
      get length() { return Object.keys(store).length },
      key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    }
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const JID = 'user@example.com'
  const STORAGE_KEY = 'fluux:fast-token:user@example.com'

  const validToken = {
    mechanism: 'HT-SHA-256-NONE',
    token: 'secret-token-value',
    expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days from now
  }

  // ── saveFastToken ──

  describe('saveFastToken', () => {
    it('stores token in localStorage with correct key', () => {
      saveFastToken(JID, validToken)
      expect(store[STORAGE_KEY]).toBeDefined()
      const stored = JSON.parse(store[STORAGE_KEY])
      expect(stored.mechanism).toBe('HT-SHA-256-NONE')
      expect(stored.token).toBe('secret-token-value')
    })

    it('preserves server-provided expiry within 14-day limit', () => {
      const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() // 3 days
      saveFastToken(JID, { mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry })
      const stored = JSON.parse(store[STORAGE_KEY])
      expect(stored.expiry).toBe(new Date(expiry).toISOString())
    })

    it('caps expiry at 14 days when server expiry exceeds limit', () => {
      const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
      const beforeSave = Date.now()
      saveFastToken(JID, { mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry: farFuture })
      const stored = JSON.parse(store[STORAGE_KEY])
      const storedExpiry = new Date(stored.expiry).getTime()
      const maxExpiry = beforeSave + 14 * 24 * 60 * 60 * 1000
      // Should be capped at ~14 days, not 30 days
      expect(storedExpiry).toBeLessThanOrEqual(maxExpiry + 1000) // 1s tolerance
      expect(storedExpiry).toBeGreaterThan(beforeSave + 13 * 24 * 60 * 60 * 1000) // at least 13 days
    })

    it('defaults to 14-day expiry when server provides no expiry', () => {
      const beforeSave = Date.now()
      saveFastToken(JID, { mechanism: 'HT-SHA-256-NONE', token: 'tok' })
      const stored = JSON.parse(store[STORAGE_KEY])
      const storedExpiry = new Date(stored.expiry).getTime()
      const maxExpiry = beforeSave + 14 * 24 * 60 * 60 * 1000
      expect(storedExpiry).toBeLessThanOrEqual(maxExpiry + 1000)
      expect(storedExpiry).toBeGreaterThan(beforeSave + 13 * 24 * 60 * 60 * 1000)
    })

    it('handles invalid server expiry by using default TTL', () => {
      saveFastToken(JID, { mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry: 'not-a-date' })
      const stored = JSON.parse(store[STORAGE_KEY])
      // Should have a valid expiry (the default 14-day TTL)
      expect(new Date(stored.expiry).getTime()).toBeGreaterThan(Date.now())
    })

    it('scopes storage by JID', () => {
      saveFastToken('alice@example.com', { mechanism: 'HT-SHA-256-NONE', token: 'alice-tok' })
      saveFastToken('bob@example.com', { mechanism: 'HT-SHA-256-NONE', token: 'bob-tok' })
      expect(JSON.parse(store['fluux:fast-token:alice@example.com']).token).toBe('alice-tok')
      expect(JSON.parse(store['fluux:fast-token:bob@example.com']).token).toBe('bob-tok')
    })

    it('does not throw when localStorage is full', () => {
      const localStorageFull = {
        ...localStorage,
        setItem: vi.fn(() => { throw new DOMException('QuotaExceededError') }),
      }
      Object.defineProperty(globalThis, 'localStorage', {
        value: localStorageFull,
        writable: true,
        configurable: true,
      })
      // Should not throw
      expect(() => saveFastToken(JID, validToken)).not.toThrow()
    })
  })

  // ── fetchFastToken ──

  describe('fetchFastToken', () => {
    it('returns stored token when valid', () => {
      saveFastToken(JID, validToken)
      const result = fetchFastToken(JID)
      expect(result).not.toBeNull()
      expect(result!.mechanism).toBe('HT-SHA-256-NONE')
      expect(result!.token).toBe('secret-token-value')
    })

    it('returns null when no token exists', () => {
      expect(fetchFastToken(JID)).toBeNull()
    })

    it('returns null and auto-deletes when token is expired', () => {
      const expiredToken = {
        mechanism: 'HT-SHA-256-NONE',
        token: 'expired-tok',
        expiry: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      }
      store[STORAGE_KEY] = JSON.stringify(expiredToken)

      const result = fetchFastToken(JID)
      expect(result).toBeNull()
      // Token should be auto-deleted from storage
      expect(store[STORAGE_KEY]).toBeUndefined()
    })

    it('returns null and cleans up corrupted JSON', () => {
      store[STORAGE_KEY] = 'not-valid-json'
      const result = fetchFastToken(JID)
      expect(result).toBeNull()
      expect(store[STORAGE_KEY]).toBeUndefined()
    })

    it('returns null and cleans up when required fields are missing', () => {
      store[STORAGE_KEY] = JSON.stringify({ mechanism: 'HT-SHA-256-NONE' })
      expect(fetchFastToken(JID)).toBeNull()
      expect(store[STORAGE_KEY]).toBeUndefined()
    })

    it('returns null when token has empty string fields', () => {
      store[STORAGE_KEY] = JSON.stringify({
        mechanism: '',
        token: 'tok',
        expiry: new Date(Date.now() + 1000).toISOString(),
      })
      expect(fetchFastToken(JID)).toBeNull()
    })

    it('does not return tokens from a different JID', () => {
      saveFastToken('alice@example.com', validToken)
      expect(fetchFastToken('bob@example.com')).toBeNull()
    })
  })

  // ── deleteFastToken ──

  describe('deleteFastToken', () => {
    it('removes the token from localStorage', () => {
      saveFastToken(JID, validToken)
      expect(store[STORAGE_KEY]).toBeDefined()
      deleteFastToken(JID)
      expect(store[STORAGE_KEY]).toBeUndefined()
    })

    it('does not throw when token does not exist', () => {
      expect(() => deleteFastToken(JID)).not.toThrow()
    })

    it('only removes token for the specified JID', () => {
      saveFastToken('alice@example.com', validToken)
      saveFastToken('bob@example.com', validToken)
      deleteFastToken('alice@example.com')
      expect(store['fluux:fast-token:alice@example.com']).toBeUndefined()
      expect(store['fluux:fast-token:bob@example.com']).toBeDefined()
    })
  })

  // ── hasFastToken ──

  describe('hasFastToken', () => {
    it('returns true when valid token exists', () => {
      saveFastToken(JID, validToken)
      expect(hasFastToken(JID)).toBe(true)
    })

    it('returns false when no token exists', () => {
      expect(hasFastToken(JID)).toBe(false)
    })

    it('returns false when token is expired', () => {
      store[STORAGE_KEY] = JSON.stringify({
        mechanism: 'HT-SHA-256-NONE',
        token: 'tok',
        expiry: new Date(Date.now() - 1000).toISOString(),
      })
      expect(hasFastToken(JID)).toBe(false)
    })

    it('returns false when token data is corrupted', () => {
      store[STORAGE_KEY] = 'garbage'
      expect(hasFastToken(JID)).toBe(false)
    })
  })

  // ── Edge cases ──

  describe('edge cases', () => {
    it('handles token expiry at exact current time as expired', () => {
      const now = new Date()
      store[STORAGE_KEY] = JSON.stringify({
        mechanism: 'HT-SHA-256-NONE',
        token: 'tok',
        expiry: now.toISOString(),
      })
      // expiry <= now should be treated as expired
      expect(fetchFastToken(JID)).toBeNull()
    })

    it('overwrites existing token on save', () => {
      saveFastToken(JID, { mechanism: 'HT-SHA-256-NONE', token: 'old-tok' })
      saveFastToken(JID, { mechanism: 'HT-SHA-256-NONE', token: 'new-tok' })
      const result = fetchFastToken(JID)
      expect(result!.token).toBe('new-tok')
    })

    it('handles JID with special characters', () => {
      const specialJid = 'user+tag@example.com'
      saveFastToken(specialJid, validToken)
      expect(hasFastToken(specialJid)).toBe(true)
      expect(fetchFastToken(specialJid)!.token).toBe(validToken.token)
    })
  })
})
