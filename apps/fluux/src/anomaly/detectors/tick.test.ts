// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { startDetectorTick, type TickWorld } from './tick'
import {
  clearAnomalySignalHandler,
  setAnomalySignalHandler,
  type AnomalySignal,
} from '../../utils/anomalySignal'
import {
  _resetViewportScrollerRegistryForTesting,
  registerViewportScroller,
} from '../../utils/viewportScroller'
import {
  _resetViewportRegistryForTesting,
  registerViewportBottomRef,
} from '../../utils/viewportAtBottom'
import { initTokenizer, resetValuesForTesting, tokenSync } from '../values'
import { warmConversation, warmRoom } from '../identity'
import { recordForSignal } from './signalRecords'
import {
  clearAnomalyObservationHandler,
  observeAnomaly,
  setAnomalyObservationHandler,
} from '../../utils/anomalyObservation'

const ACTIVE = { kind: 'conversation' as const, id: 'bob@x.tld' }

// The warm is the only thing these suites stub: a rejection is otherwise reachable
// only by breaking WebCrypto itself.
vi.mock('../identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../identity')>()
  return {
    ...actual,
    warmConversation: vi.fn(actual.warmConversation),
    warmRoom: vi.fn(actual.warmRoom),
  }
})

/** A world in the failing state for both timed detectors. */
function world(overrides: Partial<TickWorld> = {}): TickWorld {
  let clock = 0
  return {
    activeConversation: () => ACTIVE,
    unreadCount: () => 3,
    scopeKey: () => 'acct-1',
    focused: () => true,
    fabShown: () => true,
    windowAtLiveEdge: () => true,
    distFromBottom: () => 10,
    viewportMetrics: () => ({
      distFromBottom: 10,
      scrollHeight: 1_000,
      scrollTop: 490,
      clientHeight: 500,
    }),
    now: () => (clock += 1000),
    ...overrides,
  }
}

let seen: AnomalySignal[] = []

beforeEach(() => {
  seen = []
  setAnomalySignalHandler((s) => seen.push(s))
  _resetViewportRegistryForTesting()
  _resetViewportScrollerRegistryForTesting()
  resetValuesForTesting()
  // Both detectors need the viewport at the bottom to fire.
  registerViewportBottomRef('conversation', ACTIVE.id, { current: true })
})

afterEach(() => {
  clearAnomalySignalHandler()
  vi.useRealTimers()
})

describe('detector tick', () => {
  it('emits both timed detectors once their windows elapse', () => {
    const tick = startDetectorTick(world())
    for (let i = 0; i < 5; i++) tick.sample()
    tick.stop()

    expect(seen.map((s) => s.name).sort()).toEqual([
      'read-state/unread-survives-focus',
      'scroll/fab-at-live-edge',
    ])
  })

  it('emits nothing from a healthy world', () => {
    // The control. A driver that signals unconditionally would pass the test above.
    const tick = startDetectorTick(
      world({ unreadCount: () => 0, fabShown: () => false, distFromBottom: () => 900 }),
    )
    for (let i = 0; i < 10; i++) tick.sample()
    tick.stop()

    expect(seen).toEqual([])
  })

  it('reports the measured distance, not the hook at-bottom boolean', () => {
    // The reason fab-at-live-edge exists: it must be able to disagree with the hook.
    // Here the hook says NOT at bottom while the DOM says otherwise — the detector
    // must trust its own measurement.
    registerViewportBottomRef('conversation', ACTIVE.id, { current: false })
    const tick = startDetectorTick(world({ distFromBottom: () => 42 }))
    for (let i = 0; i < 5; i++) tick.sample()
    tick.stop()

    const fab = seen.find((s) => s.name === 'scroll/fab-at-live-edge')
    expect(fab).toBeDefined()
    expect(fab).toMatchObject({ distFromBottom: 42 })
    // ...and unread stayed silent, because THAT one does depend on the viewport ref.
    expect(seen.some((s) => s.name === 'read-state/unread-survives-focus')).toBe(false)
  })

  it('warms the conversation token, so records are correlatable', async () => {
    // Discovered by signalRecords.test.ts: tokenSync cannot hash on demand, so an
    // unwarmed conversation serializes as `c:unresolved` — safe but naming no entity.
    await initTokenizer()
    const tick = startDetectorTick(world())
    tick.sample()
    tick.stop()

    // Warming is async; let the microtask and the HMAC settle.
    await tick.warmSettled()
    expect(tokenSync('jid', ACTIVE.id).s).not.toBe('c:unresolved')
  })

  it('warms a room in the room namespace', async () => {
    await initTokenizer()
    const room = { kind: 'room' as const, id: 'muc@conf.x.tld' }
    const tick = startDetectorTick(world({ activeConversation: () => room }))
    tick.sample()
    tick.stop()

    await tick.warmSettled()
    expect(tokenSync('room', room.id).s).not.toBe('c:unresolved')
    // The jid space must NOT have been populated: they are disjoint identities.
    expect(tokenSync('jid', room.id).s).toBe('c:unresolved')
  })

  it('warms once per conversation, not once per tick', async () => {
    await initTokenizer()
    const tick = startDetectorTick(world())
    for (let i = 0; i < 5; i++) tick.sample()
    tick.stop()
    await tick.warmSettled()

    // A token is cached after the first warm, so re-warming is cheap but pointless.
    // The observable proof is that the unresolved counter never advanced.
    expect(tokenSync('jid', ACTIVE.id).s).not.toBe('c:unresolved')
  })

  it('warms on a later tick when the tokenizer was not ready on the first', async () => {
    // The startup window. `warmToken` is a silent no-op before the HMAC key exists,
    // so a latch taken on that call suppresses every retry and leaves the
    // conversation unwarmed for the whole episode — losing the entity on precisely
    // the first anomaly of the session, the one that says something just started
    // going wrong.
    //
    // A dedicated id, because `warmToken` writes AFTER an await: a warm started by an
    // earlier test can resolve past `resetValuesForTesting()` and repopulate the map,
    // which made this pass in file order while failing in isolation.
    const startup = { kind: 'conversation' as const, id: 'startup-window@x.tld' }
    registerViewportBottomRef('conversation', startup.id, { current: true })
    const tick = startDetectorTick(world({ activeConversation: () => startup }))

    tick.sample() // tokenizer NOT ready: nothing can be warmed
    await tick.warmSettled()
    expect(tokenSync('jid', startup.id).s).toBe('c:unresolved')

    await initTokenizer() // key arrives

    tick.sample()
    await tick.warmSettled()
    tick.stop()

    expect(
      tokenSync('jid', startup.id).s,
      'the conversation was never re-warmed after the tokenizer became ready',
    ).not.toBe('c:unresolved')
  })

  it('names the entity on the first record of an episode that began before readiness', async () => {
    // The consequence the warm exists to prevent, asserted end to end: the record is
    // built at signal time exactly as install.ts builds it.
    const episode = { kind: 'conversation' as const, id: 'first-anomaly@x.tld' }
    registerViewportBottomRef('conversation', episode.id, { current: true })

    const records: (ReturnType<typeof recordForSignal>)[] = []
    setAnomalySignalHandler((s) => {
      seen.push(s)
      records.push(recordForSignal(s))
    })

    const tick = startDetectorTick(world({ activeConversation: () => episode }))

    tick.sample() // t=1000, unready — starts the unread clock
    await tick.warmSettled()
    await initTokenizer()

    tick.sample() // t=2000, held 1000ms
    await tick.warmSettled()
    tick.sample() // t=3000, held 2000ms -> verdict
    await tick.warmSettled()
    tick.stop()

    const unreadRecord = records.find(
      (r) => r?.id.s === 'read-state/unread-survives-focus',
    )
    expect(unreadRecord, 'the unread detector never reported').toBeDefined()

    const convToken = unreadRecord!.ctx!.find(([k]) => k.s === 'conv')![1] as { s: string }
    expect(
      convToken.s,
      'the first record of the episode named no entity — it is uncorrelatable',
    ).not.toBe('c:unresolved')
  })

  it('samples on its interval', () => {
    vi.useFakeTimers()
    const samples: number[] = []
    let clock = 0
    const tick = startDetectorTick(
      world({
        now: () => (clock += 1000),
        activeConversation: () => {
          samples.push(clock)
          return ACTIVE
        },
      }),
      1000,
    )

    vi.advanceTimersByTime(3000)
    tick.stop()
    expect(samples).toHaveLength(3)

    // ...and stops when told to.
    vi.advanceTimersByTime(5000)
    expect(samples).toHaveLength(3)
  })

  it('is inert with no signal handler registered', () => {
    // The release-build shape: nothing listening, so sampling must not throw.
    clearAnomalySignalHandler()
    const tick = startDetectorTick(world())
    expect(() => {
      for (let i = 0; i < 5; i++) tick.sample()
    }).not.toThrow()
    tick.stop()
  })

  it('treats no active conversation as nothing to check', () => {
    const tick = startDetectorTick(world({ activeConversation: () => null }))
    for (let i = 0; i < 5; i++) tick.sample()
    tick.stop()
    expect(seen).toEqual([])
  })

  it('goes quiet while the loaded window has slid up', () => {
    // The FAB then means "jump to latest", which is a real affordance. This fired on
    // every healthy demo session until windowAtLiveEdge joined the sample.
    const tick = startDetectorTick(world({ windowAtLiveEdge: () => false }))
    for (let i = 0; i < 5; i++) tick.sample()
    tick.stop()
    expect(seen.some((s) => s.name === 'scroll/fab-at-live-edge')).toBe(false)
    expect(seen.some((s) => s.name === 'read-state/unread-survives-focus')).toBe(false)
  })

  it('goes quiet when an unmeasurable viewport makes the FAB check blind', () => {
    // measureViewport returns null for an unmounted or untracked list. A verdict
    // from an absence of evidence would be a guess.
    const tick = startDetectorTick(world({ distFromBottom: () => null }))
    for (let i = 0; i < 5; i++) tick.sample()
    tick.stop()
    expect(seen.some((s) => s.name === 'scroll/fab-at-live-edge')).toBe(false)
  })
})

describe('browserWorld readings', () => {
  it('measures the viewport through the scroller registry', async () => {
    const { browserWorld } = await import('./tick')
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
    el.scrollTop = 480
    document.body.appendChild(el)
    registerViewportScroller('conversation', ACTIVE.id, { current: el })

    const w = browserWorld(
      () => ACTIVE,
      () => 0,
      () => 'acct-1',
      () => true,
    )
    expect(w.distFromBottom('conversation', ACTIVE.id)).toBe(20)
  })

  it('treats an inert FAB as withdrawn, not as shown', async () => {
    // The button is ALWAYS in the DOM; its wrapper carries `inert={!fabVisible}`.
    // A presence-only check reads `true` forever, which fired the detector on every
    // healthy session.
    const { browserWorld } = await import('./tick')
    const w = browserWorld(
      () => ACTIVE,
      () => 0,
      () => 'acct-1',
      () => true,
    )
    expect(w.fabShown()).toBe(false)

    const wrapper = document.createElement('div')
    const fab = document.createElement('button')
    fab.setAttribute('data-fab', 'scroll-to-bottom')
    wrapper.appendChild(fab)
    document.body.appendChild(wrapper)

    wrapper.setAttribute('inert', '')
    expect(w.fabShown()).toBe(false)

    wrapper.removeAttribute('inert')
    expect(w.fabShown()).toBe(true)

    wrapper.remove()
    expect(w.fabShown()).toBe(false)
  })

  it('finds a live FAB even when a hidden one comes first in the document', async () => {
    // querySelector would stop at the inert one and report the affordance withdrawn.
    const { browserWorld } = await import('./tick')
    const w = browserWorld(
      () => ACTIVE,
      () => 0,
      () => 'acct-1',
      () => true,
    )
    for (const inert of [true, false]) {
      const wrapper = document.createElement('div')
      if (inert) wrapper.setAttribute('inert', '')
      const fab = document.createElement('button')
      fab.setAttribute('data-fab', 'scroll-to-bottom')
      wrapper.appendChild(fab)
      document.body.appendChild(wrapper)
    }
    expect(w.fabShown()).toBe(true)
  })
})

describe('entity warming that keeps failing', () => {
  // `warmToken` is a no-op before the tokenizer holds its key, and the tick skips the
  // whole block until then — so anything reaching the catch is a genuine crypto
  // failure, not startup. The retry is correct and stays; what was missing is any
  // way to know it is happening. Records keep being written for the conversation,
  // they simply name `c:unresolved` forever and nothing says why.

  const FAILING = { kind: 'conversation' as const, id: 'warm-fails@x.tld' }

  beforeEach(async () => {
    // Restore REAL warming before each case. A `mockRejectedValue` set by one test
    // otherwise leaks into the next, and the control below — the one asserting
    // silence on a healthy session — would then be passing or failing for reasons
    // that have nothing to do with the code under test.
    const actual = await vi.importActual<typeof import('../identity')>('../identity')
    vi.mocked(warmConversation).mockImplementation(actual.warmConversation)
    vi.mocked(warmRoom).mockImplementation(actual.warmRoom)
  })

  /** A tick whose warm always rejects. */
  function failingTick(): ReturnType<typeof startDetectorTick> {
    vi.mocked(warmConversation).mockRejectedValue(new Error('subtle.sign failed'))
    return startDetectorTick(
      world({
        activeConversation: () => FAILING,
        // Healthy on every other axis, so nothing else can report.
        unreadCount: () => 0,
        fabShown: () => false,
      }),
    )
  }

  async function tick(t: ReturnType<typeof startDetectorTick>): Promise<void> {
    t.sample()
    await t.warmSettled()
  }

  it('stays silent below the threshold', async () => {
    // A single hiccup must not cry wolf: crypto failures are likelier to arrive in
    // correlated bursts than as isolated events.
    await initTokenizer()
    const t = failingTick()
    await tick(t)
    await tick(t)
    t.stop()

    expect(seen.filter((s) => s.name === 'recorder/entity-warm-failing')).toEqual([])
  })

  it('reports once the failures are consecutive and sustained', async () => {
    await initTokenizer()
    const t = failingTick()
    await tick(t)
    await tick(t)
    await tick(t)
    t.stop()

    const reports = seen.filter((s) => s.name === 'recorder/entity-warm-failing')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ consecutiveFailures: 3 })
  })

  it('reports once per episode, not once per tick', async () => {
    // Latched. The recorder's per-id cooldown would coalesce repeats anyway, but a
    // coalesced repeat still counts as a suppression, which would read as frequency
    // information this signal does not have.
    await initTokenizer()
    const t = failingTick()
    for (let i = 0; i < 10; i++) await tick(t)
    t.stop()

    expect(seen.filter((s) => s.name === 'recorder/entity-warm-failing')).toHaveLength(1)
  })

  it('reports again after a recovery and a fresh run of failures', async () => {
    // The latch must not be permanent, or a second outage in the same session is
    // invisible.
    await initTokenizer()
    let failing = true
    vi.mocked(warmConversation).mockImplementation(async () => {
      if (failing) throw new Error('subtle.sign failed')
    })
    const t = startDetectorTick(
      world({
        activeConversation: () => (failing ? FAILING : { kind: 'conversation', id: 'ok@x.tld' }),
        unreadCount: () => 0,
        fabShown: () => false,
      }),
    )
    for (let i = 0; i < 3; i++) await tick(t)
    expect(seen.filter((s) => s.name === 'recorder/entity-warm-failing')).toHaveLength(1)

    failing = false
    await tick(t) // succeeds -> resets the run and the latch

    failing = true
    for (let i = 0; i < 3; i++) await tick(t)
    t.stop()

    expect(seen.filter((s) => s.name === 'recorder/entity-warm-failing')).toHaveLength(2)
  })

  it('says nothing at all when warming always succeeds', async () => {
    // THE control. This signal is being added to find out whether the failure ever
    // happens in the field, so its silence has to be trustworthy: a healthy session
    // must produce nothing, or the answer is unreadable.
    await initTokenizer()
    const t = startDetectorTick(world({ unreadCount: () => 0, fabShown: () => false }))
    for (let i = 0; i < 10; i++) await tick(t)
    t.stop()

    expect(seen.filter((s) => s.name === 'recorder/entity-warm-failing')).toEqual([])
  })

  it('stays silent before the tokenizer is ready, however long that takes', async () => {
    // Not a failure: the block is skipped entirely, so no attempt is made and none
    // can fail. Startup must never look like an outage.
    const t = failingTick()
    for (let i = 0; i < 10; i++) await tick(t)
    t.stop()

    expect(seen.filter((s) => s.name === 'recorder/entity-warm-failing')).toEqual([])
  })
})

describe('the sampler reports that the app is alive', () => {
  it('calls onSample once per sample, before any detector runs', () => {
    // The foreground accumulator can only distinguish a suspended hour from an
    // hour of use by being told the app was alive at a given instant — wall clock
    // cannot, because the WebView freezes timers while hidden. Without this call
    // the bound in `createForegroundShare` is unreachable and every resumed
    // window still reads as background.
    const seen: number[] = []
    let clock = 1000
    const tick = startDetectorTick({
      ...world(),
      now: () => clock,
      onSample: (now) => seen.push(now),
    })

    tick.sample()
    clock = 2000
    tick.sample()
    tick.stop()

    expect(seen).toEqual([1000, 2000])
  })
})


/**
 * The wiring, not the verdict.
 *
 * `liveEdgePinShort.test.ts` covers what the detector decides. What is proved here is
 * that a measurement leaving the release-shipped executor actually reaches it: the
 * observation seam, the tick's `observeRaw`, the tick's own sample, and the verdict
 * signal. A control that forced `hasAnomalyObservationHandler()` to `false` passed
 * 1612 tests before this existed — the whole path was unproven.
 */
describe('live-edge pin shortfall, end to end through the seams', () => {
  function seamHarness(distFromBottom: number) {
    let clock = 0
    const tick = startDetectorTick(
      world({ now: () => clock, distFromBottom: () => distFromBottom, fabShown: () => false }),
    )
    setAnomalyObservationHandler((observation) => tick.observeRaw(observation))
    return {
      tick,
      at: (ms: number) => {
        clock = ms
      },
      settleShort: () =>
        observeAnomaly({
          kind: 'live-edge-pin-settled',
          conversationId: ACTIVE.id,
          distFromBottom: 420,
          thresholdPx: 150,
        }),
      shortfalls: () => seen.filter((s) => s.name === 'scroll/live-edge-pin-short'),
      stop: () => {
        clearAnomalyObservationHandler()
        tick.stop()
      },
    }
  }

  it('carries a confirmed shortfall from the executor to a signal', () => {
    const h = seamHarness(420)
    try {
      h.settleShort()

      h.at(500)
      h.tick.sample()
      expect(h.shortfalls()).toEqual([])

      h.at(1200)
      h.tick.sample()
      expect(h.shortfalls()).toEqual([
        { name: 'scroll/live-edge-pin-short', distFromBottom: 420, heldMs: 1200 },
      ])
    } finally {
      h.stop()
    }
  })

  it('stays silent when the viewport came back to the bottom', () => {
    const h = seamHarness(10)
    try {
      h.settleShort()
      h.at(1200)
      h.tick.sample()
      expect(h.shortfalls()).toEqual([])
    } finally {
      h.stop()
    }
  })

  it('produces a record the registry accepts', () => {
    const h = seamHarness(420)
    try {
      h.settleShort()
      h.at(1200)
      h.tick.sample()
      const record = recordForSignal(h.shortfalls()[0])
      expect(record?.id.s).toBe('scroll/live-edge-pin-short')
      expect(record?.observed).toBe(420)
    } finally {
      h.stop()
    }
  })
})

/**
 * The wiring for the other half of the silence.
 *
 * `scrollportShrinkUnreconciled.test.ts` covers what the detector decides. What is proved
 * here is that a shrink measured by the release-shipped resize hook reaches it through
 * the same seam the pin settle uses, and that the two detectors stay independent — the
 * shrink observation must not arm the pin detector, or one id would report the other's
 * failure.
 */
describe('scrollport shrink, end to end through the seams', () => {
  function shrinkHarness(distFromBottom: number, scrollHeight = 1_000) {
    let clock = 0
    const tick = startDetectorTick(
      world({
        now: () => clock,
        distFromBottom: () => distFromBottom,
        viewportMetrics: () => ({
          distFromBottom,
          scrollHeight,
          scrollTop: scrollHeight - distFromBottom - 500,
          clientHeight: 500,
        }),
        fabShown: () => false,
      }),
    )
    setAnomalyObservationHandler((observation) => tick.observeRaw(observation))
    return {
      tick,
      at: (ms: number) => {
        clock = ms
      },
      shrink: (repin: 'ran' | 'refused' | null = 'ran') =>
        observeAnomaly({
          kind: 'scrollport-shrank',
          conversationId: ACTIVE.id,
          shrunkPx: 40,
          distFromBottom: 40,
          scrollHeight: 1_000,
          repin,
          tolerancePx: 4,
        }),
      unreconciled: () =>
        seen.filter((s) => s.name === 'scroll/scrollport-shrink-unreconciled'),
      shortfalls: () => seen.filter((s) => s.name === 'scroll/live-edge-pin-short'),
      stop: () => {
        clearAnomalyObservationHandler()
        tick.stop()
      },
    }
  }

  it('carries a confirmed shortfall from the resize hook to a signal', () => {
    const h = shrinkHarness(40)
    try {
      h.shrink()

      h.at(500)
      h.tick.sample()
      expect(h.unreconciled()).toEqual([])

      h.at(1200)
      h.tick.sample()
      expect(h.unreconciled()).toEqual([
        {
          name: 'scroll/scrollport-shrink-unreconciled',
          distFromBottom: 40,
          shrunkPx: 40,
          repin: 'ran',
          heldMs: 1200,
        },
      ])
    } finally {
      h.stop()
    }
  })

  it('stays silent when the re-pin brought the view back', () => {
    const h = shrinkHarness(0)
    try {
      h.shrink()
      h.at(1200)
      h.tick.sample()
      expect(h.unreconciled()).toEqual([])
    } finally {
      h.stop()
    }
  })

  it('does not arm the pin-short detector', () => {
    const h = shrinkHarness(40)
    try {
      h.shrink()
      h.at(1200)
      h.tick.sample()
      expect(h.shortfalls()).toEqual([])
    } finally {
      h.stop()
    }
  })

  it('produces a record the registry accepts', () => {
    const h = shrinkHarness(40)
    try {
      h.shrink('refused')
      h.at(1200)
      h.tick.sample()
      const record = recordForSignal(h.unreconciled()[0])
      expect(record?.id.s).toBe('scroll/scrollport-shrink-unreconciled')
      expect(record?.observed).toBe(40)
      expect(record?.ctx?.find(([k]) => k.s === 'repin')).toBeDefined()
    } finally {
      h.stop()
    }
  })
})
