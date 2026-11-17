// Session, prekey and identity lifecycle of OmemoAccount: serialized state updates, identity
// key binding, prekey replacement, key-exchange replacement, XEP-0384 key transport and
// recovery from an interrupted initialization.
import { describe, it, expect } from 'vitest'
import { MemoryStore } from '../store/MemoryStore'
import { OmemoAccount } from './OmemoAccount'
import { decodeKeyExchange } from '../omemo2/wire'
import { OmemoError } from '../errors'
import type { OmemoStore } from '../store/types'

function counterRng(start: number) {
  let c = start
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (u: Uint8Array) => new TextDecoder().decode(u)

async function pair() {
  const aliceStore = new MemoryStore()
  const bobStore = new MemoryStore()
  const alice = await OmemoAccount.create(aliceStore, counterRng(1))
  const bob = await OmemoAccount.create(bobStore, counterRng(150))
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
    bob.takeBundleDirty()
    const m = await alice.encrypt(to, enc('hi'))
    await bob.decrypt('alice@x', m.sid, m)
    expect(bob.takeBundleDirty()).toBe(true)
    expect(bob.takeBundleDirty()).toBe(false)
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
    expect(bob.takeBundleDirty()).toBe(true)
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

  it('lets a crossed initiation settle on the received key exchange', async () => {
    const { alice, bob, bDev, to } = await pair()
    await bob.processBundle('alice@x', alice.publishableDeviceId(), await alice.publishableBundleAsync())
    const fromAlice = await alice.encrypt(to, enc('hello bob'))
    const fromBob = await bob.encrypt([{ jid: 'alice@x', deviceIds: [alice.publishableDeviceId()] }], enc('hello alice'))
    expect(dec(await bob.decrypt('alice@x', fromAlice.sid, fromAlice))).toBe('hello bob')
    expect(dec(await alice.decrypt('bob@x', fromBob.sid, fromBob))).toBe('hello alice')
    void bDev
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
