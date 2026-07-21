// Review fixes for B3 Task 3 (Findings 2 and 3):
//
// Finding 2 — `publishSettledVerifications` used to guard its post-drain
// resume with `if (!this.ctx) return`, which only catches a `shutdown()`
// that has NOT been followed by a fresh `init()`. If a `shutdown()` →
// `init()` cycle completes entirely while the drain (`getSettled()`) is
// still in flight, `this.ctx` is truthy again by the time the drain
// resolves — but it now points at a DIFFERENT session than the `ctx`
// captured when the publish timer fired, so the old guard let the publish
// go out on `ctx.xmpp` from the torn-down session. The fix compares
// identity (`this.ctx !== ctx`) instead of truthiness.
//
// Finding 3 — a stalled `storage.put` blocks `getSettled()` (and therefore
// every subsequent publish) indefinitely, which is the CORRECT behavior
// under "published implies persisted" but was previously invisible. The fix
// logs via `ctx.logger.debug` when the drain takes longer than
// `SLOW_DRAIN_WARN_MS`.
import { describe, it, expect, vi } from 'vitest'
import type { PluginStorage } from '@fluux/sdk'
import { getVerifiedKeysCache, makeTestBase, makeTestCtx } from './testSupport/baseHarness'
import { VERIFICATIONS_NODE } from './verificationSync'
import type { KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'

function canonicalBundle(): KeyBundle {
  return { fingerprint: 'AA'.repeat(20), publicArmored: 'own-pub-key', keychainBacked: false }
}

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

/** Gated `PluginStorage`: `put` blocks on `gate` until released. */
function gatedStorage(gate: { promise: Promise<void> }): { storage: PluginStorage; putCalls: () => number } {
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
  return { storage, putCalls: () => putCalls }
}

describe('OpenPGPPluginBase — publishSettledVerifications review fixes (B3 Task 3)', () => {
  it('Finding 2: does not publish on a torn-down ctx if shutdown()+init() completes while the drain is in flight', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<void>()
      const { storage, putCalls } = gatedStorage(gate)
      const harness = makeTestBase()
      harness.base.ensureKeyMaterialImpl = async () => canonicalBundle()
      ;(
        harness.base as unknown as {
          encryptToRecipient: (jid: string, key: string, plaintext: string) => Promise<string>
        }
      ).encryptToRecipient = async (_jid, _key, plaintext) => plaintext

      const ctx1 = makeTestCtx(ACCOUNT, { storage })
      const publishSpy1 = vi.fn(async () => {})
      ctx1.xmpp.publishPEP = publishSpy1

      await harness.base.init(ctx1)
      await flushMicrotasks()
      publishSpy1.mockClear()

      // A local write on session 1 — its persist is gated open, and the
      // publish debounce (500ms) is now armed against `ctx1`.
      void getVerifiedKeysCache(harness.base).setVerified('carol@x', 'CAROL_FP')
      await flushMicrotasks()
      expect(putCalls()).toBe(1)

      // Fire the debounce: `publishSettledVerifications` captures `ctx1` and
      // starts awaiting `getSettled()`, which is still blocked on the gated
      // persist.
      await vi.advanceTimersByTimeAsync(600)

      // While that drain is still in flight, the session tears down AND a
      // fresh one is established — `this.ctx` becomes truthy again, but it
      // is now `ctx2`, a different session.
      await harness.base.shutdown()
      const ctx2 = makeTestCtx(ACCOUNT, { storage: (() => {
        const backing = new Map<string, Uint8Array>()
        const s: PluginStorage = {
          get: async (k) => backing.get(k) ?? null,
          put: async (k, v) => void backing.set(k, v),
          delete: async (k) => void backing.delete(k),
          list: async (p) => [...backing.keys()].filter((k) => k.startsWith(p)),
        }
        return s
      })() })
      const publishSpy2 = vi.fn(async (..._args: unknown[]) => {})
      ctx2.xmpp.publishPEP = publishSpy2
      await harness.base.init(ctx2)
      await flushMicrotasks()

      // NOW let the original (ctx1-session) gated persist resolve, so the
      // stale `publishSettledVerifications(ctx1, ...)` call resumes.
      gate.resolve()
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(0)

      // The stale publish must not have gone out on either ctx's `xmpp` —
      // not ctx1 (torn down), and not ctx2 (never asked to publish this
      // version; `init()` doesn't itself trigger a verifications publish
      // for an unrelated write from a prior session).
      expect(publishSpy1).not.toHaveBeenCalled()
      const ctx2VerificationCalls = publishSpy2.mock.calls.filter(([node]) => node === VERIFICATIONS_NODE)
      expect(ctx2VerificationCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Finding 3: logs via ctx.logger.debug when the drain takes unusually long', async () => {
    vi.useFakeTimers()
    try {
      const gate = deferred<void>()
      const { storage } = gatedStorage(gate)
      const harness = makeTestBase()
      harness.base.ensureKeyMaterialImpl = async () => canonicalBundle()
      ;(
        harness.base as unknown as {
          encryptToRecipient: (jid: string, key: string, plaintext: string) => Promise<string>
        }
      ).encryptToRecipient = async (_jid, _key, plaintext) => plaintext

      const ctx = makeTestCtx(ACCOUNT, { storage })
      const debugSpy = vi.fn()
      ctx.logger.debug = debugSpy
      ctx.xmpp.publishPEP = vi.fn(async () => {})

      await harness.base.init(ctx)
      await flushMicrotasks()
      debugSpy.mockClear()

      void getVerifiedKeysCache(harness.base).setVerified('carol@x', 'CAROL_FP')
      await flushMicrotasks()

      // Fire the debounce; `publishSettledVerifications` starts draining.
      await vi.advanceTimersByTimeAsync(600)

      // Advance `this.now()` (real `Date.now()`, faked here too by
      // `vi.useFakeTimers()`) well past the slow-drain threshold before
      // releasing the gate.
      await vi.advanceTimersByTimeAsync(3000)
      gate.resolve()
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(0)

      expect(debugSpy).toHaveBeenCalled()
      const messages = debugSpy.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => /verified-keys write queue took/.test(m))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
