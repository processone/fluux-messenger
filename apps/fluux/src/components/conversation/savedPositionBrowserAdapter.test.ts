import { describe, expect, it, vi } from 'vitest'
import type { ScrollAnchor } from '@/utils/scrollStateManager'
import { messageFraction, pixelOffset, type SavedPositionRequest } from './scrollPositionModel'
import type { MessageVirtualizer, VirtualWindowItem } from './messageVirtualizer'
import type {
  LiveEdgeExecutor,
  PositionFrameLoop,
  SavedPositionExecutionLease,
} from './positioningController'
import { BottomFractionAnchorBrowserAdapter } from './bottomFractionAnchorBrowserAdapter'
import { SavedPositionBrowserAdapter } from './savedPositionBrowserAdapter'

function scrollerHarness(input: {
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  top?: number
} = {}) {
  let scrollTop = input.scrollTop ?? 500
  const scrollHeight = input.scrollHeight ?? 2_000
  const clientHeight = input.clientHeight ?? 400
  const top = input.top ?? 100
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
    top,
    bottom: top + clientHeight,
    left: 0,
    right: 600,
    width: 600,
    height: clientHeight,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
  return {
    scroller,
    get scrollTop() { return scrollTop },
  }
}

function appendMessageRow(
  scroller: HTMLElement,
  input: { id?: string; top?: number; height?: number; offsetHeight?: number } = {},
) {
  const row = document.createElement('div')
  row.className = 'message-row'
  row.dataset.messageId = input.id ?? 'anchor'
  const top = input.top ?? 250
  const height = input.height ?? 200
  Object.defineProperty(row, 'offsetHeight', {
    configurable: true,
    get: () => input.offsetHeight ?? height,
  })
  row.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
  scroller.append(row)
  return row
}

function virtualizerHarness(
  scroller: HTMLElement,
  input: {
    index?: number | null
    offset?: number | null
    items?: VirtualWindowItem[]
  } = {},
) {
  const scrollToOffset = vi.fn((offset: number) => {
    scroller.scrollTop = offset
  })
  const scrollToIndex = vi.fn(() => {
    scroller.scrollTop = 900
  })
  const virtualizer: MessageVirtualizer = {
    getVirtualItems: () => input.items ?? [
      { index: 4, start: 600, size: 200, key: 'anchor' },
    ],
    getTotalSize: () => 2_000,
    itemCount: 10,
    getOffsetForMessageId: vi.fn(() =>
      input.offset === undefined ? 600 : input.offset),
    getIndexForMessageId: vi.fn(() =>
      input.index === undefined ? 4 : input.index),
    ensureMessageMounted: vi.fn(async () => {}),
    measureElement: vi.fn(),
    scrollToOffset,
    scrollToIndex,
    beginAnimatedScrollToOffset: vi.fn(),
  }
  return { virtualizer, scrollToOffset, scrollToIndex }
}

function anchor(fraction = 0.5): ScrollAnchor {
  return { messageId: 'anchor', fraction }
}

function savedRequest(
  desired: SavedPositionRequest['desired'] = {
    kind: 'anchor',
    messageId: 'anchor',
    placement: {
      kind: 'bottom-fraction',
      fraction: messageFraction(0.5),
    },
  },
): SavedPositionRequest {
  return {
    generation: 7,
    conversationId: 'room-a',
    source: { kind: 'entry', reason: 'saved-position' },
    desired,
    onUnavailable: { kind: 'live-edge' },
  } as SavedPositionRequest
}

function lease(isCurrent: () => boolean = () => true): SavedPositionExecutionLease {
  const controller = new AbortController()
  return {
    conversationId: 'room-a',
    generation: 7,
    operation: 1,
    frameBudget: 60,
    signal: controller.signal,
    isCurrent,
    markApplied: () => true,
    settle: () => true,
  }
}

function adapterHarness(input: {
  scroller: HTMLElement | null
  virtualizer?: MessageVirtualizer
  hasRows?: boolean
  windowAtLiveEdge?: boolean
  canRecenter?: boolean
}) {
  const anchorAdapter = new BottomFractionAnchorBrowserAdapter({
    getScroller: () => input.scroller,
    getVirtualizer: () => input.virtualizer,
  })
  const loop = {
    schedule: vi.fn(),
    recordFrame: vi.fn(),
    finish: vi.fn(),
  } satisfies PositionFrameLoop
  const beginLoop = vi.fn(() => loop)
  const adapter = new SavedPositionBrowserAdapter({
    getScroller: () => input.scroller,
    getVirtualizer: () => input.virtualizer,
    getWindowFacts: () => ({
      hasRows: input.hasRows ?? true,
      windowAtLiveEdge: input.windowAtLiveEdge ?? true,
      canRecenter: input.canRecenter ?? false,
    }),
    beginLoop,
    anchorAdapter,
  })
  return { adapter, anchorAdapter, beginLoop, loop }
}

function executorFor(adapter: SavedPositionBrowserAdapter) {
  const complete = vi.fn()
  const liveEdge = {} as LiveEdgeExecutor
  const executor = adapter.createExecutor({ liveEdge, complete })
  return { executor, complete, liveEdge }
}

describe('BottomFractionAnchorBrowserAdapter', () => {
  it('uses the mounted row rect as the exact inverse of anchor capture', () => {
    const viewport = scrollerHarness()
    appendMessageRow(viewport.scroller)
    const { virtualizer, scrollToOffset } = virtualizerHarness(viewport.scroller)
    const browser = new BottomFractionAnchorBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => virtualizer,
    })

    expect(browser.position(anchor())).toEqual({
      kind: 'positioned',
      scrollTop: 350,
      reassert: true,
    })
    expect(scrollToOffset).toHaveBeenCalledWith(350)
  })

  it('falls back to virtualizer measurements until the row is mounted', () => {
    const viewport = scrollerHarness()
    const { virtualizer, scrollToOffset } = virtualizerHarness(viewport.scroller)
    const browser = new BottomFractionAnchorBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => virtualizer,
    })

    expect(browser.position(anchor())).toEqual({
      kind: 'positioned',
      scrollTop: 300,
      reassert: true,
    })
    expect(scrollToOffset).toHaveBeenCalledWith(300)
  })

  it('mounts a bottom-edge anchor before fractional refinement', () => {
    const viewport = scrollerHarness()
    const { virtualizer, scrollToOffset, scrollToIndex } = virtualizerHarness(
      viewport.scroller,
    )
    const browser = new BottomFractionAnchorBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => virtualizer,
    })

    expect(browser.position(anchor(1))).toEqual({
      kind: 'positioned',
      scrollTop: 900,
      reassert: true,
    })
    expect(scrollToIndex).toHaveBeenCalledWith(4, { align: 'end' })
    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('uses current DOM geometry without a virtualizer and rejects hidden anchors', () => {
    const viewport = scrollerHarness()
    const row = appendMessageRow(viewport.scroller)
    const browser = new BottomFractionAnchorBrowserAdapter({
      getScroller: () => viewport.scroller,
      getVirtualizer: () => undefined,
    })

    expect(browser.position(anchor())).toEqual({
      kind: 'positioned',
      scrollTop: 350,
      reassert: false,
    })

    Object.defineProperty(row, 'offsetHeight', {
      configurable: true,
      get: () => 0,
    })
    expect(browser.position(anchor())).toEqual({ kind: 'unavailable' })
  })
})

describe('SavedPositionBrowserAdapter', () => {
  it('owns reachability, loop creation, and lifecycle ports without changing them', () => {
    const viewport = scrollerHarness({ scrollHeight: 800, clientHeight: 400 })
    const { adapter, beginLoop, loop } = adapterHarness({
      scroller: viewport.scroller,
    })
    const { executor, complete, liveEdge } = executorFor(adapter)
    const currentLease = lease()

    expect(executor.liveEdge).toBe(liveEdge)
    expect(executor.beginLoop(currentLease)).toBe(loop)
    expect(beginLoop).toHaveBeenCalledWith(currentLease)
    expect(executor.reachability(
      { kind: 'legacy-offset', offsetPx: pixelOffset(500) },
      'unavailable',
    )).toMatchObject({
      kind: 'available',
      placement: 'use-unavailable-policy',
    })

    executor.complete(savedRequest(), 'settled')
    expect(complete).toHaveBeenCalledWith(savedRequest(), 'settled')
  })

  it('restores legacy offsets through the virtualizer or bounded DOM writes', () => {
    const viewport = scrollerHarness({ scrollHeight: 1_000, clientHeight: 400 })
    const { virtualizer, scrollToOffset } = virtualizerHarness(viewport.scroller)
    const virtual = executorFor(adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    }).adapter).executor
    const request = savedRequest({
      kind: 'legacy-offset',
      offsetPx: pixelOffset(550),
    })

    expect(virtual.positionFrame(request, lease())).toEqual({
      kind: 'positioned',
      scrollTop: 550,
      reassert: false,
    })
    expect(scrollToOffset).toHaveBeenCalledWith(550)

    const dom = executorFor(adapterHarness({
      scroller: viewport.scroller,
    }).adapter).executor
    expect(dom.positionFrame(request, lease())).toMatchObject({
      kind: 'positioned',
      scrollTop: 550,
    })
    expect(dom.positionFrame(savedRequest({
      kind: 'legacy-offset',
      offsetPx: pixelOffset(601),
    }), lease())).toEqual({ kind: 'unavailable' })
  })

  it('delegates fractional anchors and rejects stale or live-edge calls', () => {
    const viewport = scrollerHarness()
    const { adapter, anchorAdapter } = adapterHarness({
      scroller: viewport.scroller,
    })
    const position = vi.spyOn(anchorAdapter, 'position').mockReturnValue({
      kind: 'positioned',
      scrollTop: 350,
      reassert: false,
    })
    const executor = executorFor(adapter).executor

    expect(executor.positionFrame(savedRequest(), lease())).toMatchObject({
      kind: 'positioned',
      scrollTop: 350,
    })
    expect(position).toHaveBeenCalledWith(anchor())

    position.mockClear()
    expect(executor.positionFrame(savedRequest(), lease(() => false))).toEqual({
      kind: 'unavailable',
    })
    expect(position).not.toHaveBeenCalled()
    expect(executor.positionFrame(savedRequest({
      kind: 'live-edge',
      follow: true,
    }), lease())).toEqual({ kind: 'unavailable' })
  })

  it('rechecks the lease after a browser write before reporting success', () => {
    const viewport = scrollerHarness()
    let current = true
    const { virtualizer } = virtualizerHarness(viewport.scroller)
    virtualizer.scrollToOffset = vi.fn(() => {
      current = false
    })
    const executor = executorFor(adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    }).adapter).executor

    expect(executor.positionFrame(savedRequest({
      kind: 'legacy-offset',
      offsetPx: pixelOffset(550),
    }), lease(() => current))).toEqual({ kind: 'unavailable' })
  })
})
