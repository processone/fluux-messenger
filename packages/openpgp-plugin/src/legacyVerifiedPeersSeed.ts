/**
 * One-shot upgrade path for OpenPGP verified-peer trust decisions made
 * before Phase B2 Task 8 deleted the app-side `verifiedPeerKeysStore` and
 * its `hostStores.verifiedPeers` mirror inside the plugin.
 *
 * Before Task 8, an install's verifications lived in a localStorage blob
 * under the key below, and `OpenPGPPluginBase.init()` seeded the
 * plugin-owned `VerifiedKeysCache` from `hostStores.verifiedPeers.getAll()`
 * (an in-memory read of that same blob, kept live by the app's Zustand
 * store). Now that the mirror is gone, this module reads the SAME
 * localStorage key(s) directly, so an install that has never launched a
 * build with the mirror (i.e. every release before B1, and any long-running
 * `features/omemo` checkout skipping straight from pre-B1 to post-Task-8)
 * still recovers its verifications on first launch, instead of silently
 * seeing every peer downgrade to `tofu`.
 *
 * Mirrors `verifiedPeerKeysStore.ts`'s own unscoped -> scoped migration
 * (that file no longer exists post-Task-8, but its migration shape does:
 * it moved a pre-account-scoping blob at the bare key
 * `fluux-e2ee-verified-peers` to the account-scoped
 * `fluux-e2ee-verified-peers:<bare-jid>` key, deleting the unscoped one).
 * An install that neither ran that migration NOR the B1 dual-write may
 * still have only the pre-migration unscoped blob, so both shapes are
 * checked here. When both exist, the scoped key wins outright for the
 * SEEDED DATA (same behaviour the legacy store itself had: it only ever
 * consulted the unscoped key when the scoped one was absent) — no merge.
 * But BOTH keys are reported in `keysToRemove` in that case: leaving the
 * unscoped blob behind would let it resurface on a later launch — e.g. the
 * user revokes every verification, the plugin cache legitimately empties
 * again, and the next `init()` (finding the cache empty and the scoped key
 * already gone) would fall back to the stale unscoped blob and resurrect
 * verifications the user explicitly revoked. Removing both up front closes
 * that gap.
 */
import { buildScopedStorageKey } from '@fluux/sdk'

const LEGACY_VERIFIED_PEERS_KEY_BASE = 'fluux-e2ee-verified-peers'

function legacyScopedKey(accountBareJid: string): string {
  return buildScopedStorageKey(LEGACY_VERIFIED_PEERS_KEY_BASE, accountBareJid)
}

/**
 * Parses a legacy blob exactly as `verifiedPeerKeysStore.ts`'s
 * `loadFromStorage` did: tolerant of a missing/corrupt/tampered value
 * (starts clean rather than throwing), and defensively keeps only
 * (string, non-empty string) entries.
 */
function parseLegacyBlob(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export interface LegacyVerifiedPeersRead {
  /** Bare JID -> verified fingerprint, or `{}` when nothing was found. */
  map: Record<string, string>
  /**
   * The raw localStorage key(s) to remove after a successful seed. Usually
   * one key, but when BOTH the scoped and unscoped blobs exist, this holds
   * both — the scoped one wins for `map`, but the unscoped leftover must
   * still be deleted so it can't resurrect a later-revoked entry (see the
   * module doc). May be non-empty even when `map` is `{}` (e.g. a corrupt
   * blob) so the caller can clean up a legacy key it will never use again.
   */
  keysToRemove: string[]
}

/**
 * Read-only: never mutates localStorage. Checks the scoped key first;
 * falls back to the pre-migration unscoped key only when the scoped key is
 * absent. Returns `{ map: {}, keysToRemove: [] }` on any localStorage
 * failure (unavailable, disabled, corrupt JSON) — the caller treats that
 * identically to "nothing to seed", same as the legacy store's own
 * catch-and-start-clean policy.
 */
export function readLegacyVerifiedPeers(accountBareJid: string): LegacyVerifiedPeersRead {
  try {
    const scopedKey = legacyScopedKey(accountBareJid)
    const scopedRaw = localStorage.getItem(scopedKey)
    if (scopedRaw) {
      const keysToRemove = [scopedKey]
      // The scoped blob wins the data, but an orphaned unscoped leftover
      // must be removed too — see the module doc for why leaving it behind
      // can resurrect a revoked verification on a later launch.
      if (scopedKey !== LEGACY_VERIFIED_PEERS_KEY_BASE && localStorage.getItem(LEGACY_VERIFIED_PEERS_KEY_BASE) !== null) {
        keysToRemove.push(LEGACY_VERIFIED_PEERS_KEY_BASE)
      }
      return { map: parseLegacyBlob(scopedRaw), keysToRemove }
    }
    // Only ever consult the unscoped key when the scoped one is absent —
    // mirrors the legacy store's own migration order exactly.
    if (scopedKey !== LEGACY_VERIFIED_PEERS_KEY_BASE) {
      const unscopedRaw = localStorage.getItem(LEGACY_VERIFIED_PEERS_KEY_BASE)
      if (unscopedRaw) {
        return { map: parseLegacyBlob(unscopedRaw), keysToRemove: [LEGACY_VERIFIED_PEERS_KEY_BASE] }
      }
    }
  } catch {
    // localStorage unavailable — nothing to seed.
  }
  return { map: {}, keysToRemove: [] }
}

/**
 * Best-effort removal of the legacy key(s) after a successful seed. A
 * failure here is harmless: the plugin cache now owns the data, and
 * `VerifiedKeysCache.seed` is a no-op once the cache is populated, so a
 * leftover legacy key is simply never read again.
 */
export function removeLegacyVerifiedPeersKeys(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Best-effort — see the doc comment above.
    }
  }
}
