import { describe, it, expect } from 'vitest'
import type { MessageSecurityContext } from '@fluux/sdk'
import type { KeyDecision } from '@fluux/openpgp-plugin'
import { resolveDisplayTrust } from './messageTrust'

const FP_A = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const FP_B = 'FFFF6666EEEE7777DDDD8888CCCC9999BBBB0000'

/** The sender's keys the user decided about. */
const decided = (entries: Record<string, KeyDecision> = {}): Readonly<Record<string, KeyDecision>> => entries
const VERIFIED_A = decided({ [FP_A]: 'verified' })
const NONE = decided()

const ctx = (over: Partial<MessageSecurityContext>): MessageSecurityContext => ({
  protocolId: 'openpgp',
  trust: 'tofu',
  ...over,
})

describe('resolveDisplayTrust', () => {
  it('returns undefined when there is no security context', () => {
    expect(resolveDisplayTrust(undefined, VERIFIED_A)).toBeUndefined()
  })

  it('upgrades tofu → verified when the message fingerprint matches the verified one', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_A }), VERIFIED_A)).toBe('verified')
  })

  it('matches case-insensitively (Sequoia UPPER vs openpgp.js lower)', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_A.toLowerCase() }), VERIFIED_A)).toBe('verified')
  })

  it('does NOT upgrade when a DIFFERENT key is verified (rotation / server substitution)', () => {
    // Peer was verified under FP_A; this message is signed by FP_B → must stay tofu.
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_B }), VERIFIED_A)).toBe('tofu')
  })

  it('shows verified for a message signed by a second verified key of the same contact', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_B }), decided({ [FP_A]: 'verified', [FP_B]: 'verified' }))).toBe('verified')
  })

  it('shows untrusted once the user refused the key that signed the message', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_A }), decided({ [FP_A]: 'untrusted' }))).toBe('untrusted')
  })

  it('shows tofu for a key the user approved without verifying', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_A }), decided({ [FP_A]: 'tofu' }))).toBe('tofu')
  })

  it('does NOT upgrade when the peer has no verified fingerprint', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_A }), NONE)).toBe('tofu')
  })

  // Legacy fallback: messages decrypted before #544 (which began baking the
  // signing fingerprint) carry no `fingerprint` to match. Rather than force a
  // peer's entire pre-#544 history grey, fall back to live JID-level
  // verification — the same signal the conversation header chip uses.
  it('upgrades a fingerprint-less message to verified when the peer is verified (legacy fallback)', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu' }), VERIFIED_A)).toBe('verified')
  })

  it('keeps a fingerprint-less baked-verified message verified when the peer is verified (legacy fallback)', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified' }), VERIFIED_A)).toBe('verified')
  })

  it('leaves a fingerprint-less message at tofu when the peer is not verified', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu' }), NONE)).toBe('tofu')
    expect(resolveDisplayTrust(ctx({ trust: 'verified' }), NONE)).toBe('tofu')
  })

  it('never upgrades an untrusted (signature-failed) message, even on a fingerprint match', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'untrusted', fingerprint: FP_A }), VERIFIED_A)).toBe('untrusted')
  })

  it('passes a rejected trust through unchanged', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'rejected', fingerprint: FP_A }), VERIFIED_A)).toBe('rejected')
  })

  it('keeps a baked verified trust when its fingerprint is still verified', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_A }), VERIFIED_A)).toBe('verified')
  })

  it('downgrades a baked verified to tofu when the peer is no longer verified', () => {
    // Baked `verified` means verified AT decrypt time; if the user later clears
    // the verification, the live lock must fall back to tofu.
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_A }), NONE)).toBe('tofu')
  })

  it('downgrades a baked verified to tofu when a DIFFERENT key is now verified', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_B }), VERIFIED_A)).toBe('tofu')
  })

  // Own outgoing messages are signed by OUR OWN key and the plugin already
  // baked the correct trust against our own bundle (verified iff the signature
  // verified and matched our fingerprint). Our own JID is never an entry in the
  // verified-PEER store, so the peer-verification downgrade must be skipped —
  // otherwise every own message renders a grey "unverified peer" lock. This is
  // the bug seen after reload, when MAM-decrypted own messages carry the own
  // signing fingerprint.
  describe('own outgoing messages (isOwn)', () => {
    it('keeps a baked verified own message verified even with no verified-peer entry (MAM reload path)', () => {
      expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_A }), NONE, true)).toBe('verified')
    })

    it('keeps a fingerprint-less baked verified own message verified (live send path)', () => {
      expect(resolveDisplayTrust(ctx({ trust: 'verified' }), NONE, true)).toBe('verified')
    })

    it('preserves an untrusted own message (own signature did not verify) without greening it', () => {
      expect(resolveDisplayTrust(ctx({ trust: 'untrusted', fingerprint: FP_A }), NONE, true)).toBe('untrusted')
    })

    it('still returns undefined for a cleartext own message', () => {
      expect(resolveDisplayTrust(undefined, NONE, true)).toBeUndefined()
    })
  })

  // FLM-268: the live check belongs to OpenPGP. A verified OpenPGP contact must
  // not lend a verified lock to a message from another protocol.
  describe('messages from another protocol', () => {
    it('keeps the baked trust of an OMEMO message while the contact is OpenPGP-verified', () => {
      expect(resolveDisplayTrust(ctx({ protocolId: 'omemo:2', trust: 'tofu' }), VERIFIED_A)).toBe('tofu')
    })

    it('keeps the baked trust of an OMEMO message that carries no fingerprint (legacy fallback is OpenPGP only)', () => {
      expect(resolveDisplayTrust(ctx({ protocolId: 'omemo:2', trust: 'tofu', fingerprint: undefined }), VERIFIED_A)).toBe('tofu')
    })

    it('does not downgrade an OMEMO message its plugin verified', () => {
      expect(resolveDisplayTrust(ctx({ protocolId: 'omemo:2', trust: 'verified' }), NONE)).toBe('verified')
    })

    it('still follows the live check for an OpenPGP message', () => {
      expect(resolveDisplayTrust(ctx({ protocolId: 'openpgp', trust: 'tofu', fingerprint: FP_A }), VERIFIED_A)).toBe('verified')
    })
  })
})
