/**
 * Plugin-less probe for the XEP-0373 §5 secret-key PEP node.
 *
 * We use this from the Settings toggle-on handler, BEFORE the
 * SequoiaPgpPlugin is registered: the point of the restore-first flow
 * is to check whether a backup exists on the server so we can offer
 * the user a choice (restore vs. generate fresh) instead of silently
 * auto-generating a forking key.
 *
 * Returns the armored OpenPGP message (ready to pass to
 * `openpgp_backup_import`) when a backup exists. Returns `null` ONLY
 * when the server has confirmed there is no backup — i.e. an
 * `item-not-found` IQ error, or a node that resolved successfully but
 * carried no parseable `<secretkey>` item.
 *
 * Any other failure — network down, server timeout, permission error,
 * malformed reply, base64 decode failure on a recognized item — throws
 * a {@link SecretKeyBackupProbeError}. The caller MUST NOT proceed to
 * fresh-key generation on this error: doing so would publish a new
 * public-key fingerprint that overwrites the metadata pointing at the
 * still-existing backup, forking the user's OpenPGP identity. The
 * right response is to surface the error and let the user retry, or
 * make them explicitly confirm "yes, generate a new key anyway."
 */

import type { XMPPClient } from '@fluux/sdk/core'

const OX_NAMESPACE = 'urn:xmpp:openpgp:0'
const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'

/**
 * Raised by {@link probeRemoteSecretKeyBackup} when the probe couldn't
 * reach a definitive answer because of an operational failure
 * (network, server unavailable, permission denied, malformed reply,
 * undecodable backup data). Treated as retryable by the caller — the
 * user should try again rather than silently proceed to fresh-key
 * generation, which would clobber an existing identity.
 */
export class SecretKeyBackupProbeError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`OpenPGP backup probe failed: ${detail}`)
    this.name = 'SecretKeyBackupProbeError'
    this.cause = cause
  }
}

/**
 * Query our own PEP secret-key node. Returns the armored OpenPGP
 * backup ciphertext when present and parseable. Returns `null` when
 * the server has confirmed there is no backup. Throws
 * {@link SecretKeyBackupProbeError} on any other failure — see the
 * module docstring for why we refuse to swallow those.
 */
export async function probeRemoteSecretKeyBackup(
  client: XMPPClient,
  bareJid: string,
): Promise<string | null> {
  let items: Awaited<ReturnType<XMPPClient['pubsub']['query']>>
  try {
    items = await client.pubsub.query(bareJid, SECRET_KEY_NODE, 1)
  } catch (err) {
    // `item-not-found` is the only error condition that means "the
    // user has never published a backup" — every server we care about
    // (ejabberd, Prosody) returns it for an absent node. Anything
    // else (timeout, permission, transport down) is an open question
    // and must NOT collapse to "no backup."
    if (isItemNotFoundError(err)) return null
    throw new SecretKeyBackupProbeError(err)
  }

  for (const item of items) {
    const p = item.payload
    if (!p || typeof p === 'string') continue
    if (p.name !== 'secretkey' || p.attrs?.xmlns !== OX_NAMESPACE) continue
    const text = p.children[0]
    if (typeof text !== 'string') continue
    try {
      return base64DecodeOpenPgpBlock(text, 'PGP MESSAGE')
    } catch (err) {
      // We *did* find a `<secretkey>...</secretkey>` item — there's
      // something on the server. We just can't decode it. Surfacing as
      // "no backup" would let the settings flow overwrite that something
      // with a fresh key; surface the failure instead so the user can retry.
      throw new SecretKeyBackupProbeError(err)
    }
  }
  return null
}

/**
 * The IQ caller surfaces XMPP error conditions inside the Error's
 * message; the codebase convention (see `Profile.ts`) is to substring-
 * match on the condition name. Matches the ejabberd/Prosody behavior
 * of returning `<item-not-found/>` for a node that has never been
 * created.
 */
function isItemNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('item-not-found')
}

function base64DecodeOpenPgpBlock(encoded: string, blockType: string): string {
  return armorOpenPgpBlock(base64ToBytes(encoded), blockType)
}

function armorOpenPgpBlock(raw: Uint8Array, blockType: string): string {
  const body = wrapBase64(bytesToBase64(raw))
  return `-----BEGIN ${blockType}-----\n\n${body}\n=${crc24Base64(raw)}\n-----END ${blockType}-----`
}

function base64ToBytes(encoded: string): Uint8Array {
  const clean = encoded.replace(/\s+/g, '')
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error('invalid base64 OpenPGP payload')
  }
  if (typeof atob === 'function') {
    const binary = atob(clean)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') return btoa(bytesToBinaryString(bytes))
  return Buffer.from(bytes).toString('base64')
}

function bytesToBinaryString(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)))
  }
  return chunks.join('')
}

function wrapBase64(input: string): string {
  const lines: string[] = []
  for (let i = 0; i < input.length; i += 64) lines.push(input.slice(i, i + 64))
  return lines.join('\n')
}

function crc24Base64(bytes: Uint8Array): string {
  const crc = crc24(bytes)
  return bytesToBase64(new Uint8Array([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]))
}

function crc24(bytes: Uint8Array): number {
  let crc = 0xb704ce
  for (const byte of bytes) {
    crc ^= byte << 16
    for (let i = 0; i < 8; i++) {
      crc <<= 1
      if ((crc & 0x1000000) !== 0) crc ^= 0x1864cfb
    }
  }
  return crc & 0xffffff
}
