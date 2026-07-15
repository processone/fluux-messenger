import { describe, it, expect } from 'vitest'
import { resolveInboundTrust, toTrustState } from './trust'

describe('BTBV', () => {
  it('auto-trusts (tofu) new devices before any verification', () => {
    const r = resolveInboundTrust(false, null)
    expect(r.store).toBe('trusted') // blind-trust before verification
    expect(r.surfaced).toBe('tofu')
  })
  it('distrusts a new device once the peer has a verified device', () => {
    const r = resolveInboundTrust(true, null)
    expect(r.store).toBe('untrusted')
    expect(r.surfaced).toBe('untrusted')
  })
  it('keeps an explicit prior decision', () => {
    expect(resolveInboundTrust(true, 'trusted').surfaced).toBe('tofu') // note: verified elsewhere; existing trusted stays
    expect(resolveInboundTrust(false, 'untrusted').store).toBe('untrusted')
  })
  it('maps store state to TrustState', () => {
    expect(toTrustState('trusted')).toBe('tofu')
    expect(toTrustState('untrusted')).toBe('untrusted')
    expect(toTrustState('undecided')).toBe('unknown')
  })

  // Additional edge cases beyond the brief.
  it('blind-trusts a brand new device with no prior decision and no verified peer device', () => {
    const r = resolveInboundTrust(false, null)
    expect(r).toEqual({ store: 'trusted', surfaced: 'tofu' })
  })
  it('distrusts a brand new device with no prior decision once peer has a verified device', () => {
    const r = resolveInboundTrust(true, null)
    expect(r).toEqual({ store: 'untrusted', surfaced: 'untrusted' })
  })
  it('does not downgrade an existing trusted decision even when the peer now has a verified device', () => {
    const r = resolveInboundTrust(true, 'trusted')
    expect(r).toEqual({ store: 'trusted', surfaced: 'tofu' })
  })
  it('does not upgrade an existing untrusted decision even when the peer has no verified device', () => {
    const r = resolveInboundTrust(false, 'untrusted')
    expect(r).toEqual({ store: 'untrusted', surfaced: 'untrusted' })
  })
  it('treats existing="undecided" as no decision and re-derives from peerHasVerifiedDevice', () => {
    expect(resolveInboundTrust(false, 'undecided')).toEqual({ store: 'trusted', surfaced: 'tofu' })
    expect(resolveInboundTrust(true, 'undecided')).toEqual({ store: 'untrusted', surfaced: 'untrusted' })
  })
})
