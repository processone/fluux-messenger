// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRecorder,
  install,
  installCount,
  resetInstallForTesting,
  setSessionRetryDelayForTesting,
  whenReady,
} from './install'
import { CTX, METRIC, resetValuesForTesting } from './values'

type WindowWithSink = Record<string, unknown> & { __fluuxAnomalies?: string[] }
const w = () => window as unknown as WindowWithSink
const lines = () => w().__fluuxAnomalies ?? []
const records = () => lines().map((l) => JSON.parse(l))

beforeEach(() => {
  localStorage.clear()
  delete w().__fluuxAnomalies
  delete w().__fluuxAnomalyBuild
  resetInstallForTesting()
  // Also reset the value layer: the tokenizer key lives there, so without this a
  // test that awaits readiness leaves the NEXT test already ready, and any
  // assertion about the pre-ready window silently stops testing anything.
  resetValuesForTesting()
})

describe('the runtime is a singleton', () => {
  it('installs and exposes a recorder', () => {
    const cleanup = install()
    expect(getRecorder()).not.toBeNull()
    cleanup()
  })

  it('keeps the runtime alive after cleanup, detaching only subscriptions', () => {
    const cleanup = install()
    const before = getRecorder()
    cleanup()
    // Deliberately NOT null: destroying it is what would reset the bounds.
    expect(getRecorder()).toBe(before)
  })

  it('preserves recorder STATE across a StrictMode cycle, not just the session id', async () => {
    // A stable session id proves only that the id lives at module scope. If cleanup
    // destroyed the recorder, counters, cooldowns and the ring would silently reset
    // on remount — so assert continuity of something the runtime actually holds.
    await whenReady()
    const cleanup1 = install()
    getRecorder()!.count(METRIC.probe, 7)
    cleanup1()

    const cleanup2 = install()
    getRecorder()!.count(METRIC.probe, 5)
    getRecorder()!.flushDigest(1000)
    cleanup2()

    const digest = records().filter((r) => r.kind === 'digest').pop()
    expect(digest.counters['probe.metric']).toBe(12)
  })

  it('keeps one session id across the cycle', () => {
    const cleanup1 = install()
    const first = getRecorder()!.sessionId()
    cleanup1()
    const cleanup2 = install()
    expect(getRecorder()!.sessionId()).toBe(first)
    cleanup2()
  })
})

describe('attach and detach', () => {
  it('is idempotent — a second install without cleanup does not re-attach', () => {
    const cleanup1 = install()
    const cleanup2 = install()
    // Read the module-level counter, NOT a method on the recorder: a recorder
    // method would be created by the first install and could only ever report its
    // own existence, making the assertion unfalsifiable.
    expect(installCount()).toBe(1)
    cleanup1()
    cleanup2()
  })

  it('control: two installs SEPARATED by cleanup do attach twice', () => {
    // Proves the assertion above can fail. Without this, `installCount() === 1`
    // would also pass against an implementation that never incremented at all.
    const cleanup1 = install()
    cleanup1()
    const cleanup2 = install()
    expect(installCount()).toBe(2)
    cleanup2()
  })

  it('a stale cleanup cannot detach an attachment another holder still needs', async () => {
    // React can run a previous effect's cleanup after the next effect has already
    // mounted. Asserting that a LATER install still works would only prove the
    // runtime can restart; the property that matters is that the listener never
    // came off while a holder remained, so count the listener directly.
    await whenReady()
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')

    const cleanupA = install()
    const cleanupB = install()
    cleanupA() // A's cleanup, running late

    const attached = add.mock.calls.filter((c) => c[0] === 'visibilitychange').length
    const detached = remove.mock.calls.filter((c) => c[0] === 'visibilitychange').length
    expect(attached - detached).toBe(1)

    cleanupB()
    expect(
      remove.mock.calls.filter((c) => c[0] === 'visibilitychange').length,
    ).toBe(detached + 1)

    add.mockRestore()
    remove.mockRestore()
  })

  it('tolerates a double cleanup', () => {
    const cleanup = install()
    cleanup()
    expect(() => cleanup()).not.toThrow()
  })

  it('removes its visibility listener on cleanup', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    install()()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    remove.mockRestore()
  })
})

describe('the session record', () => {
  it('announces the session exactly once across a StrictMode cycle', async () => {
    // The emission belongs to the runtime, not to an attachment. If each install()
    // attached its own callback, the cooldown would hide the second RECORD but
    // still count a phantom suppressed entry.
    const cleanup1 = install()
    cleanup1()
    const cleanup2 = install()
    await whenReady()
    await Promise.resolve()

    getRecorder()!.flushDigest(1000)
    cleanup2()

    expect(records().filter((r) => r.id === 'recorder/session-start')).toHaveLength(1)
    const digest = records().filter((r) => r.kind === 'digest').pop()
    expect(digest.suppressed['recorder/session-start']).toBeUndefined()
  })

  it('does not write a record before the tokenizer holds its key', async () => {
    install()
    await whenReady()
    await Promise.resolve()

    const start = records().find((r) => r.id === 'recorder/session-start')
    expect(start).toBeDefined()
    // tokenKeyId is the correlation boundary; "unknown" makes the record
    // unattributable to a token space.
    expect(start.tokenKeyId).not.toBe('unknown')
    expect(start.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
  })

  it('publishes the build sentinel so CI can observe the gate', () => {
    install()()
    expect(w().__fluuxAnomalyBuild).toBe('fluux-anomaly-instrumentation-present')
  })
})

describe('readiness', () => {
  it('returns the same promise on repeated calls', () => {
    expect(whenReady()).toBe(whenReady())
  })

  it('does not wedge the runtime when the tokenizer fails', async () => {
    // A rejected promise cached forever would make every later awaiter throw, and
    // the session record would never be attempted again.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const crypto = globalThis.crypto.subtle
    vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValue(new Error('no crypto'))

    await expect(whenReady()).resolves.toBe(false)

    vi.mocked(crypto.importKey).mockRestore?.()
    warn.mockRestore()
  })

  it('retries after a failure rather than caching it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')
    importKey.mockRejectedValueOnce(new Error('transient'))

    expect(await whenReady()).toBe(false)
    // A cached rejection would keep answering false forever.
    expect(await whenReady()).toBe(true)

    importKey.mockRestore()
    warn.mockRestore()
  })

  it('retries the session record itself when both mounts share a failing promise', async () => {
    // The real StrictMode shape: BOTH mounts happen before the promise settles, so
    // the second finds the announcement claimed and registers no callback. When the
    // shared promise then fails there is no third mount to notice, and nothing else
    // calls back into the announcement — so the runtime has to retry on its own.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')
    importKey.mockRejectedValueOnce(new Error('transient'))
    setSessionRetryDelayForTesting(1)

    const cleanupA = install()
    cleanupA()
    const cleanupB = install()

    await vi.waitFor(() => {
      expect(records().filter((r) => r.id === 'recorder/session-start')).toHaveLength(1)
    })

    cleanupB()
    importKey.mockRestore()
    warn.mockRestore()
  })

  it('gives up after a bounded number of attempts rather than retrying forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')
    importKey.mockRejectedValue(new Error('permanent'))
    setSessionRetryDelayForTesting(1)

    install()()
    await vi.waitFor(() => {
      expect(warn.mock.calls.some((c) => String(c[0]).includes('abandoned'))).toBe(true)
    })
    expect(records()).toHaveLength(0)

    importKey.mockRestore()
    warn.mockRestore()
  })

  it('files an invalid pre-ready payload as a rejection, not as merely early', async () => {
    // Otherwise a detector bug arriving during startup is indistinguishable from a
    // well-formed record that was simply too early.
    install()
    getRecorder()!.record({
      id: CTX.conv as never,
      sev: 'bug',
      ctx: [[CTX.conv, 'raw' as never]],
    })

    await whenReady()
    getRecorder()!.flushDigest(1000)

    const digest = records().filter((r) => r.kind === 'digest').pop()
    expect(digest.counters['recorder/rejected-value']).toBe(1)
    expect(digest.counters['recorder/dropped-not-ready']).toBe(0)
  })

  it('drops records written before the tokenizer is ready, and counts them', async () => {
    install()
    // No await: the tokenizer is still resolving.
    getRecorder()!.flushDigest(1000)
    expect(records().filter((r) => r.kind === 'digest')).toHaveLength(0)

    await whenReady()
    getRecorder()!.flushDigest(1000)
    const digest = records().filter((r) => r.kind === 'digest').pop()
    expect(digest.counters['recorder/dropped-not-ready']).toBeGreaterThan(0)
  })
})
