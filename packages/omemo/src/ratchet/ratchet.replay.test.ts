// Intent: consumed earlier-chain messages are harmless without retaining used keys
// or losing delayed messages. Real generated ratchet traffic owns the crypto and
// persistence facts; host API dispatch is covered by the shared compatibility suite.
import { describe, expect, it } from 'vitest'
import { generateEd25519, generateX25519 } from '../primitives/curve'
import { concatBytes } from '../primitives/bytes'
import { decodeOmemoMessage, encodeOmemoMessage } from '../omemo2/wire'
import {
  initRatchetInitiator, initRatchetResponder, ratchetEncrypt, ratchetDecrypt,
  serializeRatchet, deserializeRatchet, MAX_RETIRED_CHAINS,
} from './ratchet'

const rng = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const enc = (s: string) => new TextEncoder().encode(s)

function traffic() {
  const sharedSecret = rng(32)
  const spk = generateX25519(rng)
  const ad = concatBytes(generateEd25519(rng).pub, generateEd25519(rng).pub)
  let alice = initRatchetInitiator(sharedSecret, spk.pub, rng)
  let bob = initRatchetResponder(sharedSecret, spk.priv, spk.pub)
  bob.rng = rng
  const delayed = ratchetEncrypt(alice, enc('delayed first message'), ad)
  alice = delayed.state
  const delivered = ratchetEncrypt(alice, enc('delivered second message'), ad)
  alice = delivered.state
  bob = ratchetDecrypt(bob, delivered.authMessage, ad).state
  const reply = ratchetEncrypt(bob, enc('reply advances sender chain'), ad)
  bob = reply.state
  alice = ratchetDecrypt(alice, reply.authMessage, ad).state
  const current = ratchetEncrypt(alice, enc('new chain message'), ad)
  alice = current.state
  bob = ratchetDecrypt(bob, current.authMessage, ad).state
  return { alice, bob, ad, delayed, delivered, current }
}

describe('consumed earlier-chain replay', () => {
  it('recognizes consumed old chains after restart while allowing delayed keys once', () => {
    const { bob, ad, delivered, delayed } = traffic()
    let restored = deserializeRatchet(serializeRatchet(bob))
    restored.rng = rng
    const before = serializeRatchet(restored)
    expect(() => ratchetDecrypt(restored, delivered.authMessage, ad)).toThrowError(expect.objectContaining({ code: 'duplicate' }))
    expect(serializeRatchet(restored)).toEqual(before)
    const received = ratchetDecrypt(restored, delayed.authMessage, ad)
    expect(received.plaintext).toEqual(enc('delayed first message'))
    restored = received.state
    expect(() => ratchetDecrypt(restored, delayed.authMessage, ad)).toThrowError(expect.objectContaining({ code: 'duplicate' }))
  })

  it('does not commit chain retirement on authentication failure', () => {
    const { alice, bob, ad, current } = traffic()
    const reply = ratchetEncrypt(bob, enc('another reply'), ad)
    const sender = ratchetDecrypt(alice, reply.authMessage, ad).state
    const next = ratchetEncrypt(sender, enc('next remote chain'), ad)
    const corrupt = { ...next.authMessage, mac: next.authMessage.mac.slice() }
    corrupt.mac[0] ^= 1
    const before = serializeRatchet(reply.state)
    expect(() => ratchetDecrypt(reply.state, corrupt, ad)).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(serializeRatchet(reply.state)).toEqual(before)
    expect(ratchetDecrypt(reply.state, next.authMessage, ad).plaintext).toEqual(enc('next remote chain'))
    // The failed speculative step must not turn the active chain into a retired one.
    expect(() => ratchetDecrypt(reply.state, current.authMessage, ad)).toThrowError(expect.objectContaining({ code: 'duplicate' }))
  })

  it('rejects unconsumed retired-chain indices and corrupt delayed ciphertext without mutation', () => {
    const { bob, ad, delivered, delayed } = traffic()
    const header = decodeOmemoMessage(delivered.authMessage.message)
    const outside = { ...delivered.authMessage, message: encodeOmemoMessage({ ...header, n: header.n + 1 }) }
    const corrupt = { ...delayed.authMessage, mac: delayed.authMessage.mac.slice() }
    corrupt.mac[0] ^= 1
    const before = serializeRatchet(bob)
    for (const message of [outside, corrupt]) {
      expect(() => ratchetDecrypt(bob, message, ad)).toThrowError(expect.objectContaining({ code: 'malformed' }))
      expect(serializeRatchet(bob)).toEqual(before)
    }
    expect(ratchetDecrypt(bob, delayed.authMessage, ad).plaintext).toEqual(enc('delayed first message'))
  })

  it('rejects an unknown chain rather than classifying every old ciphertext as duplicate', () => {
    const { bob, ad } = traffic()
    const unrelated = traffic()
    const before = serializeRatchet(bob)
    expect(() => ratchetDecrypt(bob, unrelated.delivered.authMessage, ad)).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(serializeRatchet(bob)).toEqual(before)
  })

  it('keeps only the newest retired chains without losing delayed keys or live continuity', () => {
    const initial = traffic()
    let { alice, bob } = initial
    const { ad, delivered, current, delayed } = initial
    for (let turn = 0; turn < MAX_RETIRED_CHAINS; turn++) {
      const reply = ratchetEncrypt(bob, enc(`reply ${turn}`), ad)
      alice = ratchetDecrypt(alice, reply.authMessage, ad).state
      const next = ratchetEncrypt(alice, enc(`next chain ${turn}`), ad)
      alice = next.state
      bob = ratchetDecrypt(reply.state, next.authMessage, ad).state
    }
    expect(bob.retiredChains.size).toBe(MAX_RETIRED_CHAINS)
    bob = deserializeRatchet(serializeRatchet(bob))
    bob.rng = rng
    expect(bob.retiredChains.size).toBe(MAX_RETIRED_CHAINS)
    const before = serializeRatchet(bob)
    // The initial retired chain was evicted, but its successor is still retained.
    expect(() => ratchetDecrypt(bob, delivered.authMessage, ad)).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(() => ratchetDecrypt(bob, current.authMessage, ad)).toThrowError(expect.objectContaining({ code: 'duplicate' }))
    expect(serializeRatchet(bob)).toEqual(before)
    // Skipped message keys are independent of the bounded public markers.
    const received = ratchetDecrypt(bob, delayed.authMessage, ad)
    expect(received.plaintext).toEqual(enc('delayed first message'))
    const live = ratchetEncrypt(alice, enc('live after eviction'), ad)
    expect(ratchetDecrypt(received.state, live.authMessage, ad).plaintext).toEqual(enc('live after eviction'))
  }, 30_000)

  it('loads the previous storage shape and starts tracking on the next authenticated turn', () => {
    const { alice, bob, ad, current } = traffic()
    // The previous codec wrote these same fields, without retiredChains.
    const previous = JSON.parse(new TextDecoder().decode(serializeRatchet(bob)))
    delete previous.retiredChains
    const restored = deserializeRatchet(enc(JSON.stringify(previous)))
    restored.rng = rng
    const reply = ratchetEncrypt(restored, enc('reply after upgrade'), ad)
    const sender = ratchetDecrypt(alice, reply.authMessage, ad).state
    const next = ratchetEncrypt(sender, enc('new chain after upgrade'), ad)
    const received = ratchetDecrypt(reply.state, next.authMessage, ad)
    expect(received.plaintext).toEqual(enc('new chain after upgrade'))
    expect(() => ratchetDecrypt(received.state, current.authMessage, ad)).toThrowError(expect.objectContaining({ code: 'duplicate' }))
  })
})
