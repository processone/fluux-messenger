import { describe, expect, it, beforeEach } from 'vitest'
import { E2EEPluginError, InMemoryStorageBackend, createPluginStorage, type PluginStorage } from '@fluux/sdk'
import {
  TRUST_SEAL_STORAGE_KEY,
  canonicalJson,
  sealTrustState,
  verifyTrustStateSeal,
} from './trustStateIntegrity'
import { TrustRecordStore, emptyTrustRecords } from './trustRecords'

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const PEER = 'peer@example.com'
const PEER_FP = 'B0B0000000000000000000000000000000000012'
const OTHER_FP = 'CA40100000000000000000000000000000000013'
const passthroughEncrypt = async (plaintext: string) => plaintext
const decryptOk = async (ciphertext: string) => ({
  plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
})

// Predicate the plugin will supply. Inlined here to test the gate.
const isKeyUnavailable = (err: unknown) =>
  err instanceof E2EEPluginError && (err.code === 'key-unrecoverable' || err.code === 'key-locked')

let storage: PluginStorage
let records: TrustRecordStore

beforeEach(async () => {
  storage = createPluginStorage(new InMemoryStorageBackend(), 'openpgp-test')
  records = new TrustRecordStore()
  await records.attach(storage)
})

const seal = () => sealTrustState(storage, records, passthroughEncrypt, OWN_PUBLIC)
const verify = (decrypt: Parameters<typeof verifyTrustStateSeal>[2] = decryptOk, predicate = isKeyUnavailable) =>
  verifyTrustStateSeal(storage, records, decrypt, OWN_PUBLIC, OWN_FP, predicate)

describe('verifyTrustStateSeal: key-unavailable classification', () => {
  it('returns awaiting-key (not compromised) when decrypt fails because the secret key is unavailable', async () => {
    records.setDecision(PEER, PEER_FP, 'verified')
    await seal()
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    expect((await verify(decryptUnavailable)).status).toBe('awaiting-key')
  })

  it('returns awaiting-key when decrypt fails with a key-locked (transient) error', async () => {
    records.setDecision(PEER, PEER_FP, 'verified')
    await seal()
    const decryptLocked = async () => {
      throw new E2EEPluginError('transient', 'key-locked', 'key is locked')
    }
    expect((await verify(decryptLocked)).status).toBe('awaiting-key')
  })

  it('still returns compromised when decrypt fails for a non-key reason', async () => {
    records.setDecision(PEER, PEER_FP, 'verified')
    await seal()
    const decryptBroken = async () => { throw new Error('garbage') }
    expect((await verify(decryptBroken)).status).toBe('compromised')
  })

  it('still returns compromised on a foreign signature (decrypt succeeded => key was usable)', async () => {
    records.setDecision(PEER, PEER_FP, 'verified')
    await seal()
    const decryptForeign = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: 'FFFFFFFF', signaturePresent: true,
    })
    expect((await verify(decryptForeign)).status).toBe('compromised')
  })

  it('returns sealed when decrypt succeeds and the decisions match', async () => {
    records.setDecision(PEER, PEER_FP, 'verified')
    await seal()
    expect(await verify()).toEqual({ status: 'sealed' })
  })

  it('defaults to current behavior when no predicate is passed (decrypt failure => compromised)', async () => {
    records.setDecision(PEER, PEER_FP, 'verified')
    await seal()
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(storage, records, decryptUnavailable, OWN_PUBLIC, OWN_FP)
    expect(res.status).toBe('compromised')
  })
})

describe('verifyTrustStateSeal: no seal and tamper verdicts', () => {
  it('is uninitialized when there is no seal and no decision', async () => {
    expect(await verify()).toEqual({ status: 'uninitialized' })
  })

  it('is pending-seal when decisions exist but nothing was ever sealed', async () => {
    records.setDecision(PEER, PEER_FP, 'tofu')
    expect(await verify()).toEqual({ status: 'pending-seal' })
  })

  it('is compromised when the seal was removed but decisions exist', async () => {
    records.setDecision(PEER, PEER_FP, 'tofu')
    await seal()
    await storage.delete(TRUST_SEAL_STORAGE_KEY)
    expect(await verify()).toEqual({
      status: 'compromised',
      details: ['Trust state seal was removed but trust records contain data'],
    })
  })

  it('names the invalid signature when the signature is not verified', async () => {
    records.setDecision(PEER, PEER_FP, 'tofu')
    await seal()
    const unsigned = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: false, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    expect(await verify(unsigned)).toEqual({
      status: 'compromised',
      details: ['Trust state seal has invalid or foreign signature'],
    })
  })

  it('is compromised with a malformed payload', async () => {
    records.setDecision(PEER, PEER_FP, 'tofu')
    await seal()
    const garbled = async () => ({
      plaintext: 'not json', signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    expect(await verify(garbled)).toEqual({
      status: 'compromised',
      details: ['Trust state seal payload is malformed'],
    })
  })

  it('is compromised with the payload of an earlier seal version', async () => {
    records.setDecision(PEER, PEER_FP, 'tofu')
    await seal()
    const earlier = async () => ({
      plaintext: JSON.stringify({ v: 1, pins: {}, verified: {}, alerts: {}, syncVersion: -1 }),
      signatureVerified: true,
      signerFingerprint: OWN_FP,
      signaturePresent: true,
    })
    expect((await verify(earlier)).details).toEqual(['Trust state seal payload is malformed'])
  })

  it('names a decision changed behind the plugin', async () => {
    records.setDecision(PEER, PEER_FP, 'untrusted')
    await seal()
    // Storage edited outside the plugin: the refused key is now verified.
    const edited = emptyTrustRecords()
    edited.peers[PEER] = { [PEER_FP]: { decision: 'verified', decidedAt: '2024-01-01T00:00:00Z' } }
    records.replace(edited)
    expect(await verify()).toEqual({ status: 'compromised', details: ['trust decisions differ'] })
  })

  it('names a sync version changed behind the plugin', async () => {
    records.setDecision(PEER, PEER_FP, 'verified')
    records.setSyncVersion(4)
    await seal()
    records.setSyncVersion(1)
    expect(await verify()).toEqual({ status: 'compromised', details: ['verification sync version differs'] })
  })

  it('is sealed again for the same decisions saved in another order', async () => {
    records.setDecisions([
      { peer: PEER, fingerprint: PEER_FP, decision: 'verified' },
      { peer: PEER, fingerprint: OTHER_FP, decision: 'tofu' },
    ])
    await seal()
    const reordered = emptyTrustRecords()
    reordered.peers[PEER] = {
      [OTHER_FP]: { decision: 'tofu', decidedAt: '2024-01-01T00:00:00Z' },
      [PEER_FP]: { decision: 'verified', decidedAt: '2024-01-01T00:00:00Z' },
    }
    records.replace(reordered)
    expect(await verify()).toEqual({ status: 'sealed' })
  })
})

describe('canonicalJson', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: { y: 1, x: [2, { d: 1, c: 2 }] }, a: null })).toBe('{"a":null,"b":{"x":[2,{"c":2,"d":1}],"y":1}}')
  })
})
