import { describe, expect, it, beforeEach } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import { buildCanonicalSnapshot, sealTrustState, verifyTrustStateSeal } from './trustStateIntegrity'
import { createMockHostStores, type MockHostStores } from './testing/mockHostStores'

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const passthroughEncrypt = async (plaintext: string) => plaintext

// Predicate the plugin will supply (see Task 2). Inlined here to test the gate.
const isKeyUnavailable = (err: unknown) =>
  err instanceof E2EEPluginError && (err.code === 'key-unrecoverable' || err.code === 'key-locked')

let host: MockHostStores

function setPins(pins: Record<string, string>) {
  for (const [jid, fp] of Object.entries(pins)) host.pinnedPrimaryFingerprints.set(jid, fp)
}

beforeEach(() => {
  localStorage.clear()
  host = createMockHostStores()
  host._reset()
})

describe('verifyTrustStateSeal: key-unavailable classification', () => {
  it('returns awaiting-key (not compromised) when decrypt fails because the secret key is unavailable', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {})
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(decryptUnavailable, OWN_PUBLIC, OWN_FP, host, {}, isKeyUnavailable)
    expect(res.status).toBe('awaiting-key')
  })

  it('returns awaiting-key when decrypt fails with a key-locked (transient) error', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {})
    const decryptLocked = async () => {
      throw new E2EEPluginError('transient', 'key-locked', 'key is locked')
    }
    const res = await verifyTrustStateSeal(decryptLocked, OWN_PUBLIC, OWN_FP, host, {}, isKeyUnavailable)
    expect(res.status).toBe('awaiting-key')
  })

  it('still returns compromised when decrypt fails for a non-key reason', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {})
    const decryptBroken = async () => { throw new Error('garbage') }
    const res = await verifyTrustStateSeal(decryptBroken, OWN_PUBLIC, OWN_FP, host, {}, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised when the seal decrypts but pins no longer match', async () => {
    setPins({ 'peer@example.com': 'OLDFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {})
    setPins({ 'peer@example.com': 'TAMPERED' }) // mutate after sealing
    const decryptOriginal = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptOriginal, OWN_PUBLIC, OWN_FP, host, {}, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised on a foreign signature (decrypt succeeded => key was usable)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {})
    const decryptForeign = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: 'FFFFFFFF', signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptForeign, OWN_PUBLIC, OWN_FP, host, {}, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('returns sealed when decrypt succeeds and pins match', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {})
    const decryptOk = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, isKeyUnavailable)
    expect(res.status).toBe('sealed')
  })

  it('defaults to current behavior when no predicate is passed (decrypt failure => compromised)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {})
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(decryptUnavailable, OWN_PUBLIC, OWN_FP, host, {})
    expect(res.status).toBe('compromised')
  })
})

// Task 4: `verified` is threaded in explicitly by the caller (the plugin
// passes `this.verifiedKeys.getAll()`) rather than read from `hostStores`.
// Phase B2 Task 8 went further and deleted `hostStores.verifiedPeers`
// entirely, so there is no longer a second, potentially-disagreeing source
// to read from at all — these tests prove the snapshot and the seal/verify
// round trip key off the injected map alone.
describe('buildCanonicalSnapshot: verified section reflects the injected map exactly', () => {
  it('reflects exactly the injected map', () => {
    const snapshot = buildCanonicalSnapshot(host, { 'cache@example.com': 'CACHEFP' })
    expect(snapshot.verified).toEqual({ 'cache@example.com': 'CACHEFP' })
  })
})

describe('sealTrustState / verifyTrustStateSeal: seal/verify round-trip keys off the injected map', () => {
  const decryptOk = async (ciphertext: string) => ({
    plaintext: ciphertext,
    signatureVerified: true,
    signerFingerprint: OWN_FP,
    signaturePresent: true,
  })

  it('round-trips as sealed off the injected map', async () => {
    const cacheVerified = { 'cache@example.com': 'CACHEFP' }
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, cacheVerified)

    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, cacheVerified, isKeyUnavailable)
    expect(res.status).toBe('sealed')
  })

  it('detects a change to the injected map between seal and verify', async () => {
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, { 'cache@example.com': 'CACHEFP' })

    const res = await verifyTrustStateSeal(
      decryptOk,
      OWN_PUBLIC,
      OWN_FP,
      host,
      { 'cache@example.com': 'TAMPERED' },
      isKeyUnavailable,
    )
    expect(res.status).toBe('compromised')
  })
})
