import { describe, it, expect, vi } from 'vitest'
import { SyncVersionCache, loadSyncVersion, SYNC_VERSION_STORAGE_KEY } from './syncVersionCache'
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
    const getSpy = vi.spyOn(s, 'get')
    const c = new SyncVersionCache(s)
    await c.hydrate()
    expect(getSpy).toHaveBeenCalledTimes(1)
    await c.set(4)

    // Mutate the backing store directly (bypassing `set()`) to a value the
    // in-memory cache has never seen. A guardless `hydrate()` would re-read
    // storage and clobber `this.value` with this stale-relative-to-memory
    // (but newer-on-disk) value; the guard must short-circuit instead, so
    // neither the read count nor the in-memory value moves.
    await s.put(SYNC_VERSION_STORAGE_KEY, new TextEncoder().encode('99'))
    await c.hydrate()

    expect(getSpy).toHaveBeenCalledTimes(1)
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

    it('an overlapping failed persist rolls back to the DURABLE value, not the caller-captured previous', async () => {
      // Reproduces the exact interleaving from the B3 re-review finding:
      //   set(6) runs (previous = 5), then set(7) runs (previous = 6)
      //   before the queue drains. set(6)'s enqueued persist reads the LIVE
      //   value (7, since set(7) already bumped memory synchronously) and
      //   succeeds -> disk = 7. set(7)'s own persist then fails -> rollback
      //   must land on 7 (what's durably on disk), never on 6 (set(7)'s
      //   captured `previous`), or the next reseal would capture 6 while
      //   disk holds 7 and manufacture a false "compromised" verdict.
      const s = memStorage()
      const c = new SyncVersionCache(s)
      await c.hydrate()
      await c.set(5)

      const rollbackReads: number[] = []
      const withHook = new SyncVersionCache(s, () => rollbackReads.push(withHook.get()))
      await withHook.hydrate()
      expect(withHook.get()).toBe(5)

      let putCount = 0
      const originalPut = s.put.bind(s)
      s.put = async (k, v) => {
        putCount++
        if (putCount === 1) {
          // set(6)'s persist: succeeds, writing whatever is live (7).
          return originalPut(k, v)
        }
        // set(7)'s own persist: fails transiently.
        throw new Error('disk full')
      }

      const p1 = withHook.set(6)
      const p2 = withHook.set(7)

      await expect(p2).rejects.toThrow('disk full')
      await p1

      // Disk must hold 7 (set(6)'s persist wrote the live value, which was
      // already bumped to 7 by the time it ran).
      const reloaded = new SyncVersionCache(s)
      await reloaded.hydrate()
      expect(reloaded.get()).toBe(7)

      // Memory must match the durable disk value (7), not set(7)'s stale
      // captured `previous` (6).
      expect(withHook.get()).toBe(7)

      // The reseal hook, when it fires, must see the same durable value.
      expect(rollbackReads).toEqual([7])
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
