// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRecorder,
  install,
  installCount,
  resetInstallForTesting,
  whenReady,
} from './install'
import { METRIC } from './values'

type WindowWithSink = Record<string, unknown> & { __fluuxAnomalies?: string[] }
const w = () => window as unknown as WindowWithSink
const lines = () => w().__fluuxAnomalies ?? []
const records = () => lines().map((l) => JSON.parse(l))

beforeEach(() => {
  localStorage.clear()
  delete w().__fluuxAnomalies
  delete w().__fluuxAnomalyBuild
  resetInstallForTesting()
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

  it('a stale cleanup cannot detach a later attachment', async () => {
    // React can run a previous effect's cleanup after the next effect has already
    // attached. A cleanup that blindly cleared the timer would silently stop the
    // digest schedule for the rest of the session.
    await whenReady()
    const stale = install()
    const live = install() // no-op, already attached
    stale() // the FIRST cleanup, running late

    // Re-attaching must still work, and the live handle must not have been armed
    // by the stale one.
    const cleanup = install()
    expect(installCount()).toBe(2)
    live()
    cleanup()
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

    await expect(whenReady()).resolves.toBeUndefined()

    vi.mocked(crypto.importKey).mockRestore?.()
    warn.mockRestore()
  })
})
