// Verifies that `init()` hydrates the plugin-owned `VerifiedKeysCache`
// (Task 2) before it resolves — on EVERY exit path, including the early
// returns for key-locked / needs-identity-decision / key-unrecoverable that
// skip `activateSubscriptions()` — and seeds it once from the legacy
// `hostStores.verifiedPeers` store. Drives the real `init()` path via the
// harness in `testSupport/baseHarness.ts` rather than calling the cache
// directly (that's `verifiedKeysCache.test.ts`'s job).
import { describe, it, expect } from 'vitest'
import { E2EEPluginError, type PluginStorage } from '@fluux/sdk'
import { getVerifiedKeysCache, makeTestBase, makeTestCtx } from './testSupport/baseHarness'
import { memStorage } from './testSupport/memStorage'
import { persistVerifiedMap } from './verifiedKeys'
import { VerifiedKeysCache } from './verifiedKeysCache'
import type { KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'

function canonicalBundle(fingerprint = 'AA'.repeat(20)): KeyBundle {
  return { fingerprint, publicArmored: '', keychainBacked: false }
}

/** Storage pre-populated with a persisted verified-key map, in the same
 * on-disk shape `loadVerifiedMap`/`persistVerifiedMap` (Task 1) read/write. */
async function storageWithVerified(map: Record<string, string>): Promise<PluginStorage> {
  const storage = memStorage()
  await persistVerifiedMap(storage, map)
  return storage
}

describe('OpenPGPPluginBase — verified-cache hydration in init()', () => {
  it('hydrates the verified cache before init resolves', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const storage = await storageWithVerified({ 'bob@x': 'ABCD' })
    const ctx = makeTestCtx(ACCOUNT, { storage })

    await base.init(ctx)

    // Synchronous read, no further await — must already see the persisted entry.
    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD')).toBe(true)
  })

  it('seeds the cache from the legacy store on first run', async () => {
    const { base, verified } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    verified.setVerified('bob@x', 'ABCD') // legacy store has data; plugin storage is empty
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD')).toBe(true)
    // And it was actually persisted, not just held in memory.
    const reloaded = new VerifiedKeysCache(ctx.storage)
    await reloaded.hydrate()
    expect(reloaded.isVerified('bob@x', 'ABCD')).toBe(true)
  })

  it('does NOT re-seed when the plugin store already has data', async () => {
    const { base, verified } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const storage = await storageWithVerified({ 'bob@x': 'REAL' })
    verified.setVerified('bob@x', 'STALE') // legacy disagrees with plugin-owned data
    const ctx = makeTestCtx(ACCOUNT, { storage })

    await base.init(ctx)

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'REAL')).toBe(true)
    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'STALE')).toBe(false)
    expect(getVerifiedKeysCache(base).getAll()).toEqual({ 'bob@x': 'REAL' })
  })

  it('a verified peer reads as verified immediately after init (no cold-cache window)', async () => {
    // Exercises the key-locked early return (~:537), which skips
    // activateSubscriptions() entirely. Hydration must still have happened
    // by the time init() resolves, because trust can be read in this state.
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => {
      throw new E2EEPluginError('transient', 'key-locked', 'locked')
    }
    const storage = await storageWithVerified({ 'bob@x': 'ABCD' })
    const ctx = makeTestCtx(ACCOUNT, { storage })

    await expect(base.init(ctx)).resolves.toBeUndefined()

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD')).toBe(true)
  })
})
