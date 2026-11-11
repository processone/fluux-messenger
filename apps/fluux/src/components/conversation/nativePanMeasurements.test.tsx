// Intent: FLM-276. Native upward panning must retain visible progress when a previously
// measured row above the viewport shrinks. These readings come from the actual demo pan.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observers.clear(); document.body.replaceChildren() })

function measurementHarness(
  fixture: (typeof fixtures)[number],
  { initialSize = fixture.measurement.oldSize, takeoverOnScroll = false, estimated = false } = {},
) {
  const { before, measurement } = fixture
  // An estimated row is laid out at initialSize until its first resize delivery (mount, below).
  const items = estimated
    ? fixture.items.map(item => item.index === measurement.index ? { ...item, size: initialSize, measured: false } : item)
    : fixture.items
  // The scrollable range follows the list's spacer as each render commits, with the padding the
  // capture recorded around it. The browser clamps a write to that range.
  const padding = before.height - fixture.items.reduce((sum, item) => sum + item.size, 0)
  let height = before.height
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: before.client }, offsetWidth: { value: 984 },
    clientHeight: { value: before.client }, scrollHeight: { get: () => height },
  })
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number, top?: number) => {
    const wanted = typeof options === 'number' ? top ?? 0 : options?.top ?? 0
    scroller.scrollTop = Math.max(0, Math.min(wanted, height - before.client))
  })
  // The app's own scroll handler is attached when the list mounts, before the virtualizer's, and
  // hands the pixels to the reader on each user scroll event.
  let takeover = () => {}
  if (takeoverOnScroll) scroller.addEventListener('scroll', () => takeover())
  const indexById = new Map(items.map(item => [item.key, item.index]))
  const { result } = renderHook(() => {
    const list = useTanstackMessageVirtualizer({
      items, indexById, scrollRef: { current: scroller }, estimateSize: index => items[index].size,
      initialMeasurements: new Map(items.filter(item => item.measured).map(item => [item.key, item.size])),
    })
    height = list.getTotalSize() + padding
    return list
  })
  takeover = () => result.current.cancelPendingScroll?.()
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = String(measurement.index)
  let rowHeight = initialSize
  row.getBoundingClientRect = () => new DOMRect(0, 0, 984, rowHeight)
  // Mid-scroll the library only observes a newly mounted row; its first measurement is the
  // resize observer's first delivery.
  const mount = () => act(() => result.current.measureElement(row))
  if (!estimated) mount()
  const resize = (size: number) => {
    rowHeight = size
    observers.get(row)!([
      { target: row, borderBoxSize: [{ blockSize: size }] } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver)
  }
  const scrollThrough = (...tops: number[]) => act(() => {
    for (const top of tops) {
      scroller.scrollTop = top
      scroller.dispatchEvent(new Event('scroll'))
    }
  })
  return { scroller, result, resize, mount, scrollThrough }
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

// Intent: a continuous scroll keeps the virtualizer's direction until scroll events stop, so the
// direction-dependent fold rule sees the real motion. The reader takeover runs on every user scroll
// event before the virtualizer reports it; reporting the offset at rest there cleared the direction,
// and a measured row above the reader that grows during backward motion was compensated. Replay the
// recorded native movement, with that row's captured heights as its growth.
it.each(fixtures)('$kind: keeps backward motion for the fold rule through a reader takeover', fixture => {
  const { before, after, measurement } = fixture
  const { scroller, resize } = measurementHarness(fixture, { initialSize: measurement.size, takeoverOnScroll: true })
  act(() => {
    scroller.scrollTop = before.top
    scroller.dispatchEvent(new Event('scroll'))
    scroller.scrollTop = after.top
    scroller.dispatchEvent(new Event('scroll'))
  })
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => resize(measurement.oldSize))
  // The library's backward rule leaves growth above the reader uncompensated.
  expect(scroller.scrollTop).toBe(after.top)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
})

// Intent: the same direction must survive a correction written mid-scroll. A shrink above the reader
// is compensated in either direction; reporting that write at rest cleared the direction, and the
// next growth above the reader, still during backward motion, was compensated too. Replay the
// recorded movement, then the row's captured heights as a shrink and a growth.
it.each(fixtures)('$kind: keeps backward motion for the fold rule after a correction written mid-scroll', fixture => {
  const { before, after, measurement } = fixture
  const { scroller, resize } = measurementHarness(fixture, { takeoverOnScroll: true })
  act(() => {
    scroller.scrollTop = before.top
    scroller.dispatchEvent(new Event('scroll'))
    scroller.scrollTop = after.top
    scroller.dispatchEvent(new Event('scroll'))
  })
  const shrink = measurement.size - measurement.oldSize
  act(() => resize(measurement.size))
  expect(scroller.scrollTop).toBe(after.top + shrink)
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => resize(measurement.oldSize))
  // The library's backward rule leaves growth above the reader uncompensated.
  expect(scroller.scrollTop).toBe(after.top + shrink)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
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

// Intent: a continuous scroll keeps the virtualizer's direction until scroll events stop, also when
// WebKit momentum moves the element on without a scroll event and a row resize arrives first. The
// measurement hook reported that position at rest, clearing the direction, and the row's growth
// above the reader during backward motion was compensated. The momentum carries on by the recorded
// step.
it.each(fixtures)('$kind: keeps backward motion when a row is measured between withheld scroll events', fixture => {
  const { before, after, measurement } = fixture
  const { scroller, resize, scrollThrough } = measurementHarness(fixture, { initialSize: measurement.size, takeoverOnScroll: true })
  scrollThrough(before.top, after.top)
  const top = after.top - (before.top - after.top)
  scroller.scrollTop = top
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => resize(measurement.oldSize))
  // The library's backward rule leaves growth above the reader uncompensated.
  expect(scroller.scrollTop).toBe(top)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
})

// The reader scrolls down to the end of the list and 46px past it, the end stretch measured on an
// iPhone, and the row above shrinks mid-bounce. While the element reports a position past its range
// the library holds the correction rather than writing it.
function heldThroughRubberBand(fixture: (typeof fixtures)[number]) {
  const { before, after, measurement } = fixture
  const list = measurementHarness(fixture, { takeoverOnScroll: true })
  const max = list.scroller.scrollHeight - list.scroller.clientHeight
  list.scrollThrough(max - (before.top - after.top), max, max + 46)
  vi.mocked(list.scroller.scrollTo).mockClear()
  act(() => list.resize(measurement.size))
  expect(list.scroller.scrollTop, 'precondition: the shrink is held mid-bounce').toBe(max + 46)
  expect(list.scroller.scrollTo).not.toHaveBeenCalled()
  return { ...list, max }
}

// Intent: the measurement hook's at-rest report also cleared the library's overscroll guard, so a
// correction held through a rubber band was written mid-bounce. Any resize delivery mid-bounce runs
// that hook; here the same row reports its new size again.
it.each(fixtures)('$kind: keeps a correction held through a rubber band when a row reports mid-bounce', fixture => {
  const { scroller, resize, max } = heldThroughRubberBand(fixture)
  act(() => resize(fixture.measurement.size))
  expect(scroller.scrollTop).toBe(max + 46)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
})

// Intent: the library writes a held correction itself once the element is back in range. Reporting
// that write at rest cleared the bounce's backward direction, and the row's growth above the reader
// was compensated. Replay the row's captured heights as the held shrink and then a growth.
it.each(fixtures)('$kind: keeps backward motion after a held correction is written as the bounce returns', fixture => {
  const { measurement } = fixture
  const { scroller, resize, scrollThrough, max } = heldThroughRubberBand(fixture)
  const shrink = measurement.size - measurement.oldSize
  scrollThrough(max)
  expect(scroller.scrollTop, 'the held shrink is written').toBe(max + shrink)
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => resize(measurement.oldSize))
  // The library's backward rule leaves growth above the reader uncompensated.
  expect(scroller.scrollTop).toBe(max + shrink)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
})

// Intent: a correction past the end of the scrollable range is clamped by the browser, and the
// library writes the rest from its commit-time update once the list commits its new size. That
// write's read-back was reported at rest, so the library took the reader as stopped mid-scroll;
// reported as motion from inside React's commit, it must not ask for a synchronous render. The row
// is still at its estimate as the reader leaves the end of the list: its captured heights are the
// estimate and the first measurement.
it.each(fixtures)('$kind: keeps the scroll in progress after a clamped correction is retried in the commit', fixture => {
  const { before, after, measurement } = fixture
  const adjustments = vi.spyOn(Virtualizer.prototype, 'applyScrollAdjustment')
  const errors = vi.spyOn(console, 'error')
  const { scroller, resize, mount, scrollThrough } = measurementHarness(fixture, {
    initialSize: measurement.size, estimated: true, takeoverOnScroll: true,
  })
  const max = scroller.scrollHeight - scroller.clientHeight
  const top = max - (before.top - after.top)
  scrollThrough(max, top)
  mount()
  act(() => resize(measurement.oldSize))
  const growth = measurement.oldSize - measurement.size
  expect(top + growth, 'precondition: the correction overshoots the range').toBeGreaterThan(max)
  expect(scroller.scrollTop, 'the clamped correction is written in full').toBe(top + growth)
  const library = adjustments.mock.contexts.at(-1) as Virtualizer<HTMLElement, Element>
  expect(library.isScrolling).toBe(true)
  expect(library.scrollDirection).toBe('backward')
  expect(errors.mock.calls.flat().join('\n')).not.toContain('flushSync')
})
