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

function measurementHarness(fixture: (typeof fixtures)[number]) {
  const { before, measurement, items } = fixture
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
  let rowHeight = measurement.oldSize
  row.getBoundingClientRect = () => new DOMRect(0, 0, 984, rowHeight)
  act(() => result.current.measureElement(row))
  const resize = (size: number) => {
    rowHeight = size
    observers.get(row)!([
      { target: row, borderBoxSize: [{ blockSize: size }] } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver)
  }
  return { scroller, result, resize }
}

it.each(fixtures)('$kind: compensates an above-viewport remeasurement during backward native movement', fixture => {
  const { before, after, measurement, items } = fixture
  const { scroller, result, resize } = measurementHarness(fixture)
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
  act(() => resize(measurement.size))
  const delta = measurement.size - measurement.oldSize
  expect(scroller.scrollTop).toBe(after.top + delta)
  expect(result.current.getMessageStart!(anchor.key)! - scroller.scrollTop)
    .toBe(initialPlacement + before.top - after.top)
  expect(scroller.scrollTo).toHaveBeenCalledOnce()
})

// Intent: FLM-309 F5. Two resize notifications can arrive before the lazy layout rebuild.
// Replay the same row's captured heights as a shrink/grow cycle; this is controlled owner
// ordering, not a claim that native input naturally produced this schedule in the demo.
it.each(fixtures.flatMap(fixture => (['idle', 'forward'] as const).map(direction => ({ fixture, direction }))))(
  '$fixture.kind: uses the latest measured size before a lazy rebuild while $direction',
  ({ fixture, direction }) => {
    const { measurement, items, before } = fixture
    const { scroller, result, resize } = measurementHarness(fixture)
    const rowStart = items.slice(0, measurement.index).reduce((sum, item) => sum + item.size, 0)
    const fold = rowStart + measurement.size
    const anchor = items.find(item => item.key === before.anchor.identity)!
    const initialStart = result.current.getMessageStart!(anchor.key)!
    vi.mocked(scroller.scrollTo).mockClear()
    act(() => {
      scroller.scrollTop = fold
      if (direction === 'forward') scroller.dispatchEvent(new Event('scroll'))
      // The old row spans the fold, so its shrink is not compensated. Its current end is
      // now exactly at the fold; the second resize must use that end, not the old layout.
      resize(measurement.size)
      expect(scroller.scrollTop).toBe(fold)
      expect(scroller.scrollTo).not.toHaveBeenCalled()
      resize(measurement.oldSize)
    })
    const growth = measurement.oldSize - measurement.size
    expect(scroller.scrollTop).toBe(fold + growth)
    expect(result.current.getMessageStart!(anchor.key)! - scroller.scrollTop)
      .toBe(initialStart - fold - growth)
    expect(scroller.scrollTo).toHaveBeenCalledOnce()
  },
)
