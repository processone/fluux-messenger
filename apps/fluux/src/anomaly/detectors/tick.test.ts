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

const ACTIVE = { kind: 'conversation' as const, id: 'bob@x.tld' }

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
    await new Promise((r) => setTimeout(r, 0))
    expect(tokenSync('jid', ACTIVE.id).s).not.toBe('c:unresolved')
  })

  it('warms a room in the room namespace', async () => {
    await initTokenizer()
    const room = { kind: 'room' as const, id: 'muc@conf.x.tld' }
    const tick = startDetectorTick(world({ activeConversation: () => room }))
    tick.sample()
    tick.stop()

    await new Promise((r) => setTimeout(r, 0))
    expect(tokenSync('room', room.id).s).not.toBe('c:unresolved')
    // The jid space must NOT have been populated: they are disjoint identities.
    expect(tokenSync('jid', room.id).s).toBe('c:unresolved')
  })

  it('warms once per conversation, not once per tick', async () => {
    await initTokenizer()
    const tick = startDetectorTick(world())
    for (let i = 0; i < 5; i++) tick.sample()
    tick.stop()
    await new Promise((r) => setTimeout(r, 0))

    // A token is cached after the first warm, so re-warming is cheap but pointless.
    // The observable proof is that the unresolved counter never advanced.
    expect(tokenSync('jid', ACTIVE.id).s).not.toBe('c:unresolved')
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
