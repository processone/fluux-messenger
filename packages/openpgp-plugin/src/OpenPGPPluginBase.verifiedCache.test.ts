// Verifies that `init()` hydrates the plugin-owned `VerifiedKeysCache`
// (Task 2) before it resolves — on EVERY exit path, including the early
// returns for key-locked / needs-identity-decision / key-unrecoverable that
// skip `activateSubscriptions()`. Drives the real `init()` path via the
// harness in `testSupport/baseHarness.ts` rather than calling the cache
// directly (that's `verifiedKeysCache.test.ts`'s job).
//
// The legacy-localStorage upgrade seed (Phase B2 Task 8, replacing the
// `hostStores.verifiedPeers` mirror this file used to seed from) has its own
// dedicated coverage in `OpenPGPPluginBase.legacySeed.test.ts`.
import { describe, it, expect, vi } from 'vitest'
import {
  E2EEPluginError,
  type PEPItem,
  type PluginStorage,
  type XMLElementData,
  type XMPPPrimitives,
} from '@fluux/sdk'
import {
  callBuildInboundSecurityContext,
  getVerifiedKeysCache,
  makeTestBase,
  makeTestCtx,
  seedPeerKey,
} from './testSupport/baseHarness'
import { memStorage } from './testSupport/memStorage'
import { persistVerifiedMap } from './verifiedKeys'
import { VerifiedKeysCache } from './verifiedKeysCache'
import { VERIFICATIONS_NODE } from './verificationSync'
import type { DecryptOutput, KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'

function canonicalBundle(fingerprint = 'AA'.repeat(20)): KeyBundle {
  return { fingerprint, publicArmored: '', keychainBacked: false }
}

/** Storage pre-populated with a persisted verified-key map, in the same
 * on-disk shape `loadVerifiedMap`/`persistVerifiedMap` (Task 1) read/write. */
async function storageWithVerified(map: Record<string, string>): Promise<PluginStorage> {
  const storage = memStorage()
  await persistVerifiedMap(storage, map)
  return storage
}

describe('OpenPGPPluginBase — verified-cache hydration in init()', () => {
  it('hydrates the verified cache before init resolves', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const storage = await storageWithVerified({ 'bob@x': 'ABCD' })
    const ctx = makeTestCtx(ACCOUNT, { storage })

    await base.init(ctx)

    // Synchronous read, no further await — must already see the persisted entry.
    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD')).toBe(true)
  })

  // The legacy-localStorage upgrade seed ("seeds the cache from the legacy
  // store on first run" / "does NOT re-seed when the plugin store already
  // has data", pre-Task-8 versions of this file) moved to
  // `OpenPGPPluginBase.legacySeed.test.ts`, which covers it against real
  // localStorage instead of the (now-deleted) `hostStores.verifiedPeers`
  // mock.

  it('a verified peer reads as verified immediately after init (no cold-cache window)', async () => {
    // Exercises the key-locked early return (~:537), which skips
    // activateSubscriptions() entirely. Hydration must still have happened
    // by the time init() resolves, because trust can be read in this state.
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => {
      throw new E2EEPluginError('transient', 'key-locked', 'locked')
    }
    const storage = await storageWithVerified({ 'bob@x': 'ABCD' })
    const ctx = makeTestCtx(ACCOUNT, { storage })

    await expect(base.init(ctx)).resolves.toBeUndefined()

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD')).toBe(true)
  })
})

function decryptOutput(overrides: Partial<DecryptOutput> = {}): DecryptOutput {
  return {
    plaintext: '',
    signatureVerified: true,
    signerFingerprint: 'ABCD1234',
    signaturePresent: true,
    ...overrides,
  }
}

// Task 4: the trust-read sites (evaluatePeerTrust / buildInboundSecurityContext)
// read `this.verifiedKeys` (the plugin-owned cache), which since Task 8 is
// the ONLY place verified state lives (the legacy `hostStores.verifiedPeers`
// app-side store is gone). These tests drive the base directly via
// `makeTestBase()` (no `init()`), seeding the cache through its own write API.
describe('OpenPGPPluginBase — trust reads come from the plugin-owned cache', () => {
  it('getPeerTrust reports verified from the cache', async () => {
    const { base } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await getVerifiedKeysCache(base).setVerified('bob@x', 'ABCD1234')

    expect(await base.getPeerTrust('bob@x')).toBe('verified')
  })

  it('buildInboundSecurityContext marks the message verified from the cache', async () => {
    const { base } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await getVerifiedKeysCache(base).setVerified('bob@x', 'ABCD1234')

    const context = callBuildInboundSecurityContext(base, 'bob@x', decryptOutput())
    expect(context.trust).toBe('verified')
  })

  it('a fingerprint change still demotes the peer to tofu (fingerprint-binding survives the move)', async () => {
    const { base } = makeTestBase()
    // Cache verified the OLD fingerprint; the peer's cached key has since rotated.
    await getVerifiedKeysCache(base).setVerified('bob@x', 'OLDFP0000')
    seedPeerKey(base, 'bob@x', 'NEWFP9999')

    expect(await base.getPeerTrust('bob@x')).toBe('tofu')
    const context = callBuildInboundSecurityContext(
      base,
      'bob@x',
      decryptOutput({ signerFingerprint: 'NEWFP9999' }),
    )
    expect(context.trust).toBe('tofu')
  })
})

// Task 5 introduced the dual-write (plugin-owned cache + legacy
// `hostStores.verifiedPeers` mirror); Task 8 deleted the mirror leg, so
// `setIdentityTrust` now writes only the cache. `setIdentityTrust` is
// exercised directly here since it needs no XMPP/PEP wiring; the other
// write sites (`acceptPeerKeyChange`, verification-sync apply) are covered
// against a full plugin instance in `SequoiaPgpPlugin.test.ts`, since they
// depend on peer-key fetch / PEP plumbing this harness doesn't stub.
describe('OpenPGPPluginBase — setIdentityTrust writes through the single cache funnel', () => {
  it("setIdentityTrust('verified') writes the cache", async () => {
    const { base } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')

    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD1234')).toBe(true)
  })

  it("setIdentityTrust('untrusted') clears the cache", async () => {
    const { base } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')
    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD1234')).toBe(true)

    await base.setIdentityTrust('bob@x', 'ABCD1234', 'untrusted')

    expect(getVerifiedKeysCache(base).isVerified('bob@x', 'ABCD1234')).toBe(false)
  })

  it('end-to-end: getPeerTrust (which reads ONLY the cache) sees a setIdentityTrust write', async () => {
    // evaluatePeerTrust reads exclusively from `this.verifiedKeys` (see the
    // "trust reads come from the plugin-owned cache" block above) — so this
    // closes the write -> read loop: if `setIdentityTrust` didn't reach the
    // cache, this would still read 'tofu'.
    const { base } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')

    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')

    expect(await base.getPeerTrust('bob@x')).toBe('verified')
  })

  it('persists the write: a fresh VerifiedKeysCache over the same storage sees it', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)
    await base.init(ctx)
    seedPeerKey(base, 'bob@x', 'ABCD1234')

    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')

    const reloaded = new VerifiedKeysCache(ctx.storage)
    await reloaded.hydrate()
    expect(reloaded.isVerified('bob@x', 'ABCD1234')).toBe(true)
  })
})

// Finding 2 (B2-final-review): `makeTestBase()`'s `calls` recorder wraps
// `setVerified`/`clearVerified` on whichever `VerifiedKeysCache` is live.
// Before the fix it only wrapped the PRE-init placeholder cache — `init()`
// silently replaced `verifiedKeys` with an unwrapped instance and `calls`
// stopped recording, which would have made assertions like
// `expect(calls.setVerified).toEqual([])` elsewhere in this suite
// unfalsifiable (they'd pass whether or not the recorder was still live) the
// moment a test combined `calls` with `init()`. This test drives `init()`
// BEFORE writing, so it can only pass if the recorder followed the swap.
describe("OpenPGPPluginBase — makeTestBase()'s calls recorder survives init()", () => {
  it('records a setIdentityTrust write made after init() replaced the cache', async () => {
    const { base, calls } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)
    await base.init(ctx)
    seedPeerKey(base, 'bob@x', 'ABCD1234')

    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')

    expect(calls.setVerified).toEqual([['bob@x', 'ABCD1234']])
  })
})

// Task 2: `getVerifiedKeysView()` exposes a narrow, READ-ONLY handle onto the
// plugin-owned cache — Task 3 (app-side hook) and Task 6 both consume it
// instead of reaching the `protected verifiedKeys` field directly. It must
// reflect every read the cache itself supports (isVerified /
// getVerifiedFingerprint / getSnapshot / subscribe), backed by the SAME
// underlying cache instance, not a copy that can drift.
describe('OpenPGPPluginBase — getVerifiedKeysView()', () => {
  it('isVerified reflects a write made through the cache', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)
    await base.init(ctx)

    const view = base.getVerifiedKeysView()
    expect(view.isVerified('bob@x', 'ABCD1234')).toBe(false)

    await getVerifiedKeysCache(base).setVerified('bob@x', 'ABCD1234')

    expect(view.isVerified('bob@x', 'ABCD1234')).toBe(true)
  })

  it('getVerifiedFingerprint returns null for an unknown peer', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)
    await base.init(ctx)

    const view = base.getVerifiedKeysView()
    expect(view.getVerifiedFingerprint('nobody@x')).toBeNull()
  })

  it('getSnapshot is referentially stable until the next mutation', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)
    await base.init(ctx)

    const view = base.getVerifiedKeysView()
    const before = view.getSnapshot()
    expect(view.getSnapshot()).toBe(before)

    await getVerifiedKeysCache(base).setVerified('bob@x', 'ABCD1234')

    const after = view.getSnapshot()
    expect(after).not.toBe(before)
    expect(after).toEqual({ 'bob@x': 'ABCD1234' })
  })

  it('subscribe fires when the underlying cache changes', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)
    await base.init(ctx)

    const view = base.getVerifiedKeysView()
    let notified = false
    const unsubscribe = view.subscribe(() => {
      notified = true
    })

    await getVerifiedKeysCache(base).setVerified('bob@x', 'ABCD1234')

    expect(notified).toBe(true)
    unsubscribe()
  })

  // Regresses the B2-final-review Finding 1 ordering hazard: prior to the
  // `VerifiedKeysViewIndirection` fix, `getVerifiedKeysView()` returned
  // `this.verifiedKeys` directly, so a view acquired here — BEFORE `init()`
  // installs the real, `ctx.storage`-backed cache — would keep pointing at
  // the discarded pre-init placeholder forever: every read silently reports
  // "not verified" and `subscribe` never fires, with nothing to signal the
  // view has gone stale. Today's actual call ordering (app-side callers
  // always await `register()`/`init()` before calling `getVerifiedKeysView()`)
  // hid this; nothing enforced it.
  it('a view acquired BEFORE init() reflects post-init() state (ordering hazard closed)', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()

    // Acquire the view against the pre-init placeholder cache.
    const view = base.getVerifiedKeysView()
    expect(view.getVerifiedFingerprint('bob@x')).toBeNull()

    let notified = false
    const unsubscribe = view.subscribe(() => {
      notified = true
    })

    const storage = await storageWithVerified({ 'bob@x': 'ABCD' })
    const ctx = makeTestCtx(ACCOUNT, { storage })
    await base.init(ctx)

    // The pre-init view now reads through the real, hydrated cache — not
    // the discarded placeholder.
    expect(view.getVerifiedFingerprint('bob@x')).toBe('ABCD')
    // `hydrate()` notifies once init() swaps in the real cache; the
    // pre-init subscriber, relayed across that swap, must hear it.
    expect(notified).toBe(true)

    // And it keeps working for LATER changes on the post-init cache too,
    // not just the hydrate-time notification.
    notified = false
    await getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')
    expect(notified).toBe(true)

    unsubscribe()
  })
})

// Task 7: `activateSubscriptions()`'s two verification-driven registrations
// (debounced publish + trust-state reseal) move from `hostStores.verifiedPeers`
// (the legacy mirror) onto `this.verifiedKeys.subscribe(...)` (the plugin-owned
// cache). These tests write directly through `getVerifiedKeysCache(base)` —
// bypassing the mirror entirely, same as the "trust reads" block above — so a
// passing test here can ONLY be explained by the cache's subscribe firing,
// never the mirror's.
describe('OpenPGPPluginBase — verified-cache subscriptions drive publish + reseal (Task 7)', () => {
  /** `encryptToRecipient` stubbed to the identity function: publish/seal only
   * need SOME string round-trip in these tests, not real OpenPGP crypto. */
  function makePublishableBase(): ReturnType<typeof makeTestBase> {
    const harness = makeTestBase()
    harness.base.ensureKeyMaterialImpl = async () => canonicalBundle()
    ;(
      harness.base as unknown as {
        encryptToRecipient: (jid: string, key: string, plaintext: string) => Promise<string>
      }
    ).encryptToRecipient = async (_jid, _key, plaintext) => plaintext
    return harness
  }

  /** Flush the fire-and-forget `syncVerificationsFromServer()` kicked off by
   * `activateSubscriptions()` so `_syncingFromRemoteCount` is back to 0
   * before a test's own writes — mirrors the flush in
   * `SequoiaPgpPlugin.test.ts`'s cross-device-sync tests. */
  async function flushInitSync(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  function guardedCount(base: ReturnType<typeof makeTestBase>['base']): {
    increment: () => void
    decrement: () => void
  } {
    const cast = base as unknown as { _syncingFromRemoteCount: number }
    return {
      increment: () => cast._syncingFromRemoteCount++,
      decrement: () => cast._syncingFromRemoteCount--,
    }
  }

  function sealTimeoutPending(base: ReturnType<typeof makeTestBase>['base']): boolean {
    return (
      (base as unknown as { _trustStateSealTimeout: unknown })._trustStateSealTimeout !== null
    )
  }

  /** Typed `publishPEP` spy — explicit params so `.mock.calls` destructures
   * as `[node, item, options?]` instead of collapsing to an untyped `[]`. */
  function makePublishSpy() {
    return vi.fn(
      async (
        _node: string,
        _item: PEPItem,
        _options?: Parameters<XMPPPrimitives['publishPEP']>[2],
      ) => {},
    )
  }

  /** Decode a `publishVerificationsToServer` PEP item back to its JSON
   * payload. `encryptToRecipient` is stubbed to the identity function above,
   * so the "armored" ciphertext IS the plaintext JSON — only the outer
   * base64 (applied by `publishVerificationsToServer` itself) needs undoing. */
  function decodePublishedVerifications(item: PEPItem): { verifications: Record<string, string> } {
    const dataChild = item.payload.children.find(
      (c): c is XMLElementData => typeof c !== 'string' && c.name === 'data',
    )
    const text = dataChild?.children[0]
    if (typeof text !== 'string') throw new Error('no data child in published item')
    const json = decodeURIComponent(escape(atob(text)))
    return JSON.parse(json) as { verifications: Record<string, string> }
  }

  it('a local verify (write through the cache) triggers a debounced publish', async () => {
    vi.useFakeTimers()
    try {
      const { base } = makePublishableBase()
      const ctx = makeTestCtx(ACCOUNT)
      const publishSpy = makePublishSpy()
      ctx.xmpp.publishPEP = publishSpy
      await base.init(ctx)
      await flushInitSync()
      publishSpy.mockClear()

      await getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')
      await vi.advanceTimersByTimeAsync(600)

      const verificationCalls = publishSpy.mock.calls.filter(([node]) => node === VERIFICATIONS_NODE)
      expect(verificationCalls.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a remote-sync apply (guard active) does NOT trigger a publish', async () => {
    vi.useFakeTimers()
    try {
      const { base } = makePublishableBase()
      const ctx = makeTestCtx(ACCOUNT)
      const publishSpy = makePublishSpy()
      ctx.xmpp.publishPEP = publishSpy
      await base.init(ctx)
      await flushInitSync()
      publishSpy.mockClear()

      // Simulate the window `syncVerificationsFromServer` holds open around
      // its own dual-write: increment before the mutation (as it does before
      // its first await), mutate the cache, decrement after (as its `finally`
      // does) — the notification lands synchronously inside that window.
      const guard = guardedCount(base)
      guard.increment()
      await getVerifiedKeysCache(base).setVerified('eve@x', 'EVE_FP')
      guard.decrement()

      await vi.advanceTimersByTimeAsync(600)

      const verificationCalls = publishSpy.mock.calls.filter(([node]) => node === VERIFICATIONS_NODE)
      expect(verificationCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a verified-state change still schedules a trust-state reseal', async () => {
    const { base } = makePublishableBase()
    const ctx = makeTestCtx(ACCOUNT)
    await base.init(ctx)
    await flushInitSync()

    expect(sealTimeoutPending(base)).toBe(false)

    await getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')

    expect(sealTimeoutPending(base)).toBe(true)
  })

  it('the published map reflects state at fire time, not at schedule time', async () => {
    vi.useFakeTimers()
    try {
      const { base } = makePublishableBase()
      const ctx = makeTestCtx(ACCOUNT)
      const publishSpy = makePublishSpy()
      ctx.xmpp.publishPEP = publishSpy
      await base.init(ctx)
      await flushInitSync()
      publishSpy.mockClear()

      // Schedules the debounced publish; under the OLD (schedule-time-capture)
      // behaviour this call's argument would be `{ carol }` only.
      await getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')

      // A guarded mutation lands AFTER scheduling but BEFORE the debounce
      // fires — it does not itself reschedule, but it does change what
      // `verifiedKeys.getAll()` returns.
      const guard = guardedCount(base)
      guard.increment()
      await getVerifiedKeysCache(base).setVerified('dave@x', 'DAVE_FP')
      guard.decrement()

      await vi.advanceTimersByTimeAsync(600)

      const verificationCalls = publishSpy.mock.calls.filter(([node]) => node === VERIFICATIONS_NODE)
      expect(verificationCalls).toHaveLength(1)
      const item = verificationCalls[0][1] as PEPItem
      const decoded = decodePublishedVerifications(item)
      // Fire-time read: both carol AND dave, proving the map wasn't captured
      // at schedule time (which would have missed dave).
      expect(decoded.verifications).toEqual({ 'carol@x': 'CAROL_FP', 'dave@x': 'DAVE_FP' })
    } finally {
      vi.useRealTimers()
    }
  })
})
