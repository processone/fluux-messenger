/**
 * B3 Task 4 integration coverage: proves the sync-version counter's
 * `SyncVersionCache` is actually wired through `OpenPGPPluginBase.init()` —
 * hydrated from the real `ctx.storage`, bound to the module-level
 * `loadAppliedVerificationsVersion` / `saveAppliedVerificationsVersion`
 * accessors `trustStateIntegrity.ts` and the rest of `OpenPGPPluginBase.ts`
 * read through, and seeded from the legacy `localStorage` key end to end.
 *
 * `syncVersionCache.test.ts` and `legacyTrustStateSeed.test.ts` cover the
 * cache class and the migration function in isolation; this file drives the
 * same behaviour through the real `init()` entry point so a wiring mistake
 * (wrong storage, wrong jid, binding the wrong instance) would show up here
 * even if the isolated unit tests still passed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildScopedStorageKey } from '@fluux/sdk'
import {
  getSyncVersionCache,
  getVerifiedKeysCache,
  makeTestBase,
  makeTestCtx,
} from './testSupport/baseHarness'
import { SyncVersionCache } from './syncVersionCache'
import {
  getSyncVersionCache as getBoundSyncVersionCache,
  loadAppliedVerificationsVersion,
} from './verificationSync'
import { buildCanonicalSnapshot } from './trustStateIntegrity'
import { createMockHostStores } from './testing/mockHostStores'
import type { KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'
const LEGACY_KEY_BASE = 'fluux-e2ee-verifications-version'

function scopedLegacyKey(accountJid = ACCOUNT): string {
  return buildScopedStorageKey(LEGACY_KEY_BASE, accountJid)
}

function canonicalBundle(fingerprint = 'AA'.repeat(20)): KeyBundle {
  return { fingerprint, publicArmored: '', keychainBacked: false }
}

beforeEach(() => {
  localStorage.clear()
})

describe('OpenPGPPluginBase.init() — SyncVersionCache wiring (B3 Task 4)', () => {
  it('binds the module-level accessor to the SAME cache init() hydrated', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(getBoundSyncVersionCache()).toBe(getSyncVersionCache(base))
  })

  it('buildCanonicalSnapshot returns the correct syncVersion SYNCHRONOUSLY after a real local-verify-triggered publish reservation', async () => {
    vi.useFakeTimers()
    try {
      const { base } = makeTestBase()
      base.ensureKeyMaterialImpl = async () => canonicalBundle()
      const ctx = makeTestCtx(ACCOUNT)
      await base.init(ctx)
      // Flush init()'s own fire-and-forget syncVerificationsFromServer()
      // (empty queryPEP result) before writing locally — same gap
      // SequoiaPgpPlugin.test.ts's equivalent test flushes explicitly.
      await Promise.resolve()
      await Promise.resolve()

      await getVerifiedKeysCache(base).setVerified('bob@x', 'BOB_FP')
      // Advance past the 500ms publish debounce, which reserves (and
      // synchronously persists into the cache) the next version.
      await vi.advanceTimersByTimeAsync(600)

      expect(loadAppliedVerificationsVersion()).toBe(1)

      const hostStores = createMockHostStores()
      const snapshot = buildCanonicalSnapshot(hostStores, getVerifiedKeysCache(base).getAll())
      expect(snapshot.syncVersion).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('legacy scoped key present -> seeded through init(), persisted, and readable via buildCanonicalSnapshot', async () => {
    localStorage.setItem(scopedLegacyKey(), '4')
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(loadAppliedVerificationsVersion()).toBe(4)
    expect(localStorage.getItem(scopedLegacyKey())).toBeNull()

    const hostStores = createMockHostStores()
    const snapshot = buildCanonicalSnapshot(hostStores, getVerifiedKeysCache(base).getAll())
    expect(snapshot.syncVersion).toBe(4)

    // Persisted, not merely held in memory: a FRESH cache instance over the
    // SAME storage (simulating the next app launch) must see it too.
    const reloaded = new SyncVersionCache(ctx.storage)
    await reloaded.hydrate()
    expect(reloaded.get()).toBe(4)
  })

  it('PluginStorage already populated -> init() does not re-read or lower the persisted version from a stale legacy key', async () => {
    localStorage.setItem(scopedLegacyKey(), '99')
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    // Simulate a real, already-migrated install: PluginStorage already has
    // a genuine (lower) version, and the stale legacy key is left dangling
    // (as if a previous migration on a different device path failed to
    // clean it up, or it's simply left over from before Task 4 shipped).
    const preSeed = new SyncVersionCache(ctx.storage)
    await preSeed.hydrate()
    await preSeed.set(6)

    await base.init(ctx)

    expect(loadAppliedVerificationsVersion()).toBe(6)
    // Untouched — never read because PluginStorage already had a value.
    expect(localStorage.getItem(scopedLegacyKey())).not.toBeNull()
  })
})
