import { describe, expect, it, vi } from 'vitest'
import type { MessageVirtualizer } from './messageVirtualizer'
import type {
  LiveEdgeExecutor,
  PositionExecutionLease,
  PositionFrameLoop,
} from './positioningController'
import type {
  ExplicitTargetRequest,
  UnreadMarkerRequest,
} from './scrollPositionModel'
import { ExplicitTargetBrowserAdapter } from './explicitTargetBrowserAdapter'
import { UnreadMarkerBrowserAdapter } from './unreadMarkerBrowserAdapter'

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
  scroller.getBoundingClientRect = () => ({
    top: 100,
    bottom: 100 + clientHeight,
    left: 0,
    right: 600,
    width: 600,
    height: clientHeight,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  })
  return {
    scroller,
    get scrollTop() { return scrollTop },
  }
}

function appendMessage(
  scroller: HTMLElement,
  input: { id?: string; offsetTop?: number; rectTop?: number } = {},
) {
  const element = document.createElement('div')
  element.dataset.messageId = input.id ?? 'message-5'
  Object.defineProperty(element, 'offsetTop', {
    configurable: true,
    get: () => input.offsetTop ?? 500,
  })
  element.getBoundingClientRect = () => ({
    top: input.rectTop ?? 300,
    bottom: (input.rectTop ?? 300) + 80,
    left: 0,
    right: 600,
    width: 600,
    height: 80,
    x: 0,
    y: input.rectTop ?? 300,
    toJSON: () => ({}),
  })
  element.scrollIntoView = vi.fn(() => { scroller.scrollTop = 700 })
  scroller.append(element)
  return element
}

function virtualizerHarness(
  scroller: HTMLElement,
  input: {
    index?: number | null
    offset?: number | null
    itemCount?: number
    landedTop?: number
  } = {},
) {
  const scrollToIndex = vi.fn(() => {
    scroller.scrollTop = input.landedTop ?? 900
  })
  const virtualizer: MessageVirtualizer = {
    getVirtualItems: () => [],
    getTotalSize: () => 2_000,
    itemCount: input.itemCount ?? 20,
    getOffsetForMessageId: vi.fn(() =>
      input.offset === undefined ? 900 : input.offset),
    getIndexForMessageId: vi.fn(() =>
      input.index === undefined ? 5 : input.index),
    ensureMessageMounted: vi.fn(async () => {}),
    measureElement: vi.fn(),
    scrollToOffset: vi.fn((offset: number) => { scroller.scrollTop = offset }),
    scrollToIndex,
    beginAnimatedScrollToOffset: vi.fn(),
  }
  return { virtualizer, scrollToIndex }
}

function lease(isCurrent: () => boolean = () => true): PositionExecutionLease {
  const controller = new AbortController()
  return {
    conversationId: 'room-a',
    generation: 7,
    operation: 1,
    signal: controller.signal,
    isCurrent,
    markApplied: () => true,
    settle: () => true,
  }
}

function unreadRequest(
  align: 'start' | 'top-third' = 'top-third',
): UnreadMarkerRequest {
  return {
    generation: 7,
    conversationId: 'room-a',
    source: { kind: 'entry', reason: 'unread-marker' },
    desired: { kind: 'message', messageId: 'message-5', align },
    onUnavailable: { kind: 'live-edge' },
  }
}

function explicitRequest(): ExplicitTargetRequest {
  return {
    generation: 7,
    conversationId: 'room-a',
    source: { kind: 'user-navigation', reason: 'message-target' },
    desired: { kind: 'message', messageId: 'message-5', align: 'center' },
    onUnavailable: { kind: 'wait' },
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

describe('UnreadMarkerBrowserAdapter', () => {
  it('owns reachability and loop creation while preserving the live-edge fallback port', () => {
    const viewport = scrollerHarness()
    const { virtualizer } = virtualizerHarness(viewport.scroller)
    const { loop, beginLoop } = loopHarness()
    const liveEdge = {} as LiveEdgeExecutor
    const executor = new UnreadMarkerBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => virtualizer,
      getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
      getPassiveContext: () => ({ conversationId: 'room-a', virtualizer }),
      beginLoop,
      setMeasuredAtBottom: vi.fn(),
      recordProgrammaticWrite: vi.fn(),
    }).createExecutor(liveEdge)

    expect(executor.liveEdge).toBe(liveEdge)
    expect(executor.reachability(unreadRequest().desired)).toMatchObject({
      kind: 'available',
      index: 5,
    })
    expect(executor.beginLoop(lease())).toBe(loop)
    expect(executor.readScrollTop()).toBe(400)
  })

  it('re-reads current window facts instead of freezing the render that built the executor', () => {
    const viewport = scrollerHarness()
    const { virtualizer } = virtualizerHarness(viewport.scroller)
    let hasRows = false
    const executor = new UnreadMarkerBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => virtualizer,
      getWindowFacts: () => ({ hasRows, windowAtLiveEdge: true }),
      getPassiveContext: () => ({ conversationId: 'room-a', virtualizer }),
      beginLoop: loopHarness().beginLoop,
      setMeasuredAtBottom: vi.fn(),
      recordProgrammaticWrite: vi.fn(),
    }).createExecutor({} as LiveEdgeExecutor)

    expect(executor.reachability(unreadRequest().desired)).toEqual({
      kind: 'empty-window',
    })
    hasRows = true
    expect(executor.reachability(unreadRequest().desired)).toMatchObject({
      kind: 'available',
      index: 5,
    })
  })

  it('waits for the passive conversation handoff and distinguishes hydration from absence', () => {
    const viewport = scrollerHarness()
    const hydrating = virtualizerHarness(viewport.scroller, {
      index: null,
      itemCount: 0,
    }).virtualizer
    let passiveConversation = 'room-old'
    const adapter = new UnreadMarkerBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => hydrating,
      getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
      getPassiveContext: () => ({
        conversationId: passiveConversation,
        virtualizer: hydrating,
      }),
      beginLoop: loopHarness().beginLoop,
      setMeasuredAtBottom: vi.fn(),
      recordProgrammaticWrite: vi.fn(),
    })
    const executor = adapter.createExecutor({} as LiveEdgeExecutor)

    expect(executor.positionFrame(unreadRequest(), lease())).toEqual({ kind: 'waiting' })
    passiveConversation = 'room-a'
    expect(executor.positionFrame(unreadRequest(), lease())).toEqual({ kind: 'waiting' })
    Object.defineProperty(hydrating, 'itemCount', { value: 20 })
    expect(executor.positionFrame(unreadRequest(), lease())).toEqual({ kind: 'unavailable' })
  })

  it('rejects near-top markers and positions virtual markers from current measurements', () => {
    const viewport = scrollerHarness({ clientHeight: 600 })
    const nearTop = virtualizerHarness(viewport.scroller, { offset: 200 }).virtualizer
    let virtualizer = nearTop
    const measured = vi.fn()
    const executor = new UnreadMarkerBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => virtualizer,
      getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
      getPassiveContext: () => ({ conversationId: 'room-a', virtualizer }),
      beginLoop: loopHarness().beginLoop,
      setMeasuredAtBottom: measured,
      recordProgrammaticWrite: vi.fn(),
    }).createExecutor({} as LiveEdgeExecutor)

    expect(executor.positionFrame(unreadRequest(), lease())).toEqual({ kind: 'unavailable' })
    const mounted = virtualizerHarness(viewport.scroller, {
      offset: 900,
      landedTop: 1_395,
    })
    virtualizer = mounted.virtualizer
    expect(executor.positionFrame(unreadRequest('start'), lease())).toEqual({
      kind: 'positioned',
      scrollTop: 1_395,
      atLiveEdge: true,
    })
    expect(mounted.scrollToIndex).toHaveBeenCalledWith(5, { align: 'start' })
    expect(measured).toHaveBeenLastCalledWith(true)
  })

  it('opens the settle window whenever it moves scrollTop, and only then', () => {
    // Every executor that writes scrollTop must mark it, or the measurement settle arriving after
    // the re-assert loop ends is indistinguishable from a scrollbar drag: it opens the save gate on
    // a drifted position and arms user takeover against the positioning that produced it.
    const viewport = scrollerHarness({ clientHeight: 600 })
    const nearTop = virtualizerHarness(viewport.scroller, { offset: 200 }).virtualizer
    let virtualizer = nearTop
    const recordWrite = vi.fn()
    const executor = new UnreadMarkerBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => virtualizer,
      getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
      getPassiveContext: () => ({ conversationId: 'room-a', virtualizer }),
      beginLoop: loopHarness().beginLoop,
      setMeasuredAtBottom: vi.fn(),
      recordProgrammaticWrite: recordWrite,
    }).createExecutor({} as LiveEdgeExecutor)

    // A rejected near-top marker writes nothing, so it must not open the window either.
    expect(executor.positionFrame(unreadRequest(), lease())).toEqual({ kind: 'unavailable' })
    expect(recordWrite).not.toHaveBeenCalled()

    virtualizer = virtualizerHarness(viewport.scroller, {
      offset: 900,
      landedTop: 1_395,
    }).virtualizer
    expect(executor.positionFrame(unreadRequest('start'), lease())).toMatchObject({
      kind: 'positioned',
    })
    expect(recordWrite).toHaveBeenCalledWith('room-a')
  })

  it('applies top-third placement without a virtualizer and never writes under a stale lease', () => {
    const viewport = scrollerHarness({ clientHeight: 600 })
    appendMessage(viewport.scroller, { offsetTop: 800 })
    const executor = new UnreadMarkerBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => undefined,
      getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
      getPassiveContext: () => ({ conversationId: 'room-a', virtualizer: undefined }),
      beginLoop: loopHarness().beginLoop,
      setMeasuredAtBottom: vi.fn(),
      recordProgrammaticWrite: vi.fn(),
    }).createExecutor({} as LiveEdgeExecutor)

    expect(executor.positionFrame(unreadRequest(), lease())).toMatchObject({
      kind: 'positioned',
      scrollTop: 600,
    })
    viewport.scroller.scrollTop = 111
    expect(executor.positionFrame(unreadRequest(), lease(() => false))).toEqual({
      kind: 'unavailable',
    })
    expect(viewport.scrollTop).toBe(111)
  })
})

describe('ExplicitTargetBrowserAdapter', () => {
  function harness(input: {
    scroller?: HTMLElement | null
    virtualizer?: MessageVirtualizer
    passiveConversation?: () => string
    activeConversation?: () => string
    storeTarget?: () => string | undefined
    hasRows?: boolean
  } = {}) {
    const viewport = scrollerHarness()
    const scroller = input.scroller === undefined ? viewport.scroller : input.scroller
    const { loop, beginLoop } = loopHarness()
    const measured = vi.fn()
    const markNotAtBottom = vi.fn()
    const consumeStoreTarget = vi.fn()
    const recordWrite = vi.fn()
    const adapter = new ExplicitTargetBrowserAdapter({
      getScroller: () => scroller,
      getVirtualizer: () => input.virtualizer,
      getWindowFacts: () => ({
        hasRows: input.hasRows ?? true,
        windowAtLiveEdge: true,
      }),
      getPassiveContext: () => ({
        conversationId: input.passiveConversation?.() ?? 'room-a',
        virtualizer: input.virtualizer,
      }),
      getActiveConversationId: () => input.activeConversation?.() ?? 'room-a',
      getStoreTargetMessageId: () => input.storeTarget?.() ?? 'message-5',
      beginLoop,
      setMeasuredAtBottom: measured,
      markNotAtBottom,
      consumeStoreTarget,
      recordProgrammaticWrite: recordWrite,
    })
    return {
      adapter,
      viewport,
      scroller,
      loop,
      beginLoop,
      measured,
      markNotAtBottom,
      consumeStoreTarget,
      recordWrite,
    }
  }

  it('resolves mounted aliases and promotes an empty window to an around-load target', () => {
    const mounted = harness()
    const element = appendMessage(mounted.viewport.scroller)
    element.dataset.messageId = 'row-local'
    element.dataset.stanzaId = 'message-5'
    const mountedExecutor = mounted.adapter.createExecutor({
      conversationId: 'room-a',
      messageReference: 'message-5',
      consumeStoreTarget: false,
    })

    expect(mountedExecutor.reachability(explicitRequest().desired, 'unavailable')).toEqual({
      kind: 'available',
      index: 0,
      mounted: true,
      placement: 'viable',
    })
    expect(mountedExecutor.beginLoop(lease())).toBe(mounted.loop)
    expect(mountedExecutor.readScrollTop()).toBe(400)

    const empty = harness({ hasRows: false })
    const emptyExecutor = empty.adapter.createExecutor({
      conversationId: 'room-a',
      messageReference: 'message-5',
      consumeStoreTarget: false,
      loadAround: vi.fn(),
    })
    expect(emptyExecutor.reachability(explicitRequest().desired, 'available')).toEqual({
      kind: 'target-absent',
      loadAround: 'available',
    })
  })

  it('guards around loading by abort and active conversation before changing bottom intent', () => {
    let activeConversation = 'room-a'
    const loadAround = vi.fn()
    const result = harness({ activeConversation: () => activeConversation })
    const executor = result.adapter.createExecutor({
      conversationId: 'room-a',
      messageReference: 'message-5',
      consumeStoreTarget: false,
      loadAround,
    })
    const aborted = new AbortController()
    aborted.abort()

    executor.loadAround?.('message-5', aborted.signal)
    activeConversation = 'room-b'
    executor.loadAround?.('message-5', new AbortController().signal)
    expect(loadAround).not.toHaveBeenCalled()
    expect(result.markNotAtBottom).not.toHaveBeenCalled()

    activeConversation = 'room-a'
    executor.loadAround?.('message-5', new AbortController().signal)
    expect(result.markNotAtBottom).toHaveBeenCalledOnce()
    expect(loadAround).toHaveBeenCalledOnce()
  })

  it('waits for passive handoff then centers through the virtualizer under the lease', () => {
    const viewport = scrollerHarness()
    const { virtualizer, scrollToIndex } = virtualizerHarness(viewport.scroller, {
      landedTop: 700,
    })
    let passiveConversation = 'room-old'
    const result = harness({
      scroller: viewport.scroller,
      virtualizer,
      passiveConversation: () => passiveConversation,
    })
    const executor = result.adapter.createExecutor({
      conversationId: 'room-a',
      messageReference: 'message-5',
      consumeStoreTarget: false,
    })

    expect(executor.positionFrame(explicitRequest(), lease())).toEqual({ kind: 'waiting' })
    passiveConversation = 'room-a'
    expect(executor.positionFrame(explicitRequest(), lease())).toEqual({
      kind: 'positioned',
      scrollTop: 700,
      wrote: true,
    })
    expect(scrollToIndex).toHaveBeenCalledWith(5, { align: 'center' })
    expect(result.measured).toHaveBeenCalledWith(false)
    // The centring write must open the settle window; see the equivalent unread-marker test.
    expect(result.recordWrite).toHaveBeenCalledWith('room-a')

    viewport.scroller.scrollTop = 123
    result.recordWrite.mockClear()
    expect(executor.positionFrame(explicitRequest(), lease(() => false))).toEqual({
      kind: 'unavailable',
    })
    expect(viewport.scrollTop).toBe(123)
    // A stale lease writes nothing, so it must not open the window either.
    expect(result.recordWrite).not.toHaveBeenCalled()
  })

  it('falls back to the scoped mounted element when no virtual index exists', () => {
    const viewport = scrollerHarness()
    const element = appendMessage(viewport.scroller)
    const result = harness({ scroller: viewport.scroller })
    const executor = result.adapter.createExecutor({
      conversationId: 'room-a',
      messageReference: 'message-5',
      consumeStoreTarget: false,
    })

    expect(executor.positionFrame(explicitRequest(), lease())).toMatchObject({
      kind: 'positioned',
      scrollTop: 700,
    })
    expect(element.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('highlights only applied current targets and consumes only the matching store target', () => {
    vi.useFakeTimers()
    try {
      let activeConversation = 'room-a'
      let storeTarget = 'message-5'
      const result = harness({
        activeConversation: () => activeConversation,
        storeTarget: () => storeTarget,
      })
      const element = appendMessage(result.viewport.scroller)
      const executor = result.adapter.createExecutor({
        conversationId: 'room-a',
        messageReference: 'message-5',
        consumeStoreTarget: true,
      })

      executor.complete(explicitRequest(), 'settled', false)
      expect(element).not.toHaveClass('message-highlight')
      expect(result.consumeStoreTarget).toHaveBeenCalledOnce()

      result.consumeStoreTarget.mockClear()
      executor.complete(explicitRequest(), 'settled', true)
      expect(element).toHaveClass('message-highlight')
      expect(result.consumeStoreTarget).toHaveBeenCalledOnce()
      vi.runAllTimers()
      expect(element).not.toHaveClass('message-highlight')

      result.consumeStoreTarget.mockClear()
      storeTarget = 'message-newer'
      executor.complete(explicitRequest(), 'settled', true)
      activeConversation = 'room-b'
      executor.complete(explicitRequest(), 'settled', true)
      expect(result.consumeStoreTarget).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
