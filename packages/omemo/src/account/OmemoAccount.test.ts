import { describe, it, expect } from 'vitest'
import { MemoryStore } from '../store/MemoryStore'
import { OmemoAccount } from './OmemoAccount'

function counterRng(start: number) {
  let c = start
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)

describe('OmemoAccount', () => {
  it('round-trips an initial PreKey message then an established message', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))

    const bobBundle = await bob.publishableBundleAsync()
    await alice.processBundle('bob@x', bob.publishableDeviceId(), bobBundle)

    // 1) Initial message is a KeyExchange
    const m1 = await alice.encrypt('bob@x', [bob.publishableDeviceId()], enc('secret hi'))
    expect(m1.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('secret hi')

    // 2) Bob replies (establishes his send chain); Alice decrypts
    const m2 = await bob.encrypt('alice@x', [alice.publishableDeviceId()], enc('got it'))
    expect(m2.keys[0].kex).toBe(false)
    expect(dec(await alice.decrypt('bob@x', m2.sid, m2))).toBe('got it')
  })

  it('fingerprint is 32 curve bytes and identity persists via load', async () => {
    const store = new MemoryStore()
    const a = await OmemoAccount.create(store, counterRng(9))
    const fp = a.identityFingerprint()
    expect(fp.length).toBe(32)
    const reloaded = await OmemoAccount.load(store, counterRng(9))
    expect(reloaded.identityFingerprint()).toEqual(fp)
    expect(reloaded.deviceId()).toBe(a.deviceId())
  })

  it('carries a 4+ message alternating conversation in both directions', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const aDev = alice.publishableDeviceId()
    const bDev = bob.publishableDeviceId()

    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())

    // m1: Alice -> Bob (KeyExchange)
    const m1 = await alice.encrypt('bob@x', [bDev], enc('one'))
    expect(m1.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('one')

    // m2: Bob -> Alice (established, clears Alice's kex-pending on decrypt)
    const m2 = await bob.encrypt('alice@x', [aDev], enc('two'))
    expect(m2.keys[0].kex).toBe(false)
    expect(dec(await alice.decrypt('bob@x', m2.sid, m2))).toBe('two')

    // m3: Alice -> Bob (now established -> not kex)
    const m3 = await alice.encrypt('bob@x', [bDev], enc('three'))
    expect(m3.keys[0].kex).toBe(false)
    expect(dec(await bob.decrypt('alice@x', m3.sid, m3))).toBe('three')

    // m4: Bob -> Alice
    const m4 = await bob.encrypt('alice@x', [aDev], enc('four'))
    expect(m4.keys[0].kex).toBe(false)
    expect(dec(await alice.decrypt('bob@x', m4.sid, m4))).toBe('four')

    // m5/m6: keep alternating to exercise repeated DH ratchets
    const m5 = await alice.encrypt('bob@x', [bDev], enc('five'))
    expect(dec(await bob.decrypt('alice@x', m5.sid, m5))).toBe('five')
    const m6 = await bob.encrypt('alice@x', [aDev], enc('six'))
    expect(dec(await alice.decrypt('bob@x', m6.sid, m6))).toBe('six')
  })

  it('throws when the message has no key for this device (no mis-decrypt)', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const carol = await OmemoAccount.create(new MemoryStore(), counterRng(70))
    // carol is a different device than bob
    expect(carol.publishableDeviceId()).not.toBe(bob.publishableDeviceId())

    await alice.processBundle('bob@x', bob.publishableDeviceId(), await bob.publishableBundleAsync())
    const m = await alice.encrypt('bob@x', [bob.publishableDeviceId()], enc('for bob only'))

    await expect(carol.decrypt('alice@x', m.sid, m)).rejects.toThrow(/no key for this device/)
  })

  it('archive:true decrypts without consuming the prekey or advancing the session', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()

    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    const m1 = await alice.encrypt('bob@x', [bDev], enc('archived hi'))

    const before = (await bob.publishableBundleAsync()).preKeys.length

    // Archive decrypt: returns plaintext, does NOT consume the one-time prekey.
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1, { archive: true }))).toBe('archived hi')
    expect((await bob.publishableBundleAsync()).preKeys.length).toBe(before)

    // A subsequent NORMAL decrypt of the SAME message still works (prekey survived),
    // and this one consumes the prekey.
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('archived hi')
    expect((await bob.publishableBundleAsync()).preKeys.length).toBe(before - 1)
  })

  it('rejects a tampered payload', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()

    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    const m1 = await alice.encrypt('bob@x', [bDev], enc('do not tamper'))
    // Flip a byte in the AEAD ciphertext payload.
    m1.payload![0] ^= 0xff

    await expect(bob.decrypt('alice@x', m1.sid, m1)).rejects.toThrow(/authentication failed/)
  })
})
