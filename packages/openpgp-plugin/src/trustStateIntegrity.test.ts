import { describe, expect, it, beforeEach } from 'vitest'
import { E2EEPluginError, type PluginStorage } from '@fluux/sdk'
import {
  buildCanonicalSnapshot,
  sealTrustState,
  verifyTrustStateSeal,
  hasStoredSeal,
  writeInitFlag,
  SEAL_STORAGE_KEY,
} from './trustStateIntegrity'
import { createMockHostStores, type MockHostStores } from './testing/mockHostStores'
import { memStorage } from './testSupport/memStorage'

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const passthroughEncrypt = async (plaintext: string) => plaintext

// Predicate the plugin will supply (see Task 2). Inlined here to test the gate.
const isKeyUnavailable = (err: unknown) =>
  err instanceof E2EEPluginError && (err.code === 'key-unrecoverable' || err.code === 'key-locked')

let host: MockHostStores
let storage: PluginStorage

function setPins(pins: Record<string, string>) {
  for (const [jid, fp] of Object.entries(pins)) host.pinnedPrimaryFingerprints.set(jid, fp)
}

beforeEach(() => {
  localStorage.clear()
  host = createMockHostStores()
  host._reset()
  storage = memStorage()
})

describe('verifyTrustStateSeal: key-unavailable classification', () => {
  it('returns awaiting-key (not compromised) when decrypt fails because the secret key is unavailable', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(
      decryptUnavailable,
      OWN_PUBLIC,
      OWN_FP,
      host,
      {},
      storage,
      isKeyUnavailable,
    )
    expect(res.status).toBe('awaiting-key')
  })

  it('returns awaiting-key when decrypt fails with a key-locked (transient) error', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    const decryptLocked = async () => {
      throw new E2EEPluginError('transient', 'key-locked', 'key is locked')
    }
    const res = await verifyTrustStateSeal(
      decryptLocked,
      OWN_PUBLIC,
      OWN_FP,
      host,
      {},
      storage,
      isKeyUnavailable,
    )
    expect(res.status).toBe('awaiting-key')
  })

  it('still returns compromised when decrypt fails for a non-key reason', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    const decryptBroken = async () => { throw new Error('garbage') }
    const res = await verifyTrustStateSeal(decryptBroken, OWN_PUBLIC, OWN_FP, host, {}, storage, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised when the seal decrypts but pins no longer match', async () => {
    setPins({ 'peer@example.com': 'OLDFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    setPins({ 'peer@example.com': 'TAMPERED' }) // mutate after sealing
    const decryptOriginal = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(
      decryptOriginal,
      OWN_PUBLIC,
      OWN_FP,
      host,
      {},
      storage,
      isKeyUnavailable,
    )
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised on a foreign signature (decrypt succeeded => key was usable)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    const decryptForeign = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: 'FFFFFFFF', signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(
      decryptForeign,
      OWN_PUBLIC,
      OWN_FP,
      host,
      {},
      storage,
      isKeyUnavailable,
    )
    expect(res.status).toBe('compromised')
  })

  it('returns sealed when decrypt succeeds and pins match', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    const decryptOk = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, storage, isKeyUnavailable)
    expect(res.status).toBe('sealed')
  })

  it('defaults to current behavior when no predicate is passed (decrypt failure => compromised)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(decryptUnavailable, OWN_PUBLIC, OWN_FP, host, {}, storage)
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
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, cacheVerified, storage)

    const res = await verifyTrustStateSeal(
      decryptOk,
      OWN_PUBLIC,
      OWN_FP,
      host,
      cacheVerified,
      storage,
      isKeyUnavailable,
    )
    expect(res.status).toBe('sealed')
  })

  it('detects a change to the injected map between seal and verify', async () => {
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, { 'cache@example.com': 'CACHEFP' }, storage)

    const res = await verifyTrustStateSeal(
      decryptOk,
      OWN_PUBLIC,
      OWN_FP,
      host,
      { 'cache@example.com': 'TAMPERED' },
      storage,
      isKeyUnavailable,
    )
    expect(res.status).toBe('compromised')
  })
})

// B3 Task 5: the seal blob + init flag moved from localStorage into
// PluginStorage. These tests protect the "together-ness" invariant that
// makes the migration safe (see `legacyTrustStateSeed.ts`): the blob and the
// flag must always land together, because `verifyTrustStateSeal` treats
// "no blob, but the flag says we sealed before, and stores have data" as
// `compromised`.
describe('sealTrustState / verifyTrustStateSeal: PluginStorage-backed seal + init flag (B3 Task 5)', () => {
  const decryptOk = async (ciphertext: string) => ({
    plaintext: ciphertext,
    signatureVerified: true,
    signerFingerprint: OWN_FP,
    signaturePresent: true,
  })

  it('headline: verify reports sealed (not compromised) for unchanged state after a seal round-trips through PluginStorage', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)

    // Simulate a fresh session: a brand-new call reading through the SAME
    // storage, not just an in-memory value that could pass even if the
    // write silently failed.
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, storage, isKeyUnavailable)
    expect(res.status).toBe('sealed')
  })

  it('the seal blob is durably persisted in PluginStorage, not just held in memory', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC, host, {}, storage)
    expect(await hasStoredSeal(storage)).toBe(true)
  })

  it('no seal in PluginStorage, empty stores -> uninitialized (never touches the init-flag branch)', async () => {
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, storage, isKeyUnavailable)
    expect(res.status).toBe('uninitialized')
  })

  // The exact condition `legacyTrustStateSeed.ts`'s migration is built to
  // avoid manufacturing: no seal blob in PluginStorage, but the init flag
  // says a seal happened before, and the stores hold real data. Proves the
  // "together-ness" guard is real, independent of the migration path.
  it('flag present without a blob, non-empty stores -> compromised', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await writeInitFlag(storage)
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, storage, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })
})

// B3 Task 5 review Finding 2: a zero-length stored value is truthy (only
// null/undefined are falsy for `Uint8Array`), so an unguarded `readSeal`
// would decode it as `''` — distinct from `null`, but still "no real seal".
// `hasStoredSeal` (`(await readSeal(storage)) !== null`) would then report
// `true` forever, permanently wedging the legacy-seal migration's guard
// (`if (await hasStoredSeal(storage)) return` in `migrateLegacyTrustSeal`)
// out of ever running for an install stuck with an empty stored value —
// e.g. propagated from an empty legacy blob via `scopedSeal ?? unscopedSeal`
// in `legacyTrustStateSeed.ts`.
describe('readSeal / hasStoredSeal: zero-length stored value is treated as absent (B3 Task 5 review Finding 2)', () => {
  const decryptOk = async (ciphertext: string) => ({
    plaintext: ciphertext,
    signatureVerified: true,
    signerFingerprint: OWN_FP,
    signaturePresent: true,
  })

  it('hasStoredSeal returns false for a zero-length stored seal, not wedged true', async () => {
    await storage.put(SEAL_STORAGE_KEY, new Uint8Array(0))
    expect(await hasStoredSeal(storage)).toBe(false)
  })

  it('verifyTrustStateSeal treats a zero-length stored seal the same as no seal at all (uninitialized on empty stores)', async () => {
    await storage.put(SEAL_STORAGE_KEY, new Uint8Array(0))
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, storage, isKeyUnavailable)
    expect(res.status).toBe('uninitialized')
  })
})

// B3 Task 5 review Finding 3: before this fix, `readSeal` and `isInitialized`
// called `storage.get(...)` unguarded. The old `localStorage`-backed
// `isInitialized()` wrapped its read in a try/catch (degrading to `false` ->
// `pending-seal`); the new `PluginStorage`-backed version only guarded
// `dec.decode`, not the read itself, so a rejecting backend (e.g. a Tauri
// IPC failure) propagated straight out of `verifyTrustStateSeal` as an
// unhandled rejection through the `void this.verifyTrustStateOnInit()` call
// sites in `OpenPGPPluginBase.ts` — a new unhandled-rejection source in the
// exact path this task just cleaned one out of. These tests prove a
// rejecting backend read now degrades to a real verdict instead.
describe('verifyTrustStateSeal: a rejecting storage backend yields a verdict, not an unhandled rejection (B3 Task 5 review Finding 3)', () => {
  const decryptOk = async (ciphertext: string) => ({
    plaintext: ciphertext,
    signatureVerified: true,
    signerFingerprint: OWN_FP,
    signaturePresent: true,
  })

  it('rejecting storage.get with empty stores resolves to uninitialized (exercises the readSeal guard)', async () => {
    const rejecting: PluginStorage = {
      ...storage,
      get: async () => {
        throw new Error('backend unavailable')
      },
    }
    await expect(
      verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, rejecting, isKeyUnavailable),
    ).resolves.toEqual({ status: 'uninitialized' })
  })

  it('rejecting storage.get with non-empty stores resolves to pending-seal (exercises the readSeal AND isInitialized guards)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    const rejecting: PluginStorage = {
      ...storage,
      get: async () => {
        throw new Error('backend unavailable')
      },
    }
    await expect(
      verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, host, {}, rejecting, isKeyUnavailable),
    ).resolves.toEqual({ status: 'pending-seal' })
  })
})
