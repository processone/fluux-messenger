// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  _resetViewportScrollerRegistryForTesting,
  measureViewport,
  registerViewportScroller,
} from './viewportScroller'
import { measureElementViewport, type ViewportMetrics } from './viewportMetrics'

/** A scroller with settable metrics — jsdom gives every element zeros otherwise. */
function makeScroller(metrics: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true })
  el.scrollTop = metrics.scrollTop
  document.body.appendChild(el)
  return el
}

/** A list handle whose viewport is that element — what MessageList's handle does. */
function handleOf(el: HTMLElement | null): { measureViewport(): ViewportMetrics | null } {
  return { measureViewport: () => measureElementViewport(el) }
}

beforeEach(() => {
  _resetViewportScrollerRegistryForTesting()
  document.body.innerHTML = ''
})

describe('viewportScroller', () => {
  it('measures a registered viewport', () => {
    const el = makeScroller({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 })
    registerViewportScroller('conversation', 'a@x.tld', { current: handleOf(el) })

    expect(measureViewport('conversation', 'a@x.tld')).toEqual({
      distFromBottom: 100,
      scrollHeight: 1000,
      scrollTop: 400,
      clientHeight: 500,
    })
  })

  it('returns null for an unknown id rather than inventing a measurement', () => {
    // The same rule viewportAtBottom follows: a position must never be fabricated
    // for a view we cannot see. Zeros would read as "pinned to the bottom".
    expect(measureViewport('conversation', 'nobody@x.tld')).toBeNull()
  })

  it('returns null when the ref is registered but still empty', () => {
    // The registering effect runs before the list has mounted in some orders.
    registerViewportScroller('conversation', 'a@x.tld', { current: null })
    expect(measureViewport('conversation', 'a@x.tld')).toBeNull()
  })

  it('returns null for a detached element instead of reporting zeros', () => {
    // A detached element reports 0 for every metric, which computes to
    // distFromBottom 0 — a confident "at the bottom" for a view that is gone.
    const el = makeScroller({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 })
    registerViewportScroller('conversation', 'a@x.tld', { current: handleOf(el) })
    el.remove()

    expect(measureViewport('conversation', 'a@x.tld')).toBeNull()
  })

  it('keeps conversation and room namespaces separate', () => {
    // The same bare JID can name a contact on one server and a MUC on another.
    const conv = makeScroller({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
    const room = makeScroller({ scrollHeight: 2000, scrollTop: 0, clientHeight: 500 })
    registerViewportScroller('conversation', 'same@x.tld', { current: handleOf(conv) })
    registerViewportScroller('room', 'same@x.tld', { current: handleOf(room) })

    expect(measureViewport('conversation', 'same@x.tld')?.distFromBottom).toBe(0)
    expect(measureViewport('room', 'same@x.tld')?.distFromBottom).toBe(1500)
  })

  it('reads through the ref, so a late-attached element is still measurable', () => {
    // Why the ref object is registered rather than the handle: the list can mount
    // after the view's effect has already run.
    const ref: { current: ReturnType<typeof handleOf> | null } = { current: null }
    registerViewportScroller('conversation', 'a@x.tld', ref)
    expect(measureViewport('conversation', 'a@x.tld')).toBeNull()

    ref.current = handleOf(makeScroller({ scrollHeight: 800, scrollTop: 100, clientHeight: 400 }))
    expect(measureViewport('conversation', 'a@x.tld')?.distFromBottom).toBe(300)
  })

  it('replaces the registration on remount', () => {
    const first = makeScroller({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 })
    const second = makeScroller({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
    registerViewportScroller('conversation', 'a@x.tld', { current: handleOf(first) })
    registerViewportScroller('conversation', 'a@x.tld', { current: handleOf(second) })

    expect(measureViewport('conversation', 'a@x.tld')?.scrollTop).toBe(500)
  })

  it('a stale unregister cannot drop the live registration', () => {
    // React can run a previous effect's cleanup after the next effect has mounted.
    // The same hazard viewportAtBottom guards, and the same guard.
    const first = makeScroller({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 })
    const second = makeScroller({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })
    const unregisterFirst = registerViewportScroller('conversation', 'a@x.tld', { current: handleOf(first) })
    registerViewportScroller('conversation', 'a@x.tld', { current: handleOf(second) })

    unregisterFirst()

    expect(measureViewport('conversation', 'a@x.tld')?.scrollTop).toBe(500)
  })

  it('unregisters its own slot', () => {
    const el = makeScroller({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 })
    const unregister = registerViewportScroller('conversation', 'a@x.tld', { current: handleOf(el) })
    unregister()
    expect(measureViewport('conversation', 'a@x.tld')).toBeNull()
  })
})
