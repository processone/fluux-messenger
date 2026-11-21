/**
 * Identity of the exact server backup file (FLM-411).
 *
 * XEP-0373 §5 gives a backup no id, hash, version or signature, and the backup
 * is encrypted, so the key it holds cannot be read without its code. This device
 * keeps its own record of the one file it confirmed: the SHA-256 of the decoded
 * backup packets, the sorted primary and subkey fingerprints the file holds, how
 * it was confirmed and when. Each Settings read hashes the file it already
 * downloaded and compares it with this record. A match proves the server holds
 * the file this device confirmed; it does not prove the person still has the code.
 *
 * Stored in localStorage next to the older fingerprint marker, per bare JID.
 */

/** What a Settings read can say about the server backup. */
export type BackupStatus =
  /** The server confirmed there is no backup. */
  | 'absent'
  /** The read or the hash failed; a backup may exist. Never a claim of identity. */
  | 'unknown'
  /** The file is the one this device confirmed and holds all of this key's parts. */
  | 'confirmed'
  /** The file differs from the one this device confirmed. */
  | 'changed'
  /** The confirmed file is unchanged but this key has parts the record lacks. */
  | 'out-of-date'
  /** A backup exists, but this device has no record of it. */
  | 'unconfirmed'

export type BackupConfirmedBy = 'publish' | 'restore' | 'install' | 'check' | 'adopted'

export interface BackupIdentityRecord {
  version: 1
  /** Lower-case hex SHA-256 of the decoded backup packets. */
  packetsSha256: string
  /** Sorted, upper-case primary and subkey fingerprints the confirmed file holds. */
  fingerprints: string[]
  confirmedBy: BackupConfirmedBy
  /** ISO 8601 time of the confirmation. */
  confirmedAt: string
}

const STORAGE_PREFIX = 'fluux:openpgp:backupIdentity:v1:'
const CONFIRMED_BY: readonly BackupConfirmedBy[] = ['publish', 'restore', 'install', 'check', 'adopted']

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** Sorted, upper-case, de-duplicated fingerprints, so two backends' hex casing never differs. */
export function normalizeBackupFingerprints(fingerprints: readonly string[]): string[] {
  return [...new Set(fingerprints.map((f) => f.replace(/\s+/g, '').toUpperCase()).filter(Boolean))].sort()
}

function isRecord(value: unknown): value is BackupIdentityRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    r.version === 1 &&
    typeof r.packetsSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(r.packetsSha256) &&
    Array.isArray(r.fingerprints) &&
    r.fingerprints.length > 0 &&
    r.fingerprints.every((f) => typeof f === 'string') &&
    typeof r.confirmedBy === 'string' &&
    (CONFIRMED_BY as readonly string[]).includes(r.confirmedBy) &&
    typeof r.confirmedAt === 'string'
  )
}

/** The record for this account, or `null` when none is held or it cannot be trusted. */
export function readBackupIdentity(bareJid: string): BackupIdentityRecord | null {
  if (!bareJid) return null
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(`${STORAGE_PREFIX}${bareJid}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Whether the record is durably stored: a caller that needs it must not go on without it. */
export function writeBackupIdentity(bareJid: string, record: BackupIdentityRecord): boolean {
  if (!bareJid) return false
  const s = storage()
  if (!s) return false
  try {
    s.setItem(`${STORAGE_PREFIX}${bareJid}`, JSON.stringify(record))
    return readBackupIdentity(bareJid)?.packetsSha256 === record.packetsSha256
  } catch {
    return false
  }
}

export function clearBackupIdentity(bareJid: string): void {
  if (!bareJid) return
  const s = storage()
  if (!s) return
  try {
    s.removeItem(`${STORAGE_PREFIX}${bareJid}`)
  } catch {
    // ignored, see writeBackupIdentity
  }
}

/** Lower-case hex SHA-256. Throws when the platform has no digest, so no caller can claim a match. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('SHA-256 is not available')
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The status of a backup that exists on the server.
 *
 * `serverHash` is the hash of the file just downloaded and `ownFingerprints`
 * the primary and subkey fingerprints of this device's key. Either being
 * `null` means a hash or a key read failed: that is never confirmed.
 */
export function backupIdentityStatus(input: {
  record: BackupIdentityRecord | null
  serverHash: string | null
  ownFingerprints: readonly string[] | null
}): Exclude<BackupStatus, 'absent'> {
  const { record, serverHash, ownFingerprints } = input
  if (serverHash === null) return 'unknown'
  if (!record) return 'unconfirmed'
  if (record.packetsSha256 !== serverHash) return 'changed'
  if (ownFingerprints === null) return 'unknown'
  const held = new Set(normalizeBackupFingerprints(record.fingerprints))
  const own = normalizeBackupFingerprints(ownFingerprints)
  if (own.length === 0) return 'unknown'
  return own.every((f) => held.has(f)) ? 'confirmed' : 'out-of-date'
}
