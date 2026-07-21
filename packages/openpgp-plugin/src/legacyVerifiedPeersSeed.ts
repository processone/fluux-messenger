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
 * checked here. When both exist, the scoped key wins outright (same
 * behaviour the legacy store itself had: it only ever consulted the
 * unscoped key when the scoped one was absent) — no merge, so a
 * since-superseded unscoped leftover can never resurrect a revoked entry.
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
   * The raw localStorage key(s) that held `map`, so the caller can remove
   * them after a successful seed. Empty when `map` is empty. Never more
   * than one key — see the "scoped wins outright" note in the module doc.
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
      return { map: parseLegacyBlob(scopedRaw), keysToRemove: [scopedKey] }
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
