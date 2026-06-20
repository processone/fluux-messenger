import { describe, expect, it, beforeEach } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import { sealTrustState, verifyTrustStateSeal } from './trustStateIntegrity'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const passthroughEncrypt = async (plaintext: string) => plaintext

// Predicate the plugin will supply (see Task 2). Inlined here to test the gate.
const isKeyUnavailable = (err: unknown) =>
  err instanceof E2EEPluginError && (err.code === 'key-unrecoverable' || err.code === 'key-locked')

function setPins(pins: Record<string, string>) {
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: pins })
}

beforeEach(() => {
  localStorage.clear()
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {} })
  useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  useKeyChangeAlertsStore.setState({ alertsByJid: {} })
})

describe('verifyTrustStateSeal: key-unavailable classification', () => {
  it('returns awaiting-key (not compromised) when decrypt fails because the secret key is unavailable', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(decryptUnavailable, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('awaiting-key')
  })

  it('returns awaiting-key when decrypt fails with a key-locked (transient) error', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptLocked = async () => {
      throw new E2EEPluginError('transient', 'key-locked', 'key is locked')
    }
    const res = await verifyTrustStateSeal(decryptLocked, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('awaiting-key')
  })

  it('still returns compromised when decrypt fails for a non-key reason', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptBroken = async () => { throw new Error('garbage') }
    const res = await verifyTrustStateSeal(decryptBroken, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised when the seal decrypts but pins no longer match', async () => {
    setPins({ 'peer@example.com': 'OLDFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    setPins({ 'peer@example.com': 'TAMPERED' }) // mutate after sealing
    const decryptOriginal = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptOriginal, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised on a foreign signature (decrypt succeeded => key was usable)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptForeign = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: 'FFFFFFFF', signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptForeign, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('returns sealed when decrypt succeeds and pins match', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptOk = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('sealed')
  })

  it('defaults to current behavior when no predicate is passed (decrypt failure => compromised)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(decryptUnavailable, OWN_PUBLIC, OWN_FP)
    expect(res.status).toBe('compromised')
  })
})
