// B3 Task 2: a local verify that lands WHILE `syncVerificationsFromServer`
// is in flight gets suppressed by the `_syncingFromRemoteCount` guard (so it
// doesn't race a possibly-newer remote snapshot) — but nothing used to
// reschedule it, so the write silently never reached the account's other
// devices. `_pendingRepublish` + `_remoteApplyDepth` (see
// `OpenPGPPluginBase.ts`) fix that: a suppressed *local* write is remembered
// and republished once the outermost overlapping sync finishes, while the
// sync's own remote-apply writes are never republished (that would just
// echo the server's data back and reopen the loop the guard exists to
// prevent).
//
// These tests drive the REAL `syncVerificationsFromServer()` path (via
// `init()` and a manually-triggered PEP headline callback), unlike
// `OpenPGPPluginBase.verifiedCache.test.ts`'s Task 7 block, which simulates
// the guard by poking `_syncingFromRemoteCount` directly. That simulation
// can't exercise this fix, because the fix's whole point is distinguishing
// writes that come from `syncVerificationsFromServer`'s own apply loop from
// ones that don't — a distinction that only exists on the real path.
import { describe, it, expect, vi } from 'vitest'
import type { PEPItem, XMLElementData } from '@fluux/sdk'
import { getVerifiedKeysCache, makeTestBase, makeTestCtx } from './testSupport/baseHarness'
import { VERIFICATIONS_NODE } from './verificationSync'
import type { DecryptOutput, KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'
const OWN_FP = 'AA'.repeat(20)

function canonicalBundle(): KeyBundle {
  return { fingerprint: OWN_FP, publicArmored: 'own-pub-key', keychainBacked: false }
}

/** Same base64 helper `verificationSync.ts` uses to encode published items. */
function b64Encode(input: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(input)))
  return Buffer.from(input, 'utf-8').toString('base64')
}

/**
 * Build a `PEPItem` in the exact shape `fetchVerificationsFromServer`
 * expects, carrying a v2 payload. Paired with the identity `encryptFn`/
 * `decryptFn` stubs below, `armored` in the payload IS the plaintext JSON —
 * only the outer base64 needs applying, same trick
 * `OpenPGPPluginBase.verifiedCache.test.ts` uses in reverse.
 */
function verificationsItem(verifications: Record<string, string>, version: number): PEPItem {
  const json = JSON.stringify({ v: 2, ts: Date.now(), version, verifications })
  const payload: XMLElementData = {
    name: 'verifications-data',
    attrs: { xmlns: VERIFICATIONS_NODE },
    children: [{ name: 'data', attrs: {}, children: [b64Encode(json)] }],
  }
  return { id: 'current', payload }
}

/** Resolver pair for pausing `queryPEP` mid-fetch to hold a sync in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Build a base wired for real cross-device sync: identity encrypt/decrypt
 * (no real OpenPGP crypto needed) with a signature that always verifies
 * against our own fingerprint, so `fetchVerificationsFromServer`'s
 * downgrade-protection check passes. */
function makeSyncableBase(): ReturnType<typeof makeTestBase> {
  const harness = makeTestBase()
  harness.base.ensureKeyMaterialImpl = async () => canonicalBundle()
  const cast = harness.base as unknown as {
    encryptToRecipient: (jid: string, key: string, plaintext: string) => Promise<string>
    decryptWithOwnKey: (
      jid: string,
      ciphertext: string,
      senderKey: string | null,
    ) => Promise<DecryptOutput>
  }
  cast.encryptToRecipient = async (_jid, _key, plaintext) => plaintext
  cast.decryptWithOwnKey = async (_jid, ciphertext) => ({
    plaintext: ciphertext,
    signatureVerified: true,
    signerFingerprint: OWN_FP,
    signaturePresent: true,
  })
  return harness
}

async function flushMicrotasks(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function publishedVerificationCalls(
  spy: ReturnType<typeof vi.fn>,
): Array<[string, PEPItem, unknown]> {
  return (spy.mock.calls as Array<[string, PEPItem, unknown]>).filter(
    ([node]) => node === VERIFICATIONS_NODE,
  )
}

describe('OpenPGPPluginBase — local write suppressed during an in-flight sync (B3 Task 2)', () => {
  it('(a) a local verify during an in-flight sync IS published once the sync completes', async () => {
    vi.useFakeTimers()
    try {
      const { base } = makeSyncableBase()
      const ctx = makeTestCtx(ACCOUNT)
      const publishSpy = vi.fn(async () => {})
      ctx.xmpp.publishPEP = publishSpy
      const gate = deferred<PEPItem[]>()
      let queryCalls = 0
      // Only the verifications-node query pauses — `init()`'s own setup
      // (e.g. `checkOwnPublishedKeyConsistency`'s metadata-node query) must
      // resolve normally or `init()` itself would hang.
      ctx.xmpp.queryPEP = async (_jid, node) => {
        if (node !== VERIFICATIONS_NODE) return []
        queryCalls++
        return gate.promise
      }

      await base.init(ctx)
      // init()'s own fire-and-forget syncVerificationsFromServer() runs
      // synchronously up to the queryPEP await, so it's already paused here.
      expect(queryCalls).toBe(1)
      publishSpy.mockClear()

      // A genuine local write lands while that sync is still in flight.
      await getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')

      // No publish should have been scheduled yet — the guard suppressed it.
      await vi.advanceTimersByTimeAsync(600)
      expect(publishedVerificationCalls(publishSpy)).toHaveLength(0)

      // Let the sync finish (no remote snapshot to apply).
      gate.resolve([])
      await flushMicrotasks()

      // The suppressed write must now be scheduled for publish.
      await vi.advanceTimersByTimeAsync(600)
      const calls = publishedVerificationCalls(publishSpy)
      expect(calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('(b) the remote-applied entries themselves are still NOT republished', async () => {
    localStorage.clear()
    vi.useFakeTimers()
    try {
      const { base } = makeSyncableBase()
      const ctx = makeTestCtx(ACCOUNT)
      const publishSpy = vi.fn(async () => {})
      ctx.xmpp.publishPEP = publishSpy
      ctx.xmpp.queryPEP = async (_jid, node) =>
        node === VERIFICATIONS_NODE ? [verificationsItem({ 'dave@x': 'DAVE_FP' }, 1)] : []

      await base.init(ctx)
      await flushMicrotasks()

      // The remote snapshot really was applied.
      expect(getVerifiedKeysCache(base).isVerified('dave@x', 'DAVE_FP')).toBe(true)

      // ...but applying it must not have scheduled (or fired) a publish —
      // that would just echo the server's own data straight back.
      await vi.advanceTimersByTimeAsync(600)
      expect(publishedVerificationCalls(publishSpy)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('(c) a suppression during an inner (overlapping) sync still publishes only after the outermost completes', async () => {
    localStorage.clear()
    vi.useFakeTimers()
    try {
      const { base } = makeSyncableBase()
      const ctx = makeTestCtx(ACCOUNT)
      const publishSpy = vi.fn(async () => {})
      ctx.xmpp.publishPEP = publishSpy

      const cbHolder: { current: ((item: PEPItem) => void) | null } = { current: null }
      ctx.xmpp.subscribePEP = (_jid, node, cb) => {
        if (node === VERIFICATIONS_NODE) cbHolder.current = cb
        return { unsubscribe: () => {} }
      }

      const gateOuter = deferred<PEPItem[]>()
      const gateInner = deferred<PEPItem[]>()
      let queryCalls = 0
      ctx.xmpp.queryPEP = async (_jid, node) => {
        if (node !== VERIFICATIONS_NODE) return []
        queryCalls++
        return queryCalls === 1 ? gateOuter.promise : gateInner.promise
      }

      // Outer sync starts from init(), paused mid-fetch (count === 1).
      await base.init(ctx)
      expect(queryCalls).toBe(1)
      publishSpy.mockClear()
      expect(cbHolder.current).not.toBeNull()

      // A PEP headline fires while the outer sync is still in flight,
      // starting an overlapping inner sync (count === 2), also paused.
      cbHolder.current?.({} as PEPItem)
      await flushMicrotasks()
      expect(queryCalls).toBe(2)

      // A genuine local write lands while BOTH syncs are in flight.
      await getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')

      // The inner sync completes on its own (no remote data) — the counter
      // drops from 2 to 1, NOT to 0, so the suppressed write must not be
      // published yet.
      gateInner.resolve([])
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(600)
      expect(publishedVerificationCalls(publishSpy)).toHaveLength(0)

      // Only once the OUTER (outermost) sync also completes does the
      // suppressed write get published.
      gateOuter.resolve([])
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(600)
      const calls = publishedVerificationCalls(publishSpy)
      expect(calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
