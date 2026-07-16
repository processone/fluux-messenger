import type { PluginStorage } from '@fluux/sdk'

// Plugin-owned "verified" marker store. `@fluux/omemo`'s TrustRecord.state is
// only undecided|trusted|untrusted, so the out-of-band-VERIFIED decision lives
// here, in the adapter layer, keyed by (peer, deviceId, fingerprintHex). A
// verified marker is bound to the exact fingerprint: when a device's identity
// key (hence fingerprint) changes, the stored hex no longer matches and the
// device reverts to unverified — the same key-binding property OpenPGP's
// verifiedPeerKeysStore provides.

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Storage key holding the whole per-peer verified map. */
const verifiedKey = (peer: string) => `verified/${peer}`

/** The persisted shape: deviceId (string) → fingerprint hex. */
type VerifiedMap = Record<string, string>

export async function loadVerified(storage: PluginStorage, peer: string): Promise<VerifiedMap> {
  const bytes = await storage.get(verifiedKey(peer))
  if (!bytes) return {}
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as unknown
    // Defensive: tolerate a corrupt/legacy blob rather than throwing on read.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: VerifiedMap = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    }
  } catch {
    /* corrupt blob — treat as no verified markers */
  }
  return {}
}

async function saveVerified(storage: PluginStorage, peer: string, map: VerifiedMap): Promise<void> {
  await storage.put(verifiedKey(peer), enc.encode(JSON.stringify(map)))
}

/**
 * A device counts as verified only when a marker exists AND its stored
 * fingerprint hex equals `fpHex` (fingerprint-bound). An empty `fpHex`
 * (no key known) can never be verified.
 */
export async function isVerified(
  storage: PluginStorage,
  peer: string,
  deviceId: number,
  fpHex: string,
): Promise<boolean> {
  if (!fpHex) return false
  const map = await loadVerified(storage, peer)
  return map[String(deviceId)] === fpHex
}

export async function setVerified(
  storage: PluginStorage,
  peer: string,
  deviceId: number,
  fpHex: string,
): Promise<void> {
  const map = await loadVerified(storage, peer)
  map[String(deviceId)] = fpHex
  await saveVerified(storage, peer, map)
}

export async function clearVerified(storage: PluginStorage, peer: string, deviceId: number): Promise<void> {
  const map = await loadVerified(storage, peer)
  if (!(String(deviceId) in map)) return
  delete map[String(deviceId)]
  await saveVerified(storage, peer, map)
}

export async function hasAnyVerified(storage: PluginStorage, peer: string): Promise<boolean> {
  const map = await loadVerified(storage, peer)
  return Object.keys(map).length > 0
}
