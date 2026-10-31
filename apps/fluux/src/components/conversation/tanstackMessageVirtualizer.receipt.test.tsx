import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import type { ScrollWrite, ScrollWriteOwner } from './messageVirtualizer'
import {
  PositioningController,
  type ExplicitTargetExecutor,
  type LiveEdgeExecutor,
  type PositionExecutionLease,
} from './positioningController'
import type { ReachabilityFacts } from './scrollPositionModel'

// Intent: FLM-319 (captain-approved direction A). scrollToOffset and scrollToIndex return a receipt
// that reads applied (with the offset the browser read back), queued (the library holds the write
// for an iOS fling) or refused (with a reason), and a held write whose request was superseded is
// refused and never written. These drive the real @tanstack/virtual-core with the iPhone fling the
// FLM-174/180 traces came from, as tanstackMessageVirtualizer.iosBounce.test.tsx does.

const MAX_SCROLL = 59400

beforeEach(() => {
  vi.stubGlobal('CSS', { supports: () => true })
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
    configurable: true,
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

function list(options: { flinging: boolean }) {
  const scroller = document.body.appendChild(document.createElement('div'))
  Object.defineProperties(scroller, {
    offsetHeight: { value: 600 }, offsetWidth: { value: 800 },
    clientHeight: { value: 600 }, scrollHeight: { value: 60000 },
  })
  // The browser clamps a write to the scrollable range.
  scroller.scrollTo = o => { scroller.scrollTop = Math.min(MAX_SCROLL, Math.max(0, (o as ScrollToOptions).top ?? 0)) }
  const items = Array.from({ length: 1000 }, (_, index) => ({ key: `row-${index}` }))
  const hook = renderHook(() => useTanstackMessageVirtualizer({
    items, indexById: new Map(items.map((item, index) => [item.key, index])),
    scrollRef: { current: scroller }, estimateSize: 60,
  }))
  if (options.flinging) {
    scroller.dispatchEvent(new Event('touchstart'))
    scroller.scrollTop = 40
    scroller.dispatchEvent(new Event('scroll'))
    scroller.dispatchEvent(new Event('touchend'))
    scroller.scrollTop = 20
    scroller.dispatchEvent(new Event('scroll'))
  }
  return { scroller, virtualizer: hook.result.current }
}

function queuedFrames() {
  const frames: FrameRequestCallback[] = []
  const queue = (callback: FrameRequestCallback) => frames.push(callback)
  vi.stubGlobal('requestAnimationFrame', queue)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(queue)
  return () => act(() => { frames.splice(0).forEach(callback => callback(performance.now())) })
}

const owner = () => {
  const state = { current: true }
  const value: ScrollWriteOwner = { conversationId: 'room-a', generation: 3, isCurrent: () => state.current }
  return { state, value }
}

it('N1: an immediate write reads applied with the offset the browser clamped to', () => {
  const { scroller, virtualizer } = list({ flinging: false })
  const write = virtualizer.scrollToOffset(999_999)
  expect(scroller.scrollTop).toBe(MAX_SCROLL)
  expect(write.outcome()).toEqual({ status: 'applied', offset: MAX_SCROLL })
  expect(virtualizer.scrollToIndex(50, { align: 'start' }).outcome()).toEqual({ status: 'applied', offset: scroller.scrollTop })
})

const heldCommands = [
  { name: 'end', offset: 59400, issue: (v: ReturnType<typeof list>['virtualizer']) => v.scrollToIndex(999, { align: 'end' }) },
  { name: 'center', offset: 2730, issue: (v: ReturnType<typeof list>['virtualizer']) => v.scrollToIndex(50, { align: 'center' }) },
  { name: 'start', offset: 3000, issue: (v: ReturnType<typeof list>['virtualizer']) => v.scrollToIndex(50, { align: 'start' }) },
  { name: 'offset', offset: 3000, issue: (v: ReturnType<typeof list>['virtualizer']) => v.scrollToOffset(3000) },
]

it.each(heldCommands)('N2: a $name write held for the fling reads queued, then applied with the landed offset', command => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = list({ flinging: true })
  let write!: ScrollWrite
  act(() => { write = command.issue(virtualizer) })
  expect(scroller.scrollTop).toBe(20)
  expect(write.outcome()).toEqual({ status: 'queued' })
  paint()
  paint()
  expect(scroller.scrollTop).toBe(command.offset)
  expect(write.outcome()).toEqual({ status: 'applied', offset: command.offset })
  expect(write.outcome()).toEqual({ status: 'applied', offset: command.offset })
})

it('N3: a held write the library drops when the reader catches the fling reads refused, dropped', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = list({ flinging: true })
  const writer = vi.spyOn(scroller, 'scrollTo')
  let write!: ScrollWrite
  act(() => { write = virtualizer.scrollToIndex(50, { align: 'center' }) })
  expect(write.outcome()).toEqual({ status: 'queued' })
  // A finger comes down on the moving list: virtual-core cancels the command it was holding.
  act(() => { scroller.dispatchEvent(new Event('touchstart')) })
  scroller.scrollTop = 25
  act(() => { scroller.dispatchEvent(new Event('scroll')) })
  paint()
  paint()
  expect(writer).not.toHaveBeenCalled()
  expect(write.outcome()).toEqual({ status: 'refused', reason: 'dropped' })
})

it('N4: a restore the reader vetoes reads refused, reader, and the fling stays open', () => {
  const { scroller, virtualizer } = list({ flinging: true })
  virtualizer.setScrollWriteObserver?.(({ phase }) => (phase === 'before' ? false : undefined))
  const write = virtualizer.scrollToOffset(1956, { releaseGesture: true })
  expect(write.outcome()).toEqual({ status: 'refused', reason: 'reader' })
  expect(virtualizer.hasPendingFling?.()).toBe(true)
  expect(scroller.scrollTop).toBe(20)
})

it('N4: an immediate write the reader vetoes reads refused, reader', () => {
  const { virtualizer } = list({ flinging: false })
  virtualizer.setScrollWriteObserver?.(({ phase }) => (phase === 'before' ? false : undefined))
  expect(virtualizer.scrollToOffset(1956).outcome()).toEqual({ status: 'refused', reason: 'reader' })
})

it('N5: a held write whose owner was superseded reads refused, superseded, and never writes', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = list({ flinging: true })
  const writer = vi.spyOn(scroller, 'scrollTo')
  const request = owner()
  let write!: ScrollWrite
  act(() => { write = virtualizer.scrollToIndex(50, { align: 'center', owner: request.value }) })
  expect(write.outcome()).toEqual({ status: 'queued' })
  request.state.current = false
  paint()
  paint()
  paint()
  expect(writer).not.toHaveBeenCalled()
  expect(scroller.scrollTop).toBe(20)
  expect(write.outcome()).toEqual({ status: 'refused', reason: 'superseded' })
})

it('N5: a write whose owner is already superseded is refused before it touches the fling', () => {
  const { scroller, virtualizer } = list({ flinging: true })
  const request = owner()
  request.state.current = false
  const write = virtualizer.scrollToOffset(1956, { releaseGesture: true, owner: request.value })
  expect(write.outcome()).toEqual({ status: 'refused', reason: 'superseded' })
  expect(virtualizer.hasPendingFling?.()).toBe(true)
  expect(scroller.scrollTop).toBe(20)
})

it('N5: a newer write replaces a held one, which reads refused, superseded', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = list({ flinging: true })
  let older!: ScrollWrite
  let newer!: ScrollWrite
  act(() => {
    older = virtualizer.scrollToIndex(50, { align: 'start' })
    newer = virtualizer.scrollToIndex(80, { align: 'start' })
  })
  paint()
  paint()
  expect(older.outcome()).toEqual({ status: 'refused', reason: 'superseded' })
  expect(newer.outcome()).toEqual({ status: 'applied', offset: scroller.scrollTop })
})

it('N7: an applied receipt without an offset does not compile', () => {
  // @ts-expect-error applied carries the offset the browser read back
  const outcome: ReturnType<ScrollWrite['outcome']> = { status: 'applied' }
  expect(outcome.status).toBe('applied')
})

// N6: the owner a real controller lease hands out follows the request, so a jump held for the fling
// never lands once a newer jump (here one that is still waiting for its history) owns the list.
it('N6: a held jump replaced by a newer jump never lands', () => {
  const paint = queuedFrames()
  const { scroller, virtualizer } = list({ flinging: true })
  const writer = vi.spyOn(scroller, 'scrollTo')
  const conversationId = 'room@example.test'
  const mounted: ReachabilityFacts = { kind: 'available', index: 4, mounted: true, placement: 'viable' }
  const leases: PositionExecutionLease[] = []
  const loop = { schedule: () => {}, recordFrame: () => {}, finish: () => {} }
  const explicit = (): ExplicitTargetExecutor => ({
    reachability: () => mounted,
    beginLoop: lease => { leases.push(lease); return loop },
    observeGeometry: () => 0,
    positionFrame: () => ({ kind: 'positioned', scrollTop: 400, wrote: true }),
    complete: vi.fn(),
  })
  const controller = new PositioningController()
  const liveEdge: LiveEdgeExecutor = {
    reachability: () => ({ kind: 'global-live-edge', state: { kind: 'resident-tail', index: 9, mounted: true } }),
    beginLoop: () => loop,
    positionFrame: () => ({ kind: 'positioned', scrollTop: 1000, atLiveEdge: true, wrote: true, reassert: true }),
    complete: vi.fn(),
  }
  controller.beginLiveEdgeEntry({ conversationId, entryFacts: { syncedLiveEdge: false }, executor: liveEdge })

  const first = explicit()
  expect(controller.beginExplicitTarget({ conversationId, messageId: 'first-jump', executor: first })).not.toBeNull()
  const firstLease = leases.at(-1)!
  let held!: ScrollWrite
  act(() => { held = virtualizer.scrollToIndex(50, { align: 'center', owner: firstLease.owner }) })
  expect(held.outcome()).toEqual({ status: 'queued' })

  const waitingForHistory: ExplicitTargetExecutor = { ...explicit(), reachability: () => ({ kind: 'target-absent', loadAround: 'loading' }) }
  controller.beginExplicitTarget({ conversationId, messageId: 'jump-awaiting-history', executor: waitingForHistory })
  expect(firstLease.owner.isCurrent()).toBe(false)

  paint()
  paint()
  paint()
  expect(writer).not.toHaveBeenCalled()
  expect(scroller.scrollTop).toBe(20)
  expect(held.outcome()).toEqual({ status: 'refused', reason: 'superseded' })
})
