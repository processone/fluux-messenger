import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'

// Intent: the captain's report of jerky scrolling on mobile (FLM-174, FLM-180). On an iPhone
// (iOS 27.0.1) the older-history restore ran while the list was still in a drag-and-bounce tail.
// @tanstack/virtual-core 3.19.5+ queues a programmatic write during that tail and lands it ~100 ms
// later, so the list painted the new top rows and every row the reader was looking at left the
// screen (three device traces, 0 of 1, 9 and 8 rows kept). The restore owns the pixels once the
// batch lands, so it asks for the write to release the gesture tail. This drives the real library.

beforeEach(() => {
  vi.stubGlobal('CSS', { supports: () => true })
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
    configurable: true,
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.replaceChildren() })

function bouncingList() {
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: 600 }, offsetWidth: { value: 800 },
    clientHeight: { value: 600 }, scrollHeight: { value: 60000 },
  })
  scroller.scrollTo = options => { scroller.scrollTop = (options as ScrollToOptions).top ?? 0 }
  const items = Array.from({ length: 1000 }, (_, index) => ({ key: `row-${index}` }))
  const hook = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById: new Map(items.map((item, index) => [item.key, index])),
    scrollRef: { current: scroller }, estimateSize: 60,
  }))
  // A finger drags the list, lifts, and the momentum keeps firing scroll events.
  scroller.dispatchEvent(new Event('touchstart'))
  scroller.scrollTop = 40
  scroller.dispatchEvent(new Event('scroll'))
  scroller.dispatchEvent(new Event('touchend'))
  scroller.scrollTop = 20
  scroller.dispatchEvent(new Event('scroll'))
  return { scroller, virtualizer: hook.result.current }
}

it('writes a restore that releases the gesture tail at once', () => {
  const { scroller, virtualizer } = bouncingList()
  virtualizer.scrollToOffset(1956, { releaseGesture: true })
  expect(scroller.scrollTop).toBe(1956)
})

it('still lets the library hold an ordinary write while the tail is open', () => {
  const { scroller, virtualizer } = bouncingList()
  virtualizer.scrollToOffset(1956)
  expect(scroller.scrollTop).toBe(20)
})
