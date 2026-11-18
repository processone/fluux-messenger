/**
 * One-time migration of the trust state earlier versions kept in the app's
 * own stores (browser `localStorage`) into the plugin's trust records.
 *
 * Earlier versions kept, per account: the one verified fingerprint of each
 * contact, a pinned primary fingerprint per contact, key-change alerts,
 * certificate rejections, the verification-sync version, and a trust-state
 * seal over the first four (see `trustStateIntegrity.ts` for the seal that
 * replaces it). The migration reads them without changing them, so a
 * downgrade still finds them; the plugin's records exist from then on and
 * mark the migration done.
 *
 * Mapping:
 * - a verified fingerprint becomes a `verified` record for that key;
 * - a key-change alert's previous fingerprint was verified, so it becomes a
 *   `verified` record too (the contact's newer key then waits for a decision);
 * - pinned fingerprints are dropped: per-key records replace the pin;
 * - certificate rejections and the sync version are carried over.
 *
 * Values the oldest versions stored before scoping them per account go to the
 * first account that migrates them, as those versions' loaders moved them,
 * once its claim on them is saved ({@link claimUnscopedLegacyTrust}), under a
 * lock the app's windows share. No account uses them without such a claim:
 * when another account holds it, an account moves only its own values; when
 * no claim can be confirmed, the migration waits for the next start.
 *
 * The old seal is checked against the old data as earlier versions checked
 * it, once the account's key is usable (it may still be locked during the
 * migration), plus one check earlier versions did not need: the keys the
 * migration marks verified must be the sealed ones, alerts included. The
 * records are then checked against what the migration made of that data
 * ({@link legacyRecordsMismatch}). Until then the check waits in plugin
 * storage ({@link PendingLegacySealCheck}).
 */

import { buildScopedStorageKey } from '@fluux/sdk'
import { canonicalFingerprint, emptyTrustRecords, type TrustRecordsData } from './trustRecords'
import { canonicalJson, withoutHoldsAddedSince, type TrustStateReading } from './trustStateIntegrity'
import type { CertRejection, KeyDecision, TrustStateVerdict } from './trustTypes'
import { fingerprintsEqual } from './fingerprintCompare'
import type { DecryptFn } from './verificationSync'

/** Plugin storage key of a legacy seal check that has not run yet. */
export const LEGACY_SEAL_CHECK_STORAGE_KEY = 'legacy-seal-check'

const LEGACY_KEYS = {
  verified: 'fluux-e2ee-verified-peers',
  pins: 'fluux-e2ee-pinned-primary-fingerprints',
  alerts: 'fluux-e2ee-key-change-alerts',
  rejections: 'fluux-e2ee-cert-rejections',
  syncVersion: 'fluux-e2ee-verifications-version',
  seal: 'fluux-e2ee-trust-state-seal',
  sealInitialized: 'fluux-e2ee-trust-integrity-init',
} as const

/**
 * The account that took the values earlier versions stored before scoping
 * them per account. Earlier loaders moved each unscoped value to the first
 * account that loaded it; this marker keeps that single owner while the
 * values stay in place for an older version.
 */
const LEGACY_UNSCOPED_OWNER_KEY = 'fluux-e2ee-legacy-unscoped-owner'

/** The lock windows of this app take in turn to claim the unscoped values. */
export const LEGACY_UNSCOPED_CLAIM_LOCK = 'fluux-e2ee-legacy-unscoped-claim'

/** A key-change alert as earlier versions stored it. */
export interface LegacyKeyChangeAlert {
  previousFingerprint: string
  currentFingerprint: string
  observedAt: string
}

/** What earlier versions' seal covered, read as their stores read it. */
export interface LegacySealSnapshot {
  pins: Record<string, string>
  verified: Record<string, string>
  alerts: Record<string, LegacyKeyChangeAlert>
  syncVersion: number
}

export interface LegacyTrustState extends LegacySealSnapshot {
  rejections: Record<string, CertRejection[]>
  /** The armored seal, or `null` when none was written. */
  seal: string | null
  /** Whether a seal was ever written for this account. */
  sealInitialized: boolean
  /**
   * Some value came from the unscoped keys: the migration claims them for
   * this account first (see {@link claimUnscopedLegacyTrust}).
   */
  usesUnscoped: boolean
}

/** A check of the old seal against the old data, waiting for a usable key. */
export interface PendingLegacySealCheck {
  v: 1
  seal: string | null
  sealInitialized: boolean
  snapshot: LegacySealSnapshot
}

// ---------------------------------------------------------------------------
// Reading the old stores (read only)
// ---------------------------------------------------------------------------

/** Whether a read may fall back to an unscoped value, and whether one did. */
interface UnscopedUse {
  allowed: boolean
  used: boolean
}

/**
 * Whether `accountJid` may read the unscoped values: no account claimed them
 * yet, or this one did.
 */
function mayReadUnscoped(accountJid: string, unscoped: UnscopedUse): boolean {
  if (!unscoped.allowed) return false
  const owner = localStorage.getItem(LEGACY_UNSCOPED_OWNER_KEY)
  return owner === null || owner === accountJid
}

/**
 * The account-scoped value, or the unscoped one earlier versions stored before
 * values were scoped per account, unless another account claimed those.
 * Earlier loaders moved the unscoped value to the scoped key when they read
 * it; this reader only reads.
 */
function readScopedOrUnscoped(base: string, accountJid: string, unscoped: UnscopedUse): string | null {
  const scoped = buildScopedStorageKey(base, accountJid)
  const raw = localStorage.getItem(scoped)
  if (raw) return raw
  if (scoped !== base && mayReadUnscoped(accountJid, unscoped)) {
    const value = localStorage.getItem(base)
    if (value) {
      unscoped.used = true
      return value
    }
  }
  return null
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Earlier stores kept only string → non-empty string entries. */
function readFingerprintMap(base: string, accountJid: string, unscoped: UnscopedUse): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parseObject(readScopedOrUnscoped(base, accountJid, unscoped)))) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}

function readAlerts(accountJid: string, unscoped: UnscopedUse): Record<string, LegacyKeyChangeAlert> {
  const out: Record<string, LegacyKeyChangeAlert> = {}
  for (const [k, v] of Object.entries(parseObject(readScopedOrUnscoped(LEGACY_KEYS.alerts, accountJid, unscoped)))) {
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as LegacyKeyChangeAlert).previousFingerprint === 'string' &&
      typeof (v as LegacyKeyChangeAlert).currentFingerprint === 'string' &&
      typeof (v as LegacyKeyChangeAlert).observedAt === 'string'
    ) {
      out[k] = v as LegacyKeyChangeAlert
    }
  }
  return out
}

function isLegacyRejection(v: unknown): v is CertRejection {
  if (!v || typeof v !== 'object') return false
  const r = v as CertRejection
  return (
    typeof r.fingerprint === 'string' &&
    typeof r.code === 'string' &&
    typeof r.detail === 'string' &&
    typeof r.observedAt === 'string'
  )
}

function readRejections(accountJid: string, unscoped: UnscopedUse): Record<string, CertRejection[]> {
  const out: Record<string, CertRejection[]> = {}
  for (const [k, v] of Object.entries(parseObject(readScopedOrUnscoped(LEGACY_KEYS.rejections, accountJid, unscoped)))) {
    if (Array.isArray(v) && v.every(isLegacyRejection)) out[k] = v
  }
  return out
}

/** `-1` when no version was saved, as earlier versions read it. */
function readSyncVersion(accountJid: string, unscoped: UnscopedUse): number {
  const scoped = buildScopedStorageKey(LEGACY_KEYS.syncVersion, accountJid)
  let raw = localStorage.getItem(scoped)
  if (raw === null && scoped !== LEGACY_KEYS.syncVersion && mayReadUnscoped(accountJid, unscoped)) {
    raw = localStorage.getItem(LEGACY_KEYS.syncVersion)
    if (raw !== null) unscoped.used = true
  }
  if (raw === null) return -1
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : -1
}

/**
 * Read every piece of trust state earlier versions kept for `accountJid`.
 * They scoped each value by the signed-in account's bare JID. With
 * `includeUnscoped` false, the values they kept before that are left out.
 */
export function readLegacyTrustState(accountJid: string, includeUnscoped = true): LegacyTrustState {
  try {
    const unscoped: UnscopedUse = { allowed: includeUnscoped, used: false }
    return {
      verified: readFingerprintMap(LEGACY_KEYS.verified, accountJid, unscoped),
      pins: readFingerprintMap(LEGACY_KEYS.pins, accountJid, unscoped),
      alerts: readAlerts(accountJid, unscoped),
      rejections: readRejections(accountJid, unscoped),
      syncVersion: readSyncVersion(accountJid, unscoped),
      seal: localStorage.getItem(buildScopedStorageKey(LEGACY_KEYS.seal, accountJid)) || null,
      sealInitialized: localStorage.getItem(buildScopedStorageKey(LEGACY_KEYS.sealInitialized, accountJid)) === '1',
      usesUnscoped: unscoped.used,
    }
  } catch {
    // No localStorage: nothing to migrate.
    return { verified: {}, pins: {}, alerts: {}, rejections: {}, syncVersion: -1, seal: null, sealInitialized: false, usesUnscoped: false }
  }
}

/**
 * Who holds the unscoped values: this account (`owned`), another one
 * (`other-owner`), or no one confirmed (`unavailable`), because the lock the
 * app's windows share is missing or this account's claim could not be saved.
 */
export type UnscopedLegacyClaim = 'owned' | 'other-owner' | 'unavailable'

/**
 * Claim the unscoped values for `accountJid`, the first account whose
 * migration read them; no other account reads them after that. Run before
 * the migration writes anything, so a migration that stops half way still
 * finds them on its next run. Windows of this app claim them one at a time,
 * under a lock they share, so two accounts cannot both find no owner and
 * each save their own claim. Without that lock no claim is confirmed:
 * `unavailable`.
 */
export async function claimUnscopedLegacyTrust(accountJid: string): Promise<UnscopedLegacyClaim> {
  const claim = (): UnscopedLegacyClaim => {
    try {
      const owner = localStorage.getItem(LEGACY_UNSCOPED_OWNER_KEY)
      if (owner === null) localStorage.setItem(LEGACY_UNSCOPED_OWNER_KEY, accountJid)
      const saved = owner ?? localStorage.getItem(LEGACY_UNSCOPED_OWNER_KEY)
      if (saved === null) return 'unavailable'
      return saved === accountJid ? 'owned' : 'other-owner'
    } catch {
      return 'unavailable'
    }
  }
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return 'unavailable'
  try {
    return await locks.request(LEGACY_UNSCOPED_CLAIM_LOCK, claim)
  } catch {
    return 'unavailable'
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const REJECTION_CODES: ReadonlySet<string> = new Set([
  'validation_failed',
  'fingerprint_mismatch',
  'uid_mismatch',
  'no_encryption_subkey',
])

/**
 * The decisions the old verified keys and alerts map to (see the module
 * comment). It also reads the decrypted old seal, so it skips what is not a
 * fingerprint.
 */
function legacyDecisions(legacy: { verified?: unknown; alerts?: unknown }): Record<string, Record<string, KeyDecision>> {
  const out: Record<string, Record<string, KeyDecision>> = {}
  const entries = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : []
  const verify = (peer: string, fingerprint: unknown) => {
    const fp = typeof fingerprint === 'string' ? canonicalFingerprint(fingerprint) : null
    if (!fp) return
    out[peer] = { ...(out[peer] ?? {}), [fp]: 'verified' }
  }
  for (const [peer, fp] of entries(legacy.verified)) verify(peer, fp)
  for (const [peer, alert] of entries(legacy.alerts)) {
    verify(peer, alert && typeof alert === 'object' ? (alert as { previousFingerprint?: unknown }).previousFingerprint : null)
  }
  return out
}

function legacySyncVersion(syncVersion: number): number {
  return Number.isInteger(syncVersion) && syncVersion >= -1 ? syncVersion : -1
}

/** The trust records the old state maps to (see the module comment). */
export function trustRecordsFromLegacy(legacy: LegacyTrustState, now: string): TrustRecordsData {
  const data = emptyTrustRecords()
  for (const [peer, keys] of Object.entries(legacyDecisions(legacy))) {
    data.peers[peer] = Object.fromEntries(Object.entries(keys).map(([fp, decision]) => [fp, { decision, decidedAt: now }]))
  }
  for (const [peer, list] of Object.entries(legacy.rejections)) {
    const kept = list.filter((r) => REJECTION_CODES.has(r.code)).map((r) => ({ ...r }))
    if (kept.length > 0) data.rejections[peer] = kept
  }
  data.syncVersion = legacySyncVersion(legacy.syncVersion)
  return data
}

/**
 * What differs between the records and what the migration made of the data
 * the old seal covers. The old seal vouches for that data only, so the
 * records are sealed anew only while nothing differs: decisions, sync
 * version, and the set node not yet adopted. Holds saved since the upgrade
 * do not count ({@link withoutHoldsAddedSince}).
 */
export function legacyRecordsMismatch(check: PendingLegacySealCheck, records: TrustStateReading): string[] {
  const details: string[] = []
  const upgraded = legacyDecisions(check.snapshot)
  if (canonicalJson(upgraded) !== canonicalJson(withoutHoldsAddedSince(records.decisions(), upgraded))) {
    details.push('trust decisions differ from the upgraded trust state')
  }
  if (legacySyncVersion(check.snapshot.syncVersion) !== records.syncVersion() || records.setsAdopted()) {
    details.push('verification sync state differs from the upgraded trust state')
  }
  return details
}

function legacySnapshotIsEmpty(snapshot: LegacySealSnapshot): boolean {
  return (
    Object.keys(snapshot.pins).length === 0 &&
    Object.keys(snapshot.verified).length === 0 &&
    Object.keys(snapshot.alerts).length === 0
  )
}

/**
 * The seal check to run once the key is usable, or `null` when earlier
 * versions would have found nothing to check (no seal, no data).
 */
export function legacySealCheckFor(legacy: LegacyTrustState): PendingLegacySealCheck | null {
  const snapshot: LegacySealSnapshot = {
    pins: legacy.pins,
    verified: legacy.verified,
    alerts: legacy.alerts,
    syncVersion: legacy.syncVersion,
  }
  if (!legacy.seal && legacySnapshotIsEmpty(snapshot)) return null
  return { v: 1, seal: legacy.seal, sealInitialized: legacy.sealInitialized, snapshot }
}

export function serializeLegacySealCheck(check: PendingLegacySealCheck): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(check))
}

export function parseLegacySealCheck(bytes: Uint8Array): PendingLegacySealCheck | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as PendingLegacySealCheck
    if (!parsed || parsed.v !== 1 || typeof parsed.sealInitialized !== 'boolean') return null
    if (parsed.seal !== null && typeof parsed.seal !== 'string') return null
    const s = parsed.snapshot
    if (!s || typeof s !== 'object' || typeof s.syncVersion !== 'number') return null
    for (const part of [s.pins, s.verified, s.alerts]) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return null
    }
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The old seal check
// ---------------------------------------------------------------------------

/**
 * Earlier versions compared each part with this serialization. Its replacer
 * lists the top-level keys only, and JSON.stringify applies it at every
 * depth, so a key-change alert compares by contact only. Kept as is, so a
 * change earlier versions accepted, such as an alert's time, still passes;
 * {@link verifyLegacyTrustStateSeal} compares the alert's key on its own.
 */
function legacySortedStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort())
}

function legacyPayloadsMatch(sealed: LegacySealSnapshot, current: LegacySealSnapshot): string[] {
  const details: string[] = []
  if (legacySortedStringify(sealed.pins) !== legacySortedStringify(current.pins)) details.push('pinned fingerprints differ')
  if (legacySortedStringify(sealed.verified) !== legacySortedStringify(current.verified)) details.push('verified peers differ')
  if (legacySortedStringify(sealed.alerts) !== legacySortedStringify(current.alerts)) details.push('key-change alerts differ')
  if (sealed.syncVersion !== current.syncVersion) details.push('verification sync version differs')
  return details
}

/**
 * The verdict earlier versions would have given the old seal over the old
 * data, also requiring the keys the migration marks verified to be the
 * sealed ones: `sealed`, `uninitialized` or `pending-seal` let the migrated
 * records be sealed anew; `compromised` stands until the user reseals;
 * `awaiting-key` leaves the check for later.
 */
export async function verifyLegacyTrustStateSeal(
  check: PendingLegacySealCheck,
  decryptFn: DecryptFn,
  ownPublicArmored: string,
  ownFingerprint: string,
  isKeyUnavailable: (err: unknown) => boolean,
): Promise<TrustStateVerdict> {
  const empty = legacySnapshotIsEmpty(check.snapshot)
  if (!check.seal) {
    if (empty) return { status: 'uninitialized' }
    if (!check.sealInitialized) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal was removed but stores contain data'] }
  }

  let decrypted: Awaited<ReturnType<DecryptFn>>
  try {
    decrypted = await decryptFn(check.seal, ownPublicArmored)
  } catch (err) {
    if (isKeyUnavailable(err)) return { status: 'awaiting-key' }
    if (empty) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal could not be decrypted'] }
  }

  if (
    !decrypted.signatureVerified ||
    !decrypted.signerFingerprint ||
    !fingerprintsEqual(decrypted.signerFingerprint, ownFingerprint)
  ) {
    if (empty) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal has invalid or foreign signature'] }
  }

  let sealed: LegacySealSnapshot
  try {
    const payload = JSON.parse(decrypted.plaintext) as LegacySealSnapshot & { v?: unknown }
    if (payload.v !== 1) throw new Error('unknown version')
    sealed = payload
  } catch {
    return { status: 'compromised', details: ['Trust state seal payload is malformed'] }
  }

  const details = legacyPayloadsMatch(sealed, check.snapshot)
  // The comparison above reads an alert by contact only, but the migration
  // keeps the key an alert replaced verified: that key must be the sealed one.
  if (details.length === 0 && canonicalJson(legacyDecisions(sealed)) !== canonicalJson(legacyDecisions(check.snapshot))) {
    details.push('key-change alerts differ')
  }
  return details.length > 0 ? { status: 'compromised', details } : { status: 'sealed' }
}
