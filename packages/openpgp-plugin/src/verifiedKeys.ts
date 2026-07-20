import type { PluginStorage } from '@fluux/sdk'

/**
 * Plugin-owned persistence for the verified-key map (bare JID → fingerprint
 * hex). The whole map lives under ONE storage key because every consumer that
 * matters — the trust-state integrity snapshot and the verification-sync
 * apply — needs it in full and synchronously, and it is small (one entry per
 * verified peer) and written only on a deliberate verify/revoke.
 *
 * Compare with OMEMO's `verifiedDevices.ts`, which keys per peer because it
 * holds a device map per peer.
 */
export const VERIFIED_STORAGE_KEY = 'verified'

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function loadVerifiedMap(storage: PluginStorage): Promise<Record<string, string>> {
  const bytes = await storage.get(VERIFIED_STORAGE_KEY)
  if (!bytes) return {}
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as unknown
    // Defensive: tolerate a corrupt/legacy blob rather than throwing on read.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export async function persistVerifiedMap(
  storage: PluginStorage,
  map: Record<string, string>,
): Promise<void> {
  await storage.put(VERIFIED_STORAGE_KEY, enc.encode(JSON.stringify(map)))
}
