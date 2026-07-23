/**
 * Pure model + helpers for the per-peer set of known validated certificates.
 *
 * A peer JID owns a *set* of announced OX keys (XEP-0373). We keep every cert
 * we have fetched and validated, partitioned by an `active` flag: active certs
 * are still announced (encryption recipients); inactive certs left the announced
 * set (stamped `inactiveAt`) and are retained for verification of *eligible
 * archived* messages only — never for encryption, never for new live traffic.
 * See docs/superpowers/specs/2026-07-23-ox-multi-key-design.md.
 */
import { toXep0373Fingerprint } from './fingerprintCompare'

export interface PeerBundleInput {
  fingerprint: string
  publicArmored: string
  keychainBacked: boolean
  createdAt?: string
}
export interface CachedPeerCert extends PeerBundleInput {
  active: boolean
  inactiveAt?: string
}

export function serializePeerCache(map: Map<string, CachedPeerCert[]>): string {
  return JSON.stringify([...map.entries()])
}

/** True when a value is a usable cert record (has a non-empty fp + armored key). */
function sanitizeCert(raw: unknown, active: boolean): CachedPeerCert | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.fingerprint !== 'string' || r.fingerprint.trim() === '') return null
  if (typeof r.publicArmored !== 'string' || r.publicArmored.trim() === '') return null
  return {
    fingerprint: toXep0373Fingerprint(r.fingerprint), // canonicalize (upper, no whitespace)
    publicArmored: r.publicArmored,
    keychainBacked: r.keychainBacked === true,
    ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
    active: typeof r.active === 'boolean' ? r.active : active,
    ...(typeof r.inactiveAt === 'string' ? { inactiveAt: r.inactiveAt } : {}),
  }
}

/**
 * Parse the cache, migrating the pre-Stage-1 `[jid, KeyBundle]` shape, and
 * treating localStorage as untrusted: normalize fingerprints, discard any
 * entry that is not a well-formed cert record or JID pair.
 */
export function deserializePeerCache(json: string): Map<string, CachedPeerCert[]> {
  const out = new Map<string, CachedPeerCert[]>()
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
    const [jid, value] = entry
    let certs: CachedPeerCert[] | null
    if (Array.isArray(value)) {
      certs = value.map((c) => sanitizeCert(c, true)).filter((c): c is CachedPeerCert => c !== null)
    } else {
      const migrated = sanitizeCert(value, true) // legacy single KeyBundle
      certs = migrated ? [migrated] : null
    }
    if (certs && certs.length > 0) out.set(jid, certs)
  }
  return out
}

export function activePublics(certs: CachedPeerCert[]): string[] {
  return certs.filter((c) => c.active).map((c) => c.publicArmored)
}

export function activeFingerprints(certs: CachedPeerCert[]): string[] {
  return certs.filter((c) => c.active).map((c) => c.fingerprint)
}

/**
 * The verifier set for a message: active certs always, plus any inactive cert
 * eligible under the archive-time policy — a message whose `messageTime`
 * predates the cert's `inactiveAt` (± tolerance). `messageTime` is the MAM
 * archive timestamp for an archived message or the original `receivedAt` for a
 * deferred one. A live message (no `messageTime`) gets active certs only, so a
 * retired key never authenticates fresh traffic. Note this eligibility is not
 * cryptographic proof of age — a server-provided/backdatable timestamp — so it
 * narrows, not eliminates, the window (see spec §Retained certs).
 */
export function eligibleVerifierPublics(
  certs: CachedPeerCert[],
  msg: { messageTime?: Date },
  toleranceMs: number,
): string[] {
  const out: string[] = []
  for (const c of certs) {
    if (c.active) {
      out.push(c.publicArmored)
      continue
    }
    if (!msg.messageTime || !c.inactiveAt) continue
    if (msg.messageTime.getTime() < new Date(c.inactiveAt).getTime() + toleranceMs) {
      out.push(c.publicArmored)
    }
  }
  return out
}

/** Upsert a freshly-validated announced cert: replace by fingerprint, mark active. */
export function upsertActive(certs: CachedPeerCert[], bundle: PeerBundleInput): CachedPeerCert[] {
  const fp = toXep0373Fingerprint(bundle.fingerprint)
  const next = certs.filter((c) => c.fingerprint !== fp)
  next.push({ ...bundle, fingerprint: fp, active: true })
  return next
}

/** Mark every cert whose fingerprint is no longer announced inactive (retain it). */
export function markDepartedInactive(
  certs: CachedPeerCert[],
  stillAnnouncedFps: Set<string>,
  nowIso: string,
): CachedPeerCert[] {
  return certs.map((c) =>
    c.active && !stillAnnouncedFps.has(c.fingerprint)
      ? { ...c, active: false, inactiveAt: nowIso }
      : c,
  )
}

/** Keep all active + verified certs; LRU-cap unverified inactive certs by `inactiveAt`. */
export function capUnverifiedInactive(
  certs: CachedPeerCert[],
  isVerified: (fp: string) => boolean,
  cap: number,
): CachedPeerCert[] {
  const keep: CachedPeerCert[] = []
  const unverifiedInactive: CachedPeerCert[] = []
  for (const c of certs) {
    if (c.active || isVerified(c.fingerprint)) keep.push(c)
    else unverifiedInactive.push(c)
  }
  unverifiedInactive.sort((a, b) => (a.inactiveAt ?? '').localeCompare(b.inactiveAt ?? ''))
  const survivors = unverifiedInactive.slice(-cap)
  // Preserve original order.
  const survivorSet = new Set(survivors)
  return certs.filter((c) => keep.includes(c) || survivorSet.has(c))
}
