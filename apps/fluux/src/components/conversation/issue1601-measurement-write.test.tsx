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
