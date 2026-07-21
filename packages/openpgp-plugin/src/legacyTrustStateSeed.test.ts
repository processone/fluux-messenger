/**
 * THESE TESTS PROTECT REAL USER DATA. Before Phase B3 Task 4, the
 * verification-sync applied/published version counter lived in a
 * `localStorage` blob. Moving it into `PluginStorage` without migrating
 * would silently reset the counter to `-1`, re-opening the replay window
 * for every previously-applied snapshot (see `verificationSync.ts`'s module
 * doc: a signature proves authorship but not freshness — the monotonic
 * version is what closes the replay/rollback path). Each scenario below
 * proves the migrated value round-trips through a FRESH `SyncVersionCache`
 * reload, not just an in-memory read that could pass even if persistence
 * silently failed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildScopedStorageKey, type PluginStorage } from '@fluux/sdk'
import {
  readLegacySyncVersion,
  removeLegacySyncVersionKeys,
  migrateLegacySyncVersion,
  readLegacyTrustSeal,
  removeLegacyTrustSealKeys,
  migrateLegacyTrustSeal,
} from './legacyTrustStateSeed'
import { SyncVersionCache } from './syncVersionCache'
import { memStorage } from './testSupport/memStorage'
import {
  buildCanonicalSnapshot,
  hasStoredSeal,
  sealTrustState,
  verifyTrustStateSeal,
  SEAL_STORAGE_KEY,
  INIT_FLAG_STORAGE_KEY,
} from './trustStateIntegrity'
import { createMockHostStores } from './testing/mockHostStores'

const ACCOUNT = 'alice@example.com'
const LEGACY_KEY_BASE = 'fluux-e2ee-verifications-version'

function scopedLegacyKey(accountJid = ACCOUNT): string {
  return buildScopedStorageKey(LEGACY_KEY_BASE, accountJid)
}

beforeEach(() => {
  localStorage.clear()
})

describe('readLegacySyncVersion / removeLegacySyncVersionKeys (pure read helpers)', () => {
  it('returns no version and nothing to remove when neither key is present', () => {
    expect(readLegacySyncVersion(ACCOUNT)).toEqual({ version: null, keysToRemove: [] })
  })

  it('reads the scoped key when present', () => {
    localStorage.setItem(scopedLegacyKey(), '4')
    expect(readLegacySyncVersion(ACCOUNT)).toEqual({ version: 4, keysToRemove: [scopedLegacyKey()] })
  })

  it('reads the unscoped (pre-migration) key when present', () => {
    localStorage.setItem(LEGACY_KEY_BASE, '4')
    expect(readLegacySyncVersion(ACCOUNT)).toEqual({ version: 4, keysToRemove: [LEGACY_KEY_BASE] })
  })

  it('when both are present, the HIGHER value wins and BOTH keys are reported for removal', () => {
    localStorage.setItem(scopedLegacyKey(), '3')
    localStorage.setItem(LEGACY_KEY_BASE, '9')
    const read = readLegacySyncVersion(ACCOUNT)
    expect(read.version).toBe(9)
    expect(read.keysToRemove.sort()).toEqual([LEGACY_KEY_BASE, scopedLegacyKey()].sort())
  })

  it('when both are present with the scoped one higher, the scoped value still wins (max, not "prefer scoped")', () => {
    localStorage.setItem(scopedLegacyKey(), '9')
    localStorage.setItem(LEGACY_KEY_BASE, '3')
    const read = readLegacySyncVersion(ACCOUNT)
    expect(read.version).toBe(9)
    expect(read.keysToRemove.sort()).toEqual([LEGACY_KEY_BASE, scopedLegacyKey()].sort())
  })

  it('tolerates a corrupt (non-numeric) scoped value by treating it as absent, but still reports the key for removal', () => {
    localStorage.setItem(scopedLegacyKey(), 'not-a-number')
    expect(readLegacySyncVersion(ACCOUNT)).toEqual({ version: null, keysToRemove: [scopedLegacyKey()] })
  })

  it('removeLegacySyncVersionKeys is best-effort and silent on a missing key', () => {
    expect(() => removeLegacySyncVersionKeys(['nonexistent-key'])).not.toThrow()
  })
})

describe('migrateLegacySyncVersion', () => {
  it('scoped key present, cache empty (-1) -> seeded and persisted', async () => {
    localStorage.setItem(scopedLegacyKey(), '4')
    const storage = memStorage()
    const cache = new SyncVersionCache(storage)
    await cache.hydrate()

    await migrateLegacySyncVersion(cache, ACCOUNT)

    expect(cache.get()).toBe(4)
    // Persisted, not merely held in memory: a FRESH cache instance over the
    // SAME storage (simulating the next app launch) must see it too.
    const reloaded = new SyncVersionCache(storage)
    await reloaded.hydrate()
    expect(reloaded.get()).toBe(4)
    expect(localStorage.getItem(scopedLegacyKey())).toBeNull()
  })

  it('unscoped key present -> same outcome', async () => {
    localStorage.setItem(LEGACY_KEY_BASE, '4')
    const storage = memStorage()
    const cache = new SyncVersionCache(storage)
    await cache.hydrate()

    await migrateLegacySyncVersion(cache, ACCOUNT)

    expect(cache.get()).toBe(4)
    const reloaded = new SyncVersionCache(storage)
    await reloaded.hydrate()
    expect(reloaded.get()).toBe(4)
    expect(localStorage.getItem(LEGACY_KEY_BASE)).toBeNull()
  })

  it('both present -> the HIGHER value is seeded and BOTH legacy keys are removed', async () => {
    localStorage.setItem(scopedLegacyKey(), '3')
    localStorage.setItem(LEGACY_KEY_BASE, '9')
    const storage = memStorage()
    const cache = new SyncVersionCache(storage)
    await cache.hydrate()

    await migrateLegacySyncVersion(cache, ACCOUNT)

    expect(cache.get()).toBe(9)
    const reloaded = new SyncVersionCache(storage)
    await reloaded.hydrate()
    expect(reloaded.get()).toBe(9)
    expect(localStorage.getItem(scopedLegacyKey())).toBeNull()
    expect(localStorage.getItem(LEGACY_KEY_BASE)).toBeNull()
  })

  it('PluginStorage already populated -> legacy is not read at all, and cannot clobber the real value', async () => {
    localStorage.setItem(scopedLegacyKey(), '99')
    const storage = memStorage()
    const cache = new SyncVersionCache(storage)
    await cache.hydrate()
    await cache.set(6) // real, plugin-owned value

    await migrateLegacySyncVersion(cache, ACCOUNT)

    expect(cache.get()).toBe(6)
    // Untouched — since it was never read, it was never removed either.
    expect(localStorage.getItem(scopedLegacyKey())).not.toBeNull()
  })

  it('legacy key is corrupt -> nothing to seed, but the key is still removed so it is not re-read on every future launch', async () => {
    localStorage.setItem(scopedLegacyKey(), 'not-a-number')
    const storage = memStorage()
    const cache = new SyncVersionCache(storage)
    await cache.hydrate()

    await migrateLegacySyncVersion(cache, ACCOUNT)

    expect(cache.get()).toBe(-1)
    expect(localStorage.getItem(scopedLegacyKey())).toBeNull()
  })

  it('a second call (simulating a second init) is a no-op', async () => {
    localStorage.setItem(scopedLegacyKey(), '4')
    const storage = memStorage()
    const cache = new SyncVersionCache(storage)
    await cache.hydrate()

    await migrateLegacySyncVersion(cache, ACCOUNT)
    expect(cache.get()).toBe(4)
    expect(localStorage.getItem(scopedLegacyKey())).toBeNull()

    // Simulate the next app launch: a fresh cache over the same storage.
    const reloaded = new SyncVersionCache(storage)
    await reloaded.hydrate()
    await expect(migrateLegacySyncVersion(reloaded, ACCOUNT)).resolves.toBeUndefined()
    expect(reloaded.get()).toBe(4)
  })
})

/**
 * B3 Task 5: the trust-state integrity seal blob + its "we have sealed
 * before" init flag move from two `localStorage` keys into `PluginStorage`.
 *
 * THESE TESTS ALSO PROTECT REAL USER DATA, for a sharper reason than the
 * sync-version counter above: `verifyTrustStateSeal` treats "no seal blob,
 * but the init flag says we sealed before, and the stores hold data" as
 * `compromised` — a strong, user-facing "trust state compromised" warning.
 * Migrating the blob without the flag, or the flag without the blob, would
 * manufacture that warning purely from an incomplete migration, at the
 * worst possible moment (right after an upgrade). The HEADLINE test below
 * proves the migration does NOT do this for unchanged state; the
 * "together-ness" test proves what happens when it's broken.
 */
const LEGACY_SEAL_KEY_BASE = 'fluux-e2ee-trust-state-seal'
const LEGACY_INIT_FLAG_KEY_BASE = 'fluux-e2ee-trust-integrity-init'

function scopedLegacySealKey(accountJid = ACCOUNT): string {
  return buildScopedStorageKey(LEGACY_SEAL_KEY_BASE, accountJid)
}

function scopedLegacyInitFlagKey(accountJid = ACCOUNT): string {
  return buildScopedStorageKey(LEGACY_INIT_FLAG_KEY_BASE, accountJid)
}

describe('readLegacyTrustSeal / removeLegacyTrustSealKeys (pure read helpers)', () => {
  it('returns an empty read when nothing is present', () => {
    expect(readLegacyTrustSeal(ACCOUNT)).toEqual({ sealArmored: null, initialized: false, keysToRemove: [] })
  })

  it('reads the scoped blob + flag when present', () => {
    localStorage.setItem(scopedLegacySealKey(), 'SCOPED-BLOB')
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')
    const read = readLegacyTrustSeal(ACCOUNT)
    expect(read.sealArmored).toBe('SCOPED-BLOB')
    expect(read.initialized).toBe(true)
    expect(read.keysToRemove.sort()).toEqual([scopedLegacySealKey(), scopedLegacyInitFlagKey()].sort())
  })

  it('reads the unscoped (pre-migration) blob + flag when present', () => {
    localStorage.setItem(LEGACY_SEAL_KEY_BASE, 'UNSCOPED-BLOB')
    localStorage.setItem(LEGACY_INIT_FLAG_KEY_BASE, '1')
    const read = readLegacyTrustSeal(ACCOUNT)
    expect(read.sealArmored).toBe('UNSCOPED-BLOB')
    expect(read.initialized).toBe(true)
    expect(read.keysToRemove.sort()).toEqual([LEGACY_SEAL_KEY_BASE, LEGACY_INIT_FLAG_KEY_BASE].sort())
  })

  it('when both blobs are present, the SCOPED one wins (data, not a monotonic quantity — "prefer scoped" like legacyVerifiedPeersSeed, not "max" like the sync version above)', () => {
    localStorage.setItem(scopedLegacySealKey(), 'SCOPED-BLOB')
    localStorage.setItem(LEGACY_SEAL_KEY_BASE, 'UNSCOPED-BLOB')
    const read = readLegacyTrustSeal(ACCOUNT)
    expect(read.sealArmored).toBe('SCOPED-BLOB')
    expect(read.keysToRemove.sort()).toEqual([scopedLegacySealKey(), LEGACY_SEAL_KEY_BASE].sort())
  })

  it('the init flag is true if EITHER legacy key recorded it, independent of which blob wins', () => {
    localStorage.setItem(scopedLegacySealKey(), 'SCOPED-BLOB')
    localStorage.setItem(LEGACY_INIT_FLAG_KEY_BASE, '1') // only the unscoped flag was ever set
    const read = readLegacyTrustSeal(ACCOUNT)
    expect(read.sealArmored).toBe('SCOPED-BLOB')
    expect(read.initialized).toBe(true)
  })

  it('a stray init flag with no accompanying blob is still reported for removal', () => {
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')
    const read = readLegacyTrustSeal(ACCOUNT)
    expect(read).toEqual({ sealArmored: null, initialized: true, keysToRemove: [scopedLegacyInitFlagKey()] })
  })

  it('removeLegacyTrustSealKeys is best-effort and silent on a missing key', () => {
    expect(() => removeLegacyTrustSealKeys(['nonexistent-key'])).not.toThrow()
  })
})

describe('migrateLegacyTrustSeal', () => {
  const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
  const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
  const decryptOk = async (ciphertext: string) => ({
    plaintext: ciphertext,
    signatureVerified: true,
    signerFingerprint: OWN_FP,
    signaturePresent: true,
  })

  it('HEADLINE: after migration, verifyTrustStateSeal reports sealed (not compromised) for unchanged state', async () => {
    const host = createMockHostStores()
    host._reset()
    host.pinnedPrimaryFingerprints.set('peer@example.com', 'PEERFP')

    // Simulate the pre-B3-Task-5 world: the seal (an encrypt-to-self blob;
    // a plain JSON string stands in for it here since the decrypt below is
    // a passthrough) and the init flag sitting directly in the legacy
    // localStorage keys.
    const snapshot = buildCanonicalSnapshot(host, {})
    localStorage.setItem(scopedLegacySealKey(), JSON.stringify(snapshot))
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')

    const storage = memStorage()
    await migrateLegacyTrustSeal(storage, ACCOUNT)

    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, storage)
    expect(res.status).toBe('sealed')
  })

  it('the migrated blob + flag are durably persisted in PluginStorage (raw byte round-trip), not just observable through verifyTrustStateSeal', async () => {
    localStorage.setItem(scopedLegacySealKey(), 'ARMORED-BLOB')
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')
    const storage = memStorage()

    await migrateLegacyTrustSeal(storage, ACCOUNT)

    expect(await hasStoredSeal(storage)).toBe(true)
    const dec = new TextDecoder()
    expect(dec.decode((await storage.get(SEAL_STORAGE_KEY))!)).toBe('ARMORED-BLOB')
    expect(dec.decode((await storage.get(INIT_FLAG_STORAGE_KEY))!)).toBe('1')
    expect(localStorage.getItem(scopedLegacySealKey())).toBeNull()
    expect(localStorage.getItem(scopedLegacyInitFlagKey())).toBeNull()
  })

  it('legacy UNSCOPED blob + flag present -> same outcome', async () => {
    localStorage.setItem(LEGACY_SEAL_KEY_BASE, 'ARMORED-BLOB')
    localStorage.setItem(LEGACY_INIT_FLAG_KEY_BASE, '1')
    const storage = memStorage()

    await migrateLegacyTrustSeal(storage, ACCOUNT)

    expect(await hasStoredSeal(storage)).toBe(true)
    expect(localStorage.getItem(LEGACY_SEAL_KEY_BASE)).toBeNull()
    expect(localStorage.getItem(LEGACY_INIT_FLAG_KEY_BASE)).toBeNull()
  })

  it('PluginStorage already populated -> legacy is not read at all, and cannot clobber the real value', async () => {
    localStorage.setItem(scopedLegacySealKey(), 'STALE-LEGACY-BLOB')
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')
    const storage = memStorage()
    // Real, plugin-owned seal already present (e.g. this account already
    // upgraded and has since sealed for real).
    const host = createMockHostStores()
    host._reset()
    await sealTrustState(async (p) => p, OWN_PUBLIC, host, {}, storage)

    const getItemSpy = vi.spyOn(localStorage, 'getItem')
    try {
      await migrateLegacyTrustSeal(storage, ACCOUNT)
      expect(getItemSpy).not.toHaveBeenCalledWith(scopedLegacySealKey())
    } finally {
      getItemSpy.mockRestore()
    }

    // Untouched — since it was never read, it was never removed either.
    expect(localStorage.getItem(scopedLegacySealKey())).not.toBeNull()
  })

  it('nothing legacy present -> no-op, nothing to remove', async () => {
    const storage = memStorage()
    await expect(migrateLegacyTrustSeal(storage, ACCOUNT)).resolves.toBeUndefined()
    expect(await hasStoredSeal(storage)).toBe(false)
  })

  it('a stray legacy init flag with no blob is carried forward (preserves a genuine pre-existing compromise signal rather than silently dropping it), and the stray key is removed', async () => {
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')
    const storage = memStorage()

    await migrateLegacyTrustSeal(storage, ACCOUNT)

    expect(await hasStoredSeal(storage)).toBe(false)
    const dec = new TextDecoder()
    expect(dec.decode((await storage.get(INIT_FLAG_STORAGE_KEY))!)).toBe('1')
    expect(localStorage.getItem(scopedLegacyInitFlagKey())).toBeNull()
  })

  it('a second call (simulating a second init) is a no-op', async () => {
    localStorage.setItem(scopedLegacySealKey(), 'ARMORED-BLOB')
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')
    const storage = memStorage()

    await migrateLegacyTrustSeal(storage, ACCOUNT)
    expect(localStorage.getItem(scopedLegacySealKey())).toBeNull()

    await expect(migrateLegacyTrustSeal(storage, ACCOUNT)).resolves.toBeUndefined()
    expect(await hasStoredSeal(storage)).toBe(true)
  })

  // Together-ness / durability-ordering: a failed persist must never
  // destroy the only remaining copy of the seal. If the legacy keys were
  // removed before the PluginStorage write durably lands, a crash (or, as
  // simulated here, an outright persist failure) mid-migration would leave
  // NEITHER location holding the blob, producing `compromised` on the very
  // next launch — a tamper warning generated entirely by our own refactor.
  it('a failed persist leaves the legacy keys intact (write-before-remove ordering)', async () => {
    localStorage.setItem(scopedLegacySealKey(), 'ARMORED-BLOB')
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')
    const storage: PluginStorage = memStorage()
    storage.put = async () => {
      throw new Error('disk full')
    }

    await expect(migrateLegacyTrustSeal(storage, ACCOUNT)).rejects.toThrow('disk full')

    expect(localStorage.getItem(scopedLegacySealKey())).not.toBeNull()
    expect(localStorage.getItem(scopedLegacyInitFlagKey())).not.toBeNull()
  })
})
