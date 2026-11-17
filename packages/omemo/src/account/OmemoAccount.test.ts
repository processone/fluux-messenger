import { describe, it, expect } from 'vitest'
import { MemoryStore } from '../store/MemoryStore'
import { OmemoAccount } from './OmemoAccount'
import { decodeKeyExchange, encodeKeyExchange } from '../omemo2/wire'

function counterRng(start: number) {
  let c = start
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)

describe('OmemoAccount', () => {
  it('encrypts opaque content to multiple recipients and each decrypts it', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const alice2 = await OmemoAccount.create(new MemoryStore(), counterRng(90))

    await alice.processBundle('bob@x', bob.publishableDeviceId(), await bob.publishableBundleAsync())
    await alice.processBundle('alice@x', alice2.publishableDeviceId(), await alice2.publishableBundleAsync())

    const content = new TextEncoder().encode('<envelope>opaque sce bytes</envelope>')
    const msg = await alice.encrypt(
      [
        { jid: 'bob@x', deviceIds: [bob.publishableDeviceId()] },
        { jid: 'alice@x', deviceIds: [alice2.publishableDeviceId()] },
      ],
      content,
    )
    // keys carry their recipient jid
    expect(new Set(msg.keys.map((k) => k.jid))).toEqual(new Set(['bob@x', 'alice@x']))
    // both recipients recover the exact content bytes (no envelope wrapping by the library)
    expect(await bob.decrypt('alice@x', msg.sid, msg)).toEqual(content)
    expect(await alice2.decrypt('alice@x', msg.sid, msg)).toEqual(content)
  })

  it('round-trips a single recipient across a KeyExchange then an established message', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))

    const bobBundle = await bob.publishableBundleAsync()
    await alice.processBundle('bob@x', bob.publishableDeviceId(), bobBundle)

    // 1) Initial message is a KeyExchange; decrypt returns the exact content bytes.
    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bob.publishableDeviceId()] }], enc('secret hi'))
    expect(m1.keys[0].kex).toBe(true)
    expect(await bob.decrypt('alice@x', m1.sid, m1)).toEqual(enc('secret hi'))

    // 2) Bob replies (establishes his send chain); Alice decrypts
    const m2 = await bob.encrypt([{ jid: 'alice@x', deviceIds: [alice.publishableDeviceId()] }], enc('got it'))
    expect(m2.keys[0].kex).toBe(false)
    expect(await alice.decrypt('bob@x', m2.sid, m2)).toEqual(enc('got it'))
  })

  it('returns a zero-length Uint8Array for an empty (key-transport) message', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()

    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    // Encrypt empty content: the ratchet still transports the payload key, but there is no body.
    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], new Uint8Array(0))
    // Drop the payload to model a pure key-transport (control) message.
    delete m1.payload

    const recovered = await bob.decrypt('alice@x', m1.sid, m1)
    expect(recovered).toEqual(new Uint8Array(0))
    expect(recovered.length).toBe(0)
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
    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('one'))
    expect(m1.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('one')

    // m2: Bob -> Alice (established, clears Alice's kex-pending on decrypt)
    const m2 = await bob.encrypt([{ jid: 'alice@x', deviceIds: [aDev] }], enc('two'))
    expect(m2.keys[0].kex).toBe(false)
    expect(dec(await alice.decrypt('bob@x', m2.sid, m2))).toBe('two')

    // m3: Alice -> Bob (now established -> not kex)
    const m3 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('three'))
    expect(m3.keys[0].kex).toBe(false)
    expect(dec(await bob.decrypt('alice@x', m3.sid, m3))).toBe('three')

    // m4: Bob -> Alice
    const m4 = await bob.encrypt([{ jid: 'alice@x', deviceIds: [aDev] }], enc('four'))
    expect(m4.keys[0].kex).toBe(false)
    expect(dec(await alice.decrypt('bob@x', m4.sid, m4))).toBe('four')

    // m5/m6: keep alternating to exercise repeated DH ratchets
    const m5 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('five'))
    expect(dec(await bob.decrypt('alice@x', m5.sid, m5))).toBe('five')
    const m6 = await bob.encrypt([{ jid: 'alice@x', deviceIds: [aDev] }], enc('six'))
    expect(dec(await alice.decrypt('bob@x', m6.sid, m6))).toBe('six')
  })

  it('throws when the message has no key for this device (no mis-decrypt)', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const carol = await OmemoAccount.create(new MemoryStore(), counterRng(70))
    // carol is a different device than bob
    expect(carol.publishableDeviceId()).not.toBe(bob.publishableDeviceId())

    await alice.processBundle('bob@x', bob.publishableDeviceId(), await bob.publishableBundleAsync())
    const m = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bob.publishableDeviceId()] }], enc('for bob only'))

    await expect(carol.decrypt('alice@x', m.sid, m)).rejects.toThrow(/no key for this device/)
  })

  it('archive:true decrypts without consuming the prekey or advancing the session', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()

    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('archived hi'))

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
    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('do not tamper'))
    // Flip a byte in the AEAD ciphertext payload.
    m1.payload![0] ^= 0xff

    await expect(bob.decrypt('alice@x', m1.sid, m1)).rejects.toThrow(/authentication failed/)
  })

  it('rejects a forged KeyExchange without burning the prekey or writing trust', async () => {
    // A forged kex carries a real spkId/pkId (trivially read from the victim bundle) but a
    // corrupted embedded message. Authentication (ratchetDecrypt) must run BEFORE any
    // persistent side effect, so the throw leaves the OTK and trust store untouched.
    const bobStore = new MemoryStore()
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(bobStore, counterRng(150))
    const bDev = bob.publishableDeviceId()

    const bobBundle = await bob.publishableBundleAsync()
    await alice.processBundle('bob@x', bDev, bobBundle)
    const usedPkId = bobBundle.preKeys[0].id // the OTK Alice (and thus the forgery) references

    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('hi'))
    // Keep the real pkId/spkId; corrupt only the embedded authenticated message.
    const kex = decodeKeyExchange(m1.keys[0].data)
    expect(kex.pkId).toBe(usedPkId)
    const badMsg = Uint8Array.from(kex.message)
    badMsg[badMsg.length - 1] ^= 0xff
    m1.keys[0].data = encodeKeyExchange({ ...kex, message: badMsg })

    await expect(bob.decrypt('alice@x', m1.sid, m1)).rejects.toThrow(/authentication failed/)

    // No side effects: the one-time prekey survives and no trust record was written.
    expect((await bob.publishableBundleAsync()).preKeys.some((p) => p.id === usedPkId)).toBe(true)
    expect(await bobStore.loadTrust('alice@x', m1.sid)).toBeNull()
  })

  it('handles a duplicate initial delivery without desyncing the session', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()
    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())

    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('hi'))
    expect(m1.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('hi')

    // Redeliver the SAME initial message (ordinary in XMPP: MAM catch-up + live delivery).
    // Must NOT rebuild X3DH; a clean replay rejection is the correct outcome here.
    await expect(bob.decrypt('alice@x', m1.sid, m1)).rejects.toThrow(/authentication failed/)

    // Alice still hasn't heard back, so her next message is still kex-flagged — and it must
    // decrypt against the established session (the OLD code rebuilt X3DH and would throw).
    const m2 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('still me'))
    expect(m2.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m2.sid, m2))).toBe('still me')
  })

  it('does not downgrade an existing trust decision on a repeated kex-flagged message', async () => {
    const bobStore = new MemoryStore()
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(bobStore, counterRng(150))
    const bDev = bob.publishableDeviceId()
    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    const aliceEdPub = (await alice.publishableBundleAsync()).ik

    const m1 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('hi'))
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('hi')
    expect((await bobStore.loadTrust('alice@x', m1.sid))?.state).toBe('undecided')

    // Bob manually verifies Alice's fingerprint and marks the device trusted.
    await bobStore.saveTrust('alice@x', m1.sid, { state: 'trusted', identityKey: aliceEdPub })

    // Alice, not having heard back, sends another kex-flagged message.
    const m2 = await alice.encrypt([{ jid: 'bob@x', deviceIds: [bDev] }], enc('again'))
    expect(m2.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m2.sid, m2))).toBe('again')

    // The manual 'trusted' decision must survive — never reset to 'undecided'.
    expect((await bobStore.loadTrust('alice@x', m1.sid))?.state).toBe('trusted')
  })

  it('rejects a bundle with a tampered signed-prekey signature', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()

    // A valid bundle still processes without throwing (regression).
    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())

    // Flip a byte in the SPK signature: the signature no longer verifies against ik/spk.
    const tampered = await bob.publishableBundleAsync()
    tampered.spkSig = Uint8Array.from(tampered.spkSig)
    tampered.spkSig[0] ^= 0xff
    await expect(alice.processBundle('carol@x', bDev, tampered)).rejects.toThrow(
      /signed-prekey signature verification failed/,
    )
  })

  it('rejects a bundle whose signed prekey was substituted (signature over old spk)', async () => {
    const alice = await OmemoAccount.create(new MemoryStore(), counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()

    // Replace the SPK with a different 32-byte key while keeping the original signature:
    // the signature is over the OLD spk, so verification must fail.
    const substituted = await bob.publishableBundleAsync()
    const otherSpk = Uint8Array.from({ length: 32 }, (_, i) => (substituted.spk[i] ^ 0x5a) & 0xff)
    substituted.spk = otherSpk
    await expect(alice.processBundle('carol@x', bDev, substituted)).rejects.toThrow(
      /signed-prekey signature verification failed/,
    )
  })

  it('does not clobber an existing trust decision when a bundle is re-processed', async () => {
    const aliceStore = new MemoryStore()
    const alice = await OmemoAccount.create(aliceStore, counterRng(1))
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bDev = bob.publishableDeviceId()
    const bobEdPub = (await bob.publishableBundleAsync()).ik

    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    expect((await aliceStore.loadTrust('bob@x', bDev))?.state).toBe('undecided')

    // Alice manually verifies Bob's fingerprint.
    await aliceStore.saveTrust('bob@x', bDev, { state: 'trusted', identityKey: bobEdPub })

    // Re-processing a valid (re-fetched) bundle must not reset trust to 'undecided'.
    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    expect((await aliceStore.loadTrust('bob@x', bDev))?.state).toBe('trusted')
  })
})
