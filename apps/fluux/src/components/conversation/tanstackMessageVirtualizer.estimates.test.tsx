// Intent: FLM-311. Refreshing the estimates of rows nobody has measured must keep what the reader
// sees in place: rows above the reader shift it by their change, in either direction and during
// backward motion, while suppression and held anchors keep their precedence.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useCallback, useLayoutEffect } from 'react'
import type { MessageVirtualizer } from './messageVirtualizer'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { useRowMetrics } from './useRowMetrics'

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

afterEach(() => {
  vi.unstubAllGlobals()
  observers.clear()
  document.body.replaceChildren()
})

const ROWS = 40
const MEASURED = { from: 20, to: 27, size: 80 }

function scrollerWithSpacer() {
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: 600 },
    offsetWidth: { value: 800 },
    clientHeight: { value: 600 },
    scrollHeight: { get: () => parseFloat((scroller.firstElementChild as HTMLElement)?.style.height) || 0 },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number, top?: number) => {
    const requested = typeof options === 'number' ? top ?? 0 : options?.top ?? 0
    scroller.scrollTop = Math.max(0, Math.min(requested, scroller.scrollHeight - scroller.clientHeight))
  })
  return scroller
}

// Rows 20-27 are mounted and measured at 80px; every other row is an estimate.
function estimateHarness(initial: number) {
  const scroller = scrollerWithSpacer()
  const items = Array.from({ length: ROWS }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  const estimates = { above: initial, below: initial }
  const handle: { current?: MessageVirtualizer } = {}
  function Harness() {
    const virtualizer = useTanstackMessageVirtualizer({
      items, indexById, scrollRef: { current: scroller },
      estimateSize: index => index < MEASURED.from ? estimates.above : estimates.below,
    })
    useLayoutEffect(() => { handle.current = virtualizer }, [virtualizer])
    return <div style={{ height: virtualizer.getTotalSize() }}>
      {Array.from({ length: MEASURED.to - MEASURED.from + 1 }, (_, offset) => (
        <div key={offset} data-index={MEASURED.from + offset} ref={node => {
          if (!node) return
          node.getBoundingClientRect = () => new DOMRect(0, 0, 800, MEASURED.size)
          virtualizer.measureElement(node)
        }} />
      ))}
    </div>
  }
  const view = render(<Harness />, { container: scroller })
  const virtualizer = () => handle.current!
  // The reader sits 30px into row 21, having moved backward to get there.
  const readerRow = 'row-21'
  const readAt = () => virtualizer().getMessageStart!(readerRow)! + 30
  const scrollTo = (top: number) => act(() => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  })
  scrollTo(readAt() + 200)
  scrollTo(readAt())
  vi.mocked(scroller.scrollTo).mockClear()
  const placement = () => virtualizer().getMessageStart!(readerRow)! - scroller.scrollTop
  return { scroller, view, virtualizer, estimates, placement, readerRow }
}

it.each([
  { change: 'shrink', from: 100, to: 60 },
  { change: 'growth', from: 60, to: 100 },
])('keeps the reader in place when estimates above it $change during backward motion', ({ from, to }) => {
  const { scroller, view, virtualizer, estimates, placement } = estimateHarness(from)
  const before = placement()
  const top = scroller.scrollTop
  expect(before).toBe(-30)

  act(() => {
    estimates.above = to
    virtualizer().refreshEstimates!(false)
  })

  expect(scroller.scrollTop).toBe(top + MEASURED.from * (to - from))
  expect(placement()).toBe(before)
  // Growth past the room the old spacer leaves commits the taller spacer first, so one write lands
  // all of it instead of a clamped part and a recovery that later measurements can replace.
  expect(scroller.scrollTo).toHaveBeenCalledTimes(1)
  view.unmount()
})

// The window follows the scroll offset, as MessageList's does, and rows measure when they mount.
// Growth far past the scroll room must not render the window where a clamped write would leave it:
// the older rows mounted there measure, and their corrections replace the clamp recovery.
it('keeps the reader in place when estimates above it grow past the scroll room', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)))
  const runFrames = () => act(() => {
    for (let round = 0; round < 20 && frames.length > 0; round++) frames.splice(0).forEach(callback => callback(0))
  })
  const scroller = scrollerWithSpacer()
  const items = Array.from({ length: 200 }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  // Rows the reader has seen before keep their measured size; everything older is an estimate.
  const seen = new Map(items.slice(140, 176).map(item => [item.key, 80]))
  const estimate = { size: 60 }
  const handle: { current?: MessageVirtualizer } = {}
  const mounted = new Set<number>()
  function Harness() {
    const virtualizer = useTanstackMessageVirtualizer({
      items, indexById, scrollRef: { current: scroller }, initialMeasurements: seen,
      estimateSize: () => estimate.size,
    })
    useLayoutEffect(() => { handle.current = virtualizer }, [virtualizer])
    const { measureElement } = virtualizer
    const measure = useCallback((node: HTMLElement | null) => {
      if (node) {
        mounted.add(Number(node.dataset.index))
        node.getBoundingClientRect = () => new DOMRect(0, 0, 800, 80)
      }
      measureElement(node)
    }, [measureElement])
    return <div style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index} ref={measure} />)}
    </div>
  }
  const view = render(<Harness />, { container: scroller })
  runFrames()
  const virtualizer = () => handle.current!
  const scrollTo = (top: number) => {
    act(() => {
      scroller.scrollTop = top
      scroller.dispatchEvent(new Event('scroll'))
    })
    runFrames()
  }
  const readAt = () => virtualizer().getMessageStart!('row-150')! + 30
  scrollTo(readAt() + 200)
  scrollTo(readAt())
  const placement = () => virtualizer().getMessageStart!('row-150')! - scroller.scrollTop
  const before = placement()
  const top = scroller.scrollTop
  const room = scroller.scrollHeight - scroller.clientHeight - top
  mounted.clear()

  act(() => {
    estimate.size = 100
    virtualizer().refreshEstimates!(false)
  })
  runFrames()

  // The shift is larger than the room the old spacer left, yet all of it landed.
  expect(scroller.scrollTop - top).toBeGreaterThan(room)
  expect(placement()).toBe(before)
  // Only rows near the reader rendered: none of the older rows the clamp would have reached.
  expect([...mounted].every(index => index >= 120)).toBe(true)
  view.unmount()
})

it('commits the shifted spacer in the same task as the write', () => {
  const { scroller, view, virtualizer, estimates, placement } = estimateHarness(100)
  const total = virtualizer().getTotalSize()

  act(() => {
    estimates.above = 60
    virtualizer().refreshEstimates!(false)
    // The write and the transforms land together, so no paint shows the shift without the layout.
    expect(scroller.scrollHeight).toBe(total - MEASURED.from * 40)
    expect(placement()).toBe(-30)
  })
  view.unmount()
})

it('does not move the reader when only estimates below it change', () => {
  const { scroller, view, virtualizer, estimates, placement } = estimateHarness(100)
  const top = scroller.scrollTop

  act(() => {
    estimates.below = 60
    virtualizer().refreshEstimates!(false)
  })

  expect(scroller.scrollTop).toBe(top)
  expect(placement()).toBe(-30)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
  view.unmount()
})

it('leaves the pixels to a caller that suppressed automatic adjustment', () => {
  const { scroller, view, virtualizer, estimates } = estimateHarness(100)
  const top = scroller.scrollTop

  act(() => {
    virtualizer().setAutomaticScrollAdjustmentEnabled!(false)
    estimates.above = 60
    virtualizer().refreshEstimates!(false)
  })

  expect(scroller.scrollTop).toBe(top)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
  view.unmount()
})

it('keeps a held anchor in place instead of the viewport top, and nothing for an absent one', () => {
  const held = estimateHarness(100)
  const anchorPlacement = () => held.virtualizer().getMessageStart!('row-25')! - held.scroller.scrollTop
  const before = anchorPlacement()
  act(() => {
    held.virtualizer().holdAnchor!('row-25')
    held.estimates.above = 60
    held.estimates.below = 60
    held.virtualizer().refreshEstimates!(false)
  })
  expect(anchorPlacement()).toBe(before)
  held.view.unmount()

  const absent = estimateHarness(100)
  const top = absent.scroller.scrollTop
  act(() => {
    absent.virtualizer().holdAnchor!('not-loaded')
    absent.estimates.above = 60
    absent.virtualizer().refreshEstimates!(false)
  })
  expect(absent.scroller.scrollTop).toBe(top)
  expect(absent.scroller.scrollTo).not.toHaveBeenCalled()
  absent.view.unmount()
})

it('leaves an animated scroll to its own target', () => {
  const { scroller, view, virtualizer, estimates } = estimateHarness(100)
  act(() => virtualizer().beginAnimatedScrollToOffset!(0))
  vi.mocked(scroller.scrollTo).mockClear()
  const top = scroller.scrollTop

  act(() => {
    estimates.above = 60
    virtualizer().refreshEstimates!(false)
  })

  expect(scroller.scrollTop).toBe(top)
  expect(scroller.scrollTo).not.toHaveBeenCalled()
  view.unmount()
})

// The real sampler, wired as MessageList wires it: only own hug-width bubbles are mounted, then
// an incoming row mounts during the backward scroll, its observer measures it, and the content
// width is resampled at full width.
it('keeps the reader in place when an own-only width sample gives way to the full width', async () => {
  const scroller = scrollerWithSpacer()
  const scrollRef = { current: scroller }
  const items = Array.from({ length: ROWS }, (_, index) => ({ key: `row-${index}` }))
  const indexById = new Map(items.map((item, index) => [item.key, index]))
  const handle: { current?: MessageVirtualizer } = {}
  const refreshes: boolean[] = []
  const nodes = new Map<number, HTMLElement>()
  const lines = (width: number) => Math.ceil(4000 / width)
  function Harness({ incoming }: { incoming: boolean }) {
    const metrics = useRowMetrics(scrollRef, first => {
      refreshes.push(first)
      handle.current!.refreshEstimates!(first)
    })
    const virtualizer = useTanstackMessageVirtualizer({
      items, indexById, scrollRef, sampleEstimateMetrics: metrics.sample,
      // A long text wraps onto more lines the narrower the sampled width.
      estimateSize: () => 22 * lines(metrics.metricsRef.current.contentWidthPx),
    })
    useLayoutEffect(() => { handle.current = virtualizer }, [virtualizer])
    const mounted = incoming ? [19, 20, 21, 22] : [20, 21, 22]
    return <div style={{ height: virtualizer.getTotalSize() }}>
      {mounted.map(index => (
        <div key={index} data-index={index} ref={node => {
          if (!node) return
          nodes.set(index, node)
          node.getBoundingClientRect = () => new DOMRect(0, 0, 800, 50)
          virtualizer.measureElement(node)
        }}>
          <div {...(index === 19 ? {} : { 'data-msg-own': '' })}>
            <div data-msg-text ref={node => {
              if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, value: index === 19 ? 888 : 44 })
            }}>{index === 19 ? 'An incoming message' : 'ok'}</div>
          </div>
        </div>
      ))}
    </div>
  }
  const view = render(<Harness incoming={false} />, { container: scroller })
  await act(async () => {})
  expect(refreshes).toEqual([true])
  const virtualizer = () => handle.current!
  const placement = () => virtualizer().getMessageStart!('row-21')! - scroller.scrollTop
  const readAt = () => virtualizer().getMessageStart!('row-21')! + 10
  act(() => {
    scroller.scrollTop = readAt() + 100
    scroller.dispatchEvent(new Event('scroll'))
  })
  act(() => {
    scroller.scrollTop = readAt()
    scroller.dispatchEvent(new Event('scroll'))
  })
  const before = placement()

  await act(async () => { view.rerender(<Harness incoming />) })
  const row = nodes.get(19)!
  await act(async () => {
    observers.get(row)!([
      { target: row, borderBoxSize: [{ blockSize: 50 }] } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver)
  })

  expect(refreshes).toEqual([true, false])
  expect(virtualizer().getMessageStart!('row-1')! - virtualizer().getMessageStart!('row-0')!)
    .toBe(22 * lines(888))
  expect(placement()).toBe(before)
  view.unmount()
})
