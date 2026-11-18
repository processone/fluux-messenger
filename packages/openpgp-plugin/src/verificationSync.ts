/**
 * Cross-device synchronisation of peer verifications.
 *
 * Publishes every contact's verified keys to a private PEP node
 * (`urn:xmpp:fluux:verifications:1`, `accessModel='whitelist'`) sign+encrypted
 * to the user's own OpenPGP key. Other devices of the same account receive a
 * PEP headline, fetch the node, decrypt it, and reconcile their records.
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
 *    only when newer than the highest already applied, so a replayed
 *    (older-or-equal) node is a no-op, closing the trust-rollback path.
 *
 * Sync strategy: **versioned snapshot, last-writer-wins**. An applied snapshot
 * *replaces* the verified keys: additions AND removals propagate. A
 * revocation of the last verification publishes an empty (but signed +
 * versioned) snapshot rather than skipping the publish, so the entry cannot
 * resurface on resync. Two concurrent verifications made offline on different
 * devices collapse to the later publisher's snapshot (the other is lost and
 * must be re-done) — a fail-safe direction (under-trust → re-verify), never
 * resurrection of a revoked key.
 *
 * # The set format and the older node
 *
 * Earlier versions published one verified fingerprint per contact to
 * `urn:xmpp:fluux:verifications:0`. The set format lives on a new node so an
 * older client, which may keep writing the older node, can never roll back or
 * shrink the sets. A device that finds the new node uses it and never reads
 * the older one again. When the new node is absent, the device reads the
 * older node (a payload without a version decodes to version `0`), applies it
 * under the same version rule, and publishes the winner to the new node.
 */

import type { PluginContext, XMLElementData } from '@fluux/sdk'
// The PEP node id is a raw protocol name, so it comes from the escape hatch.
import { NS_FLUUX_VERIFICATIONS, NS_FLUUX_VERIFICATION_SETS } from '@fluux/sdk/xmpp'
import { fingerprintsEqual } from './fingerprintCompare'

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

/** The older node: one verified fingerprint per contact. Read only to migrate. */
export const LEGACY_VERIFICATIONS_NODE = NS_FLUUX_VERIFICATIONS
/** The node holding every verified key of each contact. */
export const VERIFICATION_SETS_NODE = NS_FLUUX_VERIFICATION_SETS

/** Every verified fingerprint of each contact, with the snapshot's version. */
export interface VerificationSetsSnapshot {
  sets: Record<string, string[]>
  version: number
}

/** What a read of the set node found. */
export type VerificationSetsRead =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | ({ kind: 'snapshot' } & VerificationSetsSnapshot)

interface VerificationSetsPayload {
  v: 1
  ts: number
  version: number
  verified: Record<string, string[]>
}

// ---------------------------------------------------------------------------
// PEP item builder / parser (mirrors parseSecretKeyBackupItem pattern)
// ---------------------------------------------------------------------------

function buildVerificationsPayload(xmlns: string, base64Ciphertext: string): XMLElementData {
  return {
    name: 'verifications-data',
    attrs: { xmlns },
    children: [{ name: 'data', attrs: {}, children: [base64Ciphertext] }],
  }
}

function parseVerificationsItem(xmlns: string, payload: XMLElementData): string | null {
  if (payload.name !== 'verifications-data' || payload.attrs?.xmlns !== xmlns) return null
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

/**
 * `item-not-found` is the IQ error condition for a node never created; every
 * other failure leaves the question open. The IQ caller surfaces the condition
 * in the error message.
 */
function isItemNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('item-not-found')
}

/**
 * Decrypt a fetched item and keep it only when our own primary key signed it.
 * A malicious server can encrypt an arbitrary payload to the user's public
 * key, but it cannot sign as the user, so any unsigned, wrong-signed, or
 * foreign-signed payload is discarded. `null` when it is unusable.
 */
async function decryptOwnSigned(
  xmlns: string,
  item: { payload: XMLElementData },
  decryptFn: DecryptFn,
  ownPublicArmored: string,
  ownFingerprint: string,
): Promise<unknown> {
  const base64Ciphertext = parseVerificationsItem(xmlns, item.payload)
  if (!base64Ciphertext) return null
  let decrypted: Awaited<ReturnType<DecryptFn>>
  try {
    decrypted = await decryptFn(b64Decode(base64Ciphertext), ownPublicArmored)
  } catch {
    return null
  }
  if (
    !decrypted.signatureVerified ||
    !decrypted.signerFingerprint ||
    !fingerprintsEqual(decrypted.signerFingerprint, ownFingerprint)
  ) {
    return null
  }
  try {
    return JSON.parse(decrypted.plaintext) as unknown
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt every contact's verified keys to our own key and publish them to
 * the set node.
 *
 * Always publishes — including an empty map — so a revocation of the last
 * verification overwrites the server node instead of leaving a stale one
 * behind. `version` must be strictly greater than any previously published
 * version for the monotonic replay gate on the receiving side to work.
 */
export async function publishVerificationSets(
  ctx: PluginContext,
  encryptFn: EncryptFn,
  ownPublicArmored: string,
  sets: Record<string, string[]>,
  version: number,
): Promise<void> {
  const json = JSON.stringify({
    v: 1,
    ts: Date.now(),
    version,
    verified: sets,
  } satisfies VerificationSetsPayload)

  const armored = await encryptFn(json, ownPublicArmored)

  await ctx.xmpp.publishPEP(
    VERIFICATION_SETS_NODE,
    { id: 'current', payload: buildVerificationsPayload(VERIFICATION_SETS_NODE, b64Encode(armored)) },
    { accessModel: 'whitelist', maxItems: 1, persistItems: true },
  )
}

/**
 * Read the set node. `absent` only when the server says it holds nothing
 * there; a failed read or a payload that is not ours is `unreadable`, so the
 * caller never mistakes it for a node to migrate.
 */
export async function fetchVerificationSets(
  ctx: PluginContext,
  decryptFn: DecryptFn,
  ownJid: string,
  ownPublicArmored: string,
  ownFingerprint: string,
): Promise<VerificationSetsRead> {
  let items: { id: string; payload: XMLElementData }[]
  try {
    items = await ctx.xmpp.queryPEP(ownJid, VERIFICATION_SETS_NODE)
  } catch (err) {
    return isItemNotFoundError(err) ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  if (items.length === 0) return { kind: 'absent' }
  const payload = await decryptOwnSigned(VERIFICATION_SETS_NODE, items[0], decryptFn, ownPublicArmored, ownFingerprint)
  if (!payload || typeof payload !== 'object') return { kind: 'unreadable' }
  const obj = payload as Record<string, unknown>
  if (obj.v !== 1 || typeof obj.version !== 'number' || !Number.isInteger(obj.version)) return { kind: 'unreadable' }
  if (!obj.verified || typeof obj.verified !== 'object' || Array.isArray(obj.verified)) return { kind: 'unreadable' }
  // Defensive: only keep string → array of non-empty strings.
  const sets: Record<string, string[]> = {}
  for (const [jid, list] of Object.entries(obj.verified as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const fps = list.filter((fp): fp is string => typeof fp === 'string' && fp.length > 0)
    if (fps.length > 0) sets[jid] = fps
  }
  return { kind: 'snapshot', sets, version: obj.version }
}

/**
 * Read the older node, one verified fingerprint per contact, as a set
 * snapshot. A payload without a version decodes to version `0`. `null` when
 * the node is absent, unreadable or not signed by our own key.
 */
export async function fetchLegacyVerifications(
  ctx: PluginContext,
  decryptFn: DecryptFn,
  ownJid: string,
  ownPublicArmored: string,
  ownFingerprint: string,
): Promise<VerificationSetsSnapshot | null> {
  let items: { id: string; payload: XMLElementData }[]
  try {
    items = await ctx.xmpp.queryPEP(ownJid, LEGACY_VERIFICATIONS_NODE)
  } catch {
    return null
  }
  if (items.length === 0) return null
  const payload = await decryptOwnSigned(LEGACY_VERIFICATIONS_NODE, items[0], decryptFn, ownPublicArmored, ownFingerprint)
  if (!payload || typeof payload !== 'object') return null
  const obj = payload as Record<string, unknown>
  if (obj.v !== 1 && obj.v !== 2) return null
  if (typeof obj.verifications !== 'object' || obj.verifications === null) return null
  const version =
    obj.v === 2 && typeof obj.version === 'number' && Number.isFinite(obj.version) ? obj.version : 0
  const sets: Record<string, string[]> = {}
  for (const [k, val] of Object.entries(obj.verifications as Record<string, unknown>)) {
    if (typeof val === 'string' && val.length > 0) sets[k] = [val]
  }
  return { sets, version }
}
