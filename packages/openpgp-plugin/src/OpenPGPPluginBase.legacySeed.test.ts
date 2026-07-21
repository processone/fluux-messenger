/**
 * Phase B2 Task 8 deleted the `hostStores.verifiedPeers` mirror (and the
 * app-side `verifiedPeerKeysStore` it wrapped) that `init()` used to seed
 * the plugin-owned `VerifiedKeysCache` from. In its place, `init()` seeds
 * ONCE from the legacy store's raw localStorage key(s) directly (see
 * `legacyVerifiedPeersSeed.ts` / `OpenPGPPluginBase.seedLegacyVerifiedPeers`).
 *
 * THESE TESTS PROTECT REAL USER DATA. An install that goes straight from a
 * pre-B1 release to a build with the mirror deleted has its verifications
 * sitting ONLY in that legacy localStorage blob — never having passed
 * through `hostStores.verifiedPeers` at all. If the seed silently failed to
 * find or apply that data, every peer the user verified would quietly
 * downgrade to `tofu` with no error, no warning, nothing. Each scenario
 * below is deliberately specific about WHERE the legacy data sits (the
 * account-scoped key introduced by the store's own migration / the
 * pre-migration unscoped key / both at once) and proves the result
 * round-trips through a FRESH `VerifiedKeysCache` reload, not just an
 * in-memory read that could pass even if persistence silently failed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildScopedStorageKey } from '@fluux/sdk'
import { getVerifiedKeysCache, makeTestBase, makeTestCtx } from './testSupport/baseHarness'
import { memStorage } from './testSupport/memStorage'
import { persistVerifiedMap } from './verifiedKeys'
import { VerifiedKeysCache } from './verifiedKeysCache'
import {
  readLegacyVerifiedPeers,
  removeLegacyVerifiedPeersKeys,
} from './legacyVerifiedPeersSeed'
import type { KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'
const LEGACY_KEY_BASE = 'fluux-e2ee-verified-peers'

function scopedLegacyKey(accountJid = ACCOUNT): string {
  return buildScopedStorageKey(LEGACY_KEY_BASE, accountJid)
}

function canonicalBundle(fingerprint = 'AA'.repeat(20)): KeyBundle {
  return { fingerprint, publicArmored: '', keychainBacked: false }
}

beforeEach(() => {
  localStorage.clear()
})

describe('OpenPGPPluginBase.init() — legacy verified-peers upgrade seed (Phase B2 Task 8)', () => {
  it('legacy SCOPED key present, PluginStorage empty -> readable through the plugin AND persisted', async () => {
    localStorage.setItem(scopedLegacyKey(), JSON.stringify({ 'bob@x': 'ABCD1234' }))
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD1234')).toBe(true)

    // Persisted, not merely held in memory: a FRESH cache instance over the
    // SAME storage (simulating the next app launch) must see it too.
    const reloaded = new VerifiedKeysCache(ctx.storage)
    await reloaded.hydrate()
    expect(reloaded.isVerified('bob@x', 'ABCD1234')).toBe(true)
  })

  it('legacy UNSCOPED (pre-migration) key present -> same outcome', async () => {
    localStorage.setItem(LEGACY_KEY_BASE, JSON.stringify({ 'bob@x': 'ABCD1234' }))
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD1234')).toBe(true)
    const reloaded = new VerifiedKeysCache(ctx.storage)
    await reloaded.hydrate()
    expect(reloaded.isVerified('bob@x', 'ABCD1234')).toBe(true)
  })

  it('both scoped and unscoped present -> the scoped one wins, no entry lost', async () => {
    localStorage.setItem(scopedLegacyKey(), JSON.stringify({ 'bob@x': 'SCOPED_FP' }))
    localStorage.setItem(LEGACY_KEY_BASE, JSON.stringify({ 'carol@x': 'UNSCOPED_FP' }))
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'SCOPED_FP')).toBe(true)
    expect(getVerifiedKeysCache(base).getVerifiedFingerprint('carol@x')).toBeNull()
    expect(getVerifiedKeysCache(base).getAll()).toEqual({ 'bob@x': 'SCOPED_FP' })

    const reloaded = new VerifiedKeysCache(ctx.storage)
    await reloaded.hydrate()
    expect(reloaded.getAll()).toEqual({ 'bob@x': 'SCOPED_FP' })
  })

  it('PluginStorage already populated -> the legacy key is NOT re-read and cannot clobber plugin-owned data', async () => {
    localStorage.setItem(scopedLegacyKey(), JSON.stringify({ 'bob@x': 'STALE_LEGACY_FP' }))
    const storage = memStorage()
    await persistVerifiedMap(storage, { 'bob@x': 'REAL_PLUGIN_FP' })
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT, { storage })

    const getItemSpy = vi.spyOn(localStorage, 'getItem')
    try {
      await base.init(ctx)

      // Literal "not re-read": the legacy key is never even asked for once
      // the plugin already owns data.
      expect(getItemSpy).not.toHaveBeenCalledWith(scopedLegacyKey())
    } finally {
      getItemSpy.mockRestore()
    }

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'REAL_PLUGIN_FP')).toBe(true)
    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'STALE_LEGACY_FP')).toBe(false)
    // Untouched — since it was never read, it was never removed either.
    expect(localStorage.getItem(scopedLegacyKey())).not.toBeNull()
  })

  it('after a successful seed, the legacy key is removed and a second init is a no-op', async () => {
    localStorage.setItem(scopedLegacyKey(), JSON.stringify({ 'bob@x': 'ABCD1234' }))
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(localStorage.getItem(scopedLegacyKey())).toBeNull()
    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD1234')).toBe(true)

    // Simulate the next app launch: a fresh plugin instance, same
    // PluginStorage. Nothing left to seed from (the legacy key is gone) —
    // this must not error and must not disturb the already-migrated data.
    const { base: base2 } = makeTestBase()
    base2.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx2 = makeTestCtx(ACCOUNT, { storage: ctx.storage })

    await expect(base2.init(ctx2)).resolves.toBeUndefined()

    expect(getVerifiedKeysCache(base2).isVerified('bob@x', 'ABCD1234')).toBe(true)
  })
})

describe('readLegacyVerifiedPeers / removeLegacyVerifiedPeersKeys (pure read helpers)', () => {
  it('returns an empty read when neither key is present', () => {
    expect(readLegacyVerifiedPeers(ACCOUNT)).toEqual({ map: {}, keysToRemove: [] })
  })

  it('tolerates a corrupt (non-JSON) scoped blob by treating it as empty', () => {
    localStorage.setItem(scopedLegacyKey(), 'not json{{{')
    expect(readLegacyVerifiedPeers(ACCOUNT)).toEqual({ map: {}, keysToRemove: [scopedLegacyKey()] })
  })

  it('drops non-string-keyed / non-string-valued / empty-string entries defensively', () => {
    localStorage.setItem(
      scopedLegacyKey(),
      JSON.stringify({ 'bob@x': 'FP1', 'carol@x': '', 'dave@x': 42 }),
    )
    expect(readLegacyVerifiedPeers(ACCOUNT).map).toEqual({ 'bob@x': 'FP1' })
  })

  it('removeLegacyVerifiedPeersKeys is best-effort and silent on a missing key', () => {
    expect(() => removeLegacyVerifiedPeersKeys(['nonexistent-key'])).not.toThrow()
  })
})
