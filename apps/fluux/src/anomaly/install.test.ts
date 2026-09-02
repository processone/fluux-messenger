// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatStore, connectionStore, roomStore } from '@fluux/sdk'
import {
  getRecorder,
  install,
  installCount,
  resetInstallForTesting,
  setSessionRetryDelayForTesting,
  whenReady,
} from './install'
import { CTX, METRIC, resetValuesForTesting } from './values'
import { hasAnomalySignalHandler, signalAnomaly } from '../utils/anomalySignal'
import type { ElementLike } from './detectors/stanzaFacts'
import type { TrafficClient } from './install'
import {
  recordRecountDeferral,
  resetRecountDeferralsForTesting,
} from '../../../../packages/fluux-sdk/src/stores/shared/recountDiagnostics'
import {
  reportArchiveMerge,
  type ArchiveMergeReport,
} from '../../../../packages/fluux-sdk/src/stores/shared/archiveMergeDiagnostics'
import { measured } from '../../../../packages/fluux-sdk/src/utils/measure'

type WindowWithSink = Record<string, unknown> & { __fluuxAnomalies?: string[] }
type ArrivedMessage = { isOutgoing?: boolean }
type RoomSubscriptionState = {
  lastArrivedMessage: Map<string, ArrivedMessage>
  activeRoomJid: string | null
  activationPending?: boolean
}
type ChatSubscriptionState = {
  lastArrivedMessage: Map<string, ArrivedMessage>
  activeConversationId: string | null
  activationPending?: boolean
}
const w = () => window as unknown as WindowWithSink
const lines = () => w().__fluuxAnomalies ?? []
const records = () => lines().map((l) => JSON.parse(l))

class QueuedPerformanceObserver {
  static supportedEntryTypes = ['measure']
  static latest: QueuedPerformanceObserver | null = null

  private records: PerformanceEntry[] = []

  constructor(_callback: PerformanceObserverCallback) {
    QueuedPerformanceObserver.latest = this
  }

  observe(): void {}

  disconnect(): void {}

  takeRecords(): PerformanceEntry[] {
    return this.records.splice(0)
  }

  queue(name: string, duration: number): void {
    this.records.push({ name, duration } as PerformanceEntry)
  }
}

beforeEach(() => {
  QueuedPerformanceObserver.latest = null
  localStorage.clear()
  delete w().__fluuxAnomalies
  delete w().__fluuxAnomalyBuild
  resetInstallForTesting()
  vi.mocked(chatStore.subscribe).mockClear()
  vi.mocked(roomStore.subscribe).mockClear()
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
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    install()()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function))
    expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function))
    remove.mockRestore()
    removeWindow.mockRestore()
  })
})

describe('recount deferrals reach the digest', () => {
  // Issue #1211: the badge staying stale is already reported; these say WHY. Both in
  // one digest is what turns "the badge was wrong" into an attribution.
  beforeEach(() => {
    resetRecountDeferralsForTesting()
  })

  /**
   * Record one deferral.
   *
   * The app's `@fluux/sdk` mock has no real store, so the deferral is recorded
   * directly. That the STORES call this at all is covered where it belongs, in
   * `recountDiagnostics.test.ts` against the real chatStore and roomStore; what this
   * suite owns is the fold from cumulative tallies to per-window deltas.
   */
  function provokeRoomDeferral(): void {
    recordRecountDeferral('room', 'no-meta')
  }

  /**
   * Flush through the visibility handler rather than calling `flushDigest`.
   *
   * The fold lives on the digest TRIGGERS, so a direct recorder call would skip it
   * and the assertions below would be testing nothing.
   */
  function forceDigest(): void {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  }

  it('reports a deferral as a counter delta, not a running total', async () => {
    // The SDK counts for the life of the process while a digest describes one
    // window. Re-reporting the total would make every window after the first
    // over-count, and a quiet window indistinguishable from a busy one.
    install()
    await whenReady()

    provokeRoomDeferral()
    provokeRoomDeferral()
    forceDigest()

    provokeRoomDeferral()
    forceDigest()

    const digests = records().filter((r) => r.kind === 'digest')
    const key = 'recount.deferred.room.no-meta'
    expect(digests[0].counters[key]).toBe(2)
    expect(digests[1].counters[key]).toBe(1)
  })

  it('omits a reason that never fired', async () => {
    // Control: a digest listing every reason at zero would bury the one that matters,
    // and would make the tally useless for attributing a stale badge.
    install()
    await whenReady()
    provokeRoomDeferral()
    forceDigest()

    const digest = records().filter((r) => r.kind === 'digest').pop()
    expect(digest.counters['recount.deferred.room.no-meta']).toBe(1)
    expect(digest.counters['recount.deferred.room.coverage-missing']).toBeUndefined()
    expect(digest.counters['recount.deferred.chat.no-meta']).toBeUndefined()
  })
})

describe('the sentinel fan-out seam', () => {
  it('is inert before install, so a release build records nothing', () => {
    expect(hasAnomalySignalHandler()).toBe(false)
    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })
    expect(lines()).toHaveLength(0)
  })

  it('records a signal once installed and the tokenizer is ready', async () => {
    install()
    await whenReady()

    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })

    const stall = records().find((r) => r.id === 'perf/main-thread-stall')
    expect(stall).toBeDefined()
    expect(stall.observed).toBe(2500)
    expect(stall.expected).toBe(1000)
  })

  it('includes a preceding room arrival in the stall record', async () => {
    const cleanup = install()
    await whenReady()
    const roomJid = 'team@conference.fluux.chat'
    const subscription = vi.mocked(roomStore.subscribe).mock.calls.at(-1)?.[0] as
      | ((next: RoomSubscriptionState, prev: RoomSubscriptionState) => void)
      | undefined
    expect(subscription).toBeDefined()
    subscription!(
      {
        lastArrivedMessage: new Map([[roomJid, { isOutgoing: false }]]),
        activeRoomJid: null,
      },
      { lastArrivedMessage: new Map(), activeRoomJid: null },
    )

    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })
    getRecorder()!.flushDigest(1000)

    const stall = records().find((r) => r.id === 'perf/main-thread-stall')
    const digest = records().filter((r) => r.kind === 'digest').pop()
    expect(stall.crumbs).toContainEqual([
      expect.any(Number),
      'msg:in',
      expect.stringMatching(/^c:/),
    ])
    expect(digest.counters[METRIC.roomMessageArrivals.s]).toBe(1)
    expect(digest.counters[METRIC.messageArrivals.s]).toBeUndefined()
    cleanup()
  })

  it('does not deactivate when room activation clears the previous conversation', async () => {
    const roomBase = roomStore.getState()
    const chatBase = chatStore.getState()
    let activeRoomJid: string | null = null
    let activeConversationId: string | null = 'person@example.com'
    const roomState = vi.spyOn(roomStore, 'getState').mockImplementation(() => ({
      ...roomBase,
      activeRoomJid,
    }))
    const chatState = vi.spyOn(chatStore, 'getState').mockImplementation(() => ({
      ...chatBase,
      activeConversationId,
    }))
    const cleanup = install()
    await whenReady()
    const roomSubscription = vi.mocked(roomStore.subscribe).mock.calls.at(-1)?.[0] as
      | ((next: RoomSubscriptionState, prev: RoomSubscriptionState) => void)
      | undefined
    const chatSubscription = vi.mocked(chatStore.subscribe).mock.calls.at(-1)?.[0] as
      | ((next: ChatSubscriptionState, prev: ChatSubscriptionState) => void)
      | undefined
    expect(roomSubscription).toBeDefined()
    expect(chatSubscription).toBeDefined()

    activeRoomJid = 'team@conference.fluux.chat'
    roomSubscription!(
      { lastArrivedMessage: new Map(), activeRoomJid },
      { lastArrivedMessage: new Map(), activeRoomJid: null },
    )
    activeConversationId = null
    chatSubscription!(
      { lastArrivedMessage: new Map(), activeConversationId },
      { lastArrivedMessage: new Map(), activeConversationId: 'person@example.com' },
    )
    await Promise.resolve()

    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })

    const stall = records().find((r) => r.id === 'perf/main-thread-stall')
    expect(stall.crumbs.filter((crumb: unknown[]) => crumb[1] === 'activate' || crumb[1] === 'deactivate'))
      .toEqual([[expect.any(Number), 'activate', 'c:unresolved']])
    cleanup()
    roomState.mockRestore()
    chatState.mockRestore()
  })

  it('coalesces a clear-first conversation-to-room activation', async () => {
    const roomBase = roomStore.getState()
    const chatBase = chatStore.getState()
    let activeRoomJid: string | null = null
    let activeConversationId: string | null = 'person@example.com'
    let roomActivationPending = false
    const roomState = vi.spyOn(roomStore, 'getState').mockImplementation(() => ({
      ...roomBase,
      activeRoomJid,
      activationPending: roomActivationPending,
    }))
    const chatState = vi.spyOn(chatStore, 'getState').mockImplementation(() => ({
      ...chatBase,
      activeConversationId,
      activationPending: false,
    }))
    const cleanup = install()
    await whenReady()
    const roomSubscription = vi.mocked(roomStore.subscribe).mock.calls.at(-1)?.[0] as
      | ((next: RoomSubscriptionState, prev: RoomSubscriptionState) => void)
      | undefined
    const chatSubscription = vi.mocked(chatStore.subscribe).mock.calls.at(-1)?.[0] as
      | ((next: ChatSubscriptionState, prev: ChatSubscriptionState) => void)
      | undefined
    expect(roomSubscription).toBeDefined()
    expect(chatSubscription).toBeDefined()

    activeConversationId = null
    chatSubscription!(
      { lastArrivedMessage: new Map(), activeConversationId },
      { lastArrivedMessage: new Map(), activeConversationId: 'person@example.com' },
    )
    roomActivationPending = true
    roomSubscription!(
      { lastArrivedMessage: new Map(), activeRoomJid, activationPending: true },
      { lastArrivedMessage: new Map(), activeRoomJid, activationPending: false },
    )
    await Promise.resolve()

    activeRoomJid = 'team@conference.fluux.chat'
    roomActivationPending = false
    roomSubscription!(
      { lastArrivedMessage: new Map(), activeRoomJid, activationPending: false },
      { lastArrivedMessage: new Map(), activeRoomJid: null, activationPending: true },
    )
    await Promise.resolve()

    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })

    const stall = records().find((r) => r.id === 'perf/main-thread-stall')
    expect(stall.crumbs.filter((crumb: unknown[]) => crumb[1] === 'activate' || crumb[1] === 'deactivate'))
      .toEqual([[expect.any(Number), 'activate', 'c:unresolved']])
    cleanup()
    roomState.mockRestore()
    chatState.mockRestore()
  })

  it('deduplicates overlapping visibility and window focus transitions', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const cleanup = install()
    await whenReady()

    window.dispatchEvent(new Event('blur'))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))

    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })

    const stall = records().find((r) => r.id === 'perf/main-thread-stall')
    expect(stall.crumbs.filter((crumb: unknown[]) => crumb[1] === 'focus' || crumb[1] === 'blur'))
      .toEqual([[expect.any(Number), 'blur'], [expect.any(Number), 'focus']])
    cleanup()
    hasFocus.mockRestore()
  })

  it('drains store timings before recording every signal', async () => {
    vi.stubGlobal('PerformanceObserver', QueuedPerformanceObserver)
    const cleanup = install()
    await whenReady()
    QueuedPerformanceObserver.latest!.queue('fluux:persist', 1234)

    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })

    const stall = records().find((r) => r.id === 'perf/main-thread-stall')
    expect(stall.crumbs).toContainEqual([expect.any(Number), 'perf:persist', 1234])
    cleanup()
    vi.unstubAllGlobals()
  })

  it('leaves SDK measurement disabled without an active observer', () => {
    class UnsupportedPerformanceObserver extends QueuedPerformanceObserver {
      static supportedEntryTypes: string[] = []
    }
    vi.stubGlobal('PerformanceObserver', UnsupportedPerformanceObserver)
    performance.clearMeasures()
    const cleanup = install()

    measured('persist', () => 42)

    expect(performance.getEntriesByName('fluux:persist')).toEqual([])
    cleanup()
    vi.unstubAllGlobals()
  })

  it('stops recording once the last hold is released', async () => {
    const cleanup = install()
    await whenReady()
    cleanup()

    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })

    expect(records().filter((r) => r.id === 'perf/main-thread-stall')).toHaveLength(0)
  })

  it('survives a StrictMode cycle with exactly one handler', async () => {
    // The same interleaving the refcount exists for: the first cleanup runs AFTER
    // the second install. A handler cleared unconditionally on cleanup would leave
    // the seam disconnected for the rest of the session — silently, since a
    // missing record looks exactly like a healthy app.
    const cleanup1 = install()
    const cleanup2 = install()
    cleanup1()
    await whenReady()

    expect(hasAnomalySignalHandler()).toBe(true)
    signalAnomaly({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })

    // One record, not two: a second registration would have stacked handlers.
    expect(records().filter((r) => r.id === 'perf/main-thread-stall')).toHaveLength(1)
    cleanup2()
    expect(hasAnomalySignalHandler()).toBe(false)
  })
})

describe('the detector tick', () => {
  it('arms one sampler per attachment and releases it with the last hold', () => {
    // Counted rather than inspected: two intervals sampling would double every
    // verdict, and the per-id cooldown would file the duplicate as a phantom
    // suppression rather than a visible fault.
    vi.useFakeTimers()
    try {
      const baseline = vi.getTimerCount()

      const cleanup1 = install()
      const armed = vi.getTimerCount()
      expect(armed).toBeGreaterThan(baseline)

      // Second hold: the sampler is already running, so nothing new is armed.
      const cleanup2 = install()
      expect(vi.getTimerCount()).toBe(armed)

      // First cleanup runs while the second hold is still live — the interleaving
      // the refcount exists for. The sampler must survive it.
      cleanup1()
      expect(vi.getTimerCount()).toBe(armed)

      cleanup2()
      expect(vi.getTimerCount()).toBe(baseline)
    } finally {
      vi.useRealTimers()
    }
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

describe('traffic detector wiring', () => {
  /** A client that hands back the handlers it was given. */
  function stubClient() {
    const out: Array<(s: ElementLike) => void> = []
    const inbound: Array<(s: ElementLike) => void> = []
    const released: string[] = []
    const client: TrafficClient = {
      onApplicationStanzaOut: (h) => {
        out.push(h)
        return () => released.push('out')
      },
      onStanza: (h) => {
        inbound.push(h)
        return () => released.push('in')
      },
    }
    return { client, out, inbound, released }
  }

  function iq(attrs: Record<string, unknown>, ns?: string): ElementLike {
    const children: ElementLike[] = ns
      ? [{ name: 'query', attrs: { xmlns: ns }, children: [], getChild: () => undefined }]
      : []
    return {
      name: 'iq',
      attrs,
      children,
      getChild: (name: string) => children.find((c) => c.name === name),
    }
  }

  it('records a redundant query seen through the client seams', async () => {
    vi.useFakeTimers()
    try {
      const { client, out, inbound } = stubClient()
      const cleanup = install(client)
      await whenReady()

      const disco = 'http://jabber.org/protocol/disco#info'
      out[0](iq({ type: 'get', to: 'example.com', id: 'q1' }, disco))
      inbound[0](iq({ type: 'result', id: 'q1' }))
      out[0](iq({ type: 'get', to: 'example.com', id: 'q2' }, disco))

      expect(records().map((r) => r.id)).toContain('xmpp-traffic/redundant-query')
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets pending requests when the connection drops', async () => {
    vi.useFakeTimers()
    try {
      const { client, out } = stubClient()
      const cleanup = install(client)
      await whenReady()

      out[0](iq({ type: 'get', to: 'example.com', id: 'q1' }, 'http://jabber.org/protocol/disco#info'))
      // Any connection status change resets: everything in flight when the
      // connection moved is unanswerable through no fault of the app.
      const onConnection = vi.mocked(connectionStore.subscribe).mock.calls.at(-1)?.[0] as
        unknown as (next: { status: string }, prev: { status: string }) => void
      onConnection({ status: 'reconnecting' }, { status: 'online' })
      vi.advanceTimersByTime(60_000)

      expect(records().map((r) => r.id)).not.toContain('xmpp-traffic/iq-unanswered')
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the client subscriptions with the last hold', () => {
    const { client, released } = stubClient()

    install(client)()

    expect(released).toEqual(expect.arrayContaining(['out', 'in']))
  })

  it('installs without a client', () => {
    expect(() => install()()).not.toThrow()
  })
})

describe('archive merge wiring', () => {
  function merge(overrides: Partial<ArchiveMergeReport> = {}): ArchiveMergeReport {
    return {
      entityKind: 'chat',
      entityId: 'alice@example.com',
      direction: 'forward',
      complete: true,
      outcome: 'durable',
      returned: 10,
      retained: 7,
      deduplicated: 3,
      patched: 0,
      intentionallyUnstored: 0,
      persistenceFailed: 0,
      ...overrides,
    }
  }

  it('records a failed archive write reported by a store', async () => {
    const cleanup = install()
    await whenReady()

    reportArchiveMerge(merge({ outcome: 'failed', retained: 0, persistenceFailed: 7 }))

    expect(records().map((r) => r.id)).toContain('xmpp-traffic/mam-write-failed')
    cleanup()
  })

  it('leaves a healthy merge to the counters', async () => {
    const cleanup = install()
    await whenReady()

    reportArchiveMerge(merge())

    expect(records().map((r) => r.id)).not.toContain('xmpp-traffic/mam-write-failed')
    cleanup()
  })

  it('stops observing merges once the last hold is released', async () => {
    const cleanup = install()
    await whenReady()
    cleanup()

    reportArchiveMerge(merge({ outcome: 'failed', retained: 0, persistenceFailed: 7 }))

    expect(records().map((r) => r.id)).not.toContain('xmpp-traffic/mam-write-failed')
  })
})

describe('pointer regression wiring', () => {
  type MetaLike = { readPointer?: { order: { role: 'floor'; timestamp: number } } }

  function pointerMeta(timestamp: number): MetaLike {
    return { readPointer: { order: { role: 'floor', timestamp } } }
  }

  /** Drive the chat store subscription the way the store would. */
  function pushChatMeta(next: Map<string, MetaLike>, prev: Map<string, MetaLike>): void {
    const subscription = vi.mocked(chatStore.subscribe).mock.calls.at(-1)?.[0] as unknown as (
      next: ChatSubscriptionState & { conversationMeta: Map<string, MetaLike> },
      prev: ChatSubscriptionState & { conversationMeta: Map<string, MetaLike> },
    ) => void
    const base = {
      lastArrivedMessage: new Map<string, ArrivedMessage>(),
      activeConversationId: null,
      activationPending: false,
    }
    subscription({ ...base, conversationMeta: next }, { ...base, conversationMeta: prev })
  }

  function pushRoomMeta(next: Map<string, MetaLike>, prev: Map<string, MetaLike>): void {
    const subscription = vi.mocked(roomStore.subscribe).mock.calls.at(-1)?.[0] as unknown as (
      next: RoomSubscriptionState & { roomMeta: Map<string, MetaLike> },
      prev: RoomSubscriptionState & { roomMeta: Map<string, MetaLike> },
    ) => void
    const base = {
      lastArrivedMessage: new Map<string, ArrivedMessage>(),
      activeRoomJid: null,
      activationPending: false,
    }
    subscription({ ...base, roomMeta: next }, { ...base, roomMeta: prev })
  }

  it('records a pointer that moved backwards', async () => {
    const cleanup = install()
    await whenReady()

    const first = new Map([['alice@example.com', pointerMeta(5_000)]])
    const second = new Map([['alice@example.com', pointerMeta(3_000)]])
    pushChatMeta(first, new Map())
    pushChatMeta(second, first)

    expect(records().map((r) => r.id)).toContain('read-state/pointer-regression')
    cleanup()
  })

  it('compares the first update with the pointer present at installation', async () => {
    const base = chatStore.getState()
    const first = new Map([['alice@example.com', pointerMeta(5_000)]])
    const state = vi.spyOn(chatStore, 'getState').mockReturnValue({
      ...base,
      conversationMeta: first,
    } as never)
    const cleanup = install()
    await whenReady()

    const second = new Map([['alice@example.com', pointerMeta(3_000)]])
    pushChatMeta(second, first)

    expect(records().map((r) => r.id)).toContain('read-state/pointer-regression')
    cleanup()
    state.mockRestore()
  })

  it('seeds existing room pointers as well as conversation pointers', async () => {
    const base = roomStore.getState()
    const first = new Map([['team@conference.example.com', pointerMeta(5_000)]])
    const state = vi.spyOn(roomStore, 'getState').mockReturnValue({
      ...base,
      roomMeta: first,
    } as never)
    const cleanup = install()
    await whenReady()

    const second = new Map([['team@conference.example.com', pointerMeta(3_000)]])
    pushRoomMeta(second, first)

    expect(records().map((r) => r.id)).toContain('read-state/pointer-regression')
    cleanup()
    state.mockRestore()
  })

  it('says nothing when the pointer advances', async () => {
    const cleanup = install()
    await whenReady()

    const first = new Map([['alice@example.com', pointerMeta(3_000)]])
    const second = new Map([['alice@example.com', pointerMeta(5_000)]])
    pushChatMeta(first, new Map())
    pushChatMeta(second, first)

    expect(records().map((r) => r.id)).not.toContain('read-state/pointer-regression')
    cleanup()
  })

  it('ignores a store event that did not touch the metadata map', async () => {
    const cleanup = install()
    await whenReady()

    const meta = new Map([['alice@example.com', pointerMeta(5_000)]])
    pushChatMeta(meta, new Map())
    // Same map reference on both sides: the scan must not even look, which is what
    // keeps message traffic from paying for this detector.
    pushChatMeta(meta, meta)

    expect(records().map((r) => r.id)).not.toContain('read-state/pointer-regression')
    cleanup()
  })
})
