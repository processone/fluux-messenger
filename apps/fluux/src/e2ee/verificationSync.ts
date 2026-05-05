/**
 * Cross-device synchronisation of peer verification records.
 *
 * Publishes the local `verifiedPeerKeysStore` map to a private PEP node
 * (`urn:xmpp:fluux:verifications:0`, `accessModel='whitelist'`) encrypted
 * to the user's own OpenPGP key. Other devices of the same account receive
 * a PEP headline, fetch the node, decrypt it, and merge the entries.
 *
 * This reuses the existing `openpgp_encrypt` / `openpgp_decrypt` Tauri
 * commands — no new Rust code is required. The OpenPGP ciphertext wraps
 * raw JSON (not an XMPP signcrypt envelope), which works because Sequoia's
 * `encrypt_and_sign` writes arbitrary bytes into a `LiteralWriter`.
 *
 * Merge strategy: **union**. Remote entries absent from local are added;
 * no deletions are propagated across devices (revocations remain
 * device-local for this phase).
 */

import type { PluginContext, XMLElementData } from '@fluux/sdk'

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

interface DecryptResult {
  plaintext: string
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
  invoke: InvokeFn,
  ownJid: string,
  ownPublicArmored: string,
  verifications: Record<string, string>,
): Promise<void> {
  if (Object.keys(verifications).length === 0) return

  const json = JSON.stringify({ v: 1, ts: Date.now(), verifications } satisfies VerificationPayload)

  const armored = await invoke<string>('openpgp_encrypt', {
    senderAccountJid: ownJid,
    recipientPublicArmored: ownPublicArmored,
    plaintext: json,
  })

  await ctx.xmpp.publishPEP(
    VERIFICATIONS_NODE,
    { id: 'current', payload: buildVerificationsPayload(b64Encode(armored)) },
    { accessModel: 'whitelist', maxItems: 1, persistItems: true },
  )
}

/**
 * Fetch the private PEP node, decrypt it, and return the verification map.
 * Returns `null` when the node is absent or decryption fails.
 */
export async function fetchVerificationsFromServer(
  ctx: PluginContext,
  invoke: InvokeFn,
  ownJid: string,
  ownPublicArmored: string,
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

  let rust: DecryptResult
  try {
    rust = await invoke<DecryptResult>('openpgp_decrypt', {
      accountJid: ownJid,
      ciphertext: armored,
      senderPublicArmored: ownPublicArmored,
    })
  } catch {
    return null
  }

  try {
    const payload = JSON.parse(rust.plaintext) as unknown
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
