/**
 * One-shot upgrade paths for OpenPGP trust-state data that used to live
 * directly in `localStorage`, now that Phase B3 moves it behind
 * `PluginStorage` (Task 4: the verification-sync applied/published version
 * counter; Task 5: the trust-state seal blob and its init flag).
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
 * unscoped blob. For the sync-version counter, when both exist, the
 * migration never picks the "wrong" (lower) one — see
 * {@link migrateLegacySyncVersion}'s doc comment for why this differs from
 * `legacyVerifiedPeersSeed.ts`'s "scoped always wins" rule. For the trust
 * seal (Task 5), the seal is DATA (an opaque blob), not a monotonic
 * quantity, so {@link migrateLegacyTrustSeal} follows `legacyVerifiedPeersSeed.ts`'s
 * own "scoped wins" rule instead. Both keys are always reported for removal
 * when either was read, so neither survives as an orphan that could
 * resurface on a later launch.
 */
import { buildScopedStorageKey } from '@fluux/sdk'
import type { PluginStorage } from '@fluux/sdk'
import type { SyncVersionCache } from './syncVersionCache'
import { hasStoredSeal, writeSealBytes, writeInitFlag } from './trustStateIntegrity'

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

// ---------------------------------------------------------------------------
// Task 5: trust-state integrity seal blob + init flag
// ---------------------------------------------------------------------------

const LEGACY_SEAL_KEY_BASE = 'fluux-e2ee-trust-state-seal'
const LEGACY_INIT_FLAG_KEY_BASE = 'fluux-e2ee-trust-integrity-init'

function legacyScopedSealKey(accountBareJid: string): string {
  return buildScopedStorageKey(LEGACY_SEAL_KEY_BASE, accountBareJid)
}

function legacyScopedInitFlagKey(accountBareJid: string): string {
  return buildScopedStorageKey(LEGACY_INIT_FLAG_KEY_BASE, accountBareJid)
}

export interface LegacyTrustSealRead {
  /**
   * The armored seal blob from whichever legacy key held it, preferring the
   * scoped key over the pre-scoping unscoped one (this is DATA, like
   * `legacyVerifiedPeersSeed.ts`'s verified-peers map — not a monotonic
   * quantity like the sync-version counter above, so "prefer scoped" is the
   * right rule here, not "max"). `null` when neither legacy key held a
   * value.
   */
  sealArmored: string | null
  /**
   * Whether EITHER legacy key recorded "we have sealed before". Read
   * independently of which seal blob won above: if either legacy install
   * ever completed a seal, that fact must survive the migration.
   */
  initialized: boolean
  /**
   * The raw localStorage key(s) to remove after a successful seed. May be
   * non-empty even when `sealArmored` is `null` (e.g. a stray init flag with
   * no accompanying blob) so the caller can clean up a legacy key it will
   * never use again.
   */
  keysToRemove: string[]
}

/**
 * Read-only: never mutates `localStorage`. Checks both the scoped and
 * unscoped keys for the seal blob AND the init flag independently (four
 * `localStorage` reads total), same unconditional-check reasoning as
 * {@link readLegacySyncVersion} — unlike `readLegacyVerifiedPeers`, which
 * only consults the unscoped key when the scoped one is absent.
 * Returns an all-empty read on any `localStorage` failure (unavailable,
 * disabled) — the caller treats that identically to "nothing to seed".
 */
export function readLegacyTrustSeal(accountBareJid: string): LegacyTrustSealRead {
  try {
    const scopedSealKey = legacyScopedSealKey(accountBareJid)
    const scopedSeal = localStorage.getItem(scopedSealKey)
    const unscopedSealIsDistinct = scopedSealKey !== LEGACY_SEAL_KEY_BASE
    const unscopedSeal = unscopedSealIsDistinct ? localStorage.getItem(LEGACY_SEAL_KEY_BASE) : null

    const scopedInitKey = legacyScopedInitFlagKey(accountBareJid)
    const scopedInit = localStorage.getItem(scopedInitKey)
    const unscopedInitIsDistinct = scopedInitKey !== LEGACY_INIT_FLAG_KEY_BASE
    const unscopedInit = unscopedInitIsDistinct ? localStorage.getItem(LEGACY_INIT_FLAG_KEY_BASE) : null

    const keysToRemove: string[] = []
    if (scopedSeal !== null) keysToRemove.push(scopedSealKey)
    if (unscopedSealIsDistinct && unscopedSeal !== null) keysToRemove.push(LEGACY_SEAL_KEY_BASE)
    if (scopedInit !== null) keysToRemove.push(scopedInitKey)
    if (unscopedInitIsDistinct && unscopedInit !== null) keysToRemove.push(LEGACY_INIT_FLAG_KEY_BASE)

    return {
      sealArmored: scopedSeal ?? unscopedSeal,
      initialized: scopedInit === '1' || unscopedInit === '1',
      keysToRemove,
    }
  } catch {
    // localStorage unavailable — nothing to seed.
    return { sealArmored: null, initialized: false, keysToRemove: [] }
  }
}

/**
 * Best-effort removal of the legacy key(s) after a successful seed. A
 * failure here is harmless: the plugin-owned `PluginStorage` now owns the
 * data, and {@link migrateLegacyTrustSeal} is a no-op once it does, so a
 * leftover legacy key is simply never read again.
 */
export function removeLegacyTrustSealKeys(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Best-effort — see the doc comment above.
    }
  }
}

/**
 * One-shot upgrade path, called once per `OpenPGPPluginBase.init()`
 * (alongside {@link migrateLegacySyncVersion}, before any trust-state seal
 * verification can run): if `storage` doesn't already hold a sealed blob,
 * read the legacy `localStorage` key(s), copy the blob (and, if the blob
 * copy succeeds, the init flag too) into `storage`, and remove the legacy
 * key(s) — whether or not there was anything to seed.
 *
 * ## Why the flag is written only alongside a blob, never alone
 *
 * `verifyTrustStateSeal` treats "no seal blob, but the init flag says we've
 * sealed before, and the stores hold data" as `compromised` — see
 * `trustStateIntegrity.ts`'s "seal was removed but stores contain data"
 * branch. If this migration ever wrote the NEW init flag without the NEW
 * blob actually landing first, that exact condition would fire on the very
 * next verify, manufacturing a tamper warning purely from an incomplete
 * migration. So the blob write is always attempted first and awaited before
 * the flag write is even considered, and BOTH must be durably persisted
 * before the legacy keys — the only remaining copies — are removed. (The
 * one exception: if the legacy state was already `initialized` with no
 * accompanying blob — e.g. a pre-existing corrupt/tampered install — that
 * flag-only truth is carried forward as-is rather than silently dropped,
 * which would launder a real tamper signal into a fresh, silent reseal.)
 *
 * Guards on `hasStoredSeal(storage)` BEFORE touching `localStorage` at all —
 * so an install that already upgraded (or never had legacy data) never
 * re-reads, and therefore never removes, the legacy key on every subsequent
 * launch. Mirrors `migrateLegacySyncVersion`'s guard exactly.
 */
export async function migrateLegacyTrustSeal(
  storage: PluginStorage,
  accountBareJid: string,
): Promise<void> {
  if (await hasStoredSeal(storage)) return
  const { sealArmored, initialized, keysToRemove } = readLegacyTrustSeal(accountBareJid)
  if (sealArmored !== null) {
    await writeSealBytes(storage, sealArmored)
  }
  if (sealArmored !== null || initialized) {
    await writeInitFlag(storage)
  }
  removeLegacyTrustSealKeys(keysToRemove)
}
