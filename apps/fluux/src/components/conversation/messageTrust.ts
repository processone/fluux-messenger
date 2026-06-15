import type { MessageSecurityContext } from '@fluux/sdk'
import { fingerprintsEqual } from '@/e2ee/fingerprintCompare'

/**
 * Resolve the trust level to DISPLAY for a message's E2EE lock, given the
 * peer's out-of-band-verified fingerprint (or `undefined` if the peer was
 * never verified).
 *
 * The plugin bakes `trust` at decrypt time, but the user can verify (or
 * un-verify) a peer LATER, so the displayed verified/tofu lock must track the
 * LIVE store rather than the frozen baked value. For a signature-verified
 * message (`tofu`/`verified`) the lock is `verified` only while the user
 * currently has THIS message's signing fingerprint verified, and `tofu`
 * otherwise — both the live upgrade (tofu→verified once verified) and the live
 * downgrade (verified→tofu once cleared). Crucially the check is a fingerprint
 * MATCH, not the mere existence of a verified entry for the JID: otherwise a
 * rotated or server-substituted key would inherit a green lock the user never
 * granted it. The one exception is a legacy message that predates signing-
 * fingerprint capture (no `fingerprint` baked): there's nothing to match, so
 * it falls back to JID-level verification rather than going grey. A message
 * whose signature did not verify (`untrusted` / `rejected`), or a web-of-trust
 * `introduced`, passes through untouched.
 *
 * @param securityContext - the message's baked security context, if encrypted
 * @param verifiedFingerprint - the fingerprint the user verified for this peer
 * @returns the trust level to render, or `undefined` for cleartext messages
 */
export function resolveDisplayTrust(
  securityContext: MessageSecurityContext | undefined,
  verifiedFingerprint: string | undefined,
): MessageSecurityContext['trust'] | undefined {
  if (!securityContext) return undefined
  const baked = securityContext.trust
  if (baked === 'tofu' || baked === 'verified') {
    // Legacy fallback: messages decrypted before the signing fingerprint was
    // captured carry no `fingerprint`. Force-downgrading them to tofu would
    // grey out a verified peer's entire pre-capture history, so fall back to
    // live JID-level verification — the same signal the conversation header
    // chip uses. Messages decrypted with capture always carry a fingerprint
    // and take the strict MATCH path below.
    if (!securityContext.fingerprint) {
      return verifiedFingerprint ? 'verified' : 'tofu'
    }
    const fingerprintVerified =
      !!verifiedFingerprint &&
      fingerprintsEqual(verifiedFingerprint, securityContext.fingerprint)
    return fingerprintVerified ? 'verified' : 'tofu'
  }
  return baked
}
