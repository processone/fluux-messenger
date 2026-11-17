/**
 * Persistent marker recording which local fingerprint was last backed up
 * to the server-side XEP-0373 §5 secret-key node.
 *
 * The backup itself is an OpenPGP SKESK-encrypted blob — without the
 * passphrase we can't peek inside to see which key it contains. So to
 * tell the UI "your local key is already on the server" without asking
 * for the passphrase, we record the fingerprint after publishing a backup or
 * installing a key proven to exist in the server backup (matching packet
 * bytes or a decrypted fingerprint), then compare it with the local key.
 *
 * Stored in localStorage because the SDK's `PluginStorage` backend is
 * currently in-memory; a marker that evaporates on app restart would
 * defeat the entire UX benefit. Keyed per bare JID so multi-account
 * setups don't stomp each other.
 */

const LEGACY_STORAGE_PREFIX = 'fluux:openpgp:backedUpFingerprint:'
// Earlier installs could mark an unrelated file as backed up. None of those
// claims can be trusted; establish this version only from confirmed evidence.
const STORAGE_PREFIX = `${LEGACY_STORAGE_PREFIX}v2:`

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    // Some sandboxed webview contexts throw on property access.
    return null
  }
}

function storageKey(bareJid: string): string {
  return `${STORAGE_PREFIX}${bareJid}`
}

/**
 * Read the fingerprint last backed up for this account, or `null` when
 * no backup has been recorded on this device. Returns `null` rather
 * than throwing in every failure path — the UI just shows the full
 * button row when the marker is missing.
 */
export function readBackedUpFingerprint(bareJid: string): string | null {
  if (!bareJid) return null
  const s = storage()
  if (!s) return null
  try {
    return s.getItem(storageKey(bareJid))
  } catch {
    return null
  }
}

/**
 * Persist `fingerprint` as the latest backup marker for `bareJid`.
 * Called after a successful `backupSecretKey`, or a successful key install
 * proven to exist in the server backup by matching packet bytes or a
 * decrypted fingerprint. File installation alone is not backup evidence.
 */
export function writeBackedUpFingerprint(bareJid: string, fingerprint: string): void {
  if (!bareJid || !fingerprint) return
  const s = storage()
  if (!s) return
  try {
    s.setItem(storageKey(bareJid), fingerprint)
  } catch {
    // Quota or sandbox — a missing marker just means the UI shows the
    // buttons again. Not worth surfacing.
  }
}

/**
 * Drop the marker. Called when the server-side backup is retracted
 * (explicit delete) or the local identity is destroyed — leaving a
 * stale marker would lie to the UI next time a key is generated.
 */
export function clearBackedUpFingerprint(bareJid: string): void {
  if (!bareJid) return
  const s = storage()
  if (!s) return
  try {
    s.removeItem(storageKey(bareJid))
    s.removeItem(`${LEGACY_STORAGE_PREFIX}${bareJid}`)
  } catch {
    // ignored — see writeBackedUpFingerprint
  }
}
