// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollStateManager } from '@/utils/scrollStateManager'
import { ImageAttachment } from '@/components/FileAttachments'
import { messageRowId } from './messageRowIdentity'
import type { MessageVirtualizer } from './messageVirtualizer'
import { PositioningController } from './positioningController'
import { ViewportSession } from './viewportSession'
import { resetScrollShadowDiagnostics, getScrollShadowSnapshot } from './scrollPositionShadow'
import { MEDIA_LOAD_DEBOUNCE_MS } from './useMediaGrowthPreservation'
import { useMessageListScroll, type UseMessageListScrollResult } from './useMessageListScroll'

vi.mock('@/hooks', () => ({
  useAttachmentUrl: (url: string) => ({ url, isLoading: false, error: null }),
  useCachedMediaUrl: () => ({ cachedUrl: null, isPeeking: false }),
  formatBytes: (bytes: number) => String(bytes),
}))
vi.mock('@/hooks/useDeferredMedia', () => ({ useDeferredMedia: () => ({ shouldLoad: true, approve() {} }) }))
vi.mock('@/components/ImageLightbox', () => ({ ImageLightbox: () => null }))
vi.mock('@/components/ImageContextMenu', () => ({ ImageContextMenu: () => null }))

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let resizeObservers: Map<Element, ResizeObserverCallback>

function resizeEntry(target: Element, height: number): ResizeObserverEntry {
  const size = [{ inlineSize: 800, blockSize: height }]
  return { target, contentRect: new DOMRect(0, 0, 800, height),
    borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size }
}

function runFrame() {
  act(() => {
    for (const [id, callback] of [...frames]) {
      if (frames.delete(id)) callback(performance.now())
    }
  })
}

function settle() {
  for (let count = 0; frames.size && count < 100; count++) {
    runFrame()
  }
  expect(frames.size).toBe(0)
  expect(getScrollShadowSnapshot().instrumentationErrors).toEqual([])
}

beforeEach(() => {
  vi.useFakeTimers()
  frames = new Map()
  nextFrame = 0
  resizeObservers = new Map()
  scrollStateManager.reset()
  resetScrollShadowDiagnostics()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class {
    private elements = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { this.elements.add(element); resizeObservers.set(element, this.callback) }
    unobserve(element: Element) { this.elements.delete(element); resizeObservers.delete(element) }
    disconnect() { this.elements.forEach(element => resizeObservers.delete(element)) }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function restoredHistory(virtualized: boolean, freshEntry = false, settleEntry = true, images = false) {
  const rows = Array.from({ length: 20 }, (_, index) => {
    const message = {
      id: index === 11 || index === 12 ? 'reused-id' : `message-${index}`,
      occupantId: `occupant-${index}`,
      stanzaId: `archive-${index}`,
    }
    return { ...message, rowId: messageRowId(message)!, top: index * 100, height: 100 }
  })
  const geometry = { top: 0, height: 2000, client: freshEntry ? 500 : 600 }
  const loadOlder = vi.fn()
  const loadNewer = vi.fn()
  const cancelPendingScroll = vi.fn()
  const scrollEvents: number[] = []
  const writes: number[] = []
  let scroller!: HTMLDivElement
  let api!: UseMessageListScrollResult
  let firstNewMessageId: string | undefined
  let writeObserver: Parameters<NonNullable<MessageVirtualizer['setScrollWriteObserver']>>[0]
  const write = (top: number, source: 'navigation' | 'measurement' = 'navigation') => {
    if (writeObserver?.({ phase: 'before', source }) === false) return
    scroller.scrollTop = top
    writeObserver?.({ phase: 'after', source })
  }
  const virtualizer: MessageVirtualizer | undefined = virtualized ? {
    cancelPendingScroll,
    get itemCount() { return rows.length },
    getVirtualItems: () => rows.map((row, index) => ({ index, key: row.rowId, start: row.top, size: row.height })),
    getTotalSize: () => geometry.height,
    getIndexForMessageId: id => {
      const index = rows.findIndex(row => row.rowId === id)
      return index < 0 ? null : index
    },
    getOffsetForMessageId: id => rows.find(row => row.rowId === id)?.top ?? null,
    ensureMessageMounted: async () => {},
    measureElement: () => {},
    scrollToOffset: top => write(top),
    scrollToIndex: (index, options) => write(rows[index].top + (
      options?.align === 'end' ? rows[index].height - geometry.client
        : options?.align === 'center' ? (rows[index].height - geometry.client) / 2 : 0
    )),
    beginAnimatedScrollToOffset: top => write(top),
    setScrollWriteObserver: observer => { writeObserver = observer },
  } : undefined

  function HookHarness({ conversationId }: { conversationId: string }) {
    const result = useMessageListScroll({
      conversationId,
      messageCount: rows.length,
      firstMessageId: rows[0].rowId,
      firstNewMessageId,
      lastMessageId: rows.at(-1)!.rowId,
      rowGrowthSignature: '',
      windowAtLiveEdge: true,
      virtualizer,
      onScrollToTop: loadOlder,
      onLoadNewer: loadNewer,
    })
    const setContainer = result.setScrollContainerRef
    const setScroller = React.useCallback((node: HTMLDivElement | null) => {
      if (node) {
        scroller = node
        Object.defineProperties(node, {
          scrollTop: {
            configurable: true,
            get: () => geometry.top,
            set: (top: number) => {
              writes.push(top)
              geometry.top = Math.max(0, Math.min(top, geometry.height - geometry.client))
            },
          },
          scrollHeight: { configurable: true, get: () => geometry.height },
          clientHeight: { configurable: true, get: () => geometry.client },
        })
        node.getBoundingClientRect = () => new DOMRect(0, 100, 800, geometry.client)
        node.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
          const top = typeof options === 'number' ? y ?? 0 : options?.top ?? 0
          node.scrollTop = top
        }
      }
      setContainer(node)
    }, [setContainer])
    React.useLayoutEffect(() => { api = result }, [result])
    return <div ref={setScroller} data-message-list onWheel={result.handleWheel} onScroll={event => {
      scrollEvents.push(event.currentTarget.scrollTop)
      result.handleScroll(event)
    }}>
      <div ref={result.contentWrapperRef}>
        {rows.map((row, index) => <div key={row.rowId} data-message-id={row.id} data-message-row-id={row.rowId}
          className="message-row" ref={node => {
            if (!node) return
            Object.defineProperties(node, {
              offsetTop: { configurable: true, get: () => row.top },
              offsetHeight: { configurable: true, get: () => row.height },
            })
            node.getBoundingClientRect = () => new DOMRect(0, 100 + row.top - geometry.top, 800, row.height)
            node.scrollIntoView = () => { scroller.scrollTop = row.top + (row.height - geometry.client) / 2 }
          }}>{images && [2, 4, 11, 18].includes(index) && <ImageAttachment
            attachment={{ url: `https://example.test/${row.id}.png`, mediaType: 'image/png' }}
            onLoad={result.handleMediaLoad}
          />}</div>)}
      </div>
    </div>
  }

  if (!freshEntry) {
    scrollStateManager.enterConversation('room-a', rows.length)
    scrollStateManager.leaveConversation('room-a', 640, 2000, 600, { messageId: rows[12].rowId, fraction: 0.4 })
  }
  let view = render(<HookHarness conversationId="room-a" />)
  if (!freshEntry && settleEntry) settle()
  expect(scroller.scrollTop).toBe(freshEntry ? 1500 : 640)
  writes.length = 0

  return {
    geometry, rows, writes, scrollEvents, loadOlder, loadNewer, cancelPendingScroll,
    get scroller() { return scroller },
    resizeViewport: () => act(() => resizeObservers.get(scroller)?.([
      resizeEntry(scroller, geometry.client),
    ], {} as ResizeObserver)),
    resizeContent: () => act(() => {
      const content = scroller.firstElementChild!
      resizeObservers.get(content)?.([
        resizeEntry(content, geometry.height),
      ], {} as ResizeObserver)
    }),
    growBelow: (height: number) => { geometry.height += height; rows.at(-1)!.height += height },
    move: (top: number, deliver = false) => {
      geometry.top = top
      if (deliver) fireEvent.scroll(scroller)
    },
    sample: () => { fireEvent(window, new Event('resize')); settle() },
    prepend: () => {
      act(() => api.handleLoadEarlier())
      geometry.height += 80
      rows.forEach(row => { row.top += 80 })
      const message = { id: 'older', occupantId: 'older-occupant', stanzaId: 'older-archive' }
      rows.unshift({ ...message, rowId: messageRowId(message)!, top: 0, height: 80 })
      view.rerender(<HookHarness conversationId="room-a" />)
    },
    toBottom: () => act(() => api.scrollToBottom()),
    toMarker: () => act(() => api.scrollToMarker()),
    toTarget: (index = 16) => act(() => api.requestMessageTarget({
      id: rows[index].id, occupantId: rows[index].occupantId, stanzaId: rows[index].stanzaId,
    })),
    setMarker: () => {
      firstNewMessageId = rows[14].rowId
      view.rerender(<HookHarness conversationId="room-a" />)
      settle()
    },
    mediaLoad: () => act(() => api.handleMediaLoad()),
    imageLoad: (index: number, growth: number) => {
      geometry.height += growth
      rows[index].height += growth
      rows.slice(index + 1).forEach(row => { row.top += growth })
      fireEvent.load(scroller.querySelectorAll('.message-row')[index].querySelector('img')!)
    },
    upwardIntent: () => fireEvent.wheel(scroller, { deltaY: -1 }),
    growAbove: (height: number) => {
      geometry.height += height
      rows.forEach(row => { row.top += height })
    },
    measurement: (height: number) => act(() => write(geometry.top + height, 'measurement')),
    switchTo: (conversationId: string) => { view.rerender(<HookHarness conversationId={conversationId} />); settle() },
    unmount: () => view.unmount(),
    remount: () => { view = render(<HookHarness conversationId="room-a" />); settle() },
    beginMediaCorrection: () => act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS)),
    debounce: () => { act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS)); settle() },
  }
}

describe.each([false, true])('withheld native scroll delivery (virtualized: %s)', virtualized => {
  it('keeps the new follow-live owner when an obsolete target frame observes downward movement', () => {
    const scope = restoredHistory(virtualized)
    scope.growAbove(110)
    scope.growBelow(10)
    scope.geometry.client = 480
    scope.resizeViewport()
    settle()
    scope.toTarget()
    settle()
    expect(scope.scroller.scrollTop).toBe(1520)

    scope.resizeViewport()
    runFrame()
    expect(frames.size).toBeGreaterThan(0)
    scope.writes.length = 0
    const observed = vi.spyOn(PositioningController.prototype, 'observeUserScroll')
    try {
      scope.move(1600)
      runFrame()
      settle()
      const controller = observed.mock.contexts.at(-1) as PositioningController
      expect(controller.snapshot().active?.request.desired).toMatchObject({ kind: 'live-edge' })
      expect(observed).toHaveBeenCalledTimes(1)
      expect(scope.scroller.scrollTop).toBe(1600)
      expect(scope.writes).toEqual([])

      scope.geometry.client = 500
      scope.resizeViewport()
      settle()
      expect(scope.scroller.scrollTop).toBe(1620)
      expect(scope.scrollEvents).toEqual([])
      expect(scope.loadOlder).not.toHaveBeenCalled()
      expect(scope.loadNewer).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1000))
      scope.move(80, true)
      scope.move(0, true)
      expect(scope.loadOlder).toHaveBeenCalledOnce()
    } finally {
      observed.mockRestore()
    }
  })

  it('retains sampled pagination when genuine movement rearms follow-live', () => {
    const scope = restoredHistory(virtualized)
    scope.move(1360)
    scope.sample()
    const observation = vi.spyOn(ViewportSession.prototype, 'observeScroll')
    try {
      expect(scope.loadNewer).not.toHaveBeenCalled()
      fireEvent.scroll(scope.scroller)
      expect(observation.mock.results.at(-1)?.value?.userScrollGeometry).toMatchObject({ top: 1360 })
      fireEvent.scroll(scope.scroller)
      expect(observation.mock.results.at(-1)?.value?.userScrollGeometry).toBeNull()
    } finally {
      observation.mockRestore()
    }
  })

  it('resumes follow-live after a selected-target reader moves back down', () => {
    const scope = restoredHistory(virtualized)
    scope.toTarget()
    settle()
    scope.upwardIntent()
    scope.move(900)
    scope.sample()
    scope.move(1400)
    scope.sample()
    scope.growBelow(200)
    scope.sample()
    expect(scope.scroller.scrollTop).toBe(1600)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it('settles sampled live-edge takeover before the queued container-growth correction', () => {
    const scope = restoredHistory(virtualized)
    scope.geometry.client = 500
    scope.resizeViewport()
    settle()
    scope.toBottom()
    settle()
    expect(scope.scroller.scrollTop).toBe(1500)
    scope.writes.length = 0
    scope.move(1000)
    scope.geometry.client = 550
    scope.resizeViewport()
    settle()
    expect(scope.scrollEvents).toEqual([])
    expect(scope.scroller.scrollTop).toBe(1000)
    expect(scope.writes).toEqual([])
    fireEvent.scroll(scope.scroller)
    scope.sample()
    expect(scope.scroller.scrollTop).toBe(1000)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    scope.move(80, true)
    scope.move(0, true)
    expect(scope.loadOlder).toHaveBeenCalledOnce()
  })

  it.each(['clamp', 'growth', 'write'] as const)('retains follow-live after sampled %s', change => {
    const scope = restoredHistory(virtualized)
    scope.geometry.client = 500
    scope.resizeViewport()
    settle()
    scope.toBottom()
    settle()
    if (change === 'write') { scope.mediaLoad(); scope.growBelow(200); scope.debounce() }
    if (change === 'growth') scope.growBelow(200)
    scope.geometry.client = 550
    if (change !== 'growth') scope.move(scope.geometry.height - 550)
    scope.resizeViewport()
    settle()
    expect(scope.scroller.scrollTop).toBe(scope.geometry.height - 550)
    fireEvent.scroll(scope.scroller)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['End', 'FAB'] as const)('keeps pending media correction through %s animation progress', command => {
    const scope = restoredHistory(virtualized)
    scope.geometry.client = 500
    scope.move(1360, true)
    scope.loadNewer.mockClear()
    scope.mediaLoad()
    if (command === 'End') fireEvent.keyDown(window, { key: 'End' })
    else scope.toBottom()
    if (!virtualized) {
      expect(scope.scroller.scrollTop).toBeGreaterThan(1360)
      expect(scope.scroller.scrollTop).toBeLessThan(1500)
    }
    fireEvent.scroll(scope.scroller)
    scope.resizeContent()
    runFrame()
    scope.growBelow(200)
    scope.mediaLoad()
    scope.resizeContent()
    runFrame()
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1700)
    fireEvent.scroll(scope.scroller)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.move(80, true)
    scope.move(0, true)
    expect(scope.loadOlder).toHaveBeenCalledOnce()
  })

  it('keeps movement that arrives after the first media correction', () => {
    const scope = restoredHistory(virtualized)
    scope.upwardIntent()
    scope.mediaLoad()
    scope.growAbove(80)
    scope.beginMediaCorrection()
    expect(scope.scroller.scrollTop).toBe(720)
    if (virtualized) expect(frames.size).toBeGreaterThan(0)
    scope.writes.length = 0
    scope.move(670)
    runFrame()
    settle()
    expect(scope.scroller.scrollTop).toBe(670)
    expect(scope.writes).toEqual([])
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['End', 'FAB', 'Home', 'marker', 'FAB-marker', 'target'] as const)(
    'discards earlier sampled pagination after %s navigation', command => {
      const scope = restoredHistory(virtualized)
      if (command === 'marker' || command === 'FAB-marker') scope.setMarker()
      scope.move(0)
      scope.sample()
      if (command === 'End' || command === 'Home') fireEvent.keyDown(scope.scroller, { key: command })
      else if (command === 'marker') scope.toMarker()
      else if (command === 'target') scope.toTarget()
      else scope.toBottom()
      settle()
      const destination = scope.scroller.scrollTop
      if (command === 'End' || command === 'FAB') expect(destination).toBe(1400)
      else if (command === 'Home') expect(destination).toBe(0)
      else expect(destination).toBeGreaterThan(0)
      expect(scope.scrollEvents).toEqual([])
      act(() => vi.advanceTimersByTime(1000))
      scope.move(destination, true)
      expect(scope.loadOlder).not.toHaveBeenCalled()
      scope.move(80, true)
      scope.move(0, true)
      expect(scope.loadOlder).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['End', 'Home'] as const)('discards sampled pagination when %s uses its emergency write', command => {
    const scope = restoredHistory(virtualized)
    scope.move(0)
    scope.sample()
    const rejected = vi.spyOn(PositioningController.prototype,
      command === 'End' ? 'beginLiveEdgeNavigation' : 'beginResidentTopNavigation').mockReturnValue(null)
    try {
      fireEvent.keyDown(scope.scroller, { key: command })
      settle()
      expect(scope.scroller.scrollTop).toBe(command === 'End' ? 1400 : 0)
      expect(scope.scrollEvents).toEqual([])
      act(() => vi.advanceTimersByTime(1000))
      scope.move(scope.scroller.scrollTop, true)
      expect(scope.loadOlder).not.toHaveBeenCalled()
    } finally {
      rejected.mockRestore()
    }
  })

  it('retains sampled pagination across a layout-only media correction', () => {
    const scope = restoredHistory(virtualized)
    scope.move(0)
    scope.sample()
    scope.mediaLoad()
    scope.growAbove(80)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(80)
    expect(scope.scrollEvents).toEqual([])
    act(() => vi.advanceTimersByTime(1000))
    scope.move(80, true)
    expect(scope.loadOlder).toHaveBeenCalledTimes(1)
  })

  it.each(['switch', 'unmount'] as const)('saves fresh geometry and canonical anchors through %s', exit => {
    const scope = restoredHistory(virtualized)
    scope.move(590)
    scope.sample()
    expect(scope.scroller.scrollTop).toBe(590)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()

    if (exit === 'switch') scope.switchTo('room-b')
    else scope.unmount()
    expect(scrollStateManager.getSavedScrollTop('room-a')).toBe(590)
    expect(scrollStateManager.getSavedAnchor('room-a')).toEqual({
      messageId: scope.rows[11].rowId, fraction: 0.9,
    })
    if (exit === 'switch') scope.switchTo('room-a')
    else scope.remount()
    expect(scope.scroller.scrollTop).toBe(590)
    expect(scope.scrollEvents).toEqual([])
  })

  it.each(['growth', 'clamp', 'media-write'] as const)('keeps saved restoration after layout-only %s', change => {
    const scope = restoredHistory(virtualized)
    if (change === 'growth') scope.geometry.height += 100
    if (change === 'clamp') {
      scope.geometry.height = 1200
      scope.move(600)
    }
    if (change === 'media-write') {
      scope.mediaLoad()
      scope.growAbove(80)
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(720)
    }
    scope.sample()
    scope.unmount()
    expect(scope.scrollEvents).toEqual([])
    expect(scrollStateManager.getSavedScrollTop('room-a')).toBe(640)
    expect(scrollStateManager.getSavedAnchor('room-a')).toEqual({
      messageId: scope.rows[12].rowId, fraction: 0.4,
    })
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it('samples continued movement before deciding a pending media correction', () => {
    const scope = restoredHistory(virtualized)
    scope.upwardIntent()
    settle()
    scope.mediaLoad()
    scope.geometry.height += 100
    scope.sample()
    scope.move(590)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(590)
    expect(scope.writes).toEqual([])
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()

    scope.mediaLoad()
    scope.growAbove(80)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(670)
    expect(scope.scrollEvents).toEqual([])
    act(() => vi.advanceTimersByTime(1000))
    scope.move(80, true)
    scope.move(0, true)
    expect(scope.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('keeps a no-movement upward attempt out of automatic pagination', () => {
    const scope = restoredHistory(virtualized)
    scope.upwardIntent()
    scope.mediaLoad()
    scope.geometry.height += 100
    scope.sample()
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(640)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  if (virtualized) {
    it.each(['growth', 'measurement'] as const)('keeps media reassertion through layout-only %s', change => {
      const scope = restoredHistory(true)
      scope.upwardIntent()
      scope.mediaLoad()
      scope.growAbove(80)
      scope.beginMediaCorrection()
      expect(scope.scroller.scrollTop).toBe(720)
      scope.growAbove(40)
      if (change === 'measurement') scope.measurement(40)
      runFrame()
      settle()
      expect(scope.scroller.scrollTop).toBe(760)
      expect(scope.scrollEvents).toEqual([])
      expect(scope.loadOlder).not.toHaveBeenCalled()
      expect(scope.loadNewer).not.toHaveBeenCalled()
    })

    it('retains ordinary media correction after an attributed measurement', () => {
      const scope = restoredHistory(true)
      scope.upwardIntent()
      scope.mediaLoad()
      scope.growAbove(80)
      scope.measurement(80)
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(720)
      expect(scope.scrollEvents).toEqual([])
      expect(scope.loadOlder).not.toHaveBeenCalled()
      expect(scope.loadNewer).not.toHaveBeenCalled()
    })
  }
})


describe.each([false, true])('attributed navigation frames (virtualized: %s)', virtualized => {
  it('records the entry write before growth and delayed scroll delivery', () => {
    const scope = restoredHistory(virtualized, true)
    scope.mediaLoad()
    scope.growBelow(200)
    runFrame()
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1700)
    fireEvent.scroll(scope.scroller)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['End', 'FAB', 'Home', 'target'] as const)('retires an older media batch on %s', command => {
    const scope = restoredHistory(virtualized)
    scope.mediaLoad()
    if (command === 'FAB') scope.toBottom()
    else if (command === 'target') scope.toTarget()
    else fireEvent.keyDown(scope.scroller, { key: command })
    settle()
    const destination = scope.scroller.scrollTop
    expect(destination).not.toBe(640)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(destination)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['End', 'Home'] as const)('retires pending media on emergency %s', command => {
    const scope = restoredHistory(virtualized)
    scope.mediaLoad()
    const rejected = vi.spyOn(PositioningController.prototype,
      command === 'End' ? 'beginLiveEdgeNavigation' : 'beginResidentTopNavigation').mockReturnValue(null)
    try {
      fireEvent.keyDown(scope.scroller, { key: command })
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(command === 'End' ? 1400 : 0)
    } finally { rejected.mockRestore() }
  })

  it.each(virtualized ? ['Home'] as const : ['Home', 'End'] as const)('preserves same-direction and reverse scrollbar interruption during %s', command => {
    for (const direction of [-1, 1]) {
      const scope = restoredHistory(virtualized)
      scope.growBelow(2000)
      scope.geometry.client = 500
      scope.mediaLoad()
      fireEvent.keyDown(scope.scroller, { key: command })
      const firstFrame = scope.scroller.scrollTop
      expect(firstFrame).toBeGreaterThan(0)
      expect(firstFrame).toBeLessThan(3500)
      const chosen = firstFrame + direction * 100
      scope.move(chosen)
      runFrame()
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(chosen)
      expect(scope.scrollEvents).toEqual([])
      expect(scope.loadOlder).not.toHaveBeenCalled()
      scope.unmount()
      expect(scrollStateManager.getSavedScrollTop('room-a')).toBe(chosen)
      scrollStateManager.reset()
    }
  })

  it('attributes all normal Home frames and subsequent user movement independently', () => {
    const scope = restoredHistory(virtualized)
    fireEvent.keyDown(scope.scroller, { key: 'Home' })
    expect(scope.scroller.scrollTop).toBeGreaterThan(0)
    runFrame()
    fireEvent.scroll(scope.scroller)
    settle()
    expect(scope.scroller.scrollTop).toBe(0)
    act(() => vi.advanceTimersByTime(1000))
    fireEvent.scroll(scope.scroller)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    scope.move(100, true)
    scope.move(0, true)
    expect(scope.loadOlder).toHaveBeenCalledOnce()
  })
})

describe('virtualized navigation cancellation before native scroll delivery', () => {
  it.each(['saved', 'history'] as const)('vetoes the in-flight %s reassertion after takeover', owner => {
    const scope = restoredHistory(true, false, owner !== 'saved')
    if (owner === 'saved') {
      scope.growAbove(80)
      runFrame()
    } else {
      scope.prepend()
      expect(scope.loadOlder).toHaveBeenCalledOnce()
    }
    expect(scope.scroller.scrollTop).toBe(720)
    expect(frames.size).toBeGreaterThan(0)
    scope.writes.length = 0
    scope.move(670)
    runFrame()
    settle()
    expect(scope.scroller.scrollTop).toBe(670)
    expect(scope.writes).toEqual([])
    expect(scope.cancelPendingScroll).toHaveBeenCalledOnce()
    expect(scope.scrollEvents).toEqual([])
    scope.unmount()
    expect(scrollStateManager.getSavedScrollTop('room-a')).toBe(670)
    expect(scrollStateManager.getSavedAnchor('room-a')).toEqual({
      messageId: scope.rows.find(row => row.occupantId === 'occupant-11')!.rowId, fraction: 0.9,
    })
  })

  it.each(['saved', 'history'] as const)('keeps the %s owner through layout-only remeasurement', owner => {
    const scope = restoredHistory(true, false, owner !== 'saved')
    if (owner === 'history') scope.prepend()
    else scope.growAbove(80)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(720)
    scope.growAbove(40)
    runFrame()
    settle()
    expect(scope.scroller.scrollTop).toBe(760)
    expect(scope.cancelPendingScroll).not.toHaveBeenCalled()
    const earlier = scope.loadOlder.mock.calls.length
    act(() => vi.advanceTimersByTime(1000))
    scope.move(80, true)
    scope.move(0, true)
    expect(scope.loadOlder).toHaveBeenCalledTimes(earlier + 1)
  })
})

describe('reading-anchor displacement after user movement', () => {
  it('drops old-row growth below the adopted reading position, then preserves later growth above it', () => {
    const scope = restoredHistory(false)
    scope.move(1000)
    scope.sample()
    scope.move(400)
    scope.geometry.height += 100
    scope.rows[12].height += 100
    scope.rows.slice(13).forEach(row => { row.top += 100 })
    scope.resizeContent()
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    expect(scope.writes).toEqual([])
    scope.growAbove(80)
    scope.resizeContent()
    settle()
    expect(scope.scroller.scrollTop).toBe(480)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })
})

describe.each([false, true])('image growth before load delivery (virtualized: %s)', virtualized => {
  function readingImages() {
    const scope = restoredHistory(virtualized, false, true, true)
    scope.geometry.client = 300
    scope.resizeViewport()
    settle()
    scope.move(1000, true)
    scope.sample()
    scope.writes.length = 0
    scope.scrollEvents.length = 0
    const correctLayout = (growth: number) => {
      if (virtualized) scope.measurement(growth)
      scope.resizeContent()
      settle()
    }
    return { ...scope, correctLayout }
  }

  it.each([false, true].flatMap(settled => [false, true].map(deliver => ({ settled, deliver }))))(
    'captures the landed target after motionless release (settled: $settled, scroll delivery: $deliver)',
    ({ settled, deliver }) => {
      const scope = readingImages()
      scope.toTarget(5)
      if (settled) settle()
      else {
        runFrame()
        expect(frames.size).toBeGreaterThan(0)
      }
      expect(scope.scroller.scrollTop).toBe(400)
      expect(scope.scrollEvents).toEqual([])
      scope.upwardIntent()
      scope.imageLoad(18, 200)
      if (deliver) scope.move(400, true)
      scope.correctLayout(0)
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(400)
      scope.imageLoad(11, 80)
      scope.correctLayout(0)
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(400)
      scope.imageLoad(2, 80)
      scope.correctLayout(80)
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(480)
      expect(scope.loadOlder).not.toHaveBeenCalled()
      expect(scope.loadNewer).not.toHaveBeenCalled()
      scope.unmount()
      expect(scrollStateManager.getSavedScrollTop('room-a')).toBe(480)
      expect(scrollStateManager.getSavedAnchor('room-a')).toEqual({ messageId: scope.rows[6].rowId, fraction: 1 })
    },
  )

  it.each([200, 400])('rebases preservation after its initial write for a $0 px viewport', client => {
    const scope = readingImages()
    scope.imageLoad(18, 200)
    scope.beginMediaCorrection()
    expect(scope.scroller.scrollTop).toBe(1000)
    scope.geometry.client = client
    scope.resizeViewport()
    settle()
    expect(scope.scroller.scrollTop).toBe(1000)
    scope.imageLoad(2, 80)
    scope.correctLayout(80)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1080)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it.each([200, 400].flatMap(client =>
    ['before-load', 'during-batch', 'coincident'].flatMap(order =>
      [2, 18].map(index => ({ client, order, index })),
    ),
  ))('rebases a $client px viewport $order with image growth at row $index', ({ client, order, index }) => {
    const scope = readingImages()
    if (order === 'before-load') {
      scope.geometry.client = client
      scope.resizeViewport()
      settle()
    } else if (order === 'coincident') {
      scope.geometry.client = client
    }
    scope.imageLoad(index, 200)
    if (order === 'during-batch') scope.geometry.client = client
    if (order !== 'before-load') scope.resizeViewport()
    scope.correctLayout(index === 2 ? 200 : 0)
    const expected = index === 2 ? 1200 : 1000
    expect(scope.scroller.scrollTop).toBe(expected)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(expected)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.unmount()
    expect(scrollStateManager.getSavedAnchor('room-a')).toEqual({
      messageId: scope.rows[client === 200 ? 11 : 13].rowId, fraction: 1,
    })
    expect(scrollStateManager.getSavedScrollTop('room-a')).toBe(expected)
  })

  it('restores the resized reading position on room return and still paginates genuine movement', () => {
    const scope = readingImages()
    scope.geometry.client = 400
    scope.resizeViewport()
    settle()
    scope.imageLoad(18, 200)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1000)
    scope.switchTo('room-b')
    scope.switchTo('room-a')
    expect(scope.scroller.scrollTop).toBe(1000)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1000))
    scope.move(80, true)
    scope.move(0, true)
    expect(scope.loadOlder).toHaveBeenCalledOnce()
  })

  it.each(['resize', 'scroll'] as const)('rebases the observed row when %s delivers a smaller viewport first', delivery => {
    const scope = readingImages()
    scope.mediaLoad()
    scope.geometry.client = 100
    if (delivery === 'scroll') scope.move(1000, true)
    scope.resizeViewport()
    settle()
    scope.imageLoad(11, 200)
    scope.correctLayout(0)
    expect(scope.scroller.scrollTop).toBe(1000)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1000)
    scope.imageLoad(2, 80)
    scope.correctLayout(80)
    expect(scope.scroller.scrollTop).toBe(1080)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1080)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.unmount()
    expect(scrollStateManager.getSavedAnchor('room-a')).toEqual({ messageId: scope.rows[10].rowId, fraction: 1 })
  })

  it('keeps a resize clamp out of movement and pagination evidence', () => {
    const scope = readingImages()
    scope.geometry.client = 1200
    scope.move(800)
    scope.resizeViewport()
    settle()
    scope.imageLoad(18, 0)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(800)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['before debounce', 'after debounce'] as const)('preserves the pre-growth canonical anchor through exit %s', exit => {
    const scope = readingImages()
    scope.imageLoad(2, 200)
    expect(scope.scroller.scrollTop).toBe(1000)
    scope.correctLayout(200)
    expect(scope.scroller.scrollTop).toBe(1200)
    if (exit === 'after debounce') {
      scope.debounce()
      expect(scope.scroller.scrollTop).toBe(1200)
    }
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.unmount()
    expect(scrollStateManager.getSavedAnchor('room-a')).toEqual({ messageId: scope.rows[12].rowId, fraction: 1 })
    scope.remount()
    expect(document.querySelector('[data-message-list]')?.scrollTop).toBe(1200)
    scope.debounce()
    expect(document.querySelector('[data-message-list]')?.scrollTop).toBe(1200)
  })

  it('keeps both image corrections through one media batch', () => {
    const scope = readingImages()
    scope.imageLoad(2, 200)
    scope.correctLayout(200)
    scope.imageLoad(4, 80)
    scope.correctLayout(80)
    expect(scope.scroller.scrollTop).toBe(1280)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1280)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it.each(['before', 'after'] as const)('keeps delayed takeover %s layout correction', order => {
    const scope = readingImages()
    scope.imageLoad(2, 200)
    if (order === 'after') scope.correctLayout(200)
    const chosen = scope.scroller.scrollTop - 50
    scope.move(chosen)
    scope.resizeContent()
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(chosen)
    expect(scope.scrollEvents).toEqual([])
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.imageLoad(4, 80)
    scope.correctLayout(80)
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(chosen + 80)
    act(() => vi.advanceTimersByTime(1000))
    scope.move(80, true)
    scope.move(0, true)
    expect(scope.loadOlder).toHaveBeenCalledOnce()
  })

  it('lets newer explicit navigation retire the pre-growth media anchor', () => {
    const scope = readingImages()
    scope.imageLoad(2, 200)
    scope.correctLayout(200)
    scope.toBottom()
    settle()
    scope.debounce()
    expect(scope.scroller.scrollTop).toBe(1900)
    expect(scope.loadOlder).not.toHaveBeenCalled()
  })

  it('maintains selected-message visibility while the pre-growth media batch settles', () => {
    const scope = readingImages()
    scope.toTarget()
    settle()
    scope.imageLoad(2, 200)
    scope.resizeContent()
    scope.debounce()
    const selected = scope.rows[16]
    expect(selected.top).toBeGreaterThanOrEqual(scope.scroller.scrollTop)
    expect(selected.top + selected.height).toBeLessThanOrEqual(scope.scroller.scrollTop + 300)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })
})
