// B3 Task 3: the debounced cross-device publish (Task 7,
// `scheduleVerificationsPublish`) is scheduled from `verifiedKeys.subscribe`,
// whose notification fires on the cache's OPTIMISTIC in-memory mutation —
// before write-behind persistence resolves (see `VerifiedKeysCache`'s class
// doc). If persistence takes longer than the 500ms publish debounce, the
// old fire-time read (`this.verifiedKeys.getAll()`, unguarded) would publish
// an entry this device had not yet durably saved to its own disk. A failed
// persist's rollback notification would eventually correct this (it
// reschedules another publish), but only after briefly handing another
// device state this device could not itself reproduce after a restart.
//
// The fix has the publish path await `VerifiedKeysCache.whenIdle()` — a
// promise that resolves once the cache's write queue has drained — before
// reading `getAll()`, so a publish only ever reflects state that has
// actually settled (persisted, or rolled back). This restores the pre-B2
// Task 7 invariant: published implies persisted.
import { describe, it, expect, vi } from 'vitest'
import type { PEPItem, PluginStorage, XMLElementData } from '@fluux/sdk'
import { getVerifiedKeysCache, makeTestBase, makeTestCtx } from './testSupport/baseHarness'
import { VERIFICATIONS_NODE } from './verificationSync'
import type { KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'

function canonicalBundle(): KeyBundle {
  return { fingerprint: 'AA'.repeat(20), publicArmored: 'own-pub-key', keychainBacked: false }
}

/** Resolver pair for pausing a gated `storage.put` mid-persist. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flushMicrotasks(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Decode a `publishVerificationsToServer` PEP item back to its verified
 * map. Valid only because `encryptToRecipient` is stubbed to the identity
 * function below, so the "ciphertext" IS the plaintext JSON. */
function decodePublishedVerifications(item: PEPItem): Record<string, string> {
  const dataChild = item.payload.children.find(
    (c): c is XMLElementData => typeof c !== 'string' && c.name === 'data',
  )
  const text = dataChild?.children[0]
  if (typeof text !== 'string') throw new Error('decodePublishedVerifications: no data child')
  const json = decodeURIComponent(escape(atob(text)))
  return (JSON.parse(json) as { verifications: Record<string, string> }).verifications
}

/** Build a base wired for the publish path: identity `encryptToRecipient`
 * (no real OpenPGP crypto needed) and a gated `PluginStorage` whose `put`
 * blocks on `gate` until the test releases it. */
function makeGatedBase(gate: { promise: Promise<void> }): {
  base: ReturnType<typeof makeTestBase>['base']
  storage: PluginStorage
  putCalls: () => number
} {
  const harness = makeTestBase()
  harness.base.ensureKeyMaterialImpl = async () => canonicalBundle()
  ;(
    harness.base as unknown as {
      encryptToRecipient: (jid: string, key: string, plaintext: string) => Promise<string>
    }
  ).encryptToRecipient = async (_jid, _key, plaintext) => plaintext

  const backing = new Map<string, Uint8Array>()
  let putCalls = 0
  const storage: PluginStorage = {
    get: async (k) => backing.get(k) ?? null,
    put: async (k, v) => {
      putCalls++
      await gate.promise
      backing.set(k, v)
    },
    delete: async (k) => void backing.delete(k),
    list: async (p) => [...backing.keys()].filter((k) => k.startsWith(p)),
  }
  return { base: harness.base, storage, putCalls: () => putCalls }
}

function publishedVerificationCalls(spy: ReturnType<typeof vi.fn>): Array<[string, PEPItem, unknown]> {
  return (spy.mock.calls as Array<[string, PEPItem, unknown]>).filter(([node]) => node === VERIFICATIONS_NODE)
}

describe('OpenPGPPluginBase — debounced publish awaits persistence (B3 Task 3)', () => {
  it('does not publish an entry until its persist settles, even once the 500ms debounce has fired', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<void>()
      const { base, storage, putCalls } = makeGatedBase(gate)
      const ctx = makeTestCtx(ACCOUNT, { storage })
      const publishSpy = vi.fn(async () => {})
      ctx.xmpp.publishPEP = publishSpy

      await base.init(ctx)
      await flushMicrotasks()
      publishSpy.mockClear()

      // A local write: the in-memory mutation and the publish debounce
      // schedule happen synchronously, but its persist (`storage.put`) is
      // gated open — it will not resolve until the test releases it.
      void getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')
      await flushMicrotasks()
      expect(putCalls()).toBe(1)

      // Advance well past the 500ms publish debounce. Persistence is still
      // gated (has not resolved), so no publish must have gone out — a
      // publish here would carry a never-(yet-)persisted entry.
      await vi.advanceTimersByTimeAsync(600)
      expect(publishedVerificationCalls(publishSpy)).toHaveLength(0)

      // Let persistence complete.
      gate.resolve()
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(0)

      // NOW the publish goes out, carrying the (now-persisted) entry.
      const calls = publishedVerificationCalls(publishSpy)
      expect(calls).toHaveLength(1)
      expect(decodePublishedVerifications(calls[0][1])).toEqual({ 'carol@x': 'CAROL_FP' })
    } finally {
      vi.useRealTimers()
    }
  })
})
