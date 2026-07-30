import { describe, it, expect } from 'vitest'
import {
  type CachedPeerCert,
  serializePeerCache,
  deserializePeerCache,
  activePublics,
  activeFingerprints,
  eligibleVerifierPublics,
  upsertActive,
  markDepartedInactive,
  capUnverifiedInactive,
} from './peerCertCache'

const cert = (fp: string, over: Partial<CachedPeerCert> = {}): CachedPeerCert => ({
  fingerprint: fp,
  publicArmored: `ARMOR:${fp}`,
  keychainBacked: false,
  active: true,
  ...over,
})

describe('peerCertCache', () => {
  it('round-trips an array-shaped cache', () => {
    const map = new Map([['bob@x', [cert('A'), cert('B', { active: false, inactiveAt: '2026-01-01T00:00:00.000Z' })]]])
    expect(deserializePeerCache(serializePeerCache(map))).toEqual(map)
  })

  it('migrates a legacy [jid, KeyBundle] pair cache to one active cert', () => {
    const legacy = JSON.stringify([['bob@x', { fingerprint: 'A', publicArmored: 'ARMOR:A', keychainBacked: false }]])
    const out = deserializePeerCache(legacy)
    expect(out.get('bob@x')).toEqual([cert('A')])
  })

  it('exposes only active certs to encryption', () => {
    const certs = [cert('A'), cert('B', { active: false, inactiveAt: '2026-01-01T00:00:00.000Z' })]
    expect(activePublics(certs)).toEqual(['ARMOR:A'])
    expect(activeFingerprints(certs)).toEqual(['A'])
  })

  it('adds an inactive cert to the verifier set only for a message-time before inactiveAt', () => {
    const inactiveAt = '2026-03-01T00:00:00.000Z'
    const certs = [cert('A'), cert('B', { active: false, inactiveAt })]
    // Live message (no messageTime): active only.
    expect(eligibleVerifierPublics(certs, {}, 0)).toEqual(['ARMOR:A'])
    // Message-time BEFORE inactiveAt (archive OR deferred-receipt): inactive B eligible.
    expect(
      eligibleVerifierPublics(certs, { messageTime: new Date('2026-02-01T00:00:00Z') }, 0),
    ).toEqual(['ARMOR:A', 'ARMOR:B'])
    // Message-time AFTER inactiveAt: B not eligible.
    expect(
      eligibleVerifierPublics(certs, { messageTime: new Date('2026-04-01T00:00:00Z') }, 0),
    ).toEqual(['ARMOR:A'])
  })

  it('normalizes fingerprints and discards malformed entries on deserialize', () => {
    const json = JSON.stringify([
      ['bob@x', [{ fingerprint: 'aabb', publicArmored: 'ARMOR:aabb', keychainBacked: false, active: true }]],
      ['evil@x', [{ publicArmored: 'no-fingerprint', keychainBacked: false, active: true }]], // dropped
      ['nul@x', 'not-an-array'], // dropped
    ])
    const out = deserializePeerCache(json)
    expect(out.get('bob@x')![0].fingerprint).toBe('AABB') // normalized to canonical upper
    expect(out.has('evil@x')).toBe(false)
    expect(out.has('nul@x')).toBe(false)
  })

  it('upsert replaces an existing fingerprint and reactivates it', () => {
    const certs = [cert('A', { active: false, inactiveAt: '2026-01-01T00:00:00.000Z' })]
    const out = upsertActive(certs, { fingerprint: 'A', publicArmored: 'ARMOR:A2', keychainBacked: false })
    expect(out).toEqual([cert('A', { publicArmored: 'ARMOR:A2' })])
  })

  it('marks a departed fingerprint inactive without deleting it', () => {
    const certs = [cert('A'), cert('B')]
    const out = markDepartedInactive(certs, new Set(['A']), '2026-05-01T00:00:00.000Z')
    expect(out).toEqual([cert('A'), cert('B', { active: false, inactiveAt: '2026-05-01T00:00:00.000Z' })])
  })

  it('LRU-caps unverified inactive certs but keeps verified ones', () => {
    const inactive = (fp: string, at: string) => cert(fp, { active: false, inactiveAt: at })
    const certs = [
      cert('ACT'),
      inactive('V', '2026-01-01T00:00:00.000Z'),   // verified — always kept
      inactive('U1', '2026-02-01T00:00:00.000Z'),
      inactive('U2', '2026-03-01T00:00:00.000Z'),
      inactive('U3', '2026-04-01T00:00:00.000Z'),
    ]
    const out = capUnverifiedInactive(certs, (fp) => fp === 'V', 1)
    // Active + verified-inactive kept; only the newest unverified inactive (U3) survives the cap of 1.
    expect(out.map((c) => c.fingerprint)).toEqual(['ACT', 'V', 'U3'])
  })

  it('drops ALL unverified inactive certs when cap is 0 (fails closed, not slice(-0))', () => {
    const inactive = (fp: string, at: string) => cert(fp, { active: false, inactiveAt: at })
    const certs = [
      cert('ACT'),
      inactive('V', '2026-01-01T00:00:00.000Z'), // verified — always kept
      inactive('U1', '2026-02-01T00:00:00.000Z'),
      inactive('U2', '2026-03-01T00:00:00.000Z'),
    ]
    const out = capUnverifiedInactive(certs, (fp) => fp === 'V', 0)
    // Active + verified-inactive kept; every unverified inactive cert is dropped.
    expect(out.map((c) => c.fingerprint)).toEqual(['ACT', 'V'])
  })

  it('discards an array-shaped entry missing `active` while still migrating a legacy entry missing `active`', () => {
    const json = JSON.stringify([
      // Array-shaped (new format): missing `active` is tampered data — discard the whole cert.
      ['tampered@x', [{ fingerprint: 'A', publicArmored: 'ARMOR:A', keychainBacked: false }]],
      // Legacy single-KeyBundle shape (pre-Stage-1): missing `active` is expected — migrate to active:true.
      ['legacy@x', { fingerprint: 'B', publicArmored: 'ARMOR:B', keychainBacked: false }],
    ])
    const out = deserializePeerCache(json)
    expect(out.has('tampered@x')).toBe(false)
    expect(out.get('legacy@x')).toEqual([cert('B')])
  })
})
