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
})
