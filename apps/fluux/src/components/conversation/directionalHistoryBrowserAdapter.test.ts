import { describe, expect, it, vi } from 'vitest'
import type { MessageVirtualizer, VirtualWindowItem } from './messageVirtualizer'
import type { PositionExecutionLease, PositionFrameLoop } from './positioningController'
import { pixelOffset, type DirectionalHistoryRequest } from './scrollPositionModel'
import { DirectionalHistoryBrowserAdapter } from './directionalHistoryBrowserAdapter'

function scrollerHarness(input: {
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
} = {}) {
  let scrollTop = input.scrollTop ?? 300
  const scrollHeight = input.scrollHeight ?? 2_000
  const clientHeight = input.clientHeight ?? 500
  let reflowReads = 0
  const scroller = document.createElement('div')
  Object.defineProperties(scroller, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
    offsetHeight: {
      configurable: true,
      get: () => {
        reflowReads += 1
        return clientHeight
      },
    },
  })
  scroller.getBoundingClientRect = () => ({
    top: 0,
    bottom: clientHeight,
    left: 0,
    right: 600,
    width: 600,
    height: clientHeight,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  return {
    scroller,
    get scrollTop() { return scrollTop },
    set scrollTop(value: number) { scrollTop = value },
    get reflowReads() { return reflowReads },
  }
}

function virtualizerHarness(
  scroller: HTMLElement,
  input: {
    index?: number | null
    offset?: () => number | null
    items?: VirtualWindowItem[]
  } = {},
) {
  const index = input.index === undefined ? 2 : input.index
  const items = input.items ?? [{ index: 2, start: 900, size: 80, key: 'anchor' }]
  const scrollToOffset = vi.fn((offset: number) => {
    scroller.scrollTop = offset
  })
  const virtualizer: MessageVirtualizer = {
    getVirtualItems: () => items,
    getTotalSize: () => 2_000,
    itemCount: 10,
    getOffsetForMessageId: vi.fn(input.offset ?? (() => 900)),
    getIndexForMessageId: vi.fn(() => index),
    ensureMessageMounted: vi.fn(async () => {}),
    measureElement: vi.fn(),
    scrollToOffset,
    scrollToIndex: vi.fn(),
    beginAnimatedScrollToOffset: vi.fn(),
  }
  return { virtualizer, scrollToOffset }
}

function lease(isCurrent: () => boolean = () => true): PositionExecutionLease {
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

function request(overrides: Partial<DirectionalHistoryRequest> = {}): DirectionalHistoryRequest {
  return {
    generation: 7,
    conversationId: 'room-a',
    source: { kind: 'history-preservation', reason: 'window-shift' },
    desired: {
      kind: 'anchor',
      messageId: 'anchor',
      placement: { kind: 'top-offset', offsetPx: pixelOffset(40) },
    },
    onUnavailable: {
      kind: 'distance-from-bottom',
      distancePx: pixelOffset(200),
    },
    ...overrides,
  }
}

function adapterHarness(input: {
  scroller: HTMLElement | null
  virtualizer?: MessageVirtualizer
  activeConversationId?: string
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
}) {
  const loop: PositionFrameLoop = {
    schedule: vi.fn(),
    recordFrame: vi.fn(),
    finish: vi.fn(),
  }
  const beginLoop = vi.fn(() => loop)
  const adapter = new DirectionalHistoryBrowserAdapter({
    getScroller: () => input.scroller,
    getVirtualizer: () => input.virtualizer,
    getActiveConversationId: () => input.activeConversationId ?? 'room-a',
    beginLoop,
    requestFrame: input.requestFrame ?? (() => 1),
    cancelFrame: input.cancelFrame ?? (() => {}),
  })
  return { adapter, beginLoop, loop }
}

describe('DirectionalHistoryBrowserAdapter', () => {
  it('captures the visual virtualizer anchor rather than trusting DOM order', () => {
    const viewport = scrollerHarness({ scrollTop: 300 })
    const firstWrapper = document.createElement('div')
    firstWrapper.dataset.index = '1'
    const anchorRow = document.createElement('div')
    anchorRow.dataset.messageId = 'message-8'
    firstWrapper.append(anchorRow)
    viewport.scroller.append(firstWrapper)
    const { virtualizer } = virtualizerHarness(viewport.scroller, {
      items: [
        { index: 0, start: 100, size: 100, key: 'old' },
        { index: 1, start: 320, size: 80, key: 'message-8' },
      ],
    })
    const { adapter } = adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    })

    expect(adapter.capture('message-1', 20)).toEqual({
      anchor: { id: 'message-8', offsetFromTop: 20 },
      facts: {
        anchorMessageId: 'message-8',
        anchorOffsetFromTop: 20,
        distanceFromBottom: 1_200,
        firstMessageId: 'message-1',
        messageCount: 20,
      },
      geometry: {
        scrollTop: 300,
        scrollHeight: 2_000,
        clientHeight: 500,
      },
    })
  })

  it('uses the resident first message at scrollTop zero even with a stale virtual window', () => {
    const viewport = scrollerHarness({ scrollTop: 0 })
    const staleWrapper = document.createElement('div')
    staleWrapper.dataset.index = '9'
    const staleRow = document.createElement('div')
    staleRow.dataset.messageId = 'stale-message'
    staleWrapper.append(staleRow)
    viewport.scroller.append(staleWrapper)
    const { virtualizer } = virtualizerHarness(viewport.scroller, {
      offset: () => 24,
      items: [{ index: 9, start: 900, size: 80, key: 'stale-message' }],
    })
    const { adapter } = adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    })

    expect(adapter.capture('message-1', 20)?.anchor).toEqual({
      id: 'message-1',
      offsetFromTop: 24,
    })
  })

  it('positions through the virtualizer and waits through a temporary missing anchor', () => {
    const viewport = scrollerHarness()
    let offset: number | null = 900
    const { virtualizer, scrollToOffset } = virtualizerHarness(viewport.scroller, {
      offset: () => offset,
    })
    const { adapter, beginLoop, loop } = adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    })
    const complete = vi.fn()
    const executor = adapter.createExecutor(complete)
    const currentLease = lease()

    expect(executor.beginLoop(currentLease)).toBe(loop)
    expect(beginLoop).toHaveBeenCalledWith(currentLease)
    expect(executor.positionFrame(request(), currentLease)).toEqual({
      kind: 'positioned',
      scrollTop: 860,
      wrote: true,
      reassert: true,
    })
    expect(scrollToOffset).toHaveBeenCalledWith(860)
    expect(viewport.reflowReads).toBe(2)

    offset = null
    scrollToOffset.mockClear()
    expect(executor.positionFrame(request(), currentLease)).toEqual({
      kind: 'positioned',
      scrollTop: 860,
      wrote: false,
      reassert: true,
    })
    expect(scrollToOffset).not.toHaveBeenCalled()

    executor.complete(request(), 'settled')
    expect(complete).toHaveBeenCalledWith(request(), 'settled')
  })

  it('uses distance-from-bottom once when the initial anchor is absent', () => {
    const viewport = scrollerHarness()
    const { virtualizer, scrollToOffset } = virtualizerHarness(viewport.scroller, {
      offset: () => null,
    })
    const { adapter } = adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    })

    expect(adapter.createExecutor(vi.fn()).positionFrame(request(), lease())).toEqual({
      kind: 'positioned',
      scrollTop: 1_300,
      wrote: true,
      reassert: false,
    })
    expect(scrollToOffset).toHaveBeenCalledWith(1_300)
  })

  it('uses the mounted element path and restores overflow ownership without a virtualizer', () => {
    const viewport = scrollerHarness()
    const anchor = document.createElement('div')
    anchor.dataset.messageId = 'anchor'
    Object.defineProperty(anchor, 'offsetTop', {
      configurable: true,
      get: () => 900,
    })
    viewport.scroller.append(anchor)
    const { adapter } = adapterHarness({ scroller: viewport.scroller })

    expect(adapter.createExecutor(vi.fn()).positionFrame(request(), lease())).toEqual({
      kind: 'positioned',
      scrollTop: 860,
      wrote: true,
      reassert: false,
    })
    expect(viewport.reflowReads).toBe(2)
    expect(viewport.scroller.style.overflowY).toBe('')
  })

  it('preserves the exact target-shift and geometry-drift thresholds', () => {
    const viewport = scrollerHarness()
    let offset = 900
    const { virtualizer, scrollToOffset } = virtualizerHarness(viewport.scroller, {
      offset: () => offset,
    })
    const executor = adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    }).adapter.createExecutor(vi.fn())
    const currentLease = lease()
    executor.positionFrame(request(), currentLease)
    scrollToOffset.mockClear()

    offset = 902
    expect(executor.positionFrame(request(), currentLease)).toMatchObject({ wrote: false })
    expect(scrollToOffset).not.toHaveBeenCalled()

    viewport.scrollTop = 856
    expect(executor.positionFrame(request(), currentLease)).toMatchObject({ wrote: true })
    expect(scrollToOffset).toHaveBeenCalledWith(862)
    scrollToOffset.mockClear()

    offset = 905
    expect(executor.positionFrame(request(), currentLease)).toMatchObject({ wrote: true })
    expect(scrollToOffset).toHaveBeenCalledWith(865)
  })

  it('rejects a stale lease or departed conversation before reading or writing geometry', () => {
    const viewport = scrollerHarness()
    const { virtualizer, scrollToOffset } = virtualizerHarness(viewport.scroller)
    const departed = adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
      activeConversationId: 'room-b',
    }).adapter.createExecutor(vi.fn())

    expect(departed.positionFrame(request(), lease())).toEqual({ kind: 'unavailable' })
    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(viewport.reflowReads).toBe(0)

    const stale = adapterHarness({
      scroller: viewport.scroller,
      virtualizer,
    }).adapter.createExecutor(vi.fn())
    expect(stale.positionFrame(request(), lease(() => false))).toEqual({
      kind: 'unavailable',
    })
    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(viewport.reflowReads).toBe(0)
  })

  it('cancels every pending settlement frame while synchronous frames never leak', () => {
    const viewport = scrollerHarness()
    const callbacks = new Map<number, () => void>()
    const cancelled: number[] = []
    let nextFrame = 0
    const { adapter } = adapterHarness({
      scroller: viewport.scroller,
      requestFrame: (callback) => {
        const id = ++nextFrame
        callbacks.set(id, callback)
        return id
      },
      cancelFrame: (id) => cancelled.push(id),
    })
    const first = vi.fn()
    const second = vi.fn()
    adapter.scheduleSettlement(first)
    adapter.scheduleSettlement(second)
    callbacks.get(1)?.()
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()

    adapter.dispose()
    expect(cancelled).toEqual([2])
    const afterDispose = vi.fn()
    adapter.scheduleSettlement(afterDispose)
    expect(afterDispose).not.toHaveBeenCalled()
    expect(nextFrame).toBe(2)

    const syncCancelled: number[] = []
    const sync = adapterHarness({
      scroller: viewport.scroller,
      requestFrame: (callback) => {
        callback()
        return 9
      },
      cancelFrame: (id) => syncCancelled.push(id),
    }).adapter
    const settled = vi.fn()
    sync.scheduleSettlement(settled)
    sync.dispose()
    expect(settled).toHaveBeenCalledOnce()
    expect(syncCancelled).toEqual([])
  })
})
