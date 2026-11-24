import type { MessageSecurityContext } from '@fluux/sdk'
import { canonicalFingerprint, fingerprintsEqual, type KeyDecision } from '@fluux/openpgp-plugin'

const OPENPGP_PROTOCOL_ID = 'openpgp'

/** The decision the user made about the key `fingerprint`, if any. */
function decisionFor(
  decisions: Readonly<Record<string, KeyDecision>>,
  fingerprint: string,
): KeyDecision | undefined {
  const canonical = canonicalFingerprint(fingerprint)
  if (canonical && decisions[canonical]) return decisions[canonical]
  const match = Object.keys(decisions).find((fp) => fingerprintsEqual(fp, fingerprint))
  return match ? decisions[match] : undefined
}

/**
 * Resolve the trust level to DISPLAY for a message's E2EE lock, given the
 * user's decision about each key of the sender (keyed by fingerprint).
 *
 * The plugin bakes `trust` at decrypt time, but the user can verify, approve
 * or refuse a key LATER, so the displayed lock must track the live decisions
 * rather than the frozen baked value. For a signature-verified message
 * (`tofu`/`verified`) the lock follows the decision about THIS message's
 * signing key: `verified` while that key is verified, `untrusted` once the
 * user refused it, and `tofu` otherwise. The check is per key, not per
 * contact: another verified key of the same contact lends nothing to a
 * message signed by a key the user never verified. The one exception is a
 * legacy message that predates signing-fingerprint capture (no `fingerprint`
 * baked): there is nothing to match, so it shows `verified` while any key of
 * the contact is verified rather than going grey. A message whose signature
 * did not verify (`untrusted` / `rejected`), or a web-of-trust `introduced`,
 * passes through untouched.
 *
 * Own outgoing messages (`isOwn`) are a special case: they are signed by OUR
 * OWN key, and the plugin already baked the correct trust against our own
 * bundle (`verified` iff the signature verified and matched our fingerprint,
 * `untrusted` otherwise). There is no peer to verify out of band, so for own
 * messages we trust the baked value verbatim.
 *
 * The live check applies to OpenPGP messages only; a message from any other
 * protocol shows the trust its plugin baked, whatever the OpenPGP decisions.
 *
 * @param securityContext - the message's baked security context, if encrypted
 * @param decisions - the user's decision about each OpenPGP key of the sender
 * @param isOwn - whether this is the user's own outgoing message
 * @returns the trust level to render, or `undefined` for cleartext messages
 */
export function resolveDisplayTrust(
  securityContext: MessageSecurityContext | undefined,
  decisions: Readonly<Record<string, KeyDecision>>,
  isOwn = false,
): MessageSecurityContext['trust'] | undefined {
  if (!securityContext) return undefined
  if (isOwn) return securityContext.trust
  // The live check below is OpenPGP's: the decisions are about OpenPGP keys and
  // the message's signing fingerprint is an OpenPGP one. Trust for another
  // protocol's device must not depend on these OpenPGP decisions.
  if (securityContext.protocolId !== OPENPGP_PROTOCOL_ID) return securityContext.trust
  const baked = securityContext.trust
  if (baked === 'tofu' || baked === 'verified') {
    // Legacy fallback: messages decrypted before the signing fingerprint was
    // captured carry no `fingerprint`. Force-downgrading them to tofu would
    // grey out a verified contact's entire pre-capture history, so fall back
    // to whether any key of the contact is verified. Messages decrypted with
    // capture always carry a fingerprint and take the per-key path below.
    if (!securityContext.fingerprint) {
      return Object.values(decisions).includes('verified') ? 'verified' : 'tofu'
    }
    const decision = decisionFor(decisions, securityContext.fingerprint)
    if (decision === 'verified') return 'verified'
    if (decision === 'untrusted') return 'untrusted'
    return 'tofu'
  }
  return baked
}
