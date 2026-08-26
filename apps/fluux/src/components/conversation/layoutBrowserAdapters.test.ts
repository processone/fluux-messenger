import { describe, expect, it, vi } from 'vitest'
import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  PositionExecutionLease,
  PositionFrameLoop,
} from './positioningController'
import type { AnchorPreservationRequest } from './scrollPositionModel'
import { messageFraction } from './scrollPositionModel'
import type { BottomFractionAnchorBrowserAdapter } from './bottomFractionAnchorBrowserAdapter'
import {
  AnchorPreservationBrowserAdapter,
  type AnchorPreservationLoopLabel,
} from './anchorPreservationBrowserAdapter'
import { ResidentTopBrowserAdapter } from './residentTopBrowserAdapter'

function scrollerHarness(input: {
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
} = {}) {
  let scrollTop = input.scrollTop ?? 400
  const scrollHeight = input.scrollHeight ?? 2_000
  const clientHeight = input.clientHeight ?? 600
  const scroller = document.createElement('div')
  Object.defineProperties(scroller, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
  })
  scroller.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === 'object' && typeof options?.top === 'number') {
      scrollTop = options.top
    }
  }) as HTMLElement['scrollTo']
  return {
    scroller,
    get scrollTop() { return scrollTop },
    setScrollTop: (value: number) => { scrollTop = value },
  }
}

function virtualizerHarness(input: { itemCount?: number } = {}) {
  const beginAnimatedScrollToOffset = vi.fn()
  const scrollToOffset = vi.fn()
  const virtualizer: MessageVirtualizer = {
    getVirtualItems: () => [],
    getTotalSize: () => 2_000,
    itemCount: input.itemCount ?? 20,
    getOffsetForMessageId: vi.fn(() => 900),
    getIndexForMessageId: vi.fn(() => 5),
    ensureMessageMounted: vi.fn(async () => {}),
    measureElement: vi.fn(),
    scrollToOffset,
    scrollToIndex: vi.fn(),
    beginAnimatedScrollToOffset,
  }
  return { virtualizer, beginAnimatedScrollToOffset, scrollToOffset }
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

function loopHarness() {
  const loop = {
    schedule: vi.fn(),
    recordFrame: vi.fn(),
    finish: vi.fn(),
  } satisfies PositionFrameLoop
  return { loop, beginLoop: vi.fn(() => loop) }
}

function anchorRequest(
  fraction = 0.5,
  conversationId = 'room-a',
): AnchorPreservationRequest {
  return {
    generation: 7,
    conversationId,
    source: { kind: 'media-preservation', reason: 'remeasure' },
    desired: {
      kind: 'anchor',
      messageId: 'message-5',
      placement: {
        kind: 'bottom-fraction',
        fraction: messageFraction(fraction),
      },
    },
    onUnavailable: { kind: 'warn-and-stop' },
  }
}

describe('AnchorPreservationBrowserAdapter', () => {
  function harness(input: {
    scroller?: HTMLElement | null
    virtualizer?: MessageVirtualizer
    hasRows?: boolean
    activeConversation?: () => string
  } = {}) {
    const viewport = scrollerHarness()
    const scroller = input.scroller === undefined ? viewport.scroller : input.scroller
    const loop = {
      schedule: vi.fn(),
      recordFrame: vi.fn(),
      finish: vi.fn(),
    } satisfies PositionFrameLoop
    const beginLoop = vi.fn(
      (_label: AnchorPreservationLoopLabel, _lease: PositionExecutionLease) => loop,
    )
    const position = vi.fn(() => ({
      kind: 'positioned' as const,
      scrollTop: 1_234,
      reassert: true,
    }))
    const setAtBottom = vi.fn()
    const rememberScrollSnapshot = vi.fn()
    const recordProgrammaticWrite = vi.fn()
    const adapter = new AnchorPreservationBrowserAdapter({
      getScroller: () => scroller,
      getVirtualizer: () => input.virtualizer,
      getActiveConversationId: () => input.activeConversation?.() ?? 'room-a',
      getWindowFacts: () => ({
        hasRows: input.hasRows ?? true,
        windowAtLiveEdge: true,
      }),
      beginLoop,
      anchorAdapter: { position } as unknown as BottomFractionAnchorBrowserAdapter,
      setAtBottom,
      rememberScrollSnapshot,
      recordProgrammaticWrite,
    })
    return {
      adapter,
      viewport,
      loop,
      beginLoop,
      position,
      setAtBottom,
      rememberScrollSnapshot,
      recordProgrammaticWrite,
    }
  }

  it('labels its frame loop per stimulus so three ambient owners stay distinguishable', () => {
    const scope = harness()

    scope.adapter.createExecutor('media-anchor').beginLoop(lease())
    scope.adapter.createExecutor('divider-anchor').beginLoop(lease())
    scope.adapter.createExecutor('insertion-anchor').beginLoop(lease())

    expect(scope.beginLoop.mock.calls.map(([label]) => label)).toEqual([
      'media-anchor',
      'divider-anchor',
      'insertion-anchor',
    ])
  })

  it('reports an empty hydrating window rather than treating the anchor as missing', () => {
    const hydrating = harness({ hasRows: false })
    expect(
      hydrating.adapter.createExecutor('media-anchor')
        .reachability(anchorRequest().desired),
    ).toEqual({ kind: 'empty-window' })

    const populated = harness()
    expect(
      populated.adapter.createExecutor('media-anchor')
        .reachability(anchorRequest().desired),
    ).not.toEqual({ kind: 'empty-window' })
  })

  it('delegates the write to the shared bottom-fraction geometry with the request placement', () => {
    const scope = harness()
    const executor = scope.adapter.createExecutor('media-anchor')

    expect(executor.positionFrame(anchorRequest(0.25), lease())).toEqual({
      kind: 'positioned',
      scrollTop: 1_234,
      reassert: true,
    })
    expect(scope.position).toHaveBeenCalledWith({
      messageId: 'message-5',
      fraction: 0.25,
    })
  })

  it('writes for neither a stale lease nor a conversation that has been left', () => {
    let activeConversation = 'room-a'
    const scope = harness({ activeConversation: () => activeConversation })
    const executor = scope.adapter.createExecutor('divider-anchor')

    expect(executor.positionFrame(anchorRequest(), lease(() => false))).toEqual({
      kind: 'unavailable',
    })
    activeConversation = 'room-b'
    expect(executor.positionFrame(anchorRequest(), lease())).toEqual({
      kind: 'unavailable',
    })
    expect(scope.position).not.toHaveBeenCalled()

    activeConversation = 'room-a'
    executor.positionFrame(anchorRequest(), lease())
    expect(scope.position).toHaveBeenCalledOnce()
  })

  it('records the landed reading point only for the conversation still displayed', () => {
    let activeConversation = 'room-b'
    const scope = harness({ activeConversation: () => activeConversation })
    const executor = scope.adapter.createExecutor('insertion-anchor')

    executor.complete(anchorRequest(), 'settled')
    expect(scope.setAtBottom).not.toHaveBeenCalled()
    expect(scope.rememberScrollSnapshot).not.toHaveBeenCalled()
    expect(scope.recordProgrammaticWrite).not.toHaveBeenCalled()

    activeConversation = 'room-a'
    executor.complete(anchorRequest(), 'settled')
    // 2000 - 400 - 600 = 1000px from the bottom: preservation must not claim the live edge.
    expect(scope.setAtBottom).toHaveBeenCalledWith(false)
    expect(scope.rememberScrollSnapshot).toHaveBeenCalledOnce()
    expect(scope.recordProgrammaticWrite).toHaveBeenCalledWith('room-a')

    scope.viewport.setScrollTop(1_399)
    executor.complete(anchorRequest(), 'settled')
    expect(scope.setAtBottom).toHaveBeenLastCalledWith(true)
  })
})

describe('ResidentTopBrowserAdapter', () => {
  function harness(input: {
    scroller?: HTMLElement | null
    virtualizer?: MessageVirtualizer
    hasRows?: boolean
  } = {}) {
    const viewport = scrollerHarness()
    const scroller = input.scroller === undefined ? viewport.scroller : input.scroller
    const { loop, beginLoop } = loopHarness()
    const recordProgrammaticWrite = vi.fn()
    const adapter = new ResidentTopBrowserAdapter({
      getScroller: () => scroller,
      getVirtualizer: () => input.virtualizer,
      getWindowFacts: () => ({
        hasRows: input.hasRows ?? true,
        windowAtLiveEdge: true,
      }),
      beginLoop,
      recordProgrammaticWrite,
    })
    const executor = adapter.createExecutor()
    return { adapter, executor, viewport, loop, beginLoop, recordProgrammaticWrite }
  }

  function residentTopRequest() {
    return {
      generation: 7,
      conversationId: 'room-a',
      source: { kind: 'user-navigation', reason: 'resident-top' },
      desired: { kind: 'resident-top' },
    } as Parameters<ReturnType<typeof harness>['executor']['start']>[0]
  }

  it('issues the animated write THROUGH the virtualizer so its reconciler is retargeted', () => {
    const { virtualizer, beginAnimatedScrollToOffset } = virtualizerHarness()
    const scope = harness({ virtualizer })

    expect(scope.executor.start(residentTopRequest(), lease())).toEqual({
      kind: 'started',
    })
    expect(beginAnimatedScrollToOffset).toHaveBeenCalledWith(0)
    // A raw smooth write here loses to @tanstack's still-armed pending-scroll reconciler.
    expect(scope.viewport.scroller.scrollTo).not.toHaveBeenCalled()
  })

  it('falls back to one native smooth write when no virtualizer owns the window', () => {
    const scope = harness()

    expect(scope.executor.start(residentTopRequest(), lease())).toEqual({
      kind: 'started',
    })
    expect(scope.viewport.scroller.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'smooth',
    })
  })

  it('degrades a rejected virtualized Home to one instant adapter write', () => {
    const { virtualizer, scrollToOffset, beginAnimatedScrollToOffset } = virtualizerHarness()
    const scope = harness({ virtualizer })

    expect(scope.adapter.emergencyWrite()).toBe(true)
    expect(scrollToOffset).toHaveBeenCalledWith(0)
    expect(beginAnimatedScrollToOffset).not.toHaveBeenCalled()
    expect(scope.recordProgrammaticWrite).toHaveBeenCalledOnce()
  })

  it('degrades a rejected native Home to one instant adapter write', () => {
    const scope = harness()

    expect(scope.adapter.emergencyWrite()).toBe(true)
    expect(scope.viewport.scrollTop).toBe(0)
    expect(scope.viewport.scroller.scrollTo).not.toHaveBeenCalled()
    expect(scope.recordProgrammaticWrite).toHaveBeenCalledOnce()
  })

  it('starts nothing under a stale lease or without a scroller', () => {
    const { virtualizer, beginAnimatedScrollToOffset } = virtualizerHarness()
    const stale = harness({ virtualizer })
    expect(stale.executor.start(residentTopRequest(), lease(() => false))).toEqual({
      kind: 'unavailable',
    })
    expect(beginAnimatedScrollToOffset).not.toHaveBeenCalled()

    const detached = harness({ scroller: null, virtualizer })
    expect(detached.executor.start(residentTopRequest(), lease())).toEqual({
      kind: 'unavailable',
    })
  })

  it('only observes scrollTop afterwards, never reissuing the target', () => {
    const { virtualizer, beginAnimatedScrollToOffset } = virtualizerHarness()
    const scope = harness({ virtualizer })
    scope.executor.start(residentTopRequest(), lease())

    scope.viewport.setScrollTop(120)
    expect(scope.executor.readScrollTop()).toBe(120)
    scope.viewport.setScrollTop(0)
    expect(scope.executor.readScrollTop()).toBe(0)
    expect(beginAnimatedScrollToOffset).toHaveBeenCalledOnce()
  })

  it('distinguishes an empty window from a resident one before any write', () => {
    expect(harness({ hasRows: false }).executor.reachability()).toEqual({
      kind: 'empty-window',
    })
    expect(harness().executor.reachability()).not.toEqual({ kind: 'empty-window' })
  })
})
