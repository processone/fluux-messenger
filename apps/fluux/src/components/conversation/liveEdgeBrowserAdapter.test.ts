import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  PositionExecutionLease,
  PositionFrameLoop,
} from './positioningController'
import type { LiveEdgeRequest } from './scrollPositionModel'
import {
  BOTTOM_PIN_TOLERANCE,
  LiveEdgeBrowserAdapter,
  type LiveEdgeBrowserAdapterOptions,
  type LiveEdgeBrowserPorts,
} from './liveEdgeBrowserAdapter'

function scrollerHarness(input: {
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
} = {}) {
  let scrollTop = input.scrollTop ?? 0
  let scrollHeight = input.scrollHeight ?? 2_000
  const clientHeight = input.clientHeight ?? 600
  let repaints = 0
  const scroller = document.createElement('div')
  Object.defineProperties(scroller, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
    // The stale-paint repair is the ONLY code reading offsetHeight (it forces the layout between
    // the two overflowY writes), so counting reads counts forced repaints. Asserting on the
    // inline style cannot work: the repair restores it to '' before returning.
    offsetHeight: {
      configurable: true,
      get: () => {
        repaints += 1
        return clientHeight
      },
    },
  })
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === 'object' && typeof options?.top === 'number') {
      scrollTop = options.top
    }
  }) as HTMLElement['scrollTo']
  return {
    scroller,
    get scrollTop() { return scrollTop },
    get repaints() { return repaints },
    setScrollTop: (value: number) => { scrollTop = value },
    setScrollHeight: (value: number) => { scrollHeight = value },
  }
}

function virtualizerHarness(
  land: (scrollTop: number) => void,
  input: {
    itemCount?: number
    landedTop?: number
    /** Indexes currently in the measured window; the tail is unmounted by default. */
    mountedIndexes?: number[]
  } = {},
) {
  const scrollToIndex = vi.fn(() => land(input.landedTop ?? 1_400))
  const virtualizer: MessageVirtualizer = {
    getVirtualItems: () => (input.mountedIndexes ?? []).map((index) => ({
      index,
      key: `row-${index}`,
      start: index * 100,
      end: index * 100 + 100,
      size: 100,
      lane: 0,
    })),
    getTotalSize: () => 2_000,
    itemCount: input.itemCount ?? 20,
    getOffsetForMessageId: vi.fn(() => 900),
    getIndexForMessageId: vi.fn(() => 5),
    ensureMessageMounted: vi.fn(async () => {}),
    measureElement: vi.fn(),
    scrollToOffset: vi.fn(),
    scrollToIndex,
    beginAnimatedScrollToOffset: vi.fn(),
  }
  return { virtualizer, scrollToIndex }
}

function lease(isCurrent: () => boolean = () => true): PositionExecutionLease {
  return {
    conversationId: 'room-a',
    generation: 7,
    operation: 1,
    frameBudget: 60,
    signal: new AbortController().signal,
    isCurrent,
    markApplied: () => true,
    settle: () => true,
  }
}

function request(): LiveEdgeRequest {
  return {
    generation: 7,
    conversationId: 'room-a',
    source: { kind: 'entry', reason: 'live-edge' },
    desired: { kind: 'live-edge', follow: true },
  }
}

function loopHarness() {
  const loop = {
    schedule: vi.fn(),
    recordFrame: vi.fn(),
    finish: vi.fn(),
  } satisfies PositionFrameLoop
  return { loop, beginLoop: vi.fn(() => loop) }
}

function harness(input: {
  scroller?: HTMLElement | null
  virtualizer?: MessageVirtualizer
  hasRows?: boolean
  windowAtLiveEdge?: boolean
  activeConversation?: () => string
  isLoadingOlder?: () => boolean
  options?: Partial<LiveEdgeBrowserAdapterOptions>
} = {}) {
  const { beginLoop, loop } = loopHarness()
  const rememberBottomIntent = vi.fn()
  const setMeasuredAtBottom = vi.fn()
  const recordProgrammaticWrite = vi.fn()
  let clock = 0
  const adapter = new LiveEdgeBrowserAdapter({
    getScroller: () => input.scroller ?? null,
    getVirtualizer: () => input.virtualizer,
    getActiveConversationId: () => input.activeConversation?.() ?? 'room-a',
    getWindowFacts: () => ({
      hasRows: input.hasRows ?? true,
      windowAtLiveEdge: input.windowAtLiveEdge ?? true,
    }),
    isLoadingOlder: () => input.isLoadingOlder?.() ?? false,
    beginLoop,
    setMeasuredAtBottom,
    recordProgrammaticWrite,
    readRepaintMode: () => 'on-write',
    now: () => (clock += 1),
    ...input.options,
  })
  const create = (ports: Partial<LiveEdgeBrowserPorts> = {}) =>
    adapter.createExecutor({
      trigger: 'new-message',
      rememberBottomIntent,
      canRecenter: false,
      ...ports,
    })
  return {
    adapter,
    create,
    beginLoop,
    loop,
    rememberBottomIntent,
    setMeasuredAtBottom,
    recordProgrammaticWrite,
  }
}

describe('LiveEdgeBrowserAdapter', () => {
  it('re-reads window facts per call while keeping recenter provenance per execution', () => {
    const viewport = scrollerHarness()
    const { virtualizer } = virtualizerHarness(viewport.setScrollTop)
    let hasRows = false
    const recenter = vi.fn(() => 'requested' as const)
    const scope = harness({
      scroller: viewport.scroller,
      virtualizer,
      // Read through a getter so the assertion below proves the executor is not frozen to the
      // window that existed when it was built.
      get hasRows() { return hasRows },
    })
    const executor = scope.create({
      canRecenter: true,
      recenterVersion: 'slid:idle:20:m-9',
      recenter,
    })

    expect(executor.reachability()).toEqual({ kind: 'empty-window' })
    hasRows = true
    // The tail is resident but outside the measured window, so it must mount before reconciling.
    expect(executor.reachability()).toEqual({
      kind: 'global-live-edge',
      state: { kind: 'resident-tail', index: 19, mounted: false },
    })
    expect(executor.recenterVersion).toBe('slid:idle:20:m-9')
    expect(executor.recenter?.(new AbortController().signal)).toBe('requested')
    expect(executor.beginLoop(lease())).toBe(scope.loop)
  })

  it('reports the tail as mounted once it enters the measured window', () => {
    const viewport = scrollerHarness()
    const { virtualizer } = virtualizerHarness(viewport.setScrollTop, {
      mountedIndexes: [17, 18, 19],
    })
    const executor = harness({ scroller: viewport.scroller, virtualizer }).create()

    expect(executor.reachability()).toEqual({
      kind: 'global-live-edge',
      state: { kind: 'resident-tail', index: 19, mounted: true },
    })
  })

  it('carries per-execution forward-window availability into a slid-up window verdict', () => {
    const viewport = scrollerHarness()
    const { virtualizer } = virtualizerHarness(viewport.setScrollTop)
    const scope = harness({
      scroller: viewport.scroller,
      virtualizer,
      windowAtLiveEdge: false,
    })

    // Resident rows are not proof the global tail is resident: a slid-up window must recenter
    // first, and whether it can is a fact of the request, not of live geometry.
    expect(scope.create({ canRecenter: false }).reachability()).toEqual({
      kind: 'global-live-edge',
      state: { kind: 'unavailable' },
    })
    expect(scope.create({ canRecenter: true }).reachability()).toEqual({
      kind: 'global-live-edge',
      state: { kind: 'recenter-available' },
    })
  })

  it('pins through the virtualizer on the first frame and records bottom intent once', () => {
    const viewport = scrollerHarness({ scrollHeight: 2_000, clientHeight: 600 })
    const { virtualizer, scrollToIndex } = virtualizerHarness(
      viewport.setScrollTop,
      { landedTop: 1_400 },
    )
    const scope = harness({ scroller: viewport.scroller, virtualizer })
    const executor = scope.create()

    expect(executor.positionFrame(request(), lease())).toEqual({
      kind: 'positioned',
      scrollTop: 1_400,
      atLiveEdge: true,
      wrote: true,
      reassert: true,
    })
    expect(scrollToIndex).toHaveBeenCalledWith(19, { align: 'end' })
    expect(scope.rememberBottomIntent).toHaveBeenCalledOnce()
  })

  it('re-asserts only on height change or drift past the sub-row tolerance', () => {
    const viewport = scrollerHarness({ scrollHeight: 2_000, clientHeight: 600 })
    const { virtualizer, scrollToIndex } = virtualizerHarness(
      viewport.setScrollTop,
      { landedTop: 1_400 },
    )
    const scope = harness({ scroller: viewport.scroller, virtualizer })
    const executor = scope.create()
    executor.positionFrame(request(), lease())
    scrollToIndex.mockClear()

    // Settled: same height, distance 0.
    expect(executor.positionFrame(request(), lease())).toMatchObject({ wrote: false })
    expect(scrollToIndex).not.toHaveBeenCalled()

    // Drift inside the tolerance is still treated as pinned.
    viewport.setScrollTop(1_400 - BOTTOM_PIN_TOLERANCE)
    expect(executor.positionFrame(request(), lease())).toMatchObject({ wrote: false })
    expect(scrollToIndex).not.toHaveBeenCalled()

    // One pixel past it is the missed-frame correction the WebKit coalescing bug needs.
    viewport.setScrollTop(1_400 - BOTTOM_PIN_TOLERANCE - 1)
    expect(executor.positionFrame(request(), lease())).toMatchObject({ wrote: true })
    expect(scrollToIndex).toHaveBeenCalledOnce()
  })

  it('never writes for a stale lease or a conversation that has already been left', () => {
    const viewport = scrollerHarness({ scrollTop: 42 })
    const { virtualizer, scrollToIndex } = virtualizerHarness(viewport.setScrollTop)
    let activeConversation = 'room-a'
    const scope = harness({
      scroller: viewport.scroller,
      virtualizer,
      activeConversation: () => activeConversation,
    })
    const executor = scope.create()

    expect(executor.positionFrame(request(), lease(() => false))).toEqual({
      kind: 'unavailable',
    })
    activeConversation = 'room-b'
    expect(executor.positionFrame(request(), lease())).toEqual({ kind: 'unavailable' })
    expect(scrollToIndex).not.toHaveBeenCalled()
    expect(viewport.scrollTop).toBe(42)
  })

  it('animates the non-virtualized first frame only for a smooth entry request', () => {
    const smoothViewport = scrollerHarness()
    const smooth = harness({ scroller: smoothViewport.scroller })
      .create({ trigger: 'switch', smoothNonVirtualized: true })

    expect(smooth.positionFrame(request(), lease())).toMatchObject({
      kind: 'positioned',
      // Entry keeps its historical deferred second write; every other stimulus is one-shot.
      reassert: true,
    })
    expect(smoothViewport.scroller.scrollTo).toHaveBeenCalledWith({
      top: 2_000,
      behavior: 'smooth',
    })
    // The follow-up frame is a raw write, not a second animation.
    smooth.positionFrame(request(), lease())
    expect(smoothViewport.scroller.scrollTo).toHaveBeenCalledOnce()

    const rawViewport = scrollerHarness()
    const raw = harness({ scroller: rawViewport.scroller }).create({ trigger: 'new-message' })
    expect(raw.positionFrame(request(), lease())).toMatchObject({ reassert: false })
    expect(rawViewport.scroller.scrollTo).not.toHaveBeenCalled()
    expect(rawViewport.scrollTop).toBe(2_000)
  })
})

describe('LiveEdgeBrowserAdapter repaint debt', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  function pinScope(isLoadingOlder = () => false) {
    const viewport = scrollerHarness({ scrollHeight: 2_000, clientHeight: 600 })
    const { virtualizer } = virtualizerHarness(viewport.setScrollTop, {
      landedTop: 1_400,
    })
    const scope = harness({
      scroller: viewport.scroller,
      virtualizer,
      isLoadingOlder,
    })
    return { ...scope, viewport }
  }

  /** Drive one content-arrival pin whose write actually moves scrollTop. */
  function arrive(scope: ReturnType<typeof pinScope>, trigger = 'new-message') {
    scope.viewport.setScrollTop(0)
    const executor = scope.create({ trigger })
    executor.positionFrame(request(), lease())
    return executor
  }

  it('coalesces a burst of content-arrival pins into one trailing repaint', () => {
    const scope = pinScope()
    // An isolated first arrival still paints promptly.
    arrive(scope)
    expect(scope.viewport.repaints).toBe(1)

    // Every later arrival inside the burst window supersedes the last and must NOT repaint —
    // each overflow toggle is ~50-150ms of WebKitGTK main-thread freeze.
    const second = arrive(scope)
    arrive(scope)
    expect(scope.viewport.repaints).toBe(1)

    second.complete(request(), 'settled')
    expect(scope.viewport.repaints).toBe(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PinBurstProbe'))
  })

  it('discards owed repaint on takeover and after a conversation leaves', () => {
    const scope = pinScope()
    const executor = arrive(scope)
    arrive(scope)
    const beforeTakeover = scope.viewport.repaints

    executor.complete(request(), 'user-takeover')
    expect(scope.viewport.repaints).toBe(beforeTakeover)
    expect(warn).not.toHaveBeenCalled()

    const left = pinScope()
    const leftExecutor = arrive(left)
    arrive(left)
    const beforeLeaving = left.viewport.repaints
    left.adapter.resetRepaintDebt()
    leftExecutor.complete(request(), 'settled')
    expect(left.viewport.repaints).toBe(beforeLeaving)
    expect(warn).not.toHaveBeenCalled()
  })

  it('suppresses the forced repaint while background history paging is in flight', () => {
    let loadingOlder = true
    const paging = pinScope(() => loadingOlder)
    const pagingExecutor = paging.create({ trigger: 'switch' })
    pagingExecutor.positionFrame(request(), lease())
    pagingExecutor.complete(request(), 'best-effort')
    // A catch-up pages in merges every ~50-300ms; repainting per merge is the freeze.
    expect(paging.viewport.repaints).toBe(0)

    loadingOlder = false
    const idle = pinScope(() => loadingOlder)
    const idleExecutor = idle.create({ trigger: 'switch' })
    idleExecutor.positionFrame(request(), lease())
    expect(idle.viewport.repaints).toBe(1)
    idleExecutor.complete(request(), 'best-effort')
    expect(idle.viewport.repaints).toBe(2)
    expect(idle.setMeasuredAtBottom).toHaveBeenLastCalledWith(true)
    expect(idle.recordProgrammaticWrite).toHaveBeenCalledWith('room-a')
  })

  it('drops completion bookkeeping for a conversation that is no longer displayed', () => {
    let activeConversation = 'room-b'
    const viewport = scrollerHarness()
    const scope = harness({
      scroller: viewport.scroller,
      activeConversation: () => activeConversation,
    })
    const executor = scope.create()

    executor.complete(request(), 'settled')
    expect(scope.setMeasuredAtBottom).not.toHaveBeenCalled()
    expect(scope.recordProgrammaticWrite).not.toHaveBeenCalled()

    activeConversation = 'room-a'
    executor.complete(request(), 'settled')
    expect(scope.recordProgrammaticWrite).toHaveBeenCalledWith('room-a')
  })
})
