import { PositioningController } from './positioningController'
import { UnreadMarkerBrowserAdapter } from './unreadMarkerBrowserAdapter'
import { deriveEntryPositionFacts, deriveGlobalLiveEdgeReachability } from './scrollPositionFacts'
import { useRowMetrics, ROW_METRICS_FALLBACK } from './useRowMetrics'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import type { MessageVirtualizer } from './messageVirtualizer'
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
  row.getBoundingClientRect = () => new DOMRect(0, 0, 800, rowHeight)
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

it('applies a measurement adjustment the observer refused, and still refuses a navigation write (#1510)', () => {
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

  const refusals: string[] = []
  act(() => {
    result.current.setScrollWriteObserver!(write => {
      if (write.phase === 'before') refusals.push(write.source)
      return false
    })
  })

  // Row 1 spans 100..200, entirely above the reader at 400, and measures 40px taller than its
  // estimate. The library counts that correction as applied the moment it asks for the write.
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = '1'
  Object.defineProperty(row, 'offsetHeight', { get: () => 140 })
  row.getBoundingClientRect = () => new DOMRect(0, 0, 800, 140)
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => { result.current.measureElement(row) })

  expect(refusals).toContain('measurement')
  expect(result.current.getTotalSize()).toBe(2040)
  // Refused and dropped, the reader would stay at 400 under 40px of new content above them —
  // and nothing would reconcile it, because the adjustment has already been cleared.
  expect(scroller.scrollTop).toBe(440)

  // The same refusing observer still stops a navigation write: the exemption is scoped to the
  // source that cannot survive one, not a refusal the virtualizer ignores everywhere.
  vi.mocked(scroller.scrollTo).mockClear()
  act(() => { result.current.scrollToOffset(1000) })
  expect(refusals).toContain('navigation')
  expect(scroller.scrollTo).not.toHaveBeenCalled()
  expect(scroller.scrollTop).toBe(440)

  unmount()
})

it('keeps compensating rows measured above the reader after the native event of a programmatic write', () => {
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
    result.current.scrollToOffset(400)
    // The browser's `scroll` event for that write arrives afterwards, at the offset already pushed.
    scroller.dispatchEvent(new Event('scroll'))
  })
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = '1'
  Object.defineProperty(row, 'offsetHeight', { get: () => 140 })
  row.getBoundingClientRect = () => new DOMRect(0, 0, 800, 140)
  act(() => result.current.measureElement(row))

  expect(result.current.getTotalSize()).toBe(2040)
  expect(scroller.scrollTop).toBe(440)
  unmount()
})

it.each(['native', 'raf'])('preserves backward scrolling direction for small %s movements', delivery => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const runFrame = () => {
    for (const [id, callback] of [...frames]) {
      if (frames.delete(id)) callback(performance.now())
    }
  }
  const resizeCallbacks = new Map<Element, ResizeObserverCallback>()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { resizeCallbacks.set(target, this.callback) }
    unobserve(target: Element) { resizeCallbacks.delete(target) }
    disconnect() { resizeCallbacks.clear() }
  })
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
  let rowHeight = 101
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = '1'
  row.getBoundingClientRect = () => new DOMRect(0, 0, 800, rowHeight)
  act(() => {
    result.current.measureElement(row)
    result.current.scrollToOffset(400)
    scroller.dispatchEvent(new Event('scroll'))
    for (let frame = 0; frame < 10; frame += 1) runFrame()
  })
  vi.mocked(scroller.scrollTo).mockClear()

  act(() => {
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
    for (const top of [399, 398]) {
      scroller.scrollTop = top
      if (delivery === 'native') scroller.dispatchEvent(new Event('scroll'))
      else runFrame()
    }
    rowHeight = 141
    resizeCallbacks.get(row)!([
      { target: row, borderBoxSize: [{ inlineSize: 800, blockSize: rowHeight }] } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver)
  })

  expect(result.current.getTotalSize()).toBe(2041)
  expect(scroller.scrollTop).toBe(398)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
  unmount()
})

it('re-derives unmeasured estimates from freshly sampled metrics and keeps measured sizes', () => {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    offsetHeight: { value: 600 },
    offsetWidth: { value: 800 },
    clientHeight: { value: 600 },
    scrollHeight: { value: 2000 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  const items = Array.from({ length: 20 }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  let estimate = 100
  const { result, unmount } = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById, scrollRef: { current: scroller },
    estimateSize: () => estimate,
  }))
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = '0'
  Object.defineProperty(row, 'offsetHeight', { get: () => 80 })
  row.getBoundingClientRect = () => new DOMRect(0, 0, 800, 80)
  act(() => result.current.measureElement(row))
  expect(result.current.getTotalSize()).toBe(80 + 19 * 100)
  expect(result.current.getOffsetForMessageId('row-10')).toBe(80 + 9 * 100)

  estimate = 60
  act(() => { result.current.refreshEstimates!(true) })

  expect(result.current.getOffsetForMessageId('row-10')).toBe(80 + 9 * 60)
  expect(result.current.getTotalSize()).toBe(80 + 19 * 60)
  unmount()
})

it.each([60, 150])('commits the spacer before positioning on recalibrated %ipx estimates', estimateAfterSample => {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    offsetHeight: { value: 500 },
    offsetWidth: { value: 320 },
    clientHeight: { value: 500 },
    scrollHeight: { get: () => parseFloat((scroller.firstElementChild as HTMLElement)?.style.height) || 0 },
  })
  scroller.scrollTo = (options?: ScrollToOptions | number, top?: number) => {
    const requested = typeof options === 'number' ? top ?? 0 : options?.top ?? 0
    scroller.scrollTop = Math.max(0, Math.min(requested, scroller.scrollHeight - scroller.clientHeight))
  }
  const items = Array.from({ length: 60 }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  let estimate = 100
  const virtualizerHandle: { current?: MessageVirtualizer } = {}
  function Harness() {
    const virtualizer = useTanstackMessageVirtualizer({
      items, indexById, scrollRef: { current: scroller },
      estimateSize: () => estimate,
    })
    useLayoutEffect(() => {
      virtualizerHandle.current = virtualizer
    }, [virtualizer])
    return <div style={{ height: virtualizer.getTotalSize() }} />
  }
  const view = render(<Harness />, { container: scroller })
  expect(scroller.scrollHeight).toBe(6000)

  act(() => {
    estimate = estimateAfterSample
    virtualizerHandle.current!.refreshEstimates!(true)
    virtualizerHandle.current!.scrollToIndex(40, { align: 'start' })
    expect(scroller.scrollHeight).toBe(60 * estimateAfterSample)
    expect(scroller.scrollTop).toBe(40 * estimateAfterSample)
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeGreaterThan(500)
  })
  view.unmount()
})

it('batches a later recalibration into the next render while offsets follow at once', () => {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    offsetHeight: { value: 500 },
    offsetWidth: { value: 320 },
    clientHeight: { value: 500 },
    scrollHeight: { get: () => parseFloat((scroller.firstElementChild as HTMLElement)?.style.height) || 0 },
  })
  const items = Array.from({ length: 60 }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  let estimate = 100
  const virtualizerHandle: { current?: MessageVirtualizer } = {}
  function Harness() {
    const virtualizer = useTanstackMessageVirtualizer({
      items, indexById, scrollRef: { current: scroller },
      estimateSize: () => estimate,
    })
    useLayoutEffect(() => {
      virtualizerHandle.current = virtualizer
    }, [virtualizer])
    return <div style={{ height: virtualizer.getTotalSize() }} />
  }
  const view = render(<Harness />, { container: scroller })

  act(() => {
    estimate = 60
    virtualizerHandle.current!.refreshEstimates!(false)
    expect(virtualizerHandle.current!.getOffsetForMessageId('row-40')).toBe(40 * 60)
    expect(scroller.scrollHeight).toBe(6000)
  })
  expect(scroller.scrollHeight).toBe(60 * 60)
  view.unmount()
})

it.each([12, 30])('corrects the marker before the next frame when text first measures at %ipx', async lineHeight => {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  const scrollRef = { current: scroller }
  Object.defineProperties(scroller, {
    offsetHeight: { value: 500 },
    offsetWidth: { value: 320 },
    clientHeight: { value: 500 },
    scrollHeight: { get: () => parseFloat((scroller.firstElementChild as HTMLElement)?.style.height) || 0 },
  })
  scroller.scrollTo = (options?: ScrollToOptions | number, top?: number) => {
    const requested = typeof options === 'number' ? top ?? 0 : options?.top ?? 0
    scroller.scrollTop = Math.max(0, Math.min(requested, scroller.scrollHeight - scroller.clientHeight))
  }
  const items = Array.from({ length: 60 }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  const controller = new PositioningController()
  const callbacks: Array<() => void> = []
  const landed: number[] = []
  const virtualizerHandle: { current?: MessageVirtualizer } = {}
  function Harness({ hasText }: { hasText: boolean }) {
    const metrics = useRowMetrics(scrollRef, () => {
      virtualizerHandle.current!.refreshEstimates!(true)
      controller.reassertUnreadMarker('room-a')
      landed.push(scroller.scrollTop)
    })
    const virtualizer = useTanstackMessageVirtualizer({
      items, indexById, scrollRef,
      estimateSize: () => metrics.metricsRef.current === ROW_METRICS_FALLBACK
        ? 100 : metrics.metricsRef.current.lineBoxPx * 5,
      sampleEstimateMetrics: metrics.sample,
    })
    useLayoutEffect(() => {
      virtualizerHandle.current = virtualizer
    }, [virtualizer])
    return <div style={{ height: virtualizer.getTotalSize() }}>
      <div data-index="0" ref={node => {
        if (!node) return
        node.getBoundingClientRect = () => new DOMRect(0, 0, 320, 100)
        virtualizer.measureElement(node)
      }}>
        {hasText ? <div data-msg-text style={{ fontSize: 18, lineHeight: `${lineHeight}px` }} ref={node => {
          if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, value: 280 })
        }}>A measured message</div> : <div>Nick changed</div>}
      </div>
    </div>
  }
  const view = render(<Harness hasText={false} />, { container: scroller })
  const applyLiveEdge = vi.fn(() => ({ kind: 'unavailable' as const }))
  const executor = new UnreadMarkerBrowserAdapter({
    getScroller: () => scroller,
    getVirtualizer: () => virtualizerHandle.current!,
    getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
    getPassiveContext: () => ({ conversationId: 'room-a', virtualizer: virtualizerHandle.current! }),
    beginLoop: () => ({ schedule: callback => callbacks.push(callback), recordFrame: vi.fn(), finish: vi.fn() }),
    setMeasuredAtBottom: vi.fn(),
    recordProgrammaticWrite: vi.fn(),
  }).createExecutor({
    reachability: () => deriveGlobalLiveEdgeReachability({ hasRows: true, windowAtLiveEdge: true }),
    beginLoop: () => null,
    positionFrame: applyLiveEdge,
    complete: vi.fn(),
  })
  controller.beginUnreadMarkerEntry({
    conversationId: 'room-a',
    entryFacts: deriveEntryPositionFacts({
      syncedLiveEdge: false, savedAnchor: null, savedOffsetPx: null,
      firstUnreadMessageId: 'row-40', unreadMarkerAlign: 'start',
    }),
    executor,
  })
  act(() => callbacks.shift()!())
  expect(scroller.scrollTop).toBe(4000)
  expect(landed).toEqual([])
  expect(callbacks).toHaveLength(1)

  await act(async () => {
    view.rerender(<Harness hasText />)
  })
  expect(landed).toEqual([100 + 39 * lineHeight * 5])
  expect(scroller.scrollHeight).toBe(100 + 59 * lineHeight * 5)
  expect(scroller.scrollTop).toBe(100 + 39 * lineHeight * 5)
  expect(callbacks).toHaveLength(1)
  expect(applyLiveEdge).not.toHaveBeenCalled()
  view.unmount()
})
