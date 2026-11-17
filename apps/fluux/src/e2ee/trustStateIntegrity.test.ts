import { describe, expect, it, beforeEach } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import { createAppHostStores } from './appHostStores'
import {
  clearCompromisedAndReseal,
  isTofuBlockedByCompromise,
  sealTrustState,
  verifyTrustStateSeal,
} from './trustStateIntegrity'
import {
  getTrustStateStatus,
  setTrustStateStatus,
  useTrustStateStatusStore,
} from '@/stores/trustStateStatusStore'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'

const stores = createAppHostStores()
const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const passthroughEncrypt = async (plaintext: string) => plaintext

// Predicate the plugin will supply. Inlined here to test the gate.
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
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(stores, decryptUnavailable, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('awaiting-key')
  })

  it('returns awaiting-key when decrypt fails with a key-locked (transient) error', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const decryptLocked = async () => {
      throw new E2EEPluginError('transient', 'key-locked', 'key is locked')
    }
    const res = await verifyTrustStateSeal(stores, decryptLocked, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('awaiting-key')
  })

  it('still returns compromised when decrypt fails for a non-key reason', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const decryptBroken = async () => { throw new Error('garbage') }
    const res = await verifyTrustStateSeal(stores, decryptBroken, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised when the seal decrypts but pins no longer match', async () => {
    setPins({ 'peer@example.com': 'OLDFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    setPins({ 'peer@example.com': 'TAMPERED' }) // mutate after sealing
    const decryptOriginal = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(stores, decryptOriginal, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised on a foreign signature (decrypt succeeded => key was usable)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const decryptForeign = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: 'FFFFFFFF', signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(stores, decryptForeign, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('returns sealed when decrypt succeeds and pins match', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const decryptOk = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('sealed')
  })

  it('defaults to current behavior when no predicate is passed (decrypt failure => compromised)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(stores, decryptUnavailable, OWN_PUBLIC, OWN_FP)
    expect(res.status).toBe('compromised')
  })
})

describe('verifyTrustStateSeal: no seal and tamper verdicts', () => {
  const decryptOk = async (ciphertext: string) => ({
    plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
  })

  it('is uninitialized when there is no seal and the stores are empty', async () => {
    expect(await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP)).toEqual({ status: 'uninitialized' })
  })

  it('is pending-seal when stores hold data but nothing was ever sealed', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    expect(await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP)).toEqual({ status: 'pending-seal' })
  })

  it('is compromised when the seal was removed but stores contain data', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
      .filter((k) => k.includes('trust-state-seal'))
    expect(keys.length).toBe(1)
    localStorage.removeItem(keys[0])
    const res = await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP)
    expect(res).toEqual({
      status: 'compromised',
      details: ['Trust state seal was removed but stores contain data'],
    })
  })

  it('names the invalid signature when the signature is not verified', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const unsigned = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: false, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(stores, unsigned, OWN_PUBLIC, OWN_FP)
    expect(res).toEqual({
      status: 'compromised',
      details: ['Trust state seal has invalid or foreign signature'],
    })
  })

  it('is compromised with a malformed payload', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const garbled = async () => ({
      plaintext: 'not json', signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    expect(await verifyTrustStateSeal(stores, garbled, OWN_PUBLIC, OWN_FP)).toEqual({
      status: 'compromised',
      details: ['Trust state seal payload is malformed'],
    })
  })

  it('is compromised with an unknown payload version', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    const future = async () => ({
      plaintext: JSON.stringify({ v: 2 }), signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(stores, future, OWN_PUBLIC, OWN_FP)
    expect(res.details).toEqual(['Trust state seal payload is malformed'])
  })

  it('lists which part differs when the sealed state no longer matches', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: { 'peer@example.com': 'PEERFP' } })
    const res = await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP)
    expect(res).toEqual({ status: 'compromised', details: ['verified peers differ'] })
  })
})

describe('isTofuBlockedByCompromise and clearCompromisedAndReseal', () => {
  const decryptOk = async (ciphertext: string) => ({
    plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
  })

  beforeEach(() => {
    useTrustStateStatusStore.getState().clear()
  })

  it('never blocks while the trust state is not compromised', () => {
    expect(isTofuBlockedByCompromise(stores, 'peer@example.com')).toBe(false)
  })

  it('blocks every peer when compromised and no sealed payload was read', () => {
    setTrustStateStatus('compromised')
    // Module state from earlier tests is cleared by a reseal; start clean.
    return clearCompromisedAndReseal(stores, passthroughEncrypt, OWN_PUBLIC).then(() => {
      setTrustStateStatus('compromised')
      expect(isTofuBlockedByCompromise(stores, 'anyone@example.com')).toBe(true)
    })
  })

  it('blocks only peers that were pinned in the last sealed payload', async () => {
    setPins({ 'pinned@example.com': 'PINNEDFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    setPins({ 'pinned@example.com': 'TAMPERED' })
    const res = await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP)
    setTrustStateStatus(res.status)
    expect(res.status).toBe('compromised')
    expect(isTofuBlockedByCompromise(stores, 'pinned@example.com')).toBe(true)
    expect(isTofuBlockedByCompromise(stores, 'new@example.com')).toBe(false)
  })

  it('reseals the current state, forgets the payload and reports sealed', async () => {
    setPins({ 'pinned@example.com': 'PINNEDFP' })
    await sealTrustState(stores, passthroughEncrypt, OWN_PUBLIC)
    setPins({ 'pinned@example.com': 'TAMPERED' })
    await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP)
    setTrustStateStatus('compromised')

    await clearCompromisedAndReseal(stores, passthroughEncrypt, OWN_PUBLIC)

    expect(getTrustStateStatus()).toBe('sealed')
    expect(await verifyTrustStateSeal(stores, decryptOk, OWN_PUBLIC, OWN_FP)).toEqual({ status: 'sealed' })
    setTrustStateStatus('compromised')
    // The earlier payload was dropped, so the next verdict reads a fresh one.
    expect(isTofuBlockedByCompromise(stores, 'new@example.com')).toBe(false)
  })
})
