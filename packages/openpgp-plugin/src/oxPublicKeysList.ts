/**
 * XEP-0373 `<public-keys-list/>` merge.
 *
 * The `urn:xmpp:openpgp:0:public-keys` node holds ONE item that enumerates
 * every OpenPGP key the account advertises — across all of its clients, not
 * just the one doing the publishing (XEP-0373 §4.2). Since PubSub gives us a
 * whole-item write, republishing our own single entry deletes every sibling
 * client's entry.
 *
 * That is not cosmetic. A spec-compliant peer treats the list as the set of
 * ACTIVE keys: Gajim marks any previously-known fingerprint that is missing
 * from the list `active=False`, and its recipient selection then skips it. So
 * clobbering the list makes peers stop encrypting to our sibling devices, and
 * those devices can no longer read their own account's messages (issue #1059).
 *
 * `mergePublicKeysList` is the read-modify-write half of the fix: hand it the
 * items currently on the node and it returns the payload to publish, with
 * foreign entries carried over verbatim.
 */

import type { PEPItem, XMLElementData } from '@fluux/sdk'
import { normalizeFingerprint, pubkeyMetadataFingerprintAttrs } from './fingerprintCompare'

/** The OX wire namespace, shared by every `urn:xmpp:openpgp:0` element. */
export const OX_NAMESPACE = 'urn:xmpp:openpgp:0'

const LIST_ELEMENT = 'public-keys-list'
const ENTRY_ELEMENT = 'pubkey-metadata'

/**
 * Read the fingerprint an entry advertises, preferring `v6-fingerprint`.
 *
 * Mirrors the reader in `OpenPGPPluginBase.parseAdvertisedFingerprints`: a key
 * publishes exactly one of the two attributes, matching its version.
 */
function entryFingerprint(entry: XMLElementData): string | null {
  for (const name of ['v6-fingerprint', 'v4-fingerprint'] as const) {
    const value = entry.attrs?.[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

export interface MergePublicKeysListParams {
  /** Items currently published on `urn:xmpp:openpgp:0:public-keys`. */
  existing: PEPItem[]
  /** Our own key: the entry this publish is asserting. */
  own: { fingerprint: string; date: string }
  /**
   * Fingerprints to remove rather than carry over — the identity we just
   * replaced. Without this a restore/import would leave the discarded key
   * advertised and peers would keep encrypting to a secret we no longer hold.
   */
  drop?: readonly string[]
}

/**
 * Build the `<public-keys-list/>` payload to publish: every foreign entry
 * already on the node, in their original order, followed by ours.
 *
 * Our own entry is always re-emitted fresh (new `date`, version-appropriate
 * fingerprint attribute) whether or not it was already listed, so the publish
 * is idempotent and self-healing.
 */
export function mergePublicKeysList({
  existing,
  own,
  drop = [],
}: MergePublicKeysListParams): XMLElementData {
  const ownFp = normalizeFingerprint(own.fingerprint)
  const excluded = new Set([ownFp, ...drop.map(normalizeFingerprint)])
  const seen = new Set<string>()
  const children: XMLElementData[] = []

  for (const item of existing) {
    const list = item.payload
    if (list.name !== LIST_ELEMENT || list.attrs?.xmlns !== OX_NAMESPACE) continue
    for (const child of list.children) {
      if (typeof child === 'string' || child.name !== ENTRY_ELEMENT) continue
      const fingerprint = entryFingerprint(child)
      if (!fingerprint) continue
      const normalized = normalizeFingerprint(fingerprint)
      if (excluded.has(normalized) || seen.has(normalized)) continue
      seen.add(normalized)
      // Carry the entry over verbatim: its `date` and fingerprint attribute
      // belong to the client that published it, and we must not rewrite them.
      children.push({ name: ENTRY_ELEMENT, attrs: { ...child.attrs }, children: [] })
    }
  }

  children.push({
    name: ENTRY_ELEMENT,
    attrs: { ...pubkeyMetadataFingerprintAttrs(own.fingerprint), date: own.date },
    children: [],
  })

  return { name: LIST_ELEMENT, attrs: { xmlns: OX_NAMESPACE }, children }
}
