import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { DirectionalHistoryBrowserAdapter } from './directionalHistoryBrowserAdapter'
import type { PositionExecutionLease } from './positioningController'
import { pixelOffset, type DirectionalHistoryRequest } from './scrollPositionModel'
import { currentOwner } from './scrollWriteTestDoubles'

// Intent: the captain's report of jerky scrolling on mobile (FLM-174, FLM-180). On an iPhone
// (iOS 27.0.1) the older-history restore ran while the list was still in a drag-and-bounce tail.
// @tanstack/virtual-core 3.19.5+ queues a programmatic write during that tail and lands it ~100 ms
// later, so the list painted the new top rows and every row the reader was looking at left the
// screen (three device traces, 0 of 1, 9 and 8 rows kept). The restore owns the pixels once the
// batch lands, so it asks for the write to release the gesture tail. This drives the real library.

beforeEach(() => {
  vi.stubGlobal('CSS', { supports: () => true })
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
    configurable: true,
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

function bouncingList() {
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: 600 }, offsetWidth: { value: 800 },
    clientHeight: { value: 600 }, scrollHeight: { value: 60000 },
  })
  scroller.scrollTo = options => { scroller.scrollTop = (options as ScrollToOptions).top ?? 0 }
  const items = Array.from({ length: 1000 }, (_, index) => ({ key: `row-${index}` }))
  const hook = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById: new Map(items.map((item, index) => [item.key, index])),
    scrollRef: { current: scroller }, estimateSize: 60,
  }))
  // A finger drags the list, lifts, and the momentum keeps firing scroll events.
  scroller.dispatchEvent(new Event('touchstart'))
  scroller.scrollTop = 40
  scroller.dispatchEvent(new Event('scroll'))
  scroller.dispatchEvent(new Event('touchend'))
  scroller.scrollTop = 20
  scroller.dispatchEvent(new Event('scroll'))
  return { scroller, virtualizer: hook.result.current }
}

// Intent: FLM-219 / FLM-220 measured cancellation clamping iOS end overscroll on every
// touchmove. Use the observed 46px stretch; cancellation must drop work, not issue a new target.
it('leaves a held end pull untouched when the reader takes over', () => {
  const { scroller, virtualizer } = bouncingList()
  const paint = queuedFrames()
  scroller.dispatchEvent(new Event('touchstart'))
  const stretched = scroller.scrollHeight - scroller.clientHeight + 46
  scroller.scrollTop = stretched
  scroller.dispatchEvent(new Event('scroll'))
  const writer = vi.spyOn(scroller, 'scrollTo')
  act(() => {
    virtualizer.cancelPendingScroll?.()
    virtualizer.cancelPendingScroll?.()
  })
  paint()
  paint()
  expect(writer).not.toHaveBeenCalled()
  expect(scroller.scrollTop).toBe(stretched)
})

// Intent: FLM-331. Since FLM-329 a takeover drops the library's target outright. A row that grows
// above the reader while a finger is down is held, then written when the finger lifts; after a
// takeover that write must still land, or the rows the reader sees jump by the growth.
it('keeps the rows the reader sees still when the finger lifts after a takeover', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { scroller, virtualizer } = bouncingList()
  act(() => {
    scroller.dispatchEvent(new Event('touchstart'))
    scroller.scrollTop = 3000
    scroller.dispatchEvent(new Event('scroll'))
    virtualizer.cancelPendingScroll?.()
  })
  const onScreen = () => virtualizer.getVirtualItems().find(row => row.key === 'row-55')!.start - scroller.scrollTop
  const seen = onScreen()
  const above = scroller.appendChild(document.createElement('div'))
  above.dataset.index = '10'
  above.getBoundingClientRect = () => new DOMRect(0, 0, 800, 100)
  act(() => virtualizer.measureElement(above))
  expect(scroller.scrollTop, 'precondition: the library holds the growth while the finger is down').toBe(3000)
  act(() => {
    scroller.dispatchEvent(new Event('touchend'))
    vi.advanceTimersByTime(150) // the gesture tail closes
  })
  expect(scroller.scrollTop, 'the held 40px growth is written').toBe(3040)
  expect(onScreen()).toBe(seen)
})

function queuedFrames() {
  const frames: FrameRequestCallback[] = []
  const queue = (callback: FrameRequestCallback) => frames.push(callback)
  vi.stubGlobal('requestAnimationFrame', queue)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(queue)
  return () => act(() => { frames.splice(0).forEach(callback => callback(performance.now())) })
}

// FLM-186's failed jump may rebase an old fling only, never a new reader contact or a tap.
it('reports a pending fling only for motion after the finger has lifted', () => {
  const { scroller, virtualizer } = bouncingList()
  expect(virtualizer.hasPendingFling?.()).toBe(true)
  scroller.dispatchEvent(new Event('touchstart'))
  expect(virtualizer.hasPendingFling?.()).toBe(false)
  scroller.dispatchEvent(new Event('touchend'))
  expect(virtualizer.hasPendingFling?.()).toBe(false)
})

// Captain-approved FLM-231 F1: all callers share these command shapes. The app refuses
// reconcile writes with user movement. The first delayed write is still navigation; later
// layout reconciliation is not.
const queuedCommands = [
  { callers: 'live-edge / bottom-fraction end', kind: 'end', target: 999, offset: 59400 },
  { callers: 'explicit-target center', kind: 'center', target: 50, offset: 2730 },
  { callers: 'unread-marker start', kind: 'start', target: 50, offset: 3000 },
  { callers: 'ensureMessageMounted', kind: 'mount', target: 50, offset: 2730 },
  { callers: 'saved-position / resident-top / explicit-target / bottom-fraction offset', kind: 'offset', target: 50, offset: 3000 },
  { callers: 'animated offset', kind: 'smooth', target: 50, offset: 3000 },
] as const

it.each(queuedCommands)('keeps the queued $callers command as navigation after a prior cancel', command => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = bouncingList()
  act(() => virtualizer.cancelPendingScroll?.())
  const before = virtualizer.getVirtualItems().map(row => row.key)
  const sources: string[] = []
  const writer = vi.spyOn(scroller, 'scrollTo')
  act(() => {
    virtualizer.setScrollWriteObserver?.(write => {
      if (write.phase !== 'before') return
      sources.push(write.source)
      // Same refusal as the app's reconcile-plus-userDelta branch.
      if (write.source === 'reconcile') return false
    })
    if (command.kind === 'mount') void virtualizer.ensureMessageMounted(`row-${command.target}`)
    else if (command.kind === 'offset') virtualizer.scrollToOffset(command.offset)
    else if (command.kind === 'smooth') virtualizer.beginAnimatedScrollToOffset(command.offset)
    else virtualizer.scrollToIndex(command.target, { align: command.kind })
  })
  expect(writer).not.toHaveBeenCalled()
  expect(virtualizer.getVirtualItems().map(row => row.key)).toEqual(before)

  // Real virtual-core stops momentum and issues the queued command two frames later.
  paint()
  paint()
  expect(sources).toEqual(['navigation'])
  expect(writer).toHaveBeenCalledOnce()
  expect(scroller.scrollTop).toBe(command.offset)
  if (command.kind === 'smooth') {
    // Entry overscan grows after a paint; only an early destination window would be wrong.
    expect(virtualizer.getVirtualItems().some(row => row.key === `row-${command.target}`)).toBe(false)
    act(() => scroller.dispatchEvent(new Event('scroll')))
  }
  expect(virtualizer.getVirtualItems().some(row => row.key === `row-${command.target}`)).toBe(true)
})

it('does not mistake a queued navigation for reconciliation when the observer sees user movement', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = bouncingList()
  const sources: string[] = []
  act(() => {
    virtualizer.setScrollWriteObserver?.(write => {
      if (write.phase === 'before') {
        sources.push(write.source)
        if (write.source === 'reconcile') return false
      }
    })
    virtualizer.scrollToIndex(50, { align: 'center' })
  })
  paint()
  paint()
  expect(sources).toEqual(['navigation'])
  expect(scroller.scrollTop).toBe(2730)
  expect(virtualizer.getVirtualItems().some(row => row.key === 'row-50')).toBe(true)
})

it('does not give a cancelled queued target navigation authority', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = bouncingList()
  const writer = vi.spyOn(scroller, 'scrollTo')
  act(() => {
    virtualizer.scrollToIndex(50, { align: 'center' })
    virtualizer.cancelPendingScroll?.()
  })
  paint()
  paint()
  expect(writer).not.toHaveBeenCalled()
  expect(scroller.scrollTop).toBe(20)
  expect(virtualizer.getVirtualItems().some(row => row.key === 'row-50')).toBe(false)
})

it('gives only the replacement queued command navigation authority', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = bouncingList()
  const writer = vi.spyOn(scroller, 'scrollTo')
  act(() => {
    virtualizer.cancelPendingScroll?.()
    virtualizer.setScrollWriteObserver?.(write => {
      if (write.phase === 'before' && write.source === 'reconcile') return false
    })
    virtualizer.scrollToIndex(50, { align: 'center' })
    virtualizer.scrollToIndex(80, { align: 'center' })
  })
  paint()
  paint()
  expect(writer).toHaveBeenCalledOnce()
  expect(scroller.scrollTop).toBe(80 * 60 - (scroller.clientHeight - 60) / 2)
  expect(virtualizer.getVirtualItems().some(row => row.key === 'row-80')).toBe(true)
})

it('consumes queued navigation authority before later layout reconciliation', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = bouncingList()
  const sources: string[] = []
  act(() => {
    virtualizer.setAutomaticScrollAdjustmentEnabled?.(false)
    virtualizer.setScrollWriteObserver?.(write => {
      if (write.phase === 'before') {
        sources.push(write.source)
        if (write.source === 'reconcile') return false
      }
    })
    virtualizer.scrollToIndex(50, { align: 'center' })
  })
  paint()
  paint()
  const landed = scroller.scrollTop
  expect(sources).toEqual(['navigation'])
  const row = scroller.appendChild(document.createElement('div'))
  row.dataset.index = '0'
  row.getBoundingClientRect = () => new DOMRect(0, 0, 800, 100)
  act(() => virtualizer.measureElement(row))
  paint()
  expect(sources).toContain('reconcile')
  expect(sources.filter(source => source === 'navigation')).toHaveLength(1)
  expect(scroller.scrollTop).toBe(landed)
})

it('still runs a reader veto before a queued navigation writes', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = bouncingList()
  let vetoed = false
  act(() => {
    virtualizer.setScrollWriteObserver?.(write => {
      if (write.phase === 'before' && !vetoed) {
        vetoed = true
        virtualizer.cancelPendingScroll?.()
        return false
      }
    })
    virtualizer.scrollToIndex(50, { align: 'center' })
  })
  paint()
  paint()
  expect(vetoed).toBe(true)
  expect(scroller.scrollTop).toBe(20)
  expect(virtualizer.getVirtualItems().some(row => row.key === 'row-50')).toBe(false)
})

it('writes a restore that releases the gesture tail at once', () => {
  const { scroller, virtualizer } = bouncingList()
  virtualizer.scrollToOffset(1956, { releaseGesture: true })
  expect(scroller.scrollTop).toBe(1956)
})

it('still lets the library hold an ordinary write while the tail is open', () => {
  const { scroller, virtualizer } = bouncingList()
  virtualizer.scrollToOffset(1956)
  expect(scroller.scrollTop).toBe(20)
})

// Review FLM-182 F1: a restore the reader vetoed must not cost the reader's momentum its protection.
it('keeps the gesture tail open when the restore is refused', () => {
  const { scroller, virtualizer } = bouncingList()
  virtualizer.setScrollWriteObserver?.(({ phase }) => (phase === 'before' ? false : undefined))
  virtualizer.scrollToOffset(1956, { releaseGesture: true })
  expect(scroller.scrollTop).toBe(20)
  virtualizer.setScrollWriteObserver?.(undefined)
  virtualizer.scrollToOffset(1956)
  expect(scroller.scrollTop).toBe(20)
})

it('lands the restore on the requested offset, not a bounced one', () => {
  const { scroller, virtualizer } = bouncingList()
  scroller.scrollTop = -63
  virtualizer.scrollToOffset(2000, { releaseGesture: true })
  expect(scroller.scrollTop).toBe(2000)
})

// Review FLM-182 F1 and FLM-219: a production veto cancels the target without writing or
// releasing the reader's gesture. The next ordinary navigation must still wait for the tail.
it('cancels a refused restore without writing or releasing the reader gesture', () => {
  const { scroller, virtualizer } = bouncingList()
  const landed: number[] = []
  scroller.scrollTo = options => {
    const top = (options as ScrollToOptions).top ?? 0
    landed.push(top)
    scroller.scrollTop = top
  }
  virtualizer.setScrollWriteObserver?.(({ phase }) => {
    if (phase !== 'before') return undefined
    virtualizer.cancelPendingScroll?.()
    return false
  })
  virtualizer.scrollToOffset(1956, { releaseGesture: true })
  expect(landed).toEqual([])
  expect(scroller.scrollTop).toBe(20)
  virtualizer.setScrollWriteObserver?.(undefined)
  virtualizer.scrollToOffset(1956)
  expect(scroller.scrollTop).toBe(20)
})

/**
 * A history window of the real library behind the restore adapter, with its rows mounted the way
 * MessageList mounts them (a `data-index` wrapper around the message row), so the adapter captures
 * and restores exactly as in the app. `land` prepends older rows, as a batch from the server does.
 */
function historyWindow(scrollTop: number, options: { contentHeight?: 'fixed' | 'rows' } = {}) {
  const scroller = document.body.appendChild(document.createElement('div'))
  // 'rows' ends the scrollable range at the last row, as a browser does; 'fixed' leaves room below.
  let contentHeight = () => 60000
  Object.defineProperties(scroller, {
    offsetHeight: { value: 796 }, offsetWidth: { value: 440 },
    clientHeight: { value: 796 }, scrollHeight: { get: () => contentHeight() },
  })
  scroller.scrollTo = options => { scroller.scrollTop = (options as ScrollToOptions).top ?? 0 }
  const rowsFrom = (first: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ key: `message-${first + i}` }))
  const props = (items: { key: string }[]) => ({
    items, indexById: new Map(items.map((item, index) => [item.key, index])),
    scrollRef: { current: scroller }, estimateSize: 60,
  })
  const hook = renderHook(p => useTanstackMessageVirtualizer(p), { initialProps: props(rowsFrom(100, 200)) })
  if (options.contentHeight === 'rows') contentHeight = () => hook.result.current.getTotalSize()
  const mount = () => {
    scroller.replaceChildren()
    for (const item of hook.result.current.getVirtualItems()) {
      const wrapper = scroller.appendChild(document.createElement('div'))
      wrapper.dataset.index = String(item.index)
      const row = wrapper.appendChild(document.createElement('div'))
      row.dataset.messageId = item.key
    }
  }
  const scrollTo = (top: number) => {
    act(() => {
      scroller.scrollTop = top
      scroller.dispatchEvent(new Event('scroll'))
    })
    mount()
  }
  scrollTo(scrollTop)
  const adapter = new DirectionalHistoryBrowserAdapter({
    getScroller: () => scroller,
    getVirtualizer: () => hook.result.current,
    getActiveConversationId: () => 'room-a',
    beginLoop: () => null,
    requestFrame: () => 1,
    cancelFrame: () => {},
  })
  return {
    scroller, adapter, scrollTo, mount,
    virtualizer: () => hook.result.current,
    /** Where a row sits in the viewport, as rendered. */
    onScreen: (key: string) =>
      hook.result.current.getVirtualItems().find(item => item.key === key)!.start - scroller.scrollTop,
    land: (older: number) => act(() => hook.rerender(props(rowsFrom(100 - older, 200 + older)))),
    /** Newer rows land at the resident cap: as many of the oldest rows leave. */
    landNewer: (newer: number) => act(() => hook.rerender(props(rowsFrom(100 + newer, 200)))),
  }
}

const lease: PositionExecutionLease = {
  conversationId: 'room-a', generation: 1, operation: 1, frameBudget: 60,
  signal: new AbortController().signal, isCurrent: () => true, owner: currentOwner(), markApplied: () => true, settle: () => true,
}
const restoreRequest = (messageId: string, offsetPx: number): DirectionalHistoryRequest => ({
  generation: 1, conversationId: 'room-a',
  source: { kind: 'history-preservation', reason: 'window-shift' },
  desired: { kind: 'anchor', messageId, placement: { kind: 'top-offset', offsetPx: pixelOffset(offsetPx) } },
  onUnavailable: { kind: 'distance-from-bottom', distancePx: pixelOffset(0) },
})

// Intent: FLM-185, kept rows landing up to 99 px from where the reader last saw them after an
// older-history load on an iPhone. In the FLM-176 device trace a load was captured 12 px into the
// bounce past the top, the bounce reached 114 px before the batch landed, and the landing commit
// read scrollTop 0. The reader can also scroll on during a load. Either way the rows stay where
// the reader last saw them.
it.each([
  { case: 'the bounce deepens', start: -12, last: -114 },
  { case: 'the reader scrolls on', start: 300, last: 180 },
])('lands the anchor where the reader last saw it when $case before the batch', ({ start, last }) => {
  const list = historyWindow(start)
  const anchor = list.adapter.capture('message-100', 200)!.anchor!
  list.scrollTo(last)
  list.adapter.observeScroll()
  const lastSeen = list.onScreen(anchor.id)

  list.land(100)
  list.scroller.scrollTop = 0
  list.adapter.observeScroll()
  list.adapter.createExecutor(vi.fn()).positionFrame(restoreRequest(anchor.id, anchor.offsetFromTop), lease)
  list.mount()

  expect(Math.abs(list.onScreen(anchor.id) - lastSeen)).toBeLessThanOrEqual(1)
})

// Intent: FLM-185 review finding R1. A reader at the end of the list, where the anchor row starts
// past the scrollable range, scrolls it out of the rendered window before newer history lands at
// the resident cap. The clamped offset lookup read its start short by that overhang, so the
// restore landed the anchor off by the same amount.
it('lands an anchor from the final viewport where the reader last saw it after newer history lands', () => {
  const list = historyWindow(0, { contentHeight: 'rows' })
  const maxScrollTop = list.virtualizer().getTotalSize() - 796
  list.scrollTo(maxScrollTop)
  const anchor = list.adapter.capture('message-100', 200)!.anchor!
  const layoutStart = () => list.virtualizer().getMessageStart!(anchor.id)!
  expect(layoutStart(), 'precondition: the anchor starts past the scrollable range').toBeGreaterThan(maxScrollTop)

  list.scrollTo(maxScrollTop - 2200)
  expect(
    list.virtualizer().getVirtualItems().some(item => item.key === anchor.id),
    'precondition: the reader scrolled the anchor out of the rendered window',
  ).toBe(false)
  list.adapter.observeScroll()
  const lastSeen = layoutStart() - list.scroller.scrollTop

  list.landNewer(50)
  list.adapter.observeScroll()
  list.adapter.createExecutor(vi.fn()).positionFrame(restoreRequest(anchor.id, anchor.offsetFromTop), lease)

  expect(Math.abs(layoutStart() - list.scroller.scrollTop - lastSeen)).toBeLessThanOrEqual(1)
})

// Intent: FLM-185. After the restore write, rows between the viewport top and the anchor measured
// 22 px taller than their estimate and pushed the anchor down; the reader's next touch ended the
// restore before its next frame corrected it. The anchor now stays in the same task.
it('keeps the restored anchor still when a row above it in view measures taller', () => {
  // Bounced past the top, the window's first message is on screen and the anchor is the row after
  // it. Once the batch lands, that first message sits between the viewport top and the anchor.
  const list = historyWindow(-12)
  const anchor = list.adapter.capture('message-100', 200)!.anchor!
  expect(anchor.id).toBe('message-101')
  list.land(100)
  list.scroller.scrollTop = 0
  const executor = list.adapter.createExecutor(vi.fn())
  executor.positionFrame(restoreRequest(anchor.id, anchor.offsetFromTop), lease)
  list.mount()
  const restored = list.onScreen(anchor.id)
  expect(list.onScreen('message-100')).toBeGreaterThanOrEqual(0)

  const between = list.virtualizer().getVirtualItems().find(item => item.key === 'message-100')!
  const row = list.scroller.querySelector(`[data-index="${between.index}"]`) as HTMLElement
  row.getBoundingClientRect = () => new DOMRect(0, 0, 440, between.size + 22)
  act(() => list.virtualizer().measureElement(row))
  expect(list.onScreen(anchor.id)).toBe(restored)
  executor.complete(restoreRequest(anchor.id, anchor.offsetFromTop), 'user-takeover')
})
