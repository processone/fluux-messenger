import { describe, it, expect } from 'vitest'
import { VerifiedKeysCache } from './verifiedKeysCache'
import { memStorage } from './testSupport/memStorage'

describe('VerifiedKeysCache', () => {
  it('reads are synchronous immediately after an awaited write', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    expect(c.isVerified('bob@x', 'ABCD')).toBe(true)   // no await on the read
  })

  it('the in-memory map updates BEFORE persistence resolves', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slow = memStorage()
    const put = slow.put.bind(slow)
    slow.put = async (k, v) => { await gate; return put(k, v) }

    const c = new VerifiedKeysCache(slow)
    await c.hydrate()
    const pending = c.setVerified('bob@x', 'ABCD')
    // Persistence has NOT resolved yet, but the sync read must already see it.
    expect(c.isVerified('bob@x', 'ABCD')).toBe(true)
    release()
    await pending
  })

  it('compares fingerprints case- and whitespace-insensitively', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD1234')
    expect(c.isVerified('bob@x', 'abcd1234')).toBe(true)
    expect(c.isVerified('bob@x', 'ABCD 1234')).toBe(true)
  })

  it('a different fingerprint is NOT verified (fingerprint-binding)', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    expect(c.isVerified('bob@x', 'BEEF')).toBe(false)
  })

  it('an empty fingerprint is never verified', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    expect(c.isVerified('bob@x', '')).toBe(false)
  })

  it('clearVerified removes the entry', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    await c.clearVerified('bob@x')
    expect(c.isVerified('bob@x', 'ABCD')).toBe(false)
    expect(c.getAll()).toEqual({})
  })

  it('hydrate loads previously persisted data', async () => {
    const s = memStorage()
    const a = new VerifiedKeysCache(s)
    await a.hydrate()
    await a.setVerified('bob@x', 'ABCD')
    const b = new VerifiedKeysCache(s)
    await b.hydrate()
    expect(b.isVerified('bob@x', 'ABCD')).toBe(true)
  })

  it('getAll returns a snapshot that does not alias internal state', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    const snap = c.getAll()
    snap['evil@x'] = 'X'
    expect(c.getAll()).toEqual({ 'bob@x': 'ABCD' })
  })

  it('seed populates an empty cache and persists it', async () => {
    const s = memStorage()
    const c = new VerifiedKeysCache(s)
    await c.hydrate()
    await c.seed({ 'bob@x': 'ABCD' })
    expect(c.isVerified('bob@x', 'ABCD')).toBe(true)
    const reloaded = new VerifiedKeysCache(s)
    await reloaded.hydrate()
    expect(reloaded.isVerified('bob@x', 'ABCD')).toBe(true)
  })

  it('seed does NOT overwrite an already-populated cache', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'REAL')
    await c.seed({ 'bob@x': 'STALE', 'carol@x': 'ALSOSTALE' })
    expect(c.getAll()).toEqual({ 'bob@x': 'REAL' })
  })

  // Finding 3: a failed persist must never leave the in-memory map ahead of
  // disk — otherwise a later unrelated trust change can trigger a
  // trust-state seal that snapshots the never-persisted entry, and on next
  // launch hydrate() won't reproduce it, manufacturing a false "compromised"
  // tamper verdict from what was really a transient disk/keychain error.
  describe('rollback on a failed persist', () => {
    function rejectingStorage() {
      const s = memStorage()
      s.put = async () => { throw new Error('disk full') }
      return s
    }

    it('setVerified: rolls back a NEW entry so isVerified is false afterwards, not true', async () => {
      const c = new VerifiedKeysCache(rejectingStorage())
      await expect(c.setVerified('bob@x', 'ABCD')).rejects.toThrow('disk full')
      expect(c.isVerified('bob@x', 'ABCD')).toBe(false)
      expect(c.getAll()).toEqual({})
    })

    it('setVerified: rolls back to the PREVIOUS fingerprint when overwriting an existing entry', async () => {
      const s = memStorage()
      const c = new VerifiedKeysCache(s)
      await c.hydrate()
      await c.setVerified('bob@x', 'OLD')
      s.put = async () => { throw new Error('disk full') }
      await expect(c.setVerified('bob@x', 'NEW')).rejects.toThrow('disk full')
      expect(c.isVerified('bob@x', 'NEW')).toBe(false)
      expect(c.isVerified('bob@x', 'OLD')).toBe(true)
    })

    it('clearVerified: rolls back the deletion so the entry is still verified afterwards', async () => {
      const s = memStorage()
      const c = new VerifiedKeysCache(s)
      await c.hydrate()
      await c.setVerified('bob@x', 'ABCD')
      s.put = async () => { throw new Error('disk full') }
      await expect(c.clearVerified('bob@x')).rejects.toThrow('disk full')
      expect(c.isVerified('bob@x', 'ABCD')).toBe(true)
    })

    it('clearVerified: no-ops (no persist attempt, nothing to roll back) when the jid has no entry', async () => {
      const c = new VerifiedKeysCache(rejectingStorage())
      await c.hydrate()
      await expect(c.clearVerified('nobody@x')).resolves.toBeUndefined()
    })

    it('seed: rolls back to empty when persisting the seed fails', async () => {
      const c = new VerifiedKeysCache(rejectingStorage())
      await expect(c.seed({ 'bob@x': 'ABCD' })).rejects.toThrow('disk full')
      expect(c.isVerified('bob@x', 'ABCD')).toBe(false)
      expect(c.getAll()).toEqual({})
    })
  })
})
