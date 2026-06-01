/**
 * Cross-device synchronisation of peer verification records.
 *
 * Publishes the local `verifiedPeerKeysStore` map to a private PEP node
 * (`urn:xmpp:fluux:verifications:0`, `accessModel='whitelist'`) sign+encrypted
 * to the user's own OpenPGP key. Other devices of the same account receive a
 * PEP headline, fetch the node, decrypt it, and reconcile their store.
 *
 * Crypto is abstracted behind {@link EncryptFn}/{@link DecryptFn} so this
 * module works with both the Sequoia/Tauri backend and the openpgp.js web
 * backend without modification.
 *
 * Two independent properties protect trust against an untrusted server:
 *
 *  - **Authorship — the signature, not the access model.** The fetch path
 *    discards any payload not signed by the account's own primary key, so a
 *    tampering server cannot inject forged "verified" entries by encrypting
 *    to the user's (public) key — it cannot sign as the user.
 *  - **Freshness — a monotonic version.** A signature proves authorship but
 *    NOT freshness: a server can replay an older genuine snapshot. Each
 *    publish carries a strictly increasing `version`; a snapshot is applied
 *    only when newer than the highest already applied
 *    ({@link loadAppliedVerificationsVersion}), so a replayed (older-or-equal)
 *    node is a no-op, closing the trust-rollback path.
 *
 * Sync strategy: **versioned snapshot, last-writer-wins**. An applied snapshot
 * *replaces* local state — additions, fingerprint changes, AND removals all
 * propagate. A revocation of the last verification publishes an empty (but
 * signed + versioned) snapshot rather than skipping the publish, so the entry
 * cannot resurface on resync. The trade-off is that two concurrent
 * verifications made offline on different devices collapse to the later
 * publisher's snapshot (the other is lost and must be re-done) — a fail-safe
 * direction (under-trust → re-verify), never resurrection of a revoked key.
 */

import type { PluginContext, XMLElementData } from '@fluux/sdk'
import { buildScopedStorageKey } from '@fluux/sdk'

/** Encrypt `plaintext` to `recipientPublicArmored`. Returns armored ciphertext. */
export type EncryptFn = (
  plaintext: string,
  recipientPublicArmored: string,
) => Promise<string>

/**
 * Decrypt `ciphertext` (encrypted to us) and report on its signature.
 *
 * The signature metadata is mandatory: cross-device sync only trusts a
 * payload that carries a valid signature from the account's own key, so the
 * caller must surface whatever the crypto backend reports. Mirrors the
 * backend `DecryptOutput` shape.
 */
export type DecryptFn = (
  ciphertext: string,
  senderPublicArmored: string,
) => Promise<{
  plaintext: string
  signatureVerified: boolean
  signerFingerprint: string | null
  signaturePresent: boolean
}>

/** Case- and whitespace-insensitive fingerprint comparison. */
function fingerprintsEqual(a: string, b: string): boolean {
  return a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()
}

export const VERIFICATIONS_NODE = 'urn:xmpp:fluux:verifications:0'
const VERIFICATIONS_XMLNS = VERIFICATIONS_NODE

/** localStorage base key holding the highest snapshot version applied/published. */
const VERSION_STORAGE_KEY_BASE = 'fluux-e2ee-verifications-version'

interface VerificationPayload {
  v: 2
  ts: number
  version: number
  verifications: Record<string, string>
}

/** Outcome of reconciling a fetched snapshot against local state. */
export interface VerificationUpdatePlan {
  /** Whether the snapshot is newer and should be applied. */
  apply: boolean
  /** Entries to write locally (new peers or changed fingerprints). */
  toSet: Array<{ jid: string; fingerprint: string }>
  /** JIDs to drop locally (absent from the newer snapshot). */
  toClear: string[]
  /** Version now in effect (the remote's when applied, else the prior one). */
  version: number
}

// ---------------------------------------------------------------------------
// PEP item builder / parser (mirrors parseSecretKeyBackupItem pattern)
// ---------------------------------------------------------------------------

function buildVerificationsPayload(base64Ciphertext: string): XMLElementData {
  return {
    name: 'verifications-data',
    attrs: { xmlns: VERIFICATIONS_XMLNS },
    children: [{ name: 'data', attrs: {}, children: [base64Ciphertext] }],
  }
}

function parseVerificationsItem(payload: XMLElementData): string | null {
  if (
    payload.name !== 'verifications-data' ||
    payload.attrs?.xmlns !== VERIFICATIONS_XMLNS
  )
    return null
  for (const child of payload.children) {
    if (typeof child === 'string') continue
    if (child.name !== 'data') continue
    const text = child.children[0]
    if (typeof text === 'string' && text.length > 0) return text
  }
  return null
}

// ---------------------------------------------------------------------------
// base64 helpers (same approach as SequoiaPgpPlugin internal helpers)
// ---------------------------------------------------------------------------

function b64Encode(input: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(input)))
  return Buffer.from(input, 'utf-8').toString('base64')
}

function b64Decode(encoded: string): string {
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(encoded)))
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

// ---------------------------------------------------------------------------
// Applied-version persistence
// ---------------------------------------------------------------------------

/**
 * Highest snapshot version this device has applied (from a remote fetch) or
 * published. `-1` means "nothing applied yet", so a legacy v1 node (which
 * decodes to version `0`) is still picked up exactly once on first sync.
 */
export function loadAppliedVerificationsVersion(): number {
  try {
    const scopedKey = buildScopedStorageKey(VERSION_STORAGE_KEY_BASE)
    let raw = localStorage.getItem(scopedKey)
    if (raw === null && scopedKey !== VERSION_STORAGE_KEY_BASE) {
      const legacy = localStorage.getItem(VERSION_STORAGE_KEY_BASE)
      if (legacy !== null) {
        localStorage.setItem(scopedKey, legacy)
        localStorage.removeItem(VERSION_STORAGE_KEY_BASE)
        raw = legacy
      }
    }
    if (raw === null) return -1
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : -1
  } catch {
    return -1
  }
}

export function saveAppliedVerificationsVersion(version: number): void {
  try {
    localStorage.setItem(buildScopedStorageKey(VERSION_STORAGE_KEY_BASE), String(version))
  } catch {
    // Best-effort, mirroring verifiedPeerKeysStore: a failed persist still
    // leaves in-memory state consistent for the rest of the session.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt `verifications` to own key and publish to the private PEP node.
 *
 * Always publishes — including an empty map — so a revocation of the last
 * verification overwrites the server node instead of leaving a stale one
 * behind. `version` must be strictly greater than any previously published
 * version for the monotonic replay gate on the receiving side to work.
 */
export async function publishVerificationsToServer(
  ctx: PluginContext,
  encryptFn: EncryptFn,
  ownPublicArmored: string,
  verifications: Record<string, string>,
  version: number,
): Promise<void> {
  const json = JSON.stringify({
    v: 2,
    ts: Date.now(),
    version,
    verifications,
  } satisfies VerificationPayload)

  const armored = await encryptFn(json, ownPublicArmored)

  await ctx.xmpp.publishPEP(
    VERIFICATIONS_NODE,
    { id: 'current', payload: buildVerificationsPayload(b64Encode(armored)) },
    { accessModel: 'whitelist', maxItems: 1, persistItems: true },
  )
}

/**
 * Fetch the private PEP node, decrypt it, and return the verification map
 * together with its `version`. A legacy v1 payload (no `version` field)
 * decodes to version `0`.
 *
 * Downgrade protection: the decrypted payload is only trusted when it carries
 * a signature that verifies against the account's *own primary key*
 * (`ownFingerprint`). A malicious server can encrypt an arbitrary map to the
 * user's public key (it is, after all, public), but it cannot forge a
 * signature from the user's secret key — so any unsigned, wrong-signed, or
 * foreign-signed payload is discarded.
 *
 * Returns `null` when the node is absent, decryption fails, the signature
 * check does not pass, or the payload is malformed.
 */
export async function fetchVerificationsFromServer(
  ctx: PluginContext,
  decryptFn: DecryptFn,
  ownJid: string,
  ownPublicArmored: string,
  ownFingerprint: string,
): Promise<{ verifications: Record<string, string>; version: number } | null> {
  let items: { id: string; payload: XMLElementData }[]
  try {
    items = await ctx.xmpp.queryPEP(ownJid, VERIFICATIONS_NODE)
  } catch {
    return null
  }
  if (items.length === 0) return null

  const base64Ciphertext = parseVerificationsItem(items[0].payload)
  if (!base64Ciphertext) return null

  const armored = b64Decode(base64Ciphertext)

  let decrypted: Awaited<ReturnType<DecryptFn>>
  try {
    decrypted = await decryptFn(armored, ownPublicArmored)
  } catch {
    return null
  }

  // Downgrade protection: only a payload signed by our own primary key is
  // trusted. Reject unsigned, unverified, or foreign-signed maps — these can
  // only originate from a tampering server, not from one of our devices.
  if (
    !decrypted.signatureVerified ||
    !decrypted.signerFingerprint ||
    !fingerprintsEqual(decrypted.signerFingerprint, ownFingerprint)
  ) {
    return null
  }

  try {
    const payload = JSON.parse(decrypted.plaintext) as unknown
    if (!payload || typeof payload !== 'object') return null
    const obj = payload as Record<string, unknown>
    if (obj.v !== 1 && obj.v !== 2) return null
    if (typeof obj.verifications !== 'object' || obj.verifications === null) return null

    const version =
      obj.v === 2 && typeof obj.version === 'number' && Number.isFinite(obj.version)
        ? obj.version
        : 0

    // Defensive: only keep string→string entries.
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(obj.verifications as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof val === 'string' && val.length > 0) out[k] = val
    }
    return { verifications: out, version }
  } catch {
    return null
  }
}

/**
 * Reconcile a fetched `remote` snapshot against `local` state.
 *
 * The snapshot is applied only when it is strictly newer than
 * `lastAppliedVersion` (replay/rollback defense). When applied, the remote
 * snapshot is authoritative: entries whose fingerprint differs are set,
 * and local JIDs absent from the snapshot are cleared — so revocations and
 * fingerprint changes converge across devices.
 */
export function planVerificationUpdate(
  remote: { verifications: Record<string, string>; version: number },
  local: Record<string, string>,
  lastAppliedVersion: number,
): VerificationUpdatePlan {
  if (remote.version <= lastAppliedVersion) {
    return { apply: false, toSet: [], toClear: [], version: lastAppliedVersion }
  }

  const toSet: Array<{ jid: string; fingerprint: string }> = []
  for (const [jid, fingerprint] of Object.entries(remote.verifications)) {
    if (local[jid] !== fingerprint) toSet.push({ jid, fingerprint })
  }

  const toClear: string[] = []
  for (const jid of Object.keys(local)) {
    if (!(jid in remote.verifications)) toClear.push(jid)
  }

  return { apply: true, toSet, toClear, version: remote.version }
}
