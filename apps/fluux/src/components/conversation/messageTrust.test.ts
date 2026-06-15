import { describe, it, expect } from 'vitest'
import type { MessageSecurityContext } from '@fluux/sdk'
import { resolveDisplayTrust } from './messageTrust'

const FP_A = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const FP_B = 'FFFF6666EEEE7777DDDD8888CCCC9999BBBB0000'

const ctx = (over: Partial<MessageSecurityContext>): MessageSecurityContext => ({
  protocolId: 'openpgp',
  trust: 'tofu',
  ...over,
})

describe('resolveDisplayTrust', () => {
  it('returns undefined when there is no security context', () => {
    expect(resolveDisplayTrust(undefined, FP_A)).toBeUndefined()
  })

  it('upgrades tofu → verified when the message fingerprint matches the verified one', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_A }), FP_A)).toBe('verified')
  })

  it('matches case-insensitively (Sequoia UPPER vs openpgp.js lower)', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_A.toLowerCase() }), FP_A)).toBe('verified')
  })

  it('does NOT upgrade when a DIFFERENT key is verified (rotation / server substitution)', () => {
    // Peer was verified under FP_A; this message is signed by FP_B → must stay tofu.
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_B }), FP_A)).toBe('tofu')
  })

  it('does NOT upgrade when the peer has no verified fingerprint', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu', fingerprint: FP_A }), undefined)).toBe('tofu')
  })

  // Legacy fallback: messages decrypted before #544 (which began baking the
  // signing fingerprint) carry no `fingerprint` to match. Rather than force a
  // peer's entire pre-#544 history grey, fall back to live JID-level
  // verification — the same signal the conversation header chip uses.
  it('upgrades a fingerprint-less message to verified when the peer is verified (legacy fallback)', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu' }), FP_A)).toBe('verified')
  })

  it('keeps a fingerprint-less baked-verified message verified when the peer is verified (legacy fallback)', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified' }), FP_A)).toBe('verified')
  })

  it('leaves a fingerprint-less message at tofu when the peer is not verified', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'tofu' }), undefined)).toBe('tofu')
    expect(resolveDisplayTrust(ctx({ trust: 'verified' }), undefined)).toBe('tofu')
  })

  it('never upgrades an untrusted (signature-failed) message, even on a fingerprint match', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'untrusted', fingerprint: FP_A }), FP_A)).toBe('untrusted')
  })

  it('passes a rejected trust through unchanged', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'rejected', fingerprint: FP_A }), FP_A)).toBe('rejected')
  })

  it('keeps a baked verified trust when its fingerprint is still verified', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_A }), FP_A)).toBe('verified')
  })

  it('downgrades a baked verified to tofu when the peer is no longer verified', () => {
    // Baked `verified` means verified AT decrypt time; if the user later clears
    // the verification, the live lock must fall back to tofu.
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_A }), undefined)).toBe('tofu')
  })

  it('downgrades a baked verified to tofu when a DIFFERENT key is now verified', () => {
    expect(resolveDisplayTrust(ctx({ trust: 'verified', fingerprint: FP_B }), FP_A)).toBe('tofu')
  })
})
