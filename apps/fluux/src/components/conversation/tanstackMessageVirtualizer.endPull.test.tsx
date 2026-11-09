import { useLayoutEffect } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { ViewportSession } from './viewportSession'

// Intent: growth above the reader during an iOS end pull must leave visible messages still and
// the reader at the end after release. Fixture: the unsigned iOS Demo on iOS 27, including the
// measured Sophia conversation rows, viewport, held stretch and 40px growth. The unmounted
// header's height is the next row's measured start. This replays the callback ordering, not touch
// physics: native WKWebView validation owns that proof.
const captured = {
  clientHeight: 636,
  width: 402,
  scrollHeight: 2247,
  stretchedTop: 1756,
  grownIndex: 12,
  grownHeight: 173.375,
  trackedIndex: 15,
  heights: [51, 51, 98.5, 98.5, 121.875, 121.875, 157.875, 51, 423.625, 134.5,
    51, 94.625, 133.375, 148.8125, 53.8125, 355.25, 75.125, 8.5],
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('CSS', { supports: () => true })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  )
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function endPull() {
  const initialTotal = captured.heights.reduce((total, height) => total + height, 0)
  const padding = captured.scrollHeight - Math.round(initialTotal)
  let committedHeight = captured.scrollHeight
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: captured.clientHeight }, clientHeight: { value: captured.clientHeight },
    offsetWidth: { value: captured.width }, scrollHeight: { get: () => committedHeight },
  })
  scroller.scrollTo = vi.fn(options => {
    scroller.scrollTop = Math.max(0, Math.min((options as ScrollToOptions).top ?? 0,
      scroller.scrollHeight - scroller.clientHeight))
  })
  const items = captured.heights.map((_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((row, index) => [row.key, index]))
  const { result } = renderHook(() => {
    const virtualizer = useTanstackMessageVirtualizer({
      items, indexById, scrollRef: { current: scroller }, estimateSize: index => captured.heights[index],
    })
    // Like the real spacer, the DOM height changes only when React commits, not when the
    // library first changes its layout. A synchronous offset read-back can cause that commit.
    useLayoutEffect(() => { committedHeight = Math.round(virtualizer.getTotalSize()) + padding })
    return virtualizer
  })
  const virtualizer = result.current
  const bottom = captured.scrollHeight - captured.clientHeight
  act(() => virtualizer.scrollToOffset(bottom))
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = String(captured.grownIndex)
  let rowHeight = captured.heights[captured.grownIndex]
  row.getBoundingClientRect = () => new DOMRect(0, 0, captured.width, rowHeight)
  act(() => virtualizer.measureElement(row))
  const onScreen = () => padding + result.current.getVirtualItems()
    .find(item => item.index === captured.trackedIndex)!.start - scroller.scrollTop
  const seen = onScreen()
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => {
    scroller.dispatchEvent(new Event('touchstart'))
    // The compositor position is visible to the input handler before its native scroll event.
    scroller.scrollTop = captured.stretchedTop
    virtualizer.cancelPendingScroll?.()
    rowHeight = captured.grownHeight
    virtualizer.measureElement(row)
  })
  const growth = captured.grownHeight - captured.heights[captured.grownIndex]
  expect(scroller.scrollHeight, 'the spacer still excludes the held growth').toBe(captured.scrollHeight)
  expect(scroller.scrollTop).toBe(captured.stretchedTop)
  expect(scroller.scrollTo, 'a held pull must not receive a physical write').not.toHaveBeenCalled()

  const session = new ViewportSession('conversation')
  const geometry = () => ({ top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight })
  session.recordProgrammaticWrite('conversation', 0, geometry())
  const takeovers: number[] = []
  virtualizer.setScrollWriteObserver?.(write => {
    if (write.phase === 'after') {
      session.recordProgrammaticWrite('conversation', 0, geometry())
      return
    }
    const movement = session.observeGeometry('conversation', geometry(), { now: 0, controllerOwnsPixels: true })
    if (movement?.userDelta) {
      takeovers.push(movement.userDelta)
      virtualizer.cancelPendingScroll?.()
      return false
    }
  })
  vi.mocked(scroller.scrollTo).mockClear()
  return { scroller, virtualizer, bottom, growth, seen, onScreen, takeovers }
}

it('records the release pin before a held correction can re-enter the reader veto', () => {
  const list = endPull()
  act(() => {
    list.scroller.dispatchEvent(new Event('touchend'))
    list.virtualizer.scrollToIndex(captured.heights.length - 1, { align: 'end' })
  })
  expect(list.takeovers).toEqual([])
  expect(list.scroller.scrollTop).toBe(list.bottom + list.growth)
  expect(list.onScreen()).toBe(list.seen)
  // A later native read-back must not lose or apply the held correction twice.
  act(() => {
    list.scroller.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(150)
  })
  expect(list.scroller.scrollTop).toBe(list.scroller.scrollHeight - list.scroller.clientHeight)
  expect(list.onScreen()).toBe(list.seen)
})

it('keeps real reader movement instead of re-pinning when the held growth is released', () => {
  const list = endPull()
  const readerTop = list.bottom - list.growth
  act(() => {
    list.scroller.dispatchEvent(new Event('touchend'))
    list.scroller.scrollTop = readerTop
    list.virtualizer.scrollToIndex(captured.heights.length - 1, { align: 'end' })
  })
  expect(list.takeovers).toEqual([-list.growth])
  // The held correction still belongs to the reader: it compensates growth once on their new
  // position, rather than writing the pin's destination at the new end.
  expect(list.scroller.scrollTop).toBe(readerTop + list.growth)
  expect(list.onScreen()).toBe(list.seen + list.growth)
})
