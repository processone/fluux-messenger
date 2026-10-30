// Intent: FLM-276. Native upward panning must retain visible progress when a previously
// measured row above the viewport shrinks. These readings come from the actual demo pan.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import fixtures from './__fixtures__/nativePanMeasurements.json'

const observers = new Map<Element, ResizeObserverCallback>()
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { observers.set(element, this.callback) }
    unobserve(element: Element) { observers.delete(element) }
    disconnect() {}
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); observers.clear(); document.body.replaceChildren() })

it.each(fixtures)('$kind: compensates an above-viewport remeasurement during backward native movement', fixture => {
  const { before, after, measurement, items } = fixture
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: before.client }, offsetWidth: { value: 984 },
    clientHeight: { value: before.client }, scrollHeight: { value: before.height },
  })
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number, top?: number) => {
    scroller.scrollTop = typeof options === 'number' ? top ?? 0 : options?.top ?? 0
  })
  const indexById = new Map(items.map(item => [item.key, item.index]))
  const { result } = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById, scrollRef: { current: scroller }, estimateSize: index => items[index].size,
    initialMeasurements: new Map(items.filter(item => item.measured).map(item => [item.key, item.size])),
  }))
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = String(measurement.index)
  row.getBoundingClientRect = () => new DOMRect(0, 0, 984, measurement.oldSize)
  act(() => result.current.measureElement(row))
  const anchor = items.find(item => item.key === before.anchor.identity)!
  const initialStart = result.current.getMessageStart!(anchor.key)!
  act(() => {
    scroller.scrollTop = before.top
    scroller.dispatchEvent(new Event('scroll'))
  })
  const initialPlacement = initialStart - scroller.scrollTop
  // Replay only the independently recorded native movement, not the uncorrected layout shift.
  act(() => {
    scroller.scrollTop = after.top
    scroller.dispatchEvent(new Event('scroll'))
  })
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => observers.get(row)!([
    { target: row, borderBoxSize: [{ blockSize: measurement.size }] } as unknown as ResizeObserverEntry,
  ], {} as ResizeObserver))
  const delta = measurement.size - measurement.oldSize
  expect(scroller.scrollTop).toBe(after.top + delta)
  expect(result.current.getMessageStart!(anchor.key)! - scroller.scrollTop)
    .toBe(initialPlacement + before.top - after.top)
  expect(scroller.scrollTo).toHaveBeenCalledOnce()
})
