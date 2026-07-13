import { describe, it, expect } from 'vitest'
import { generateX25519 } from '../primitives/curve'
import {
  initRatchetInitiator,
  initRatchetResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchet,
  deserializeRatchet,
} from './ratchet'

function counterRng() {
  let c = 100
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)
const AD = new Uint8Array(64).fill(0xab) // stand-in for IK_a || IK_b

describe('double ratchet (OMEMO 2 message cipher)', () => {
  it('exchanges messages both directions, including out of order', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(1)
    const bobSpk = generateX25519(rng)
    let alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    let bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng

    const a1 = ratchetEncrypt(alice, enc('hello'), AD)
    alice = a1.state
    const b1 = ratchetDecrypt(bob, a1.authMessage, AD)
    bob = b1.state
    expect(dec(b1.plaintext)).toBe('hello')

    const b2 = ratchetEncrypt(bob, enc('hi back'), AD)
    bob = b2.state
    const a2 = ratchetDecrypt(alice, b2.authMessage, AD)
    alice = a2.state
    expect(dec(a2.plaintext)).toBe('hi back')

    const m1 = ratchetEncrypt(alice, enc('one'), AD)
    alice = m1.state
    const m2 = ratchetEncrypt(alice, enc('two'), AD)
    alice = m2.state
    const r2 = ratchetDecrypt(bob, m2.authMessage, AD)
    bob = r2.state
    const r1 = ratchetDecrypt(bob, m1.authMessage, AD)
    bob = r1.state
    expect(dec(r2.plaintext)).toBe('two')
    expect(dec(r1.plaintext)).toBe('one')
  })

  it('rejects a message whose MAC does not match the AD', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(1)
    const bobSpk = generateX25519(rng)
    const alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    const bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng
    const a1 = ratchetEncrypt(alice, enc('secret'), AD)
    const wrongAd = new Uint8Array(64).fill(0xcd)
    expect(() => ratchetDecrypt(bob, a1.authMessage, wrongAd)).toThrow()
  })

  it('serializes and restores ratchet state', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(2)
    const spk = generateX25519(rng)
    const a = initRatchetInitiator(ss, spk.pub, rng)
    const restored = deserializeRatchet(serializeRatchet(a))
    restored.rng = rng
    const m = ratchetEncrypt(restored, new TextEncoder().encode('x'), AD)
    expect(m.authMessage.mac.length).toBe(16)
  })

  // SECURITY REGRESSION: a deserialized ratchet whose real rng has NOT been re-injected
  // must FAIL LOUD if an inbound message triggers a DH-ratchet step, instead of silently
  // minting a predictable keypair from an all-zero scalar (forward-secrecy break).
  it('throws (does not silently mint a degenerate key) when a DH ratchet fires before rng re-injection', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(4)
    const bobSpk = generateX25519(rng)
    let alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    let bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng

    // Alice → Bob: establishes Bob's recv chain and makes Bob DH-ratchet (new dhSelfPub).
    const a1 = ratchetEncrypt(alice, enc('hello'), AD)
    alice = a1.state
    bob = ratchetDecrypt(bob, a1.authMessage, AD).state

    // Bob → Alice: msg2 carries Bob's NEW dhPub (differs from Alice's stored dhRemote),
    // so decrypting it will trigger a DH ratchet on Alice → generateX25519(alice.rng).
    const b1 = ratchetEncrypt(bob, enc('hi back'), AD)
    bob = b1.state

    // Persist Alice and restore WITHOUT re-injecting the real rng (the account-layer step
    // that would normally run). The fail-loud stub must fire on the DH-ratchet path.
    const restored = deserializeRatchet(serializeRatchet(alice))
    expect(() => ratchetDecrypt(restored, b1.authMessage, AD)).toThrow(/rng not re-injected/)
  })

  // (a) Duplicate delivery: a skipped key is consumed exactly once. Re-delivering the
  // SAME authMessage after its key was consumed must NOT silently yield a fresh valid
  // plaintext — it must throw (the chain has advanced past it and the skipped key is gone).
  it('does not double-decrypt a duplicate (replayed) message', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(1)
    const bobSpk = generateX25519(rng)
    let alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    let bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng

    const a1 = ratchetEncrypt(alice, enc('once'), AD)
    alice = a1.state
    const first = ratchetDecrypt(bob, a1.authMessage, AD)
    bob = first.state
    expect(dec(first.plaintext)).toBe('once')

    // Second delivery of the exact same authMessage: the recv chain has advanced (nr=1),
    // no skipped key was stored for n=0, so decryption throws instead of returning plaintext.
    expect(() => ratchetDecrypt(bob, a1.authMessage, AD)).toThrow()
  })

  // (b) Tampered message bytes → MAC verification fails, throws before AES-decrypt.
  it('rejects a message whose ciphertext bytes were tampered', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(1)
    const bobSpk = generateX25519(rng)
    const alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    const bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng

    const a1 = ratchetEncrypt(alice, enc('tamper me'), AD)
    const tampered = {
      mac: a1.authMessage.mac,
      message: Uint8Array.from(a1.authMessage.message),
    }
    tampered.message[tampered.message.length - 1] ^= 0xff
    expect(() => ratchetDecrypt(bob, tampered, AD)).toThrow()
  })

  // (c) Long in-order run: 50 messages one direction all decrypt (chain advances correctly).
  it('decrypts a long in-order run of 50 messages', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(7)
    const bobSpk = generateX25519(rng)
    let alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    let bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng

    for (let i = 0; i < 50; i++) {
      const out = ratchetEncrypt(alice, enc(`msg-${i}`), AD)
      alice = out.state
      const inn = ratchetDecrypt(bob, out.authMessage, AD)
      bob = inn.state
      expect(dec(inn.plaintext)).toBe(`msg-${i}`)
    }
  })

  // (d) Interleaved bidirectional with a skipped message across a DH ratchet step.
  //     A sends 2, B replies 1 (triggers a DH ratchet on A), then A's FIRST message
  //     arrives late at B — it must still decrypt from the pre-ratchet chain.
  it('decrypts a message skipped across a DH ratchet step', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(3)
    const bobSpk = generateX25519(rng)
    let alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    let bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng

    // Alice sends 2 messages.
    const a1 = ratchetEncrypt(alice, enc('a-one'), AD)
    alice = a1.state
    const a2 = ratchetEncrypt(alice, enc('a-two'), AD)
    alice = a2.state

    // Only a2 arrives at Bob first (a1 is delayed). Bob stores skipped key for n=0.
    const rb2 = ratchetDecrypt(bob, a2.authMessage, AD)
    bob = rb2.state
    expect(dec(rb2.plaintext)).toBe('a-two')

    // Bob replies — introduces Bob's new DH pubkey.
    const b1 = ratchetEncrypt(bob, enc('b-one'), AD)
    bob = b1.state
    const ra = ratchetDecrypt(alice, b1.authMessage, AD)
    alice = ra.state // triggers DH ratchet on Alice
    expect(dec(ra.plaintext)).toBe('b-one')

    // Alice sends after the ratchet.
    const a3 = ratchetEncrypt(alice, enc('a-three'), AD)
    alice = a3.state
    const rb3 = ratchetDecrypt(bob, a3.authMessage, AD)
    bob = rb3.state
    expect(dec(rb3.plaintext)).toBe('a-three')

    // Now the delayed a1 finally arrives at Bob — decrypt from the stored skipped key.
    const rb1 = ratchetDecrypt(bob, a1.authMessage, AD)
    bob = rb1.state
    expect(dec(rb1.plaintext)).toBe('a-one')
  })

  // (e) MAX_SKIP: a gap larger than the bound throws instead of allocating unboundedly.
  it('throws when the skip gap exceeds MAX_SKIP', () => {
    const rng = counterRng()
    const ss = new Uint8Array(32).fill(9)
    const bobSpk = generateX25519(rng)
    let alice = initRatchetInitiator(ss, bobSpk.pub, rng)
    let bob = initRatchetResponder(ss, bobSpk.priv, bobSpk.pub)
    bob.rng = rng

    // Alice sends the first message so Bob establishes the recv chain (n=0).
    const first = ratchetEncrypt(alice, enc('start'), AD)
    alice = first.state
    bob = ratchetDecrypt(bob, first.authMessage, AD).state

    // Alice sends many more but Bob receives none until a huge n.
    let last = first
    for (let i = 0; i < 1100; i++) {
      last = ratchetEncrypt(alice, enc(`skip-${i}`), AD)
      alice = last.state
    }
    // Delivering the last one forces skipping > MAX_SKIP (1000) → throw.
    expect(() => ratchetDecrypt(bob, last.authMessage, AD)).toThrow(/too many skipped/)
  })
})
