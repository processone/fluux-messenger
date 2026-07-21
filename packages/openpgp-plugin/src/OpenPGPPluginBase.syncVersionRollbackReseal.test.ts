// B3 final-review Finding 2: `SyncVersionCache.set()` updates its in-memory
// value SYNCHRONOUSLY, before its write-behind persist even starts (see
// `syncVersionCache.ts`'s class doc's "Persistence failure semantics"
// section). If a trust-state seal reads that not-yet-persisted value via
// `buildCanonicalSnapshot` (also synchronous) during that window, and the
// persist then rejects, the ROLLBACK restores memory to the durable value —
// but the seal has already captured the un-persisted one. Disk stays at the
// old value, the seal now sits AHEAD of disk, and the next
// `verifyTrustStateSeal()` call (the next launch) reports a false "trust
// state compromised" verdict, manufactured by our own rollback logic rather
// than real tampering.
//
// `SyncVersionCache`'s `onRollback` hook — wired by `OpenPGPPluginBase.init()`
// to `scheduleTrustStateSeal()` — exists so a failed persist triggers a
// FRESH reseal against the rolled-back (durable) value, converging the seal
// back onto disk. This is a DIFFERENT bug from B3 final-review Finding 1 (see
// `OpenPGPPluginBase.republishSuppressedDuringSync.test.ts`'s case (e)):
// Finding 1's fix reseals right after the version SAVE, but that reseal's
// own snapshot read can itself land inside this exact persist-in-flight
// window — it does not, and cannot, cover this failure mode.
import { describe, it, expect, vi } from 'vitest'
import type { PluginStorage } from '@fluux/sdk'
import {
  getHostStores,
  getSyncVersionCache,
  getVerifiedKeysCache,
  makeTestBase,
  makeTestCtx,
} from './testSupport/baseHarness'
import { SYNC_VERSION_STORAGE_KEY, loadSyncVersion } from './syncVersionCache'
import { verifyTrustStateSeal } from './trustStateIntegrity'
import type { DecryptOutput, KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'
const OWN_FP = 'BB'.repeat(20)

function canonicalBundle(): KeyBundle {
  return { fingerprint: OWN_FP, publicArmored: 'own-pub-key', keychainBacked: false }
}

/** Resolver pair for pausing (then failing) a gated `storage.put`. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flushMicrotasks(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('OpenPGPPluginBase — SyncVersionCache rollback reseals (B3 final-review Finding 2)', () => {
  it('a persist failure on the version save still leaves the trust-state seal in sync with the (unwritten) persisted version', async () => {
    localStorage.clear()
    vi.useFakeTimers()
    try {
      const { base } = makeTestBase()
      base.ensureKeyMaterialImpl = async () => canonicalBundle()
      // Identity encrypt/decrypt — no real OpenPGP crypto needed, mirrors
      // `OpenPGPPluginBase.republishSuppressedDuringSync.test.ts`'s
      // `makeSyncableBase()` helper.
      const cast = base as unknown as {
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

      // The sync-version key's `put` hangs on a gate the FIRST time it's
      // called (the reservation this test drives), then REJECTS once
      // released — every other storage key persists normally.
      const backing = new Map<string, Uint8Array>()
      const gate = deferred<void>()
      let versionPutCalls = 0
      const storage: PluginStorage = {
        get: async (k) => backing.get(k) ?? null,
        put: async (k, v) => {
          if (k === SYNC_VERSION_STORAGE_KEY) {
            versionPutCalls++
            if (versionPutCalls === 1) {
              await gate.promise
              throw new Error('disk full')
            }
          }
          backing.set(k, v)
        },
        delete: async (k) => void backing.delete(k),
        list: async (p) => [...backing.keys()].filter((k) => k.startsWith(p)),
      }

      const ctx = makeTestCtx(ACCOUNT, { storage })
      const hostStores = getHostStores(base)

      await base.init(ctx)
      // init()'s own fire-and-forget syncVerificationsFromServer() (empty
      // queryPEP result) must settle before the local write below.
      await flushMicrotasks()

      // A genuine local verify schedules a publish; its timer body reserves
      // version 1 and calls `saveAppliedVerificationsVersion(1)`, which
      // updates `SyncVersionCache`'s in-memory value to 1 SYNCHRONOUSLY and
      // (Finding 1's fix) immediately arms a trust-state seal timer too —
      // but the version's own persist is now gated, hanging mid-flight.
      await getVerifiedKeysCache(base).setVerified('carol@x', 'CAROL_FP')
      await vi.advanceTimersByTimeAsync(600)
      expect(versionPutCalls).toBe(1)
      expect(getSyncVersionCache(base).get()).toBe(1)

      // Fire the seal timer Finding 1's fix armed, WHILE the version persist
      // is still hanging: this seal captures the not-yet-durable value 1 —
      // exactly the "seal ahead of disk" precursor Finding 2 describes.
      await vi.advanceTimersByTimeAsync(600)
      await flushMicrotasks()
      expect(hostStores.trustStateStatus.get()).toBe('sealed')

      // Now let the version's persist actually fail. `SyncVersionCache.set()`
      // rolls the in-memory value back to -1 and (with the fix) fires
      // `onRollback`, which schedules a FRESH reseal against that rolled-
      // back value.
      gate.resolve()
      await flushMicrotasks()
      expect(getSyncVersionCache(base).get()).toBe(-1)

      // Fire the rollback-triggered seal timer.
      await vi.advanceTimersByTimeAsync(600)
      await flushMicrotasks()

      // Disk was never actually written (the only `put` for this key
      // rejected), so the durable version is still -1 — reconfirm via a raw
      // read, independent of the in-memory cache.
      expect(await loadSyncVersion(storage)).toBe(-1)

      // The real assertion: an independent "next launch" verification must
      // see the LATEST seal matching the (unwritten) persisted version, not
      // the abandoned value 1 an earlier seal captured mid-flight.
      const decryptFn = async (ciphertext: string) => ({
        plaintext: ciphertext,
        signatureVerified: true,
        signerFingerprint: OWN_FP,
        signaturePresent: true,
      })
      const verdict = await verifyTrustStateSeal(
        decryptFn,
        'own-pub-key',
        OWN_FP,
        hostStores,
        getVerifiedKeysCache(base).getAll(),
        ctx.storage,
      )
      expect(verdict).toEqual({ status: 'sealed' })
    } finally {
      vi.useRealTimers()
    }
  })
})
