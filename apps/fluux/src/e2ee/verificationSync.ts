/**
 * Cross-device synchronisation of peer verification records.
 *
 * Publishes the local `verifiedPeerKeysStore` map to a private PEP node
 * (`urn:xmpp:fluux:verifications:0`, `accessModel='whitelist'`) sign+encrypted
 * to the user's own OpenPGP key. Other devices of the same account receive
 * a PEP headline, fetch the node, decrypt it, and merge the entries.
 *
 * Trust hinges on the signature, not the access model: the fetch path discards
 * any payload not signed by the account's own primary key, so a tampering
 * server cannot inject forged "verified" entries by encrypting to the user's
 * (public) key.
 *
 * Crypto is abstracted behind {@link EncryptFn}/{@link DecryptFn} so this
 * module works with both the Sequoia/Tauri backend and the openpgp.js web
 * backend without modification.
 *
 * Merge strategy: **union**. Remote entries absent from local are added;
 * no deletions are propagated across devices (revocations remain
 * device-local for this phase).
 */

import type { PluginContext, XMLElementData } from '@fluux/sdk'

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

interface VerificationPayload {
  v: 1
  ts: number
  verifications: Record<string, string>
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt `verifications` to own key and publish to the private PEP node.
 * Skips the publish if the map is empty to avoid creating a node with no
 * useful data.
 */
export async function publishVerificationsToServer(
  ctx: PluginContext,
  encryptFn: EncryptFn,
  ownPublicArmored: string,
  verifications: Record<string, string>,
): Promise<void> {
  if (Object.keys(verifications).length === 0) return

  const json = JSON.stringify({ v: 1, ts: Date.now(), verifications } satisfies VerificationPayload)

  const armored = await encryptFn(json, ownPublicArmored)

  await ctx.xmpp.publishPEP(
    VERIFICATIONS_NODE,
    { id: 'current', payload: buildVerificationsPayload(b64Encode(armored)) },
    { accessModel: 'whitelist', maxItems: 1, persistItems: true },
  )
}

/**
 * Fetch the private PEP node, decrypt it, and return the verification map.
 *
 * Downgrade protection: the decrypted payload is only trusted when it carries
 * a signature that verifies against the account's *own primary key*
 * (`ownFingerprint`). A malicious server can encrypt an arbitrary map to the
 * user's public key (it is, after all, public), but it cannot forge a
 * signature from the user's secret key — so any unsigned, wrong-signed, or
 * foreign-signed payload is discarded.
 *
 * Returns `null` when the node is absent, decryption fails, or the signature
 * check does not pass.
 */
export async function fetchVerificationsFromServer(
  ctx: PluginContext,
  decryptFn: DecryptFn,
  ownJid: string,
  ownPublicArmored: string,
  ownFingerprint: string,
): Promise<Record<string, string> | null> {
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
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload as Record<string, unknown>).v !== 1 ||
      typeof (payload as Record<string, unknown>).verifications !== 'object'
    )
      return null
    const raw = (payload as VerificationPayload).verifications
    // Defensive: only keep string→string entries.
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return null
  }
}

/**
 * Union-merge `remote` into `local`.
 *
 * Entries present in `remote` but absent from `local` are added.
 * Entries already in `local` are kept as-is (local device wins on conflict).
 * Returns the merged map and whether any new entries were introduced.
 */
export function mergeVerifications(
  remote: Record<string, string>,
  local: Record<string, string>,
): { merged: Record<string, string>; hasNewEntries: boolean } {
  let hasNewEntries = false
  const merged = { ...local }
  for (const [jid, fp] of Object.entries(remote)) {
    if (!merged[jid]) {
      merged[jid] = fp
      hasNewEntries = true
    }
  }
  return { merged, hasNewEntries }
}
