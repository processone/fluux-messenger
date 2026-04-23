/**
 * Plugin-less probe for the XEP-0373 §5 secret-key PEP node.
 *
 * We use this from the Settings toggle-on handler, BEFORE the
 * SequoiaPgpPlugin is registered: the point of the restore-first flow
 * is to check whether a backup exists on the server so we can offer
 * the user a choice (restore vs. generate fresh) instead of silently
 * auto-generating a forking key.
 *
 * Queries the node on the user's own JID and returns the armored
 * OpenPGP message (ready to pass to `openpgp_backup_import`). A node
 * that doesn't exist, has no items, or returns a shape we don't
 * recognize all resolve to `null` — we treat any of those as "no
 * usable backup" rather than propagating the error, because the
 * caller falls through to fresh-generation in every such case.
 */

import type { XMPPClient } from '@fluux/sdk/core'

const OX_NAMESPACE = 'urn:xmpp:openpgp:0'
const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'

/**
 * Query our own PEP secret-key node. Returns the armored OpenPGP
 * backup ciphertext when present and parseable, `null` otherwise.
 * Never throws; a transport failure is indistinguishable from
 * "no backup" for the caller's purposes.
 */
export async function probeRemoteSecretKeyBackup(
  client: XMPPClient,
  bareJid: string,
): Promise<string | null> {
  try {
    const items = await client.pubsub.query(bareJid, SECRET_KEY_NODE)
    for (const item of items) {
      const p = item.payload
      if (!p || typeof p === 'string') continue
      if (p.name !== 'secretkey' || p.attrs?.xmlns !== OX_NAMESPACE) continue
      for (const child of p.children) {
        if (typeof child === 'string') continue
        if (child.name !== 'data') continue
        const text = child.children[0]
        if (typeof text !== 'string') continue
        return base64Decode(text)
      }
    }
  } catch {
    // `item-not-found` is what ejabberd and Prosody return for a node
    // that has never been created — the normal case for any account
    // that hasn't published a backup. Anything else (network, parse
    // failures) is swallowed here too; the caller's fallback
    // (fresh generation) is the correct outcome in every case.
  }
  return null
}

function base64Decode(encoded: string): string {
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(encoded)))
  return Buffer.from(encoded, 'base64').toString('utf-8')
}
