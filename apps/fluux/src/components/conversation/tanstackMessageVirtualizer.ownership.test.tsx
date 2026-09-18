import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('measures rows without competing writes while adjustment is disabled, then restores library anchoring', () => {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    offsetHeight: { value: 600 },
    offsetWidth: { value: 800 },
    clientHeight: { value: 600 },
    scrollHeight: { value: 2000 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number, top?: number) => {
    scroller.scrollTop = typeof options === 'number' ? top ?? 0 : options?.top ?? 0
  })
  const items = Array.from({ length: 20 }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  const { result, unmount } = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById, scrollRef: { current: scroller }, estimateSize: 100,
  }))
  act(() => {
    scroller.scrollTop = 400
    scroller.dispatchEvent(new Event('scroll'))
    result.current.scrollToOffset(400)
  })
  vi.mocked(scroller.scrollTo).mockClear()
  let rowHeight = 140
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = '1'
  Object.defineProperty(row, 'offsetHeight', { get: () => rowHeight })
  act(() => {
    result.current.setAutomaticScrollAdjustmentEnabled!(false)
    result.current.measureElement(row)
  })
  expect(result.current.getTotalSize()).toBe(2040)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
  expect(scroller.scrollTop).toBe(400)
  act(() => {
    result.current.setAutomaticScrollAdjustmentEnabled!(true)
    rowHeight = 160
    result.current.measureElement(row)
  })
  expect(result.current.getTotalSize()).toBe(2060)
  expect(scroller.scrollTop).toBe(420)
  expect(scroller.scrollTo).toHaveBeenCalledOnce()
  unmount()
})

it('leaves a scroll the user starts after cancelPendingScroll to the user (#1465)', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)))
  const flushFrames = () => {
    for (let i = 0; i < 10 && frames.length > 0; i++) frames.splice(0).forEach(callback => callback(performance.now()))
  }
  const scroller = document.createElement('div')
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    offsetHeight: { value: 600 },
    offsetWidth: { value: 800 },
    clientHeight: { value: 600 },
    scrollHeight: { value: 2000 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number, top?: number) => {
    scroller.scrollTop = typeof options === 'number' ? top ?? 0 : options?.top ?? 0
  })
  const items = Array.from({ length: 20 }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  const { result, unmount } = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById, scrollRef: { current: scroller }, estimateSize: 100,
  }))
  act(() => {
    scroller.scrollTop = 1400
    scroller.dispatchEvent(new Event('scroll'))
    flushFrames()
  })

  act(() => { result.current.cancelPendingScroll!() })
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => {
    // The first step of a native smooth PageUp lands within the library's
    // one-pixel "arrived" tolerance of the position the cancel ran at.
    scroller.scrollTop = 1399
    scroller.dispatchEvent(new Event('scroll'))
    flushFrames()
  })

  expect(scroller.scrollTo).not.toHaveBeenCalled()
  expect(scroller.scrollTop).toBe(1399)
  unmount()
})
