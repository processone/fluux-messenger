// Intent: issue #1601. A reader movement published after a measurement was computed must survive
// the measurement's write, even when the reader's takeover cancels the pending target.
// Replays a delayed geometry publication at the adapter write boundary (real TanStack core).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { ViewportSession } from './viewportSession'

const fixture = {
  "source": "e2e/scroll-reading.ts invariant-14e, WebKit on macOS; real local geometry",
  "geometry": {
    "scrollTop": 6395,
    "scrollHeight": 11956,
    "clientHeight": 532,
    "rows": [
      {
        "index": 101,
        "key": "stress-0-99",
        "height": 72
      },
      {
        "index": 102,
        "key": "delayed-arrival-0",
        "height": 446
      }
    ]
  },
  "observation": {
    "trackedId": "stress-0-114",
    "beforeTop": 351,
    "afterTop": -249,
    "drift": 600,
    "allInsertedAboveViewport": true,
    "residentCountBefore": 200,
    "residentCountAfter": 201,
    "scrollTopBefore": 5839,
    "scrollTopAfter": 6995,
    "scrollTopBeforeTakeover": 6395,
    "tailAtResidentEnd": false
  }
}
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it.each(['before-measure', 'before-write'] as const)('#1601: keeps the reader movement published at %s', publication => {
  const { geometry: g, observation: o } = fixture
  const normal = g.rows.find((r: {key: string}) => r.key === 'stress-0-99')!
  const tall = g.rows.find((r: {key: string}) => r.key === 'delayed-arrival-0')!
  const growth = tall.height - normal.height
  const wheel = o.scrollTopAfter - o.scrollTopBeforeTakeover
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: g.clientHeight }, offsetWidth: { value: 800 },
    clientHeight: { value: g.clientHeight }, scrollHeight: { value: g.scrollHeight },
  })
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    scroller.scrollTop = typeof options === 'object' ? options.top ?? 0 : 0
  }) as typeof scroller.scrollTo
  // Minimal real-data replay: resident count and measured heights come from invariant-14e.
  // Uniform estimates deliberately omit app-level policy; the real TanStack core remains in use.
  const items = Array.from({ length: o.residentCountAfter }, (_, i) => ({key: `stress-0-${i}`}))
  const indexById = new Map(items.map((item, i) => [item.key, i]))
  const { result } = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById, scrollRef: { current: scroller }, estimateSize: normal.height,
  }))
  act(() => result.current.scrollToOffset(g.scrollTop))
  const session = new ViewportSession('room')
  const geometry = () => ({ top: scroller.scrollTop, height: g.scrollHeight, client: g.clientHeight })
  session.recordProgrammaticWrite('room', 0, geometry())
  let published = false
  let takeovers = 0
  let measurementAfter = 0
  act(() => result.current.setScrollWriteObserver?.(write => {
    if (write.phase === 'after') {
      if (write.source === 'measurement') measurementAfter++
      session.recordProgrammaticWrite('room', 0, geometry())
      return
    }
    // Models the compositor publishing a completed wheel after the pre-measure read.
    // This is a controlled replay, NOT a claim that a natural wheel hit this schedule here.
    if (publication === 'before-write' && write.phase === 'before' && write.source === 'measurement' && published === false) {
      published = true
      scroller.scrollTop += wheel
    }
    const movement = session.observeGeometry('room', geometry(), { now: 0, controllerOwnsPixels: false })
    if (movement?.userDelta) {
      takeovers++
      result.current.cancelPendingScroll?.()
      return false
    }
  }))
  if (publication === 'before-measure') scroller.scrollTop += wheel
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = '1'
  row.getBoundingClientRect = () => new DOMRect(0, 0, 800, tall.height)
  act(() => result.current.measureElement(row))
  expect(takeovers).toBe(1)
  expect(measurementAfter).toBe(1)
  expect(scroller.scrollTop, 'a cancelled measurement must preserve the published reader movement and apply growth once').toBe(g.scrollTop + wheel + growth)
})

// Intent: issue #1601, successive measurements after a cancelled target. A target cancelled by the
// reader's takeover must not rewrite later measurements: each counts its growth once on the position
// the reader holds at that write.
it('#1601: applies each successive measurement once on the reader position after a cancelled target', () => {
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: 532 }, offsetWidth: { value: 800 },
    clientHeight: { value: 532 }, scrollHeight: { value: 11956 },
  })
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    scroller.scrollTop = typeof options === 'object' ? options.top ?? 0 : 0
  }) as typeof scroller.scrollTo
  const items = Array.from({ length: 201 }, (_, i) => ({ key: `row-${i}` }))
  const indexById = new Map(items.map((item, i) => [item.key, i]))
  const { result } = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById, scrollRef: { current: scroller }, estimateSize: 72,
  }))
  act(() => result.current.scrollToOffset(6395))
  const readerMovesTo = (top: number) => act(() => {
    scroller.scrollTop = top
    result.current.scrollToOffset(top)
    result.current.cancelPendingScroll?.() // the takeover cancels the target again
  })
  const measure = (index: number, height: number) => {
    const row = scroller.appendChild(document.createElement('div'))
    row.dataset.index = String(index)
    row.getBoundingClientRect = () => new DOMRect(0, 0, 800, height)
    act(() => result.current.measureElement(row))
  }
  readerMovesTo(6995)
  measure(1, 446) // +374
  expect(scroller.scrollTop).toBe(6995 + 374)
  readerMovesTo(scroller.scrollTop + 100)
  measure(2, 172) // +100
  expect(scroller.scrollTop).toBe(6995 + 374 + 100 + 100)
})

// Intent: issue #1601 / FLM-70 direction B. The write keeps TanStack's approval honest against the
// reader's live position, and a destination or row decided before the reader took over is void.
function harness(opts: { count?: number; estimate?: number; clientHeight?: number; scrollHeight?: number } = {}) {
  const scroller = document.body.appendChild(document.createElement('div'))
  const dims = { clientHeight: opts.clientHeight ?? 600, scrollHeight: opts.scrollHeight ?? 5000 }
  Object.defineProperties(scroller, {
    offsetHeight: { get: () => dims.clientHeight }, offsetWidth: { value: 800 },
    clientHeight: { get: () => dims.clientHeight }, scrollHeight: { get: () => dims.scrollHeight },
  })
  scroller.scrollTo = vi.fn((o?: ScrollToOptions | number) => {
    const top = typeof o === 'object' ? o.top ?? 0 : 0
    scroller.scrollTop = Math.max(0, Math.min(top, dims.scrollHeight - dims.clientHeight))
  }) as typeof scroller.scrollTo
  const make = (keys: string[]) => {
    const items = keys.map(key => ({ key }))
    return { items, indexById: new Map(items.map((item, i) => [item.key, i])) }
  }
  const keys = Array.from({ length: opts.count ?? 50 }, (_, i) => `row-${i}`)
  const hook = renderHook((props: { keys: string[] }) => useTanstackMessageVirtualizer({
    ...make(props.keys), scrollRef: { current: scroller }, estimateSize: opts.estimate ?? 100,
  }), { initialProps: { keys } })
  const measure = (index: number, height: number, inAct = true) => {
    const row = scroller.appendChild(document.createElement('div'))
    row.dataset.index = String(index)
    row.getBoundingClientRect = () => new DOMRect(0, 0, 800, height)
    if (inAct) act(() => hook.result.current.measureElement(row))
    else hook.result.current.measureElement(row)
  }
  const lib = () => hook.result.current as unknown as Record<string, unknown>
  return { scroller, dims, hook, measure, lib }
}

it('#1601 R1: drops a +300 approved for a row that the reader has since moved above', () => {
  const { scroller, hook, measure } = harness()
  act(() => hook.result.current.scrollToOffset(500))
  act(() => hook.result.current.setScrollWriteObserver?.(write => {
    if (write.phase === 'before' && write.source === 'measurement') scroller.scrollTop = 100
  }))
  measure(4, 400) // row 4 starts at 400, above the reader at 500 when TanStack approves, below it at 100
  expect(scroller.scrollTop).toBe(100)
})

it('#1601 R2: a rebased write that the spacer clamps is recovered once the spacer grows', () => {
  const { scroller, dims, hook, measure } = harness({ scrollHeight: 1600 }) // max scrollTop 1000
  act(() => hook.result.current.scrollToOffset(500))
  act(() => hook.result.current.setScrollWriteObserver?.(write => {
    if (write.phase === 'before' && write.source === 'measurement') scroller.scrollTop = 850
  }))
  measure(4, 400) // +300 on 850 asks for 1150; the element holds 1000 until its spacer grows
  expect(scroller.scrollTop).toBe(1000)
  dims.scrollHeight = 1900
  act(() => hook.result.current.refreshEstimates?.(true))
  act(() => { scroller.dispatchEvent(new Event('scroll')) })
  expect(scroller.scrollTop).toBe(1150)
})

it('#1601 R3: a destination cancelled while the observer looks is not written', () => {
  const { scroller, hook } = harness()
  act(() => hook.result.current.scrollToOffset(500))
  let cancelled = false
  act(() => hook.result.current.setScrollWriteObserver?.(write => {
    if (write.phase === 'before' && write.source === 'navigation' && !cancelled) {
      cancelled = true
      scroller.scrollTop = 520 // the reader took over
      hook.result.current.cancelPendingScroll?.()
    }
  }))
  act(() => hook.result.current.scrollToOffset(3000))
  expect(scroller.scrollTop).toBe(520)
})

it('#1601 R3: a measurement of a row from the previous conversation adds nothing to the new one', () => {
  const { scroller, hook, measure } = harness()
  act(() => hook.result.current.scrollToOffset(500))
  act(() => hook.result.current.setScrollWriteObserver?.(write => {
    if (write.phase === 'before' && write.source === 'measurement') {
      hook.rerender({ keys: Array.from({ length: 50 }, (_, i) => `other-${i}`) }) // conversation switched
    }
  }))
  measure(2, 400, false) // outside act so the switch renders while the write is in flight
  expect(scroller.scrollTop).toBe(500)
})

it('#1601 R1: drops a re-measure +300 for a row that spans the reader after the reader moves up', () => {
  const { scroller, hook, measure } = harness()
  act(() => hook.result.current.scrollToOffset(1000))
  measure(4, 90, false) // row 4 (400-490) is now measured: its next size change is a re-measure
  act(() => hook.result.current.scrollToOffset(500))
  act(() => hook.result.current.setScrollWriteObserver?.(write => {
    if (write.phase === 'before' && write.source === 'measurement') scroller.scrollTop = 450
  }))
  measure(4, 390) // entirely above 500 when TanStack approves; spans the reader at 450
  expect(scroller.scrollTop).toBe(450)
})
