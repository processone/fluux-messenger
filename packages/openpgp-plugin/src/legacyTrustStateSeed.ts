/**
 * One-shot upgrade paths for OpenPGP trust-state data that used to live
 * directly in `localStorage`, now that Phase B3 moves it behind
 * `PluginStorage` (Task 4: the verification-sync applied/published version
 * counter; Task 5 will extend this module for the trust-state seal blob and
 * its init flag).
 *
 * Mirrors `legacyVerifiedPeersSeed.ts`'s shape exactly: pure, read-only
 * `readLegacy*` functions that never mutate `localStorage`, a separate
 * best-effort `removeLegacy*Keys` cleanup function, and an orchestration
 * function that reads, seeds the new store, and removes the legacy key(s)
 * only after the new value is durably persisted.
 *
 * Checks BOTH the account-scoped key (`buildScopedStorageKey`) and the
 * pre-account-scoping unscoped key, same reasoning as
 * `legacyVerifiedPeersSeed.ts`: an install that neither ran the scoping
 * migration nor any later dual-write may still have only the pre-migration
 * unscoped blob. When both exist, the migration never picks the "wrong"
 * (lower) one — see {@link migrateLegacySyncVersion}'s doc comment for why
 * this differs from `legacyVerifiedPeersSeed.ts`'s "scoped always wins"
 * rule. Both keys are always reported for removal when either was read, so
 * neither survives as an orphan that could resurface on a later launch.
 */
import { buildScopedStorageKey } from '@fluux/sdk'
import type { SyncVersionCache } from './syncVersionCache'

const LEGACY_VERSION_KEY_BASE = 'fluux-e2ee-verifications-version'

function legacyScopedVersionKey(accountBareJid: string): string {
  return buildScopedStorageKey(LEGACY_VERSION_KEY_BASE, accountBareJid)
}

export interface LegacySyncVersionRead {
  /**
   * Highest version found across the scoped and unscoped legacy keys, or
   * `null` when neither held a parseable value — the migration must never
   * lower the counter, so when both are present the caller applies the
   * MAX of the two, not "prefer scoped" (which is `legacyVerifiedPeersSeed`'s
   * rule for the verified-peers MAP, where "prefer scoped" is about which
   * DATA wins, not a monotonic quantity).
   */
  version: number | null
  /**
   * The raw localStorage key(s) to remove after a successful seed. May be
   * non-empty even when `version` is `null` (e.g. a corrupt blob) so the
   * caller can clean up a legacy key it will never use again.
   */
  keysToRemove: string[]
}

function parseLegacyVersion(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Read-only: never mutates `localStorage`. Checks both the scoped and
 * unscoped keys (unconditionally — unlike `readLegacyVerifiedPeers`, which
 * only consults the unscoped key when the scoped one is absent, because
 * here BOTH values matter for the max, not just whichever is found first).
 * Returns `{ version: null, keysToRemove: [] }` on any `localStorage`
 * failure (unavailable, disabled) — the caller treats that identically to
 * "nothing to seed".
 */
export function readLegacySyncVersion(accountBareJid: string): LegacySyncVersionRead {
  try {
    const scopedKey = legacyScopedVersionKey(accountBareJid)
    const scopedRaw = localStorage.getItem(scopedKey)
    const scopedVersion = parseLegacyVersion(scopedRaw)

    const unscopedIsDistinctKey = scopedKey !== LEGACY_VERSION_KEY_BASE
    const unscopedRaw = unscopedIsDistinctKey ? localStorage.getItem(LEGACY_VERSION_KEY_BASE) : null
    const unscopedVersion = parseLegacyVersion(unscopedRaw)

    const keysToRemove: string[] = []
    if (scopedRaw !== null) keysToRemove.push(scopedKey)
    if (unscopedIsDistinctKey && unscopedRaw !== null) keysToRemove.push(LEGACY_VERSION_KEY_BASE)

    if (scopedVersion === null && unscopedVersion === null) {
      return { version: null, keysToRemove }
    }
    // Never lower the version during migration — take the max of whatever
    // legacy sources exist.
    const version = Math.max(
      scopedVersion ?? Number.NEGATIVE_INFINITY,
      unscopedVersion ?? Number.NEGATIVE_INFINITY,
    )
    return { version, keysToRemove }
  } catch {
    // localStorage unavailable — nothing to seed.
    return { version: null, keysToRemove: [] }
  }
}

/**
 * Best-effort removal of the legacy key(s) after a successful seed. A
 * failure here is harmless: the plugin-owned cache now owns the data, and
 * {@link migrateLegacySyncVersion} is a no-op once the cache is populated,
 * so a leftover legacy key is simply never read again.
 */
export function removeLegacySyncVersionKeys(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Best-effort — see the doc comment above.
    }
  }
}

/**
 * One-shot upgrade path, called once per `OpenPGPPluginBase.init()`: if the
 * plugin-owned `SyncVersionCache` is still at its "nothing applied yet"
 * sentinel (`-1`), read the legacy `localStorage` key(s), seed the cache
 * with the higher of the two (never lowering it), and remove the legacy
 * key(s) — whether or not there was anything to seed. `readLegacySyncVersion`
 * can report `keysToRemove` for a corrupt/empty value too (`version: null`),
 * and that key must still be deleted here or it survives forever, silently
 * re-read (and re-ignored) on every future launch.
 *
 * Guards on `cache.get() !== -1` BEFORE touching `localStorage` at all — not
 * just relying on `SyncVersionCache.set`'s own clamp — so an install that
 * already upgraded (or never had legacy data, or has already applied/
 * published a real version through the new path) never re-reads, and
 * therefore never removes, the legacy key on every subsequent launch. This
 * mirrors `OpenPGPPluginBase.seedLegacyVerifiedPeers`'s guard exactly.
 *
 * The new value is durably persisted (`await cache.set(version)`) BEFORE
 * the legacy key(s) are removed: removing first and persisting after would
 * leave a window where a crash mid-migration loses the version with no
 * remaining copy anywhere, silently resetting the replay-defense counter to
 * `-1` and reopening the replay window for every previously-applied
 * snapshot.
 */
export async function migrateLegacySyncVersion(
  cache: SyncVersionCache,
  accountBareJid: string,
): Promise<void> {
  if (cache.get() !== -1) return
  const { version, keysToRemove } = readLegacySyncVersion(accountBareJid)
  if (version === null) {
    removeLegacySyncVersionKeys(keysToRemove)
    return
  }
  await cache.set(version)
  removeLegacySyncVersionKeys(keysToRemove)
}
