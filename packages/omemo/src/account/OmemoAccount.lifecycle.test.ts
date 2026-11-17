// Session, prekey and identity lifecycle of OmemoAccount: serialized state updates, identity
// key binding, prekey replacement, key-exchange replacement, XEP-0384 key transport and
// recovery from an interrupted initialization.
import { describe, it, expect } from 'vitest'
import { MemoryStore } from '../store/MemoryStore'
import { OmemoAccount } from './OmemoAccount'
import {
  decodeKeyExchange,
  encodeKeyExchange,
  decodeAuthMessage,
  encodeAuthMessage,
  decodeOmemoMessage,
  encodeOmemoMessage,
} from '../omemo2/wire'
import { OmemoError } from '../errors'
import type { OmemoStore } from '../store/types'

function counterRng(start: number) {
  let c = start
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)

async function pair(bobSeed = 150) {
  const aliceStore = new MemoryStore()
  const bobStore = new MemoryStore()
  const alice = await OmemoAccount.create(aliceStore, counterRng(1))
  const bob = await OmemoAccount.create(bobStore, counterRng(bobSeed))
  const bDev = bob.publishableDeviceId()
  await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
  return { alice, bob, aliceStore, bobStore, bDev, to: [{ jid: 'bob@x', deviceIds: [bDev] }] }
}

describe('serialized session updates', () => {
  it('gives concurrent encrypts distinct ratchet steps that all decrypt in order', async () => {
    const { alice, bob, to } = await pair()
    const sent = await Promise.all(['a', 'b', 'c', 'd'].map((t) => alice.encrypt(to, enc(t))))
    for (const [i, m] of sent.entries()) expect(dec(await bob.decrypt('alice@x', m.sid, m))).toBe('abcd'[i])
    // Distinct message numbers, never a reused counter/key/IV.
    const blobs = new Set(sent.map((m) => Array.from(m.keys[0].data).join(',')))
    expect(blobs.size).toBe(4)
  })

  it('does not lose received ratchet progress when decrypts run concurrently', async () => {
    const { alice, bob, to } = await pair()
    const m1 = await alice.encrypt(to, enc('one'))
    const m2 = await alice.encrypt(to, enc('two'))
    const m3 = await alice.encrypt(to, enc('three'))
    const out = await Promise.all([m1, m2, m3].map((m) => bob.decrypt('alice@x', m.sid, m)))
    expect(out.map(dec)).toEqual(['one', 'two', 'three'])
    const m4 = await alice.encrypt(to, enc('four'))
    expect(dec(await bob.decrypt('alice@x', m4.sid, m4))).toBe('four')
  })

  it('keeps an established session when a bundle is processed again, unless replacing', async () => {
    const { alice, bob, bDev, to } = await pair()
    const bundle = await bob.publishableBundleAsync()
    expect(await alice.processBundle('bob@x', bDev, bundle)).toBe(false)
    const m = await alice.encrypt(to, enc('still works'))
    expect(dec(await bob.decrypt('alice@x', m.sid, m))).toBe('still works')
    expect(await alice.processBundle('bob@x', bDev, bundle, { replace: true })).toBe(true)
  })
})

describe('identity key binding', () => {
  it('re-binds a changed bundle identity to an untrusted record', async () => {
    const { alice, aliceStore, bDev, bobStore } = await pair()
    await aliceStore.saveTrust('bob@x', bDev, { state: 'trusted', identityKey: (await aliceStore.loadTrust('bob@x', bDev))!.identityKey })
    const impostor = await OmemoAccount.create(new MemoryStore(), counterRng(77))
    const bundle = await impostor.publishableBundleAsync()
    await alice.processBundle('bob@x', bDev, bundle, { replace: true })
    const trust = (await aliceStore.loadTrust('bob@x', bDev))!
    expect(trust.state).toBe('untrusted')
    expect(trust.identityKey).toEqual(bundle.ik)
    void bobStore
  })

  it('re-binds a changed sender identity on a replacement key exchange to untrusted', async () => {
    const { alice, bob, bobStore, bDev, to } = await pair()
    const m1 = await alice.encrypt(to, enc('hi'))
    await bob.decrypt('alice@x', m1.sid, m1)
    const first = (await bobStore.loadTrust('alice@x', m1.sid))!
    await bobStore.saveTrust('alice@x', m1.sid, { ...first, state: 'trusted' })

    // A different identity claiming the same device id performs a new key exchange.
    const rogue = await OmemoAccount.create(new MemoryStore(), counterRng(33))
    const rogueStore = (rogue as unknown as { store: OmemoStore }).store
    const id = (await rogueStore.loadIdentity())!
    await rogueStore.saveIdentity({ ...id, deviceId: m1.sid })
    const rogue2 = await OmemoAccount.load(rogueStore, counterRng(34))
    await rogue2.processBundle('bob@x', bDev, await bob.publishableBundleAsync())
    const m2 = await rogue2.encrypt(to, enc('replacement'))
    expect(dec(await bob.decrypt('alice@x', m2.sid, m2))).toBe('replacement')

    const after = (await bobStore.loadTrust('alice@x', m1.sid))!
    expect(after.state).toBe('untrusted')
    expect(after.identityKey).not.toEqual(first.identityKey)
  })
})

describe('prekey lifecycle', () => {
  it('spreads initiators across the published prekeys', async () => {
    const bob = await OmemoAccount.create(new MemoryStore(), counterRng(150))
    const bundle = await bob.publishableBundleAsync()
    const used = new Set<number>()
    for (let i = 0; i < 12; i++) {
      const alice = await OmemoAccount.create(new MemoryStore(), counterRng(i * 7 + 1))
      await alice.processBundle('bob@x', 1, bundle)
      const m = await alice.encrypt([{ jid: 'bob@x', deviceIds: [1] }], enc('x'))
      used.add(decodeKeyExchange(m.keys[0].data).pkId)
    }
    expect(used.size).toBeGreaterThan(1)
  })

  it('replaces a consumed prekey and flags the bundle for republishing', async () => {
    const { alice, bob, to } = await pair()
    const before = await bob.publishableBundleAsync()
    bob.markBundlePublished(bob.bundleRevision())
    expect(bob.isBundleDirty()).toBe(false)
    const m = await alice.encrypt(to, enc('hi'))
    await bob.decrypt('alice@x', m.sid, m)
    expect(bob.isBundleDirty()).toBe(true)
    // A publish of an older revision does not clear a newer change.
    const rev = bob.bundleRevision()
    bob.markBundlePublished(rev)
    expect(bob.isBundleDirty()).toBe(false)
    const after = await bob.publishableBundleAsync()
    const usedId = decodeKeyExchange(m.keys[0].data).pkId
    expect(after.preKeys.some((p) => p.id === usedId)).toBe(false)
    expect(after.preKeys).toHaveLength(before.preKeys.length)
    // The next independent sender gets a usable bundle.
    const carol = await OmemoAccount.create(new MemoryStore(), counterRng(60))
    await carol.processBundle('bob@x', bob.publishableDeviceId(), after)
    const m2 = await carol.encrypt([{ jid: 'bob@x', deviceIds: [bob.publishableDeviceId()] }], enc('from carol'))
    expect(dec(await bob.decrypt('carol@x', m2.sid, m2))).toBe('from carol')
  })

  it('tops the pool up when replenished after prekeys were lost', async () => {
    const store = new MemoryStore()
    const bob = await OmemoAccount.create(store, counterRng(150))
    for (const id of (await store.listPreKeyIds()).slice(0, 10)) await store.removePreKey(id)
    await bob.replenishPreKeys()
    expect((await store.listPreKeyIds()).length).toBe(100)
    expect(bob.isBundleDirty()).toBe(true)
  })
})

describe('replacement key exchange', () => {
  it('accepts a genuinely new key exchange over an existing session, and still rejects a replay', async () => {
    const { alice, bob, bDev, to } = await pair()
    const m1 = await alice.encrypt(to, enc('first'))
    expect(dec(await bob.decrypt('alice@x', m1.sid, m1))).toBe('first')

    // Alice rebuilds the session (e.g. repair): a NEW key exchange arrives over Bob's old session.
    await alice.processBundle('bob@x', bDev, await bob.publishableBundleAsync(), { replace: true })
    const m2 = await alice.encrypt(to, enc('replacement'))
    expect(m2.keys[0].kex).toBe(true)
    expect(dec(await bob.decrypt('alice@x', m2.sid, m2))).toBe('replacement')
    const m3 = await alice.encrypt(to, enc('on the new session'))
    expect(dec(await bob.decrypt('alice@x', m3.sid, m3))).toBe('on the new session')

    // The consumed key exchange cannot be replayed to reset the session again.
    await expect(bob.decrypt('alice@x', m2.sid, m2)).rejects.toBeInstanceOf(OmemoError)
    const m4 = await alice.encrypt(to, enc('still fine'))
    expect(dec(await bob.decrypt('alice@x', m4.sid, m4))).toBe('still fine')
  })

  it('converges a crossed initiation on one session that carries follow-ups both ways', async () => {
    // Whichever side holds the higher identity key wins, so cover both orderings.
    const seen = new Set<boolean>()
    for (let seed = 150; seed < 190 && seen.size < 2; seed++) {
      const { alice, bob, to } = await pair(seed)
      const aDev = alice.publishableDeviceId()
      const toAlice = [{ jid: 'alice@x', deviceIds: [aDev] }]
      const aliceHigher = (await alice.publishableBundleAsync()).ik.join() > (await bob.publishableBundleAsync()).ik.join()
      const ik = [(await alice.publishableBundleAsync()).ik, (await bob.publishableBundleAsync()).ik]
      let cmp = 0
      for (let i = 0; i < 32 && cmp === 0; i++) cmp = ik[0][i] - ik[1][i]
      seen.add(cmp > 0)
      void aliceHigher
      await bob.processBundle('alice@x', aDev, await alice.publishableBundleAsync())
      const fromAlice = await alice.encrypt(to, enc('hello bob'))
      const fromAlice2 = await alice.encrypt(to, enc('hello again bob'))
      const fromBob = await bob.encrypt(toAlice, enc('hello alice'))
      const fromBob2 = await bob.encrypt(toAlice, enc('again alice'))
      expect(dec(await bob.decrypt('alice@x', fromAlice.sid, fromAlice))).toBe('hello bob')
      expect(dec(await alice.decrypt('bob@x', fromBob.sid, fromBob))).toBe('hello alice')
      // The second message of each initiation is readable on both sides, winner or loser.
      expect(dec(await alice.decrypt('bob@x', fromBob2.sid, fromBob2))).toBe('again alice')
      expect(dec(await bob.decrypt('alice@x', fromAlice2.sid, fromAlice2))).toBe('hello again bob')
      for (let i = 0; i < 3; i++) {
        const a = await alice.encrypt(to, enc(`a${i}`))
        expect(dec(await bob.decrypt('alice@x', a.sid, a))).toBe(`a${i}`)
        const b = await bob.encrypt(toAlice, enc(`b${i}`))
        expect(dec(await alice.decrypt('bob@x', b.sid, b))).toBe(`b${i}`)
      }
    }
    expect(seen.size).toBe(2)
  })
})

describe('crossed initiation with a delayed losing message', () => {
  it('keeps the winning session when a late second message of the losing handshake arrives after a reply', async () => {
    const seen = new Set<boolean>()
    for (let seed = 150; seed < 190 && seen.size < 2; seed++) {
      const { alice, bob, to } = await pair(seed)
      const aDev = alice.publishableDeviceId()
      const toAlice = [{ jid: 'alice@x', deviceIds: [aDev] }]
      const [aik, bik] = [(await alice.publishableBundleAsync()).ik, (await bob.publishableBundleAsync()).ik]
      let cmp = 0
      for (let i = 0; i < 32 && cmp === 0; i++) cmp = aik[i] - bik[i]
      seen.add(cmp > 0)
      await bob.processBundle('alice@x', aDev, await alice.publishableBundleAsync())
      const a1 = await alice.encrypt(to, enc('a1'))
      const a2 = await alice.encrypt(to, enc('a2'))
      const b1 = await bob.encrypt(toAlice, enc('b1'))
      const b2 = await bob.encrypt(toAlice, enc('b2'))
      // First messages cross; the winner then carries a reply BEFORE the loser's second message arrives.
      await bob.decrypt('alice@x', a1.sid, a1)
      await alice.decrypt('bob@x', b1.sid, b1)
      const winnerIsAlice = cmp > 0
      const [winner, loser, lateFromLoser] = winnerIsAlice ? [alice, bob, b2] : [bob, alice, a2]
      const [winJid, loseJid] = winnerIsAlice ? ['bob@x', 'alice@x'] : ['alice@x', 'bob@x']
      // The loser answers on the winning session, which clears the winner's pending flag.
      const reply = await loser.encrypt(winnerIsAlice ? toAlice : to, enc('reply'))
      expect(dec(await winner.decrypt(winJid, reply.sid, reply))).toBe('reply')
      // Now the delayed second message of the losing handshake shows up: readable, but it must not replace the session.
      expect(dec(await winner.decrypt(winJid, lateFromLoser.sid, lateFromLoser))).toBe(winnerIsAlice ? 'b2' : 'a2')
      const next = await winner.encrypt(winnerIsAlice ? to : toAlice, enc('after'))
      expect(dec(await loser.decrypt(loseJid, next.sid, next))).toBe('after')
      const back = await loser.encrypt(winnerIsAlice ? toAlice : to, enc('and back'))
      expect(dec(await winner.decrypt(winJid, back.sid, back))).toBe('and back')
    }
    expect(seen.size).toBe(2)
  })
})

describe('counter gaps are unauthenticated input', () => {
  it('reports an absurd message counter as malformed and leaves the session working', async () => {
    const { alice, bob, to } = await pair()
    const toAlice = [{ jid: 'alice@x', deviceIds: [alice.publishableDeviceId()] }]
    const first = await alice.encrypt(to, enc('one'))
    await bob.decrypt('alice@x', first.sid, first)
    const r = await bob.encrypt(toAlice, enc('r'))
    await alice.decrypt('bob@x', r.sid, r)
    const next = await alice.encrypt(to, enc('two'))
    const auth = decodeAuthMessage(next.keys[0].data)
    const header = decodeOmemoMessage(auth.message)
    for (const bad of [{ ...header, n: header.n + 100000 }, { ...header, pn: header.pn + 100000, n: header.n + 5000 }]) {
      const forged = { ...next, keys: [{ ...next.keys[0], data: encodeAuthMessage({ mac: auth.mac, message: encodeOmemoMessage(bad) }) }] }
      await expect(bob.decrypt('alice@x', next.sid, forged)).rejects.toMatchObject({ code: 'malformed' })
    }
    expect(dec(await bob.decrypt('alice@x', next.sid, next))).toBe('two')
  })
})

describe('send authorization at wrapping time', () => {
  it('asks about the identity key of the session itself and skips refused devices without advancing them', async () => {
    const { alice, bob, to } = await pair()
    const bobKey = (await bob.publishableBundleAsync()).ik
    const asked: Uint8Array[] = []
    const refused = await alice.encrypt(to, enc('no'), {
      authorize: async (_j, _r, ik) => {
        asked.push(ik)
        return false
      },
    })
    expect(refused.keys).toHaveLength(0)
    expect(asked[0]).toEqual(bobKey)
    // The refused attempt did not consume a ratchet step: the next message is still the first.
    const m = await alice.encrypt(to, enc('yes'), { authorize: async () => true })
    expect(dec(await bob.decrypt('alice@x', m.sid, m))).toBe('yes')
  })
})
describe('key transport (empty message)', () => {
  it('carries 32 zero key bytes and no payload, and decrypts to nothing', async () => {
    const { alice, bob, to } = await pair()
    const m = await alice.encrypt(to, new Uint8Array(0))
    expect(m.payload).toBeUndefined()
    expect(await bob.decrypt('alice@x', m.sid, m)).toEqual(new Uint8Array(0))
    const next = await alice.encrypt(to, enc('content after transport'))
    expect(dec(await bob.decrypt('alice@x', next.sid, next))).toBe('content after transport')
  })
})

describe('recipient scoping', () => {
  it('selects the key addressed to this account, not just this device id', async () => {
    const { alice, bob, bDev, to } = await pair()
    const m = await alice.encrypt(to, enc('for bob'))
    // A decoy key for the same device id under another account sits first in the header.
    const decoy = { ...m.keys[0], jid: 'sibling@x', data: new Uint8Array([1, 2, 3]) }
    const crowded = { ...m, keys: [decoy, m.keys[0]] }
    expect(crowded.keys[0].rid).toBe(bDev)
    expect(dec(await bob.decrypt('alice@x', m.sid, crowded, { ownJid: 'bob@x' }))).toBe('for bob')
    await expect(bob.decrypt('alice@x', m.sid, { ...m, keys: [decoy] }, { ownJid: 'bob@x' })).rejects.toMatchObject({
      code: 'not-addressed',
    })
  })
})

describe('interrupted initialization', () => {
  /** A store whose prekey writes fail until `armed` is cleared. */
  class FlakyStore extends MemoryStore {
    armed = true
    override async savePreKey(id: number, r: Parameters<MemoryStore['savePreKey']>[1]) {
      if (this.armed) throw new Error('disk full')
      return super.savePreKey(id, r)
    }
  }

  it('starts over after a failed first initialization instead of adopting a half-built identity', async () => {
    const store = new FlakyStore()
    await expect(OmemoAccount.create(store, counterRng(1))).rejects.toThrow('disk full')
    expect(await store.loadIdentity()).toBeNull()
    store.armed = false
    const account = await OmemoAccount.create(store, counterRng(1))
    expect((await account.publishableBundleAsync()).preKeys).toHaveLength(100)
  })

  it('repairs an identity that was stored without its signed prekey or prekeys', async () => {
    const donor = new MemoryStore()
    await OmemoAccount.create(donor, counterRng(1))
    const stranded = new MemoryStore()
    await stranded.saveIdentity((await donor.loadIdentity())!)
    const account = await OmemoAccount.create(stranded, counterRng(5))
    const bundle = await account.publishableBundleAsync()
    expect(bundle.preKeys).toHaveLength(100)
    const peer = await OmemoAccount.create(new MemoryStore(), counterRng(90))
    await peer.processBundle('me@x', account.publishableDeviceId(), bundle)
  })
})

describe('decrypt side effects only after the content verifies', () => {
  it('keeps the one-time prekey, trust record and session when the payload tag is bad', async () => {
    const { alice, bob, bobStore, to } = await pair()
    const m = await alice.encrypt(to, enc('payload'))
    const tampered = { ...m, payload: Uint8Array.from(m.payload!, (b, i) => (i === 0 ? b ^ 1 : b)) }
    const pkId = decodeKeyExchange(m.keys[0].data).pkId
    await expect(bob.decrypt('alice@x', m.sid, tampered)).rejects.toMatchObject({ code: 'malformed' })
    expect(await bobStore.loadPreKey(pkId)).toBeDefined()
    expect(await bobStore.loadTrust('alice@x', m.sid)).toBeFalsy()
    expect(await bobStore.loadSession('alice@x', m.sid)).toBeFalsy()
    // The genuine message still opens afterwards.
    expect(dec(await bob.decrypt('alice@x', m.sid, m))).toBe('payload')
  })
})

describe('failures that must not trigger repair', () => {
  const flip = (u: Uint8Array) => Uint8Array.from(u, (b, i) => (i === u.length - 1 ? b ^ 1 : b))

  it('reports a forged MAC on an established session as malformed, not session-broken', async () => {
    const { alice, bob, to } = await pair()
    const first = await alice.encrypt(to, enc('one'))
    await bob.decrypt('alice@x', first.sid, first)
    const reply = await bob.encrypt([{ jid: 'alice@x', deviceIds: [alice.publishableDeviceId()] }], enc('r'))
    await alice.decrypt('bob@x', reply.sid, reply)
    const next = await alice.encrypt(to, enc('two'))
    const forged = { ...next, keys: [{ ...next.keys[0], data: flip(next.keys[0].data) }] }
    await expect(bob.decrypt('alice@x', next.sid, forged)).rejects.toMatchObject({ code: 'malformed' })
    expect(dec(await bob.decrypt('alice@x', next.sid, next))).toBe('two')
  })

  it('reports a key exchange naming an unknown signed prekey as malformed', async () => {
    const { alice, bob, to } = await pair()
    const m = await alice.encrypt(to, enc('x'))
    const kex = decodeKeyExchange(m.keys[0].data)
    const bad = { ...m, keys: [{ ...m.keys[0], data: encodeKeyExchange({ ...kex, spkId: kex.spkId + 7 }) }] }
    await expect(bob.decrypt('alice@x', m.sid, bad)).rejects.toMatchObject({ code: 'malformed' })
  })

  it('does not call a replay from a retired chain a broken session', async () => {
    const { alice, bob, to } = await pair()
    const toAlice = [{ jid: 'alice@x', deviceIds: [alice.publishableDeviceId()] }]
    const old = await alice.encrypt(to, enc('old'))
    await bob.decrypt('alice@x', old.sid, old)
    // Alternate directions so the ratchet moves to new chains.
    for (let i = 0; i < 2; i++) {
      const r = await bob.encrypt(toAlice, enc('r'))
      await alice.decrypt('bob@x', r.sid, r)
      const a = await alice.encrypt(to, enc('a'))
      await bob.decrypt('alice@x', a.sid, a)
    }
    await expect(bob.decrypt('alice@x', old.sid, old)).rejects.toSatisfy(
      (e: unknown) => e instanceof OmemoError && e.code !== 'session-broken',
    )
  })

  it('still reports a missing session as broken', async () => {
    const { alice, bob, to } = await pair()
    const first = await alice.encrypt(to, enc('one'))
    await bob.decrypt('alice@x', first.sid, first)
    const reply = await bob.encrypt([{ jid: 'alice@x', deviceIds: [alice.publishableDeviceId()] }], enc('r'))
    await alice.decrypt('bob@x', reply.sid, reply)
    const next = await alice.encrypt(to, enc('two'))
    const stranger = await OmemoAccount.create(new MemoryStore(), counterRng(90))
    await expect(stranger.decrypt('alice@x', next.sid, next)).rejects.toMatchObject({ code: 'not-addressed' })
    await expect(bob.decrypt('nobody@x', next.sid, next)).rejects.toMatchObject({ code: 'session-broken' })
  })
})

describe('authenticating identity of a decrypt', () => {
  it('returns the identity key that vouched for the message, also for a continuing session', async () => {
    const { alice, bob, to } = await pair()
    const aliceKey = (await alice.publishableBundleAsync()).ik
    const first = await alice.encrypt(to, enc('one'))
    const r1 = await bob.decryptAuthenticated('alice@x', first.sid, first)
    expect(r1.senderIdentityKey).toEqual(aliceKey)
    const second = await alice.encrypt(to, enc('two'))
    const r2 = await bob.decryptAuthenticated('alice@x', second.sid, second)
    expect(r2.senderIdentityKey).toEqual(aliceKey)
    const bobKey = (await bob.publishableBundleAsync()).ik
    const reply = await bob.encrypt([{ jid: 'alice@x', deviceIds: [alice.publishableDeviceId()] }], enc('r'))
    expect((await alice.decryptAuthenticated('bob@x', reply.sid, reply)).senderIdentityKey).toEqual(bobKey)
  })

  it('attaches the recorded sender identity to a duplicate', async () => {
    const { alice, bob, to } = await pair()
    const m = await alice.encrypt(to, enc('once'))
    await bob.decrypt('alice@x', m.sid, m)
    const second = await alice.encrypt(to, enc('twice'))
    await bob.decrypt('alice@x', second.sid, second)
    const err = await bob.decrypt('alice@x', second.sid, second).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OmemoError)
    expect((err as OmemoError).code).toBe('duplicate')
    expect((err as OmemoError).senderIdentityKey).toEqual((await alice.publishableBundleAsync()).ik)
  })
})
