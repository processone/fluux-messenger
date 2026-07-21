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
import { describe, it, expect, beforeEach } from 'vitest'
import { buildScopedStorageKey } from '@fluux/sdk'
import {
  readLegacySyncVersion,
  removeLegacySyncVersionKeys,
  migrateLegacySyncVersion,
} from './legacyTrustStateSeed'
import { SyncVersionCache } from './syncVersionCache'
import { memStorage } from './testSupport/memStorage'

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
