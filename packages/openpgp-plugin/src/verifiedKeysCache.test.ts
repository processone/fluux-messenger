import { describe, it, expect } from 'vitest'
import { VerifiedKeysCache } from './verifiedKeysCache'
import { loadVerifiedMap } from './verifiedKeys'
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

  // Re-review Finding 3 (Phase B1): an empty-string fingerprint must never
  // even enter the map. If it did, it would be sealed via `getAll()`,
  // silently dropped by `persistVerifiedMap`'s write-side filter, and then
  // vanish on the next `hydrate()` — the same false "compromised" tamper
  // shape Finding 1's filter exists to close, just entered from the write
  // side instead of a corrupt read.
  it('setVerified rejects an empty fingerprint instead of storing it', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await expect(c.setVerified('bob@x', '')).rejects.toThrow(/fingerprint must not be empty/)
    expect(c.getAll()).toEqual({})
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

  // Finding 1 (B2 Task 1 review): `OpenPGPPluginBase.init()` does
  // `new VerifiedKeysCache(ctx.storage)` then `await verifiedKeys.hydrate()`.
  // That `await` yields to the event loop on real (Tauri IPC) storage, so a
  // `getSnapshot()` call racing the hydrate must not get permanently stuck
  // on the pre-hydrate `{}` snapshot once hydration completes — it must
  // reflect the loaded data, and subscribers must be told.
  it('hydrate invalidates a snapshot taken before it resolves and notifies subscribers', async () => {
    const s = memStorage()
    const seedCache = new VerifiedKeysCache(s)
    await seedCache.hydrate()
    await seedCache.setVerified('bob@x', 'ABCD')

    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = { ...s }
    slow.get = async (key: string) => {
      await gate
      return s.get(key)
    }

    const c = new VerifiedKeysCache(slow)
    // Cache a snapshot BEFORE hydrate() resolves — this is the racy window.
    expect(c.getSnapshot()).toEqual({})

    let notified = false
    c.subscribe(() => {
      notified = true
    })

    const pending = c.hydrate()
    release()
    await pending

    expect(notified).toBe(true)
    expect(c.getSnapshot()).toEqual({ 'bob@x': 'ABCD' })
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

    // Re-review Finding 2 (Phase B1): a rollback for one write must never
    // race a concurrent write's already-successful persist. `persist()`
    // snapshots `getAll()` synchronously then awaits `storage.put` — if two
    // writes' `persist()` calls could be in flight at once, they can settle
    // out of order: write A (bob) starts, write B (carol) starts (its
    // synchronous mutation always runs after A's, so its snapshot already
    // includes bob), B's put resolves first (disk = {bob, carol}), THEN
    // A's put rejects and A's rollback deletes bob from MEMORY only —
    // leaving memory ({carol}) BEHIND disk ({bob, carol}). That reverse
    // divergence manufactures the same false "trust state compromised"
    // verdict as memory running ahead of disk.
    //
    // The storage stub below controls resolution order independent of call
    // order: the FIRST `put` invocation (whichever write it belongs to)
    // rejects; every subsequent invocation succeeds. Both gates are
    // released before either write is awaited, so with writes serialized
    // (the fix) B's `put` is never even invoked until A's whole
    // persist-and-rollback has settled; without serialization (the bug)
    // both `put` calls are already in flight by the time the gates release,
    // and resolving B's gate lets it win the race.
    it('a rejected persist never leaves memory diverged from disk when it races a concurrent successful write', async () => {
      const s = memStorage()
      const c = new VerifiedKeysCache(s)
      await c.hydrate()

      let releaseFirst: () => void = () => {}
      let releaseSecond: () => void = () => {}
      const gateFirst = new Promise<void>((r) => {
        releaseFirst = r
      })
      const gateSecond = new Promise<void>((r) => {
        releaseSecond = r
      })
      const originalPut = s.put.bind(s)
      let putCount = 0
      s.put = async (key, value) => {
        putCount += 1
        if (putCount === 1) {
          await gateFirst
          throw new Error('disk full')
        }
        await gateSecond
        return originalPut(key, value)
      }

      const pendingA = c.setVerified('bob@x', 'ABCD').catch((err: unknown) => err)
      const pendingB = c.setVerified('carol@x', 'EF01')

      // Release both gates up front — see the comment above for why this
      // only matters (i.e. only creates the racy interleaving) when writes
      // are NOT serialized.
      releaseSecond()
      releaseFirst()

      await pendingA
      await pendingB

      const disk = await loadVerifiedMap(s)
      expect(c.getAll()).toEqual(disk)
      expect(disk).toEqual({ 'carol@x': 'EF01' })
    })
  })

  describe('subscribe / getSnapshot', () => {
    it('notifies subscribers synchronously on setVerified, before persistence resolves', async () => {
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

      const c = new VerifiedKeysCache(slow)
      await c.hydrate()
      let notified = false
      c.subscribe(() => {
        notified = true
      })

      const pending = c.setVerified('bob@x', 'ABCD')
      // Persistence has NOT resolved yet, but the listener must already have fired.
      expect(notified).toBe(true)
      expect(c.getSnapshot()).toEqual({ 'bob@x': 'ABCD' })
      release()
      await pending
    })

    it('notifies again on rollback when persistence fails, so the UI reverts', async () => {
      const s = memStorage()
      s.put = async () => {
        throw new Error('disk full')
      }
      const c = new VerifiedKeysCache(s)
      await c.hydrate()
      let notifications = 0
      c.subscribe(() => {
        notifications += 1
      })

      await expect(c.setVerified('bob@x', 'ABCD')).rejects.toThrow('disk full')
      expect(notifications).toBe(2)
      expect(c.getSnapshot()).toEqual({})
    })

    // Finding 3 (B2 Task 1 review): only setVerified's rollback notification
    // had coverage. clearVerified's and seed's rollback `notify()` calls
    // (verified functionally by the "rollback on a failed persist" describe
    // block above) had no assertion on the notification itself, so a future
    // refactor could delete either call with the suite still green.
    it('clearVerified notifies again on rollback when persistence fails, so the UI reverts', async () => {
      const s = memStorage()
      const c = new VerifiedKeysCache(s)
      await c.hydrate()
      await c.setVerified('bob@x', 'ABCD')

      s.put = async () => {
        throw new Error('disk full')
      }
      let notifications = 0
      c.subscribe(() => {
        notifications += 1
      })

      await expect(c.clearVerified('bob@x')).rejects.toThrow('disk full')
      expect(notifications).toBe(2)
      expect(c.getSnapshot()).toEqual({ 'bob@x': 'ABCD' })
    })

    it('seed notifies again on rollback when persistence fails, so the UI reverts', async () => {
      const s = memStorage()
      s.put = async () => {
        throw new Error('disk full')
      }
      const c = new VerifiedKeysCache(s)
      await c.hydrate()
      let notifications = 0
      c.subscribe(() => {
        notifications += 1
      })

      await expect(c.seed({ 'bob@x': 'ABCD' })).rejects.toThrow('disk full')
      expect(notifications).toBe(2)
      expect(c.getSnapshot()).toEqual({})
    })

    it('getSnapshot returns the SAME object identity when nothing changed', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      await c.setVerified('bob@x', 'ABCD')
      expect(c.getSnapshot()).toBe(c.getSnapshot())
    })

    // Finding 2 (B2 Task 1 review): unlike `getAll()`, which copies on every
    // call, `getSnapshot()` hands the SAME object to every caller (that's
    // the point, for `useSyncExternalStore`). Without freezing, one consumer
    // mutating the returned object would poison every other caller's view
    // until the next mutation invalidates the cache.
    it('getSnapshot returns a frozen object that mutation cannot poison', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      await c.setVerified('bob@x', 'ABCD')
      const snap = c.getSnapshot()
      expect(() => {
        ;(snap as Record<string, string>)['evil@x'] = 'X'
      }).toThrow()
      expect(c.getSnapshot()).toEqual({ 'bob@x': 'ABCD' })
    })

    it('getSnapshot returns a NEW identity after a mutation', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      await c.setVerified('bob@x', 'ABCD')
      const before = c.getSnapshot()
      await c.setVerified('carol@x', 'EF01')
      const after = c.getSnapshot()
      expect(after).not.toBe(before)
      expect(after).toEqual({ 'bob@x': 'ABCD', 'carol@x': 'EF01' })
    })

    it('unsubscribe stops further notifications', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      let count = 0
      const unsubscribe = c.subscribe(() => {
        count += 1
      })
      await c.setVerified('bob@x', 'ABCD')
      expect(count).toBe(1)
      unsubscribe()
      await c.setVerified('carol@x', 'EF01')
      expect(count).toBe(1)
    })

    it('a listener that throws does not prevent other listeners from being notified', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      let secondCalled = false
      c.subscribe(() => {
        throw new Error('boom')
      })
      c.subscribe(() => {
        secondCalled = true
      })
      await expect(c.setVerified('bob@x', 'ABCD')).resolves.toBeUndefined()
      expect(secondCalled).toBe(true)
    })

    it('a listener that throws does not abort the write in progress', async () => {
      const s = memStorage()
      const c = new VerifiedKeysCache(s)
      await c.hydrate()
      c.subscribe(() => {
        throw new Error('boom')
      })
      await c.setVerified('bob@x', 'ABCD')
      const reloaded = new VerifiedKeysCache(s)
      await reloaded.hydrate()
      expect(reloaded.isVerified('bob@x', 'ABCD')).toBe(true)
    })

    it('notifies on clearVerified and on seed', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      let count = 0
      c.subscribe(() => {
        count += 1
      })

      await c.setVerified('bob@x', 'ABCD')
      expect(count).toBe(1)

      await c.clearVerified('bob@x')
      expect(count).toBe(2)

      await c.seed({ 'carol@x': 'EF01' })
      expect(count).toBe(3)
    })
  })

  describe('getVerifiedFingerprint', () => {
    it('returns the raw stored fingerprint for a verified jid', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      await c.setVerified('bob@x', 'ABCD')
      expect(c.getVerifiedFingerprint('bob@x')).toBe('ABCD')
    })

    it('returns null when the jid has no verified entry', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      expect(c.getVerifiedFingerprint('nobody@x')).toBeNull()
    })
  })

  // B3 Task 3: `OpenPGPPluginBase`'s debounced cross-device publish awaits
  // this before reading `getAll()`, so a publish only ever reflects state
  // that has actually settled — see `whenIdle`'s doc comment.
  describe('whenIdle', () => {
    it('resolves immediately when there is no write in flight', async () => {
      const c = new VerifiedKeysCache(memStorage())
      await c.hydrate()
      await expect(c.whenIdle()).resolves.toBeUndefined()
    })

    it('does not resolve until a pending persist settles', async () => {
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
      const c = new VerifiedKeysCache(slow)
      await c.hydrate()

      const write = c.setVerified('bob@x', 'ABCD')
      let idleSettled = false
      const idle = c.whenIdle().then(() => {
        idleSettled = true
      })

      // Give any stray microtasks a chance to run — `whenIdle()` must still
      // not have resolved, because the persist is still gated.
      await Promise.resolve()
      await Promise.resolve()
      expect(idleSettled).toBe(false)

      release()
      await write
      await idle
      expect(idleSettled).toBe(true)
    })

    it('waits for a write enqueued WHILE it is already waiting (chain reassignment)', async () => {
      // Regression coverage for the loop in `whenIdle()`: a naive single
      // `await this.writeChain` would capture the chain BEFORE the second
      // write is enqueued and could resolve without ever reflecting it.
      let releaseFirst: () => void = () => {}
      const gateFirst = new Promise<void>((r) => {
        releaseFirst = r
      })
      const slow = memStorage()
      const put = slow.put.bind(slow)
      let putCalls = 0
      slow.put = async (k, v) => {
        putCalls += 1
        if (putCalls === 1) await gateFirst
        return put(k, v)
      }
      const c = new VerifiedKeysCache(slow)
      await c.hydrate()

      const writeA = c.setVerified('bob@x', 'ABCD')
      const idle = c.whenIdle()

      // Enqueue a second write while `whenIdle()` is still awaiting the
      // first write's (gated) persist.
      const writeB = c.setVerified('carol@x', 'EF01')

      let idleSettled = false
      void idle.then(() => {
        idleSettled = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(idleSettled).toBe(false)

      releaseFirst()
      await writeA
      await writeB
      await idle

      expect(idleSettled).toBe(true)
      expect(c.isVerified('bob@x', 'ABCD')).toBe(true)
      expect(c.isVerified('carol@x', 'EF01')).toBe(true)
    })

    it('resolves (never rejects) even when the pending write is rolled back after a failed persist', async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      const slow = memStorage()
      slow.put = async () => {
        await gate
        throw new Error('disk full')
      }
      const c = new VerifiedKeysCache(slow)
      await c.hydrate()

      const write = c.setVerified('bob@x', 'ABCD').catch((err: unknown) => err)
      const idle = c.whenIdle()

      release()
      await write
      await expect(idle).resolves.toBeUndefined()
      // The rollback ran: the optimistic entry did not survive the failure.
      expect(c.isVerified('bob@x', 'ABCD')).toBe(false)
    })
  })
})
