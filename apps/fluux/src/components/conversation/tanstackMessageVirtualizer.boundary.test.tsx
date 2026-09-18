import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { ViewportSession } from './viewportSession'
import { LiveEdgeBrowserAdapter } from './liveEdgeBrowserAdapter'
import { PositioningController } from './positioningController'
import { deriveEntryPositionFacts } from './scrollPositionFacts'
import { getScrollShadowSnapshot, resetScrollShadowDiagnostics } from './scrollPositionShadow'

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
beforeEach(() => {
  resetScrollShadowDiagnostics()
  frames = new Map()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

function fixture({
  count = 80,
  size = 20,
  client = 400,
  height = 4000,
  initialMeasurements,
}: {
  count?: number
  size?: number
  client?: number
  height?: number
  initialMeasurements?: ReadonlyMap<string, number>
} = {}) {
  const scroller = document.body.appendChild(document.createElement('div'))
  vi.spyOn(scroller.ownerDocument.defaultView!, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.spyOn(scroller.ownerDocument.defaultView!, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  Object.defineProperties(scroller, {
    offsetHeight: { value: client }, offsetWidth: { value: 800 },
    clientHeight: { value: client }, scrollHeight: { get: () => height },
  })
  scroller.scrollTo = options => { scroller.scrollTop = (options as ScrollToOptions).top ?? 0 }
  const items = Array.from({ length: count }, (_, index) => ({ key: `row-${index}` }))
  const measured = vi.fn()
  const hook = renderHook(({ items }) => {
    const indexById = new Map(items.map((item, index) => [item.key, index]))
    return useTanstackMessageVirtualizer({
      items, indexById, scrollRef: { current: scroller }, estimateSize: size, onMeasured: measured, initialMeasurements,
    })
  }, { initialProps: { items } })
  const measure = (index: number, height: number) => {
    const row = scroller.appendChild(document.createElement('div'))
    row.dataset.index = String(index)
    Object.defineProperty(row, 'offsetHeight', { value: height })
    act(() => hook.result.current.measureElement(row))
  }
  return {
    ...hook,
    items,
    scroller,
    measure,
    measured,
    prepend: (keys: string[]) => hook.rerender({ items: [...keys.map(key => ({ key })), ...items] }),
    grow: (amount: number) => { height += amount },
  }
}

it('measures a seeded row at its rendered height, not the seed', () => {
  const scope = fixture({ initialMeasurements: new Map([['row-3', 72]]) })
  expect(scope.result.current.getTotalSize()).toBe(80 * 20 + 52)

  scope.measure(3, 68)

  expect(scope.result.current.getVirtualItems().find(row => row.key === 'row-3')?.size).toBe(68)
  expect(scope.result.current.getTotalSize()).toBe(80 * 20 + 48)
})

it('measures a re-rendered row at its new height, not the cached one', () => {
  const scope = fixture()
  scope.measure(3, 72)
  expect(scope.result.current.getVirtualItems().find(row => row.key === 'row-3')?.size).toBe(72)

  scope.measure(3, 68)

  expect(scope.result.current.getVirtualItems().find(row => row.key === 'row-3')?.size).toBe(68)
})

it('retains a selected resident row outside the recalculated overscan', () => {
  const scope = fixture()
  act(() => {
    scope.result.current.scrollToOffset(800)
    scope.result.current.setAutomaticScrollAdjustmentEnabled!(false)
    scope.result.current.retainMessage?.('row-59')
  })
  expect(scope.result.current.getVirtualItems().some(row => row.key === 'row-59')).toBe(true)
  scope.measure(41, 1200)
  expect(scope.result.current.getVirtualItems().some(row => row.key === 'row-59')).toBe(true)
  expect(scope.scroller.scrollTop).toBe(800)
  act(() => scope.result.current.retainMessage?.(null))
  expect(scope.result.current.getVirtualItems().some(row => row.key === 'row-59')).toBe(false)
})

it('retains the selected row when prepended history shifts its index', () => {
  const scope = fixture()
  act(() => {
    scope.result.current.scrollToOffset(800)
    scope.result.current.retainMessage?.('row-10')
  })
  expect(scope.result.current.getVirtualItems().some(row => row.key === 'row-10')).toBe(true)

  act(() => scope.prepend(['older-0', 'older-1', 'older-2', 'older-3', 'older-4']))

  expect(scope.result.current.getIndexForMessageId('row-10')).toBe(15)
  expect(scope.result.current.getVirtualItems().some(row => row.key === 'row-10')).toBe(true)
})

it('attributes navigation reconciler writes before the next session observation', () => {
  const scope = fixture()
  const session = new ViewportSession('room')
  const geometry = () => ({ top: scope.scroller.scrollTop, height: 4000, client: 400 })
  const sources: string[] = []
  act(() => {
    scope.result.current.setScrollWriteObserver?.(write => {
      if (write.phase === 'after') {
        sources.push(write.source)
        session.recordProgrammaticWrite('room', 1000, geometry())
      }
    })
    scope.result.current.scrollToIndex(59, { align: 'center' })
    scope.result.current.setAutomaticScrollAdjustmentEnabled!(false)
  })
  session.recordProgrammaticWrite('room', 1000, geometry())
  const before = scope.scroller.scrollTop
  sources.length = 0
  scope.measure(41, 100)
  expect(scope.result.current.getTotalSize()).toBe(1680)
  act(() => {
    const callbacks = [...frames.entries()]
    for (const [id, callback] of callbacks) if (frames.delete(id)) callback(0)
  })
  expect(scope.scroller.scrollTop).toBe(before + 80)
  expect(sources).toContain('reconcile')
  expect(session.observeGeometry('room', geometry(), { now: 1020, controllerOwnsPixels: true })?.userDelta).toBe(0)
})

it('retires the selected index reconciler when the reader takes over', () => {
  const scope = fixture()
  act(() => {
    scope.result.current.retainMessage?.('row-59')
    scope.result.current.scrollToIndex(59, { align: 'center' })
    scope.result.current.setAutomaticScrollAdjustmentEnabled!(false)
    scope.scroller.scrollTop -= 50
    scope.result.current.retainMessage?.(null)
  })
  const userTop = scope.scroller.scrollTop
  scope.measure(41, 100)
  expect(scope.result.current.getTotalSize()).toBe(1680)
  act(() => {
    for (const [id, callback] of [...frames.entries()]) if (frames.delete(id)) callback(0)
  })
  expect(scope.scroller.scrollTop).toBe(userTop)
})


it.each([false, true])('actual TanStack entry/index lifecycle with takeover retirement enabled: %s', retire => {
  const scope = fixture({ count: 50, size: 100, client: 500, height: 5000 })
  const controller = new PositioningController(undefined, undefined,
    retire ? () => scope.result.current.cancelPendingScroll?.() : undefined)
  const session = new ViewportSession('room')
  const geometry = () => ({ top: scope.scroller.scrollTop, height: scope.scroller.scrollHeight, client: 500 })
  const record = () => { session.recordProgrammaticWrite('room', 1000, geometry()) }
  const observe = () => {
    const movement = session.observeGeometry('room', geometry(), { now: 1000, controllerOwnsPixels: true })
    if (movement?.userDelta) controller.observeUserScroll('room', movement.userDelta, false)
  }
  let controllerFrame: (() => void) | undefined
  const adapter = new LiveEdgeBrowserAdapter({
    getScroller: () => scope.scroller,
    getVirtualizer: () => scope.result.current,
    getActiveConversationId: () => 'room',
    getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
    isLoadingOlder: () => false,
    beginLoop: () => ({
      schedule: callback => { controllerFrame = callback }, recordFrame() {},
      finish: () => { controllerFrame = undefined },
    }),
    setMeasuredAtBottom() {}, observeGeometry: observe, recordProgrammaticWrite: record,
    readRepaintMode: () => 'off', now: () => 1000,
  })
  act(() => {
    scope.result.current.setScrollWriteObserver?.(write => { if (write.phase === 'after') record() })
    scope.result.current.setAutomaticScrollAdjustmentEnabled?.(false)
    const request = controller.beginLiveEdgeEntry({
      conversationId: 'room',
      entryFacts: deriveEntryPositionFacts({ syncedLiveEdge: false, savedAnchor: null, savedOffsetPx: null }),
      executor: adapter.createExecutor({ trigger: 'new-message', rememberBottomIntent() {}, canRecenter: false }),
    })
    expect(request).not.toBeNull()
  })
  expect(scope.scroller.scrollTop).toBe(4500)
  expect(controllerFrame).toBeDefined()
  act(() => { scope.scroller.scrollTop = 1000; observe() })
  expect(controller.snapshot().active).toBeNull()
  expect(controllerFrame).toBeUndefined()
  scope.grow(100)
  scope.measure(0, 200)
  act(() => {
    for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(0)
  })
  expect(scope.scroller.scrollTop).toBe(retire ? 1000 : 4600)
  expect(getScrollShadowSnapshot().instrumentationErrors).toEqual([])

  if (retire) {
    act(() => scope.result.current.scrollToIndex(49, { align: 'end' }))
    expect(scope.scroller.scrollTop).toBe(4600)
    scope.grow(100)
    scope.measure(0, 300)
    act(() => {
      for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(0)
    })
    expect(scope.scroller.scrollTop).toBe(4700)
  }
})

it.each(['offset', 'index', 'mount'] as const)('publishes the landed viewport after a cancelled %s write', command => {
  const scope = fixture()
  act(() => scope.result.current.scrollToOffset(800))
  const before = scope.result.current.getVirtualItems().map(row => row.key)
  let cancelled = false
  const after = vi.fn()
  act(() => {
    scope.result.current.setScrollWriteObserver?.(write => {
      if (write.phase === 'after') { after(); return }
      if (cancelled) return
      cancelled = true
      scope.result.current.cancelPendingScroll?.()
      return false
    })
    if (command === 'offset') scope.result.current.scrollToOffset(200)
    else if (command === 'index') scope.result.current.scrollToIndex(5, { align: 'start' })
    else void scope.result.current.ensureMessageMounted('row-5')
  })
  expect(cancelled).toBe(true)
  expect(scope.scroller.scrollTop).toBe(800)
  expect(scope.result.current.getVirtualItems().map(row => row.key)).toEqual(before)
  expect(after).toHaveBeenCalledOnce()
  scope.measure(0, 100)
  act(() => {
    for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(0)
  })
  expect(scope.scroller.scrollTop).toBe(880)
  act(() => scope.result.current.scrollToOffset(200))
  expect(scope.scroller.scrollTop).toBe(200)
})
