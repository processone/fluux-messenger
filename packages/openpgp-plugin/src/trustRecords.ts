/**
 * Per-key trust records: the user's decision about each key of each contact,
 * and the certificates of a contact that failed validation.
 *
 * The plugin owns these records and keeps them in its own storage
 * (`PluginStorage`, key {@link TRUST_RECORDS_STORAGE_KEY}), as one JSON blob.
 * Reads are synchronous from an in-memory copy; every change updates that copy
 * and notifies listeners at once, then writes the whole blob in the
 * background, one write at a time and in order. {@link TrustRecordStore.flush}
 * waits for the writes queued so far.
 *
 * How a key stands follows from its record and from whether the contact is
 * verified (see {@link keyStanding}): a contact is verified while any of its
 * keys has a `verified` record, retired keys included. A key with no record is
 * used without asking (blind trust) for a contact never verified, and is held
 * until the user decides for a verified contact. A key with a `held` record
 * stays held either way.
 *
 * The keys held on any of the account's devices travel with the synced
 * verifications (see `verificationSync.ts`); the records keep what this device
 * last read or published of them ({@link TrustRecordsData.accountHolds}), so
 * a device that joins later holds them too.
 */

import type { PluginStorage } from '@fluux/sdk'
import { toXep0373Fingerprint } from './fingerprintCompare'
import type { CertRejection, KeyDecision } from './trustTypes'

/** Plugin storage key of the trust records blob. */
export const TRUST_RECORDS_STORAGE_KEY = 'trust-records'

export interface KeyTrustRecord {
  decision: KeyDecision
  /** ISO time of the decision. */
  decidedAt: string
}

export interface TrustRecordsData {
  v: 1
  /** Contact bare JID → canonical (upper-case) fingerprint → record. */
  peers: Record<string, Record<string, KeyTrustRecord>>
  /** Contact bare JID → certificates that failed validation. */
  rejections: Record<string, CertRejection[]>
  /** Highest verification-sync version applied or reserved; `-1` when none. */
  syncVersion: number
  /**
   * The account's verifications live on the set node: this device read it or
   * published it once. The older node is never read again after that.
   */
  setsAdopted: boolean
  /**
   * Contact bare JID → canonical fingerprints, sorted, of the keys held on
   * the account's devices, as this device last read or published them with
   * the synced verifications. Each publication carries them on, with this
   * device's own holds, so a key held on one device is held on every device
   * that joins later. Left out when there are none.
   */
  accountHolds?: Record<string, string[]>
}

/** What one change to the records touched. */
export interface TrustRecordsChange {
  /** Contacts whose decisions or rejections changed. */
  peers: string[]
  /** A decision changed: the trust-state seal covers decisions. */
  decisions: boolean
  /** The verified keys of some contact changed: they sync across devices. */
  verified: boolean
  /**
   * The sync state changed: its version, the set adoption or the keys held on
   * the account's devices. The trust-state seal covers all three.
   */
  syncVersion: boolean
  /**
   * Every record was replaced at once: read from storage, replaced by the
   * migration, or forgotten at sign-out. Nobody decided anything, so nothing
   * is published or sealed for it.
   */
  loaded: boolean
}

export type TrustRecordsListener = (change: TrustRecordsChange) => void

/** One decision to record; `null` removes the key's record. */
export interface KeyDecisionChange {
  peer: string
  fingerprint: string
  decision: KeyDecision | null
}

const DECISIONS: ReadonlySet<string> = new Set(['verified', 'tofu', 'untrusted', 'held'])
const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/
const REJECTION_CODES: ReadonlySet<string> = new Set([
  'validation_failed',
  'fingerprint_mismatch',
  'uid_mismatch',
  'no_encryption_subkey',
])

export function emptyTrustRecords(): TrustRecordsData {
  return { v: 1, peers: {}, rejections: {}, syncVersion: -1, setsAdopted: false }
}

/**
 * The canonical form records use for a fingerprint: upper-case hex without
 * spaces, as XEP-0373 publishes it. `null` for anything that is not a v4 or
 * v6 fingerprint.
 */
export function canonicalFingerprint(fingerprint: string): string | null {
  const fp = toXep0373Fingerprint(fingerprint)
  return FINGERPRINT_PATTERN.test(fp) ? fp : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isRejection(value: unknown): value is CertRejection {
  if (!isRecord(value)) return false
  return (
    typeof value.fingerprint === 'string' &&
    typeof value.code === 'string' &&
    REJECTION_CODES.has(value.code) &&
    typeof value.detail === 'string' &&
    typeof value.observedAt === 'string'
  )
}

/**
 * Read a saved blob. Storage is untrusted: entries of the wrong shape are
 * dropped, and `null` means the blob itself is unreadable. A dropped entry
 * shows up as a difference against the trust-state seal.
 */
export function parseTrustRecords(bytes: Uint8Array): TrustRecordsData | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null
  const data = emptyTrustRecords()
  if (isRecord(parsed.peers)) {
    for (const [peer, keys] of Object.entries(parsed.peers)) {
      if (!isRecord(keys)) continue
      const out: Record<string, KeyTrustRecord> = {}
      for (const [fp, record] of Object.entries(keys)) {
        const canonical = canonicalFingerprint(fp)
        if (!canonical || !isRecord(record)) continue
        if (typeof record.decision !== 'string' || !DECISIONS.has(record.decision)) continue
        if (typeof record.decidedAt !== 'string') continue
        out[canonical] = { decision: record.decision as KeyDecision, decidedAt: record.decidedAt }
      }
      if (Object.keys(out).length > 0) data.peers[peer] = out
    }
  }
  if (isRecord(parsed.rejections)) {
    for (const [peer, list] of Object.entries(parsed.rejections)) {
      if (!Array.isArray(list)) continue
      const kept = list.filter(isRejection).map((r) => ({
        fingerprint: r.fingerprint,
        code: r.code,
        detail: r.detail,
        observedAt: r.observedAt,
      }))
      if (kept.length > 0) data.rejections[peer] = kept
    }
  }
  if (typeof parsed.syncVersion === 'number' && Number.isInteger(parsed.syncVersion) && parsed.syncVersion >= -1) {
    data.syncVersion = parsed.syncVersion
  }
  data.setsAdopted = parsed.setsAdopted === true
  const accountHolds = parseKeyLists(parsed.accountHolds)
  if (Object.keys(accountHolds).length > 0) data.accountHolds = accountHolds
  return data
}

/**
 * Read lists of fingerprints keyed by contact from untrusted data: canonical
 * fingerprints only, sorted and without repeats, contacts in sorted order;
 * contacts with none are left out, and so is anything that is not such a list.
 */
export function parseKeyLists(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!isRecord(value)) return out
  for (const peer of Object.keys(value).sort()) {
    const list = value[peer]
    if (!Array.isArray(list)) continue
    const fps = new Set<string>()
    for (const fp of list) {
      const canonical = typeof fp === 'string' ? canonicalFingerprint(fp) : null
      if (canonical) fps.add(canonical)
    }
    if (fps.size > 0) out[peer] = [...fps].sort()
  }
  return out
}

/** Every key of `a` and of `b`, in the form {@link parseKeyLists} gives. */
export function unionKeyLists(
  a: Readonly<Record<string, readonly string[]>>,
  b: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  for (const lists of [a, b]) {
    for (const [peer, fps] of Object.entries(lists)) merged[peer] = [...(merged[peer] ?? []), ...fps]
  }
  return parseKeyLists(merged)
}

export function serializeTrustRecords(data: TrustRecordsData): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data))
}

/** How one key of a contact stands, and the decisions the user may take on it. */
export interface KeyStanding {
  trust: 'verified' | 'tofu' | 'untrusted' | 'unknown'
  used: boolean
  notUsedReason?: 'awaiting-decision' | 'trust-pending' | 'distrusted'
  /** The decisions the user may take; `held` is never one of them. */
  allowedDecisions: Array<Exclude<KeyDecision, 'held'>>
}

/**
 * The standing of an announced key from its recorded decision. `holdsNewKeys`
 * is true for a verified contact other than the account itself: a key the user
 * never decided on then waits for a decision instead of being used.
 * `trustPending` is true while trust data an earlier version saved for the
 * contact is still being moved: whether they were verified is not known yet,
 * so a key without a decision, or held, waits for that instead
 * (`trust-pending`).
 */
export function keyStanding(decision: KeyDecision | undefined, holdsNewKeys: boolean, trustPending = false): KeyStanding {
  if (trustPending && (decision === undefined || decision === 'held')) {
    return { trust: 'unknown', used: false, notUsedReason: 'trust-pending', allowedDecisions: ['verified', 'tofu', 'untrusted'] }
  }
  switch (decision) {
    case 'verified':
      return { trust: 'verified', used: true, allowedDecisions: ['tofu', 'untrusted'] }
    case 'tofu':
      return { trust: 'tofu', used: true, allowedDecisions: ['verified', 'untrusted'] }
    case 'untrusted':
      return { trust: 'untrusted', used: false, notUsedReason: 'distrusted', allowedDecisions: ['verified', 'tofu'] }
    case 'held':
      return awaitingDecision()
    default:
      return holdsNewKeys ? awaitingDecision() : { trust: 'tofu', used: true, allowedDecisions: ['verified', 'untrusted'] }
  }
}

function awaitingDecision(): KeyStanding {
  return { trust: 'unknown', used: false, notUsedReason: 'awaiting-decision', allowedDecisions: ['verified', 'tofu', 'untrusted'] }
}

/**
 * The decisions that bring local records in line with a newer synced snapshot
 * of verified keys. A key verified there becomes verified here; a key verified
 * here but absent there loses its verification and stays approved (`tofu`), as
 * when the user removes a verification. Other records are left alone.
 */
export function planVerifiedSetsUpdate(
  remote: Readonly<Record<string, readonly string[]>>,
  local: Readonly<Record<string, readonly string[]>>,
): KeyDecisionChange[] {
  const changes: KeyDecisionChange[] = []
  for (const peer of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const remoteSet = new Set((remote[peer] ?? []).map((fp) => canonicalFingerprint(fp)).filter((fp): fp is string => fp !== null))
    const localSet = new Set((local[peer] ?? []).map((fp) => canonicalFingerprint(fp)).filter((fp): fp is string => fp !== null))
    for (const fp of remoteSet) {
      if (!localSet.has(fp)) changes.push({ peer, fingerprint: fp, decision: 'verified' })
    }
    for (const fp of localSet) {
      if (!remoteSet.has(fp)) changes.push({ peer, fingerprint: fp, decision: 'tofu' })
    }
  }
  return changes
}

/**
 * The trust records of the signed-in account, read synchronously and written
 * in the background (see the module comment).
 */
export class TrustRecordStore {
  private data: TrustRecordsData = emptyTrustRecords()
  private storage: PluginStorage | null = null
  private writes: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<TrustRecordsListener>()
  private readonly decisionViews = new Map<string, Readonly<Record<string, KeyDecision>>>()

  /** Called when a background write fails; the in-memory records stay as they are. */
  onPersistError: ((err: unknown) => void) | null = null

  /**
   * Read what `storage` holds and use it from now on. `found` is false when
   * nothing was saved yet; `readable` is false when a saved blob could not be
   * read, in which case the records start empty.
   */
  async attach(storage: PluginStorage): Promise<{ found: boolean; readable: boolean }> {
    this.storage = storage
    const bytes = await storage.get(TRUST_RECORDS_STORAGE_KEY)
    if (this.storage !== storage) return { found: false, readable: true }
    if (!bytes) {
      this.setData(emptyTrustRecords())
      return { found: false, readable: true }
    }
    const parsed = parseTrustRecords(bytes)
    this.setData(parsed ?? emptyTrustRecords())
    return { found: true, readable: parsed !== null }
  }

  /** Replace every record (the migration's result) and save it. */
  replace(data: TrustRecordsData): void {
    this.setData(data)
    this.persist()
  }

  /** Forget the records and the storage, as the account signs out. */
  detach(): void {
    this.storage = null
    this.setData(emptyTrustRecords())
  }

  /** Wait for every write queued so far. */
  flush(): Promise<void> {
    return this.writes
  }

  subscribe(listener: TrustRecordsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---- reads ----

  decisionOf(peer: string, fingerprint: string): KeyDecision | undefined {
    const fp = canonicalFingerprint(fingerprint)
    return fp ? this.data.peers[peer]?.[fp]?.decision : undefined
  }

  /** Every record of a contact, keyed by canonical fingerprint. */
  recordsOf(peer: string): Readonly<Record<string, KeyTrustRecord>> {
    return this.data.peers[peer] ?? {}
  }

  isVerified(peer: string, fingerprint: string): boolean {
    return this.decisionOf(peer, fingerprint) === 'verified'
  }

  /** Whether any key of the contact is verified, retired keys included. */
  hasVerified(peer: string): boolean {
    return Object.values(this.data.peers[peer] ?? {}).some((r) => r.decision === 'verified')
  }

  /** The contact's verified fingerprints, sorted. */
  verifiedFingerprints(peer: string): string[] {
    return Object.entries(this.data.peers[peer] ?? {})
      .filter(([, r]) => r.decision === 'verified')
      .map(([fp]) => fp)
      .sort()
  }

  /** Every contact's verified fingerprints, sorted; contacts with none are left out. */
  verifiedSets(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const peer of Object.keys(this.data.peers).sort()) {
      const fps = this.verifiedFingerprints(peer)
      if (fps.length > 0) out[peer] = fps
    }
    return out
  }

  /** Every decision, without times: what the trust-state seal covers. */
  decisions(): Record<string, Record<string, KeyDecision>> {
    const out: Record<string, Record<string, KeyDecision>> = {}
    for (const [peer, keys] of Object.entries(this.data.peers)) {
      out[peer] = Object.fromEntries(Object.entries(keys).map(([fp, r]) => [fp, r.decision]))
    }
    return out
  }

  /**
   * A contact's decisions keyed by canonical fingerprint. The same object is
   * returned until one of them changes, so a view can compare by identity.
   */
  decisionsView(peer: string): Readonly<Record<string, KeyDecision>> {
    let view = this.decisionViews.get(peer)
    if (!view) {
      view = Object.freeze(
        Object.fromEntries(Object.entries(this.data.peers[peer] ?? {}).map(([fp, r]) => [fp, r.decision])),
      )
      this.decisionViews.set(peer, view)
    }
    return view
  }

  hasDecisions(): boolean {
    return Object.keys(this.data.peers).length > 0
  }

  rejectionsOf(peer: string): CertRejection[] {
    return [...(this.data.rejections[peer] ?? [])]
  }

  /** Every contact's rejected certificates. */
  allRejections(): Record<string, CertRejection[]> {
    return Object.fromEntries(Object.entries(this.data.rejections).map(([peer, list]) => [peer, list.map((r) => ({ ...r }))]))
  }

  syncVersion(): number {
    return this.data.syncVersion
  }

  setsAdopted(): boolean {
    return this.data.setsAdopted
  }

  /** The keys held on the account's devices, as last read or published here (see {@link TrustRecordsData.accountHolds}). */
  accountHolds(): Record<string, string[]> {
    return parseKeyLists(this.data.accountHolds ?? {})
  }

  /** Every key held here, by contact, in the form {@link parseKeyLists} gives. */
  heldKeys(): Record<string, string[]> {
    const held: Record<string, string[]> = {}
    for (const [peer, keys] of Object.entries(this.data.peers)) {
      const fps = Object.entries(keys).filter(([, r]) => r.decision === 'held').map(([fp]) => fp)
      if (fps.length > 0) held[peer] = fps
    }
    return parseKeyLists(held)
  }

  // ---- writes ----

  /** Record decisions; a change equal to the current decision is skipped. */
  setDecisions(changes: readonly KeyDecisionChange[], now: string = new Date().toISOString()): void {
    const peers = new Set<string>()
    let verified = false
    let next: Record<string, Record<string, KeyTrustRecord>> | null = null
    for (const change of changes) {
      const fp = canonicalFingerprint(change.fingerprint)
      if (!fp) continue
      const current = (next ?? this.data.peers)[change.peer]?.[fp]?.decision
      if (current === (change.decision ?? undefined)) continue
      next ??= { ...this.data.peers }
      const keys = { ...(next[change.peer] ?? {}) }
      if (change.decision === null) delete keys[fp]
      else keys[fp] = { decision: change.decision, decidedAt: now }
      if (Object.keys(keys).length > 0) next[change.peer] = keys
      else delete next[change.peer]
      peers.add(change.peer)
      if (current === 'verified' || change.decision === 'verified') verified = true
    }
    if (!next) return
    this.data = { ...this.data, peers: next }
    for (const peer of peers) this.decisionViews.delete(peer)
    this.persist()
    this.emit({ peers: [...peers], decisions: true, verified, syncVersion: false, loaded: false })
  }

  setDecision(peer: string, fingerprint: string, decision: KeyDecision | null, now?: string): void {
    this.setDecisions([{ peer, fingerprint, decision }], now)
  }

  /** Replace a contact's rejected certificates; `[]` clears them. */
  setRejections(peer: string, rejections: readonly CertRejection[]): void {
    const prior = this.data.rejections[peer] ?? []
    if (JSON.stringify(prior) === JSON.stringify(rejections)) return
    const next = { ...this.data.rejections }
    if (rejections.length > 0) next[peer] = rejections.map((r) => ({ ...r }))
    else delete next[peer]
    this.data = { ...this.data, rejections: next }
    this.persist()
    this.emit({ peers: [peer], decisions: false, verified: false, syncVersion: false, loaded: false })
  }

  setSyncVersion(version: number): void {
    if (version === this.data.syncVersion) return
    this.data = { ...this.data, syncVersion: version }
    this.persist()
    this.emit({ peers: [], decisions: false, verified: false, syncVersion: true, loaded: false })
  }

  /** Record that the account's verifications live on the set node; it stays so. */
  adoptSets(): void {
    if (this.data.setsAdopted) return
    this.data = { ...this.data, setsAdopted: true }
    this.persist()
    this.emit({ peers: [], decisions: false, verified: false, syncVersion: true, loaded: false })
  }

  /** Replace the keys held on the account's devices. */
  setAccountHolds(holds: Readonly<Record<string, readonly string[]>>): void {
    const next = parseKeyLists(holds)
    if (JSON.stringify(next) === JSON.stringify(this.accountHolds())) return
    const data: TrustRecordsData = { ...this.data }
    if (Object.keys(next).length > 0) data.accountHolds = next
    else delete data.accountHolds
    this.data = data
    this.persist()
    this.emit({ peers: [], decisions: false, verified: false, syncVersion: true, loaded: false })
  }

  /**
   * Use `data` with `storage` from now on, in one step, without reading
   * what `storage` holds: `save` writes it there. A migration that completes
   * during the session swaps its records in this way, so nothing reads the
   * records half-replaced.
   */
  adopt(storage: PluginStorage, data: TrustRecordsData, save: boolean): void {
    this.storage = storage
    this.setData(data)
    if (save) this.persist()
  }

  // ---- internals ----

  private setData(data: TrustRecordsData): void {
    const peers = new Set([
      ...Object.keys(this.data.peers),
      ...Object.keys(this.data.rejections),
      ...Object.keys(data.peers),
      ...Object.keys(data.rejections),
    ])
    this.data = data
    this.decisionViews.clear()
    this.emit({ peers: [...peers], decisions: true, verified: true, syncVersion: true, loaded: true })
  }

  /** Queue a write of the records as they are now, after the writes before it. */
  private persist(): void {
    const storage = this.storage
    if (!storage) return
    const bytes = serializeTrustRecords(this.data)
    this.writes = this.writes
      .then(() => storage.put(TRUST_RECORDS_STORAGE_KEY, bytes))
      .catch((err: unknown) => {
        this.onPersistError?.(err)
      })
  }

  private emit(change: TrustRecordsChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch {
        // A listener's failure must not stop the others.
      }
    }
  }
}
