import { describe, it, expect } from 'vitest'
import { SyncVersionCache, loadSyncVersion } from './syncVersionCache'
import { memStorage } from './testSupport/memStorage'

describe('SyncVersionCache', () => {
  it('get() returns -1 before hydrate/set (nothing applied yet)', () => {
    const c = new SyncVersionCache(memStorage())
    expect(c.get()).toBe(-1)
  })

  it('reads are synchronous immediately after an awaited set', async () => {
    const c = new SyncVersionCache(memStorage())
    await c.hydrate()
    await c.set(3)
    expect(c.get()).toBe(3) // no await on the read
  })

  it('the in-memory value updates BEFORE persistence resolves', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = memStorage()
    const put = slow.put.bind(slow)
    slow.put = async (k, v) => {
      await gate
      return put(k, v)
    }

    const c = new SyncVersionCache(slow)
    await c.hydrate()
    const pending = c.set(5)
    // Persistence has NOT resolved yet, but the sync read must already see it.
    expect(c.get()).toBe(5)
    release()
    await pending
  })

  it('hydrate loads a previously persisted value', async () => {
    const s = memStorage()
    const a = new SyncVersionCache(s)
    await a.hydrate()
    await a.set(7)

    const b = new SyncVersionCache(s)
    await b.hydrate()
    expect(b.get()).toBe(7)
  })

  it('hydrate is idempotent (a second call does not re-read storage)', async () => {
    const s = memStorage()
    const c = new SyncVersionCache(s)
    await c.hydrate()
    await c.set(4)
    // A concurrent/late second hydrate() must not clobber the in-memory
    // value with a stale storage read (there is none here, but the guard
    // must still short-circuit rather than re-run `loadSyncVersion`).
    await c.hydrate()
    expect(c.get()).toBe(4)
  })

  describe('monotonic clamp', () => {
    it('set() never lowers the value — a smaller version is a no-op numerically', async () => {
      const c = new SyncVersionCache(memStorage())
      await c.hydrate()
      await c.set(5)
      await c.set(3)
      expect(c.get()).toBe(5)
    })

    it('set() raises the value when the new version is higher', async () => {
      const c = new SyncVersionCache(memStorage())
      await c.hydrate()
      await c.set(3)
      await c.set(5)
      expect(c.get()).toBe(5)
    })

    it('the clamp holds across persistence too (reload sees the higher value)', async () => {
      const s = memStorage()
      const c = new SyncVersionCache(s)
      await c.hydrate()
      await c.set(5)
      await c.set(2)

      const reloaded = new SyncVersionCache(s)
      await reloaded.hydrate()
      expect(reloaded.get()).toBe(5)
    })
  })

  describe('rollback on a failed persist', () => {
    function rejectingStorage() {
      const s = memStorage()
      s.put = async () => {
        throw new Error('disk full')
      }
      return s
    }

    it('rolls back to the value before the call so get() is not left ahead of disk', async () => {
      const c = new SyncVersionCache(rejectingStorage())
      await expect(c.set(9)).rejects.toThrow('disk full')
      expect(c.get()).toBe(-1)
    })

    it('rolls back to the PREVIOUS value when raising an already-nonzero counter', async () => {
      const s = memStorage()
      const c = new SyncVersionCache(s)
      await c.hydrate()
      await c.set(3)
      s.put = async () => {
        throw new Error('disk full')
      }
      await expect(c.set(9)).rejects.toThrow('disk full')
      expect(c.get()).toBe(3)
    })

    it('a subsequent successful set() after a rollback persists correctly', async () => {
      const s = memStorage()
      const c = new SyncVersionCache(s)
      await c.hydrate()
      await c.set(3)
      const originalPut = s.put.bind(s)
      s.put = async () => {
        throw new Error('disk full')
      }
      await expect(c.set(9)).rejects.toThrow('disk full')
      s.put = originalPut
      await c.set(9)
      expect(c.get()).toBe(9)

      const reloaded = new SyncVersionCache(s)
      await reloaded.hydrate()
      expect(reloaded.get()).toBe(9)
    })
  })

  describe('loadSyncVersion (pure storage read)', () => {
    it('returns -1 when nothing is stored', async () => {
      expect(await loadSyncVersion(memStorage())).toBe(-1)
    })

    it('tolerates a corrupt stored value by returning -1', async () => {
      const enc = new TextEncoder()
      const s = memStorage({ 'verifications-sync-version': enc.encode('not-a-number') })
      expect(await loadSyncVersion(s)).toBe(-1)
    })
  })
})
