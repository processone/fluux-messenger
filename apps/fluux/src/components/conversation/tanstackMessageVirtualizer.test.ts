/**
 * @vitest-environment jsdom
 *
 * Guards the @tanstack scroll-offset sync fix.
 *
 * @tanstack/react-virtual updates its reactive `scrollOffset` ONLY from the scroll
 * element's 'scroll' DOM event (observeElementOffset). `scrollToOffset` sets the DOM
 * scrollTop but leaves `scrollOffset` stale until that event fires. During a MAM-prepend
 * restore (a useLayoutEffect right after a count change) the browser's pending scroll
 * event may not re-window before paint, so the mounted rows stay at the old (top)
 * position while scrollTop sits at the restored offset → the viewport renders BLANK.
 *
 * This reproduced in Tauri WebKitGTK and the headless preview browser, but NOT in
 * Playwright chromium/webkit (their engines fire the native scroll event promptly), so
 * the Playwright scroll-invariant harness cannot catch it. This deterministic unit test
 * pins the fix at the mechanism level instead: the adapter's `scrollToOffset` must
 * dispatch a synthetic 'scroll' event so the virtualizer re-reads scrollTop and
 * re-windows — the same sync a real user scroll performs.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { RefObject } from 'react'

const scrollToOffsetSpy = vi.fn()
const scrollToIndexSpy = vi.fn()

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    getOffsetForIndex: () => [0],
    scrollToOffset: scrollToOffsetSpy,
    scrollToIndex: scrollToIndexSpy,
    measureElement: vi.fn(),
  }),
}))

// Imported after the mock so the adapter binds to the mocked useVirtualizer.
const { useTanstackMessageVirtualizer } = await import('./tanstackMessageVirtualizer')

function renderAdapter(el: HTMLElement) {
  const scrollRef = { current: el } as RefObject<HTMLElement>
  return renderHook(() =>
    useTanstackMessageVirtualizer({
      items: [{ key: 'a' }, { key: 'b' }],
      indexById: new Map([['a', 0], ['b', 1]]),
      scrollRef,
    }),
  )
}

describe('useTanstackMessageVirtualizer — scroll-offset sync', () => {
  it('scrollToOffset delegates to @tanstack AND dispatches a scroll event to force re-window', () => {
    const el = document.createElement('div')
    const dispatchSpy = vi.spyOn(el, 'dispatchEvent')
    const { result } = renderAdapter(el)

    result.current.scrollToOffset(1000)

    // Delegates to @tanstack (sets the DOM scrollTop)…
    expect(scrollToOffsetSpy).toHaveBeenCalledWith(1000, undefined)
    // …and dispatches a 'scroll' event so @tanstack's observeElementOffset re-reads
    // scrollTop and re-windows. Without this, the virtualizer window desyncs from
    // scrollTop after a programmatic scroll and the viewport blanks on engines that
    // don't fire a native scroll event promptly (Tauri WebKitGTK).
    const scrollEvents = dispatchSpy.mock.calls.filter(([e]) => (e as Event).type === 'scroll')
    expect(
      scrollEvents.length,
      'scrollToOffset must dispatch a scroll event to keep the virtualizer window synced to scrollTop',
    ).toBeGreaterThan(0)
  })
})
