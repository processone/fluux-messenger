import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewportSession } from './viewportSession'
import { PositioningController } from './positioningController'
import { TARGET_HIGHLIGHT_MS } from './explicitTargetBrowserAdapter'
import { MEDIA_LOAD_DEBOUNCE_MS } from './useMediaGrowthPreservation'
import { resetScrollShadowDiagnostics, getScrollShadowSnapshot } from './scrollPositionShadow'
import { scrollStateManager } from '@/utils/scrollStateManager'
import type { MessageVirtualizer } from './messageVirtualizer'
import { useMessageListScroll, type UseMessageListScrollResult } from './useMessageListScroll'

const conversationId = 'room-a'
let frames: Map<number, FrameRequestCallback>
let nextFrameId: number
let resizeCallbacks: Map<Element, (height: number) => void>

function runFrame() {
  act(() => {
    const due = [...frames.entries()]
    for (const [id, callback] of due) {
      if (frames.delete(id)) callback(performance.now())
    }
  })
}

function settle() {
  for (let i = 0; frames.size && i < 100; i++) runFrame()
  expect(frames.size).toBe(0)
  expect(getScrollShadowSnapshot().instrumentationErrors).toEqual([])
}

beforeEach(() => {
  vi.useFakeTimers()
  scrollStateManager.reset()
  resetScrollShadowDiagnostics()
  frames = new Map()
  nextFrameId = 1
  resizeCallbacks = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    private elements = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) {
      this.elements.add(element)
      resizeCallbacks.set(element, (height) => this.callback([
        { target: element, contentRect: { height, width: 800 } } as ResizeObserverEntry,
      ], this as unknown as ResizeObserver))
    }
    unobserve(element: Element) { resizeCallbacks.delete(element) }
    disconnect() { this.elements.forEach(element => resizeCallbacks.delete(element)) }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function harness(virtualized: boolean, contentHeight = 1000, targetInset = 0, historical = false) {
  const geometry = { height: contentHeight, client: 600, targetTop: contentHeight - 80 - targetInset, targetHeight: 80 }
  let scrollTop = 0
  let messageCount = 20
  let rowGrowthSignature = 0
  let scroller: HTMLDivElement
  let target: HTMLDivElement
  let api: UseMessageListScrollResult
  let setSearchTarget: React.Dispatch<React.SetStateAction<string | null>>
  let scrollQueued = false
  let deliverScrollEvents = !historical
  const writes: number[] = []
  const scrollEvents: number[] = []
  const loadAround = vi.fn()
  const loadNewer = vi.fn()
  const loadOlder = vi.fn()
  const consumeStoreTarget = vi.fn(() => setSearchTarget(null))
  const measuredLiveEdge = vi.fn()
  const center = () => {
    scroller.scrollTop = geometry.targetTop + geometry.targetHeight / 2 - geometry.client / 2
  }
  const retained = vi.fn()
  let automaticAdjustmentEnabled = true
  let writeObserver: Parameters<NonNullable<MessageVirtualizer['setScrollWriteObserver']>>[0]
  const virtualizer: MessageVirtualizer | undefined = virtualized ? {
    retainMessage: retained,
    setScrollWriteObserver: observer => { writeObserver = observer },
    setAutomaticScrollAdjustmentEnabled: enabled => { automaticAdjustmentEnabled = enabled },
    getVirtualItems: () => [{ index: 19, start: geometry.targetTop, size: geometry.targetHeight, key: 'selected' }],
    getTotalSize: () => geometry.height,
    itemCount: 20,
    getOffsetForMessageId: (id) => id === 'selected' ? geometry.targetTop : null,
    getIndexForMessageId: (id) => id === 'selected' ? 19 : null,
    ensureMessageMounted: vi.fn(async () => {}),
    measureElement: vi.fn(),
    scrollToOffset: (top) => { scroller.scrollTop = top },
    scrollToIndex: (index, options) => {
      if (options?.align === 'end') scroller.scrollTop = (index === 19
        ? geometry.targetTop + geometry.targetHeight
        : geometry.height) - geometry.client
      else center()
    },
    beginAnimatedScrollToOffset: (top) => { scroller.scrollTo({ top, behavior: 'smooth' }) },
  } : undefined
  const setTarget = (node: HTMLDivElement | null) => {
    if (!node) return
    target = node
    Object.defineProperties(node, {
      offsetTop: { configurable: true, get: () => geometry.targetTop },
      offsetHeight: { configurable: true, get: () => geometry.targetHeight },
    })
    node.getBoundingClientRect = () =>
      new DOMRect(0, 100 + geometry.targetTop - scrollTop, 780, geometry.targetHeight)
    node.scrollIntoView = center
  }
  function HookHarness() {
    const [targetMessageId, setTargetMessageId] = React.useState<string | null>(null)
    const result = useMessageListScroll({
      conversationId,
      messageCount,
      firstMessageId: 'first',
      lastMessageId: messageCount === 20 ? 'selected' : `incoming-${messageCount}`,
      rowGrowthSignature: String(rowGrowthSignature),
      onLoadAround: loadAround,
      onLoadNewer: loadNewer,
      onScrollToTop: loadOlder,
      windowAtLiveEdge: !historical,
      targetMessageId,
      onTargetMessageConsumed: consumeStoreTarget,
      onLiveEdgeMeasured: measuredLiveEdge,
      virtualizer,
    })
    const setContainer = result.setScrollContainerRef
    const setScroller = React.useCallback((node: HTMLDivElement | null) => {
      if (node) {
        scroller = node
        Object.defineProperties(node, {
          scrollTop: {
            configurable: true,
            get: () => scrollTop,
            set: (top: number) => {
              writes.push(top)
              const next = Math.max(0, Math.min(top, geometry.height - geometry.client))
              if (next === scrollTop) return
              scrollTop = next
              if (!scrollQueued) {
                scrollQueued = true
                requestAnimationFrame(() => {
                  scrollQueued = false
                  if (deliverScrollEvents) node.dispatchEvent(new Event('scroll'))
                })
              }
            },
          },
          scrollHeight: { configurable: true, get: () => geometry.height },
          clientHeight: { configurable: true, get: () => geometry.client },
          clientWidth: { configurable: true, get: () => 794 },
        })
        node.getBoundingClientRect = () => new DOMRect(0, 100, 800, geometry.client)
        node.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
          node.scrollTop = typeof options === 'number' ? y ?? node.scrollTop : options?.top ?? node.scrollTop
        }
      }
      setContainer(node)
    }, [setContainer])
    React.useLayoutEffect(() => {
      api = result
      setSearchTarget = setTargetMessageId
    }, [result])
    return (
      <div ref={setScroller} onScroll={event => {
        scrollEvents.push(event.currentTarget.scrollTop)
        result.handleScroll(event)
      }} onWheel={result.handleWheel} data-message-list>
        <div ref={result.contentWrapperRef}>
          <div ref={setTarget} className="message-row" data-message-id="selected" />
        </div>
      </div>
    )
  }
  const view = render(<HookHarness />)
  act(() => resizeCallbacks.get(scroller)!(geometry.client))
  settle()
  const highlight = vi.spyOn(target!.classList, 'add')
  act(() => api.requestMessageTarget('selected'))
  settle()
  expect(scroller!.scrollTop).toBe(contentHeight - geometry.client)
  expect(target!).toHaveClass('message-highlight')
  act(() => vi.advanceTimersByTime(TARGET_HIGHLIGHT_MS))
  expect(target!).not.toHaveClass('message-highlight')
  writes.length = 0
  const queueResize = (height: number) => {
    geometry.client = height
    const maximumTop = Math.max(0, geometry.height - height)
    if (scrollTop > maximumTop) {
      scrollTop = maximumTop
      requestAnimationFrame(() => {
        if (deliverScrollEvents) fireEvent.scroll(scroller)
      })
    }
    act(() => resizeCallbacks.get(scroller)!(height))
  }
  return {
    geometry, loadNewer, loadOlder, retained, request: (id: string) => act(() => api.requestMessageTarget(id)), scroller: scroller!, target: target!, unmount: view.unmount, writes, scrollEvents, measuredLiveEdge, consumeStoreTarget,
    replayRef: () => {
      let detached: { anchoring: string; automaticAdjustmentEnabled: boolean }
      act(() => {
        api.setScrollContainerRef(null)
        detached = { anchoring: scroller.style.overflowAnchor, automaticAdjustmentEnabled }
        api.setScrollContainerRef(scroller)
      })
      return detached!
    },
    setScrollDelivery: (enabled: boolean) => { deliverScrollEvents = enabled },
    search: () => act(() => setSearchTarget('selected')),
    nativeScroll: (top: number) => {
      scrollTop = Math.max(0, Math.min(top, geometry.height - geometry.client))
      fireEvent.scroll(scroller)
    },
    follow: () => act(() => api.scrollToBottom()),
    growAbove: (height: number, anchored = true) => {
      geometry.height += height
      geometry.targetTop += height
      if (anchored && scroller.style.overflowAnchor !== 'none') scrollTop += height
    },
    applyLayoutAdjustment: (height: number) => {
      if (virtualizer) {
        writeObserver?.({ phase: 'before', source: 'measurement' })
        scrollTop += height
        writeObserver?.({ phase: 'after', source: 'measurement' })
      } else {
        act(() => resizeCallbacks.get(scroller.firstElementChild!)!(geometry.height))
        runFrame()
      }
    },
    reportContentGrowth: (source: 'signature' | 'measurement' | 'observer', height: number) => {
      if (source === 'signature') {
        rowGrowthSignature++
        view.rerender(<HookHarness />)
      } else if (source === 'measurement') {
        act(() => api.handleVirtualRowMeasuredGrowth(conversationId, height))
      } else {
        act(() => resizeCallbacks.get(scroller.firstElementChild!)!(geometry.height))
      }
    },
    mediaLoad: () => act(() => api.handleMediaLoad()),
    wheel: (deltaY: number, delivery: 'native' | 'react' | 'both' = 'both', deltaMode = 0) => {
      if (delivery === 'react') {
        act(() => api.handleWheel({ currentTarget: scroller, deltaY, deltaMode } as React.WheelEvent<HTMLDivElement>))
      } else {
        fireEvent.wheel(scroller, { deltaY, deltaMode, bubbles: delivery === 'both' })
      }
    },
    drag: (delta: number) => {
      fireEvent.pointerDown(scroller, { button: 0, clientX: 795, clientY: 300 })
      act(() => { scroller.scrollTop += delta })
      fireEvent.pointerUp(window, { button: 0 })
    },
    append: (height: number) => {
      geometry.height += height
      messageCount++
      if (virtualizer) virtualizer.itemCount = messageCount
      view.rerender(<HookHarness />)
    },
    queueResize,
    resize: (height: number) => {
      queueResize(height)
      runFrame()
    },
    assertNoNavigationSideEffects: () => {
      expect(loadAround).not.toHaveBeenCalled()
      expect(consumeStoreTarget).not.toHaveBeenCalled()
      expect(highlight.mock.calls.filter(([name]) => name === 'message-highlight')).toHaveLength(1)
      expect(target).not.toHaveClass('message-highlight')
    },
  }
}

function startInput(scroller: HTMLDivElement, kind: 'touch' | 'keyboard' | 'scrollbar') {
  switch (kind) {
    case 'touch':
      fireEvent.touchStart(scroller)
      return () => fireEvent.touchEnd(window)
    case 'keyboard':
      fireEvent.keyDown(scroller, { key: 'ArrowDown' })
      return () => fireEvent.keyUp(window, { key: 'ArrowDown' })
    case 'scrollbar':
      fireEvent.pointerDown(scroller, { button: 0, clientX: 795, clientY: 300 })
      return () => fireEvent.pointerUp(window, { button: 0 })
  }
}

describe.each([false, true])('shared layout ownership (virtualized: %s)', (virtualized) => {
  it('recovers from a released downward gesture during shrinking layout', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    const gesture = movingGesture(scope.scroller, 'touch')
    gesture.move(20)
    gesture.end()
    settle()
    scope.growAbove(-20)
    scope.nativeScroll(scope.scroller.scrollTop + 20)
    settle()
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(483)
    scope.assertNoNavigationSideEffects()
  })

  it('does not infer movement from a released gesture and stationary shrink', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    const gesture = movingGesture(scope.scroller, 'touch')
    gesture.move(20)
    gesture.end()
    settle()
    scope.growAbove(-20, false)
    scope.nativeScroll(393)
    settle()
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
  })

  it('maintains the selected target through shrinking measurements', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.append(1200)
    settle()
    scope.growAbove(-500, false)
    scope.reportContentGrowth(virtualized ? 'measurement' : 'observer', -500)
    settle()
    expect(scope.scroller.scrollTop).toBe(420)
    scope.assertNoNavigationSideEffects()
  })

  it('retains target visibility after ambient media preservation', () => {
    const scope = harness(virtualized)
    scope.append(400)
    settle()
    scope.nativeScroll(scope.scroller.scrollTop)
    scope.mediaLoad()
    scope.growAbove(80, false)
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS))
    settle()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(523)
    scope.append(80)
    settle()
    expect(scope.scroller.scrollTop).toBe(523)
    scope.assertNoNavigationSideEffects()
  })
})

function movingGesture(scroller: HTMLDivElement, kind: 'touch' | 'scrollbar') {
  if (kind === 'touch') fireEvent.touchStart(scroller, { touches: [{ identifier: 1, clientY: 300 }] })
  else fireEvent.pointerDown(scroller, { button: 0, pointerId: 1, clientX: 795, clientY: 300 })
  return {
    move: (delta: number) => {
      if (kind === 'touch') fireEvent.touchMove(scroller, { touches: [{ identifier: 1, clientY: 300 - delta }] })
      else fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 + delta })
    },
    end: () => {
      if (kind === 'touch') fireEvent.touchEnd(window)
      else fireEvent.pointerUp(window, { button: 0, pointerId: 1 })
    },
  }
}

describe.each([false, true])('message-target resize maintenance (virtualized: %s)', (virtualized) => {
  it.each(['signature', virtualized ? 'measurement' : 'observer'] as const)(
    'maintains a settled target after content growth reported by %s', (source) => {
      const scope = harness(virtualized)
      scope.resize(557)
      settle()
      expect(scope.scroller.scrollTop).toBe(443)
      scope.growAbove(80, false)
      scope.reportContentGrowth(source, 80)
      settle()
      expect(scope.scroller.scrollTop).toBe(523)
      expect(scope.target.getBoundingClientRect().bottom).toBe(scope.scroller.getBoundingClientRect().bottom)
      scope.append(100)
      settle()
      expect(scope.scroller.scrollTop).toBe(523)
      scope.assertNoNavigationSideEffects()
    },
  )

  it.each(['signature', virtualized ? 'measurement' : 'observer'] as const)(
    'leaves an already visible target in place after content growth reported by %s', (source) => {
      const scope = harness(virtualized, 1000, 100)
      scope.resize(557)
      settle()
      scope.growAbove(20, false)
      scope.reportContentGrowth(source, 20)
      settle()
      expect(scope.scroller.scrollTop).toBe(400)
      expect(scope.writes).toEqual([])
      scope.assertNoNavigationSideEffects()
    },
  )

  it.each(['wheel', 'keyboard', 'touch', 'scrollbar'] as const)(
    'recovers follow when downward %s movement equals unanchored row growth', (kind) => {
      const scope = harness(virtualized)
      scope.resize(557)
      settle()
      scope.drag(-50)
      settle()
      expect(scope.scroller.style.overflowAnchor).toBe('none')
      const gesture = kind === 'touch' || kind === 'scrollbar' ? movingGesture(scope.scroller, kind) : null
      if (gesture) gesture.move(50)
      else if (kind === 'wheel') scope.wheel(50)
      else fireEvent.keyDown(scope.scroller, { key: 'ArrowDown' })
      scope.growAbove(50, false)
      scope.nativeScroll(443)
      gesture?.end()
      if (kind === 'keyboard') fireEvent.keyUp(window, { key: 'ArrowDown' })
      settle()
      scope.append(60)
      settle()
      expect(scope.scroller.scrollTop).toBe(553)
      scope.assertNoNavigationSideEffects()
    },
  )

  it('recovers follow after ArrowDown release and delayed movement amid equal growth', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    fireEvent.keyDown(scope.scroller, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyUp(window, { key: 'ArrowDown', code: 'ArrowDown' })
    settle()
    act(() => vi.advanceTimersByTime(40))
    expect(scope.scroller.scrollTop).toBe(393)
    scope.growAbove(20, false)
    scope.nativeScroll(413)
    settle()
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(523)
    scope.assertNoNavigationSideEffects()
  })

  it('keeps Home animation owned after the initiating key is delivered to the focused list', () => {
    const h = harness(virtualized)
    h.scroller.scrollTo = vi.fn()
    const navigation = vi.spyOn(PositioningController.prototype, 'beginResidentTopNavigation')
    try {
      fireEvent.keyDown(h.scroller, { key: 'Home' })
      const controller = navigation.mock.contexts[0] as PositioningController
      settle()
      h.nativeScroll(0)
      settle()
      expect(controller.snapshot().active?.phase.kind).toBe('settled')
    } finally {
      navigation.mockRestore()
    }
  })

  it('keeps delayed Home settlement out of pagination while allowing later user movement', () => {
    const scope = harness(virtualized, 1400)
    expect(scope.scroller.scrollTop).toBe(800)
    scope.setScrollDelivery(false)
    scope.scroller.scrollTo = vi.fn()
    fireEvent.keyDown(scope.scroller, { key: 'Home' })
    settle()

    act(() => vi.advanceTimersByTime(5000))
    scope.nativeScroll(0)
    settle()
    expect(scope.loadOlder).not.toHaveBeenCalled()

    scope.nativeScroll(120)
    settle()
    scope.wheel(-120)
    scope.nativeScroll(0)
    settle()
    expect(scope.loadOlder).toHaveBeenCalledTimes(1)
  })


  it('keeps layout adjustment owned through takeover and fresh navigation', () => {
    const scope = harness(virtualized)
    expect(scope.scroller.style.overflowAnchor).toBe('none')
    scope.drag(-20)
    settle()
    expect(scope.scroller.style.overflowAnchor).toBe('none')
    scope.search()
    settle()
    expect(scope.scroller.style.overflowAnchor).toBe('none')
    scope.follow()
    settle()
    expect(scope.scroller.style.overflowAnchor).toBe('none')
  })

  it('restores the scroller anchoring setting on unmount', async () => {
    const scope = harness(virtualized)
    expect(scope.scroller.style.overflowAnchor).toBe('none')
    scope.unmount()
    await act(async () => { await Promise.resolve() })
    expect(scope.scroller.style.overflowAnchor).toBe('')
  })

  it('keeps anchoring ownership across a temporary ref detach', async () => {
    const scope = harness(virtualized)
    expect(scope.replayRef()).toEqual({ anchoring: 'none', automaticAdjustmentEnabled: !virtualized })
    await act(async () => { await Promise.resolve() })
    expect(scope.scroller.style.overflowAnchor).toBe('none')
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it('honors scrolling equal to a row shrink below the browser anchor', () => {
    const scope = harness(virtualized)
    scope.append(100)
    const gesture = movingGesture(scope.scroller, 'scrollbar')
    scope.growAbove(-20, false)
    scope.nativeScroll(380)
    gesture.move(-20)
    gesture.end()
    scope.writes.length = 0
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(380)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each((['native', 'react', 'both'] as const).flatMap(delivery =>
    [0, 1, 2].flatMap(deltaMode => [false, true].map(preapplied => ({ delivery, deltaMode, preapplied }))),
  ))('preserves movement for wheel mode $deltaMode through $delivery delivery (preapplied: $preapplied)', ({ delivery, deltaMode, preapplied }) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    if (!preapplied) scope.wheel(-3, delivery, deltaMode)
    scope.growAbove(60)
    act(() => { scope.scroller.scrollTop -= 60 })
    if (preapplied) scope.wheel(-3, delivery, deltaMode)
    scope.nativeScroll(383)
    settle()
    scope.writes.length = 0
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(383)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it('preserves PageUp movement overlapping row growth from a focused descendant', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.target.tabIndex = 0
    scope.target.focus()
    fireEvent.keyDown(scope.target, { key: 'PageUp', code: 'PageUp' })
    scope.growAbove(100)
    scope.nativeScroll(343)
    fireEvent.keyUp(window, { key: 'PageUp', code: 'PageUp' })
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(343)
    expect(scope.writes).toEqual([])
  })

  it('honors delayed keyboard animation after upward intent cancels maintenance', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    fireEvent.keyDown(scope.scroller, { key: 'PageUp' })
    scope.growAbove(100)
    fireEvent.keyUp(window, { key: 'PageUp' })
    runFrame()
    runFrame()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.nativeScroll(423)
    scope.writes.length = 0
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(423)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it('resumes target visibility after an abandoned nonmoving PageDown', () => {
    const scope = harness(virtualized)
    fireEvent.keyDown(scope.scroller, { key: 'PageDown', code: 'PageDown' })
    fireEvent.blur(window)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.assertNoNavigationSideEffects()
  })
  it.each((['wheel', 'touch', 'scrollbar'] as const).flatMap(kind =>
    (['scroll', 'release'] as const).map(delivery => ({ kind, delivery })),
  ))('retains $kind input preceding row growth ($delivery delivery)', ({ kind, delivery }) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const gesture = kind === 'wheel' ? null : movingGesture(scope.scroller, kind)
    if (gesture) gesture.move(-100)
    else scope.wheel(-100)
    scope.growAbove(100)
    scope.setScrollDelivery(false)
    act(() => { scope.scroller.scrollTop -= 100 })
    if (delivery === 'scroll') scope.nativeScroll(343)
    gesture?.end()
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(343)
    expect(scope.writes).toEqual([])
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(343)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each(['touch', 'scrollbar'] as const)('keeps the selected target after a clamped downward %s attempt after row growth', (kind) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.growAbove(100)
    scope.resize(556)
    settle()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(543)
    const gesture = movingGesture(scope.scroller, kind)
    gesture.move(100)
    scope.nativeScroll(543)
    gesture.end()
    settle()
    scope.writes.length = 0
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(543)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it('retains touch tracking when native panning cancels the pointer stream', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const gesture = movingGesture(scope.scroller, 'touch')
    fireEvent.pointerCancel(window, { pointerType: 'touch', pointerId: 1 })
    fireEvent.keyUp(window, { key: 'ArrowDown' })
    scope.growAbove(100)
    act(() => { scope.scroller.scrollTop -= 100 })
    gesture.move(-100)
    gesture.end()
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(343)
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(343)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it('allows a real downward return to bottom amid anchoring', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    const gesture = movingGesture(scope.scroller, 'scrollbar')
    gesture.move(50)
    scope.growAbove(100)
    scope.nativeScroll(543)
    gesture.end()
    settle()
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(603)
    scope.assertNoNavigationSideEffects()
  })

  it('does not restore target protection after an ended upward wheel', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.wheel(-100)
    settle()
    scope.growAbove(100, false)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it.each((['touch', 'scrollbar'] as const).flatMap(kind =>
    (['scroll', 'release'] as const).map(delivery => ({ kind, delivery })),
  ))('preserves $kind movement with $delivery delivery', ({ kind, delivery }) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const gesture = movingGesture(scope.scroller, kind)
    scope.growAbove(100)
    scope.setScrollDelivery(false)
    act(() => { scope.scroller.scrollTop -= 100 })
    gesture.move(-100)
    if (delivery === 'scroll') scope.nativeScroll(343)
    gesture.end()
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(343)
    expect(scope.writes).toEqual([])
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(343)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each((['native', 'react', 'both'] as const).flatMap(delivery =>
    (delivery === 'react' ? [true] : [false, true]).map(moved => ({ delivery, moved })),
  ))('cancels upward wheel protection with or without stationary growth ($delivery, moved: $moved)', ({ delivery, moved }) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.growAbove(100, moved)
    if (moved) act(() => { scope.scroller.scrollTop -= 100 })
    scope.wheel(moved ? -100 : -20, delivery)
    settle()
    expect(scope.scroller.scrollTop).toBe(moved ? 343 : 443)
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(moved ? 343 : 443)
    scope.assertNoNavigationSideEffects()
  })

  it.each((['touch', 'scrollbar'] as const).flatMap(kind =>
    [100, 400].map(growth => ({ kind, growth })),
  ))('retains ownership during stationary $kind input and $growth px unanchored row growth', ({ kind, growth }) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const gesture = movingGesture(scope.scroller, kind)
    scope.growAbove(growth, false)
    gesture.move(0)
    scope.nativeScroll(443)
    gesture.end()
    settle()
    expect(scope.scroller.scrollTop).toBe(443 + growth)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(443 + growth)
    scope.assertNoNavigationSideEffects()
  })

  it.each(['touch', 'scrollbar'] as const)('retains upward %s direction when a lower row shrinks without anchoring', (kind) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    scope.append(60)
    const gesture = movingGesture(scope.scroller, kind)
    scope.growAbove(-100, false)
    act(() => { scope.scroller.scrollTop = 373 })
    gesture.move(-20)
    scope.nativeScroll(373)
    gesture.end()
    settle()
    expect(scope.geometry.height - scope.scroller.scrollTop - scope.geometry.client).toBe(30)
    scope.writes.length = 0
    scope.append(60)
    scope.mediaLoad()
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS))
    settle()
    expect(scope.scroller.scrollTop).toBe(373)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each([false, true])('accepts fresh navigation after withheld movement (delayed scroll: %s)', (delayedScroll) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.wheel(-50)
    act(() => { scope.scroller.scrollTop = 393 })
    scope.setScrollDelivery(delayedScroll)
    scope.search()
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    expect(scope.consumeStoreTarget).toHaveBeenCalledOnce()
    expect(scope.target).toHaveClass('message-highlight')
  })

  it('honors new movement after fresh navigation acceptance', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.wheel(-50)
    act(() => { scope.scroller.scrollTop = 393 })
    scope.search()
    scope.wheel(-20)
    scope.nativeScroll(373)
    settle()
    expect(scope.scroller.scrollTop).toBe(373)
    expect(scope.consumeStoreTarget).toHaveBeenCalledOnce()
    expect(scope.target).not.toHaveClass('message-highlight')
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(373)
  })

  it('still corrects an ordinary live follower after a near-bottom upward drag', () => {
    const scope = harness(virtualized)
    scope.follow()
    settle()
    act(() => vi.advanceTimersByTime(300))
    scope.drag(-50)
    settle()
    expect(scope.scroller.scrollTop).toBe(350)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
  })

  it('keeps the selected target visible after a larger arrival moves the tail away', () => {
    const scope = harness(virtualized)
    scope.append(200)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    expect(scope.target.getBoundingClientRect().bottom).toBe(657)
    expect(scope.geometry.height - scope.scroller.scrollTop - scope.geometry.client).toBe(200)
    scope.assertNoNavigationSideEffects()
  })

  it('keeps the selected target through a padding click and later shrink', () => {
    const scope = harness(virtualized)
    fireEvent.pointerDown(scope.scroller, { button: 0, clientX: 8, clientY: 108 })
    scope.append(60)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it('corrects only clipping after an append and another typing-band growth', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(463)
    expect(scope.target.getBoundingClientRect().bottom).toBe(637)
    expect(scope.geometry.height - scope.scroller.scrollTop - scope.geometry.client).toBe(60)
    scope.assertNoNavigationSideEffects()
  })

  it('does not follow an append between resize-correction frames', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it('does not recenter a target already visible after shrink', () => {
    const scope = harness(virtualized)
    scope.geometry.targetTop -= 100
    scope.append(60)
    scope.resize(580)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each([0, 300])('honors a 50px scrollbar takeover after %ims before later shrink', (elapsed) => {
    const scope = harness(virtualized)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(443)
    if (elapsed > 0) settle()
    act(() => vi.advanceTimersByTime(elapsed))
    scope.measuredLiveEdge.mockClear()
    scope.drag(-50)
    scope.writes.length = 0
    settle()
    expect(scope.scrollEvents.at(-1)).toBe(393)
    expect(scope.measuredLiveEdge).toHaveBeenLastCalledWith(true)
    expect(scope.scroller.scrollTop).toBe(393)
    expect(scope.writes).toEqual([])
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each(['native', 'react', 'both'] as const)('keeps a nonmoving downward wheel eligible for target resize correction (%s delivery)', (delivery) => {
    const scope = harness(virtualized)
    const eventsBeforeWheel = scope.scrollEvents.length
    scope.wheel(50, delivery)
    settle()
    expect(scope.scrollEvents).toHaveLength(eventsBeforeWheel)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(463)
    scope.assertNoNavigationSideEffects()
  })

  it.each(['native', 'react', 'both'] as const)('follows arrivals after downward movement reaches bottom before %s wheel delivery', (delivery) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    const eventsBeforeWheel = scope.scrollEvents.length

    act(() => { scope.scroller.scrollTop += 60 })
    expect(scope.scroller.scrollTop).toBe(503)
    expect(scope.scrollEvents).toHaveLength(eventsBeforeWheel)
    scope.wheel(60, delivery)
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(503)
    expect(scope.writes).toEqual([])

    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(563)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(583)
    scope.assertNoNavigationSideEffects()
  })

  it.each(['native', 'react', 'both'] as const)('honors wheel movement applied before %s wheel delivery and the queued scroll event', (delivery) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    const observedBeforeWheel = scope.scrollEvents.length

    act(() => { scope.scroller.scrollTop -= 50 })
    expect(scope.scrollEvents).toHaveLength(observedBeforeWheel)
    scope.wheel(-50, delivery)
    scope.writes.length = 0
    settle()

    expect(scope.scroller.scrollTop).toBe(393)
    expect(scope.writes).toEqual([])
    const endInput = startInput(scope.scroller, 'touch')
    endInput()
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    expect(scope.writes).toEqual([])
    scope.resize(537)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    scope.assertNoNavigationSideEffects()
  })

  it.each(['touch', 'keyboard', 'scrollbar'] as const)(
    'preserves the selected target after nonmoving %s input',
    (kind) => {
      const scope = harness(virtualized)
      const endInput = startInput(scope.scroller, kind)
      endInput()
      settle()
      expect(scope.scroller.scrollTop).toBe(400)
      expect(scope.writes).toEqual([])
      scope.resize(557)
      settle()
      expect(scope.scroller.scrollTop).toBe(443)
      scope.append(60)
      settle()
      expect(scope.scroller.scrollTop).toBe(443)
      scope.assertNoNavigationSideEffects()
    },
  )

  it.each(['touch', 'keyboard', 'scrollbar'] as const)(
    'suspends pending correction writes through a nonmoving %s prelude',
    (kind) => {
      const scope = harness(virtualized)
      scope.resize(557)
      runFrame()
      expect(scope.scroller.scrollTop).toBe(443)
      const endInput = startInput(scope.scroller, kind)
      scope.writes.length = 0
      scope.append(60)
      scope.resize(537)
      settle()
      expect(scope.scroller.scrollTop).toBe(443)
      expect(scope.writes).toEqual([])
      endInput()
      settle()
      expect(scope.scroller.scrollTop).toBe(463)
      scope.assertNoNavigationSideEffects()
    },
  )

  it('preserves fixed targeting for a clamped wheel during resize correction and an arrival', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.wheel(50)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(463)
    scope.assertNoNavigationSideEffects()
  })

  it('retains upward movement across repeated key input before the scroll event', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    act(() => vi.advanceTimersByTime(300))
    fireEvent.keyDown(scope.scroller, { key: 'ArrowUp' })
    act(() => { scope.scroller.scrollTop -= 50 })
    fireEvent.keyDown(scope.scroller, { key: 'ArrowUp', repeat: true })
    fireEvent.keyUp(window, { key: 'ArrowUp' })
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    scope.assertNoNavigationSideEffects()
  })

  it('keeps upward takeover after nonmoving input and until fresh navigation', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    act(() => vi.advanceTimersByTime(300))
    scope.drag(-50)
    settle()
    const endInput = startInput(scope.scroller, 'touch')
    endInput()
    settle()
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    scope.follow()
    settle()
    expect(scope.scroller.scrollTop).toBe(463)
  })

  it('preserves the selected target when typing removal clamps the viewport after settling', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    act(() => vi.advanceTimersByTime(300))
    scope.resize(600)
    settle()
    expect(scope.scrollEvents.at(-1)).toBe(400)
    expect(scope.scroller.scrollTop).toBe(400)
    scope.writes.length = 0
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    expect(scope.writes).toEqual([])
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it.each(['before-frame', 'queued', 'withheld'] as const)('retains the target through a large viewport clamp during maintenance (%s scroll delivery)', (delivery) => {
    const scope = harness(virtualized, 2000, 8)
    if (delivery === 'withheld') scope.setScrollDelivery(false)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(1435)
    expect(frames.size).toBeGreaterThan(0)
    const eventsBeforeClamp = scope.scrollEvents.length

    scope.queueResize(1000)
    expect(scope.scroller.scrollTop).toBe(1000)
    if (delivery === 'before-frame') scope.nativeScroll(1000)
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(1000)
    expect(scope.writes).toEqual([])
    if (delivery === 'withheld') expect(scope.scrollEvents).toHaveLength(eventsBeforeClamp)

    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(1000)
    expect(scope.writes).toEqual([])
    scope.resize(980)
    settle()
    expect(scope.scroller.scrollTop).toBe(1012)
    scope.assertNoNavigationSideEffects()
  })

  it('retains the target when a delayed clamp scroll arrives after another shrink', () => {
    const scope = harness(virtualized, 2000, 8)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(1435)
    scope.setScrollDelivery(false)
    scope.queueResize(1000)
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(1000)
    expect(scope.writes).toEqual([])
    act(() => vi.advanceTimersByTime(300))
    scope.queueResize(980)
    scope.nativeScroll(1000)
    settle()
    expect(scope.scroller.scrollTop).toBe(1012)
    scope.writes.length = 0
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(1012)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it('honors delayed small user movement observed by a no-write frame', () => {
    const scope = harness(virtualized, 2000, 8)
    scope.resize(1000)
    settle()
    const endInput = startInput(scope.scroller, 'scrollbar')
    endInput()
    scope.setScrollDelivery(false)
    act(() => { scope.scroller.scrollTop -= 5 })
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(995)
    expect(scope.writes).toEqual([])
    scope.append(60)
    scope.resize(980)
    settle()
    expect(scope.scroller.scrollTop).toBe(995)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each(['scroll', 'release', 'nonmoving-wheel'] as const)('preserves upward takeover through application anchoring observed on %s', (delivery) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    const endInput = delivery === 'release' ? startInput(scope.scroller, 'touch') : null
    scope.growAbove(100)
    scope.applyLayoutAdjustment(100)
    expect(scope.scroller.scrollTop).toBe(493)
    if (endInput) endInput()
    else if (delivery === 'nonmoving-wheel') scope.wheel(0)
    else scope.nativeScroll(493)
    scope.writes.length = 0
    scope.mediaLoad()
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS))
    settle()
    expect(scope.scroller.scrollTop).toBe(493)
    expect(scope.writes).toEqual([])
    scope.resize(537)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(493)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each(['native', 'react', 'both'] as const)('allows a genuine downward return after browser anchoring (%s wheel delivery)', (delivery) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    scope.growAbove(100)
    scope.nativeScroll(493)
    act(() => { scope.scroller.scrollTop += 50 })
    scope.wheel(50, delivery)
    settle()
    expect(scope.scroller.scrollTop).toBe(543)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(603)
    scope.assertNoNavigationSideEffects()
  })

  it.each([
    { clamped: false, delivery: 'before-frame' },
    { clamped: false, delivery: 'withheld' },
    { clamped: true, delivery: 'before-frame' },
    { clamped: true, delivery: 'withheld' },
  ] as const)('honors real user drift during maintenance (clamped: $clamped, scroll delivery: $delivery)', ({ clamped, delivery }) => {
    const scope = harness(virtualized, 2000, 8)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(1435)
    expect(frames.size).toBeGreaterThan(0)
    if (clamped) scope.queueResize(1000)
    const userTop = clamped ? 650 : 1100
    if (delivery === 'withheld') {
      scope.setScrollDelivery(false)
      act(() => { scope.scroller.scrollTop = userTop })
    } else {
      scope.nativeScroll(userTop)
    }
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(userTop)
    expect(scope.writes).toEqual([])

    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(userTop)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each([false, true])('completes interrupted store navigation before settling (applied: %s)', (applied) => {
    const scope = harness(virtualized)
    scope.search()
    if (applied) runFrame()
    scope.drag(-50)
    expect.soft(scope.consumeStoreTarget).toHaveBeenCalledOnce()
    settle()
    expect(scope.scroller.scrollTop).toBe(350)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(350)
  })

  it('honors native drag movement arriving after release and an unchanged resumed frame', () => {
    const scope = harness(virtualized)
    const endInput = startInput(scope.scroller, 'scrollbar')
    act(() => vi.advanceTimersByTime(21))
    endInput()
    expect(scope.scroller.scrollTop).toBe(400)
    act(() => vi.advanceTimersByTime(14))
    runFrame()
    expect(scope.scroller.scrollTop).toBe(400)
    expect(scope.writes).toEqual([])
    act(() => vi.advanceTimersByTime(21))
    scope.nativeScroll(214)
    expect(scope.scrollEvents.at(-1)).toBe(214)
    runFrame()
    settle()
    expect(scope.scroller.scrollTop).toBe(214)
    expect(scope.writes).toEqual([])
    scope.resize(557)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(214)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it('honors an upward drag after an arrival changes content height before release', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.append(60)
    const endInput = startInput(scope.scroller, 'scrollbar')
    scope.nativeScroll(393)
    endInput()
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    scope.writes.length = 0
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each((['touch', 'scrollbar'] as const).flatMap(kind =>
    (['above', 'below'] as const).flatMap(growth =>
      (['scroll', 'release'] as const).map(delivery => ({ kind, growth, delivery })),
    ),
  ))('honors an active $kind gesture across growth $growth with $delivery delivery', ({ kind, growth, delivery }) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const gesture = movingGesture(scope.scroller, kind)
    if (growth === 'above') scope.growAbove(60)
    else scope.append(60)
    const userTop = scope.scroller.scrollTop - 50
    act(() => { scope.scroller.scrollTop = userTop })
    gesture.move(-50)
    if (delivery === 'scroll') scope.nativeScroll(userTop)
    else {
      scope.setScrollDelivery(false)
      act(() => { scope.scroller.scrollTop = userTop })
    }
    gesture.end()
    scope.writes.length = 0
    settle()
    expect(scope.scroller.scrollTop).toBe(userTop)
    expect(scope.writes).toEqual([])
    scope.resize(537)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(userTop)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each(['above', 'below'] as const)('keeps the target during nonmoving input and growth %s', (growth) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const endInput = startInput(scope.scroller, 'touch')
    if (growth === 'above') scope.growAbove(60)
    else scope.append(60)
    endInput()
    settle()
    expect(scope.scroller.scrollTop).toBe(growth === 'above' ? 503 : 443)
    scope.resize(537)
    settle()
    const targetTop = growth === 'above' ? 523 : 463
    expect(scope.scroller.scrollTop).toBe(targetTop)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(targetTop)
    scope.assertNoNavigationSideEffects()
  })

  it('follows after a downward gesture reaches a tail appended during input', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const endInput = startInput(scope.scroller, 'scrollbar')
    scope.append(60)
    scope.nativeScroll(503)
    endInput()
    settle()
    expect(scope.scroller.scrollTop).toBe(503)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(563)
    scope.assertNoNavigationSideEffects()
  })

  it.each((['native', 'react', 'both'] as const).flatMap(delivery =>
    [false, true].map(moved => ({ delivery, moved })),
  ))('keeps upward wheel direction across attributed anchoring ($delivery delivery, moved: $moved)', ({ delivery, moved }) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    scope.growAbove(100)
    scope.applyLayoutAdjustment(100)
    if (moved) act(() => { scope.scroller.scrollTop -= 20 })
    scope.wheel(-20, delivery)
    scope.writes.length = 0
    settle()
    const userTop = moved ? 473 : 493
    expect(scope.scroller.scrollTop).toBe(userTop)
    expect(scope.writes).toEqual([])
    scope.append(60)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(userTop)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each((['above', 'above-unanchored', 'below'] as const).flatMap(growth =>
    (['before-frame', 'withheld'] as const).map(delivery => ({ growth, delivery })),
  ))('retains maintenance ownership across 400px growth $growth ($delivery delivery)', ({ growth, delivery }) => {
    const scope = harness(virtualized, 2000, 8)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(1435)
    expect(frames.size).toBeGreaterThan(0)
    if (growth === 'below') scope.append(400)
    else scope.growAbove(400, growth === 'above')
    if (delivery === 'before-frame') scope.nativeScroll(scope.scroller.scrollTop)
    else scope.setScrollDelivery(false)
    settle()
    const targetTop = growth === 'below' ? 1435 : 1835
    expect(scope.scroller.scrollTop).toBe(targetTop)
    scope.writes.length = 0
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(targetTop)
    expect(scope.writes).toEqual([])
    scope.assertNoNavigationSideEffects()
  })

  it.each([false, true])('gives a repeated search during maintenance its own cancellation (applied: %s)', (applied) => {
    const scope = harness(virtualized)
    scope.resize(557)
    runFrame()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.search()
    if (applied) runFrame()
    scope.drag(-50)
    expect.soft(scope.consumeStoreTarget).toHaveBeenCalledOnce()
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(393)
  })

  it.each(['release', 'repeated input'] as const)('classifies a queued viewport clamp on %s before its scroll event', (input) => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    const endInput = startInput(scope.scroller, input === 'release' ? 'touch' : 'keyboard')
    scope.queueResize(600)
    expect(scope.scroller.scrollTop).toBe(400)
    expect(scope.scrollEvents.at(-1)).toBe(443)
    if (input === 'repeated input') fireEvent.keyDown(scope.scroller, { key: 'ArrowDown', repeat: true })
    endInput()
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.assertNoNavigationSideEffects()
  })

  it('resumes ordinary following when the reader scrolls back down after target takeover', () => {
    const scope = harness(virtualized)
    scope.resize(557)
    settle()
    scope.drag(-50)
    settle()
    act(() => vi.advanceTimersByTime(300))
    scope.drag(20)
    settle()
    expect(scope.scroller.scrollTop).toBe(413)
    scope.resize(537)
    settle()
    expect(scope.scroller.scrollTop).toBe(463)
  })
})


describe.each([false, true])('final shared boundary (virtualized: %s)', virtualized => {
  it('rebaselines the reading row after upward and downward movement', () => {
    const observed = vi.spyOn(ViewportSession.prototype, 'observeGeometry')
    const scope = harness(virtualized, 2000)
    const rows = Array.from({ length: 19 }, (_, index) => {
      const node = document.createElement('div')
      node.dataset.messageId = `earlier-${index}`
      const geometry = { top: index * 100, height: 100 }
      Object.defineProperty(node, 'offsetHeight', { get: () => geometry.height })
      node.getBoundingClientRect = () => new DOMRect(0, 100 + geometry.top - scope.scroller.scrollTop, 780, geometry.height)
      scope.target.before(node)
      return geometry
    })
    scope.nativeScroll(400)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    scope.geometry.height += 200
    scope.geometry.targetTop += 200
    rows.slice(15).forEach(row => { row.top += 200 })
    scope.reportContentGrowth(virtualized ? 'measurement' : 'observer', 200)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    expect((observed.mock.contexts.at(-1) as ViewportSession).observedRowIdFor(conversationId)).toBe('earlier-9')
    scope.nativeScroll(700)
    settle()
    scope.geometry.height += 80
    scope.geometry.targetTop += 80
    rows.slice(10).forEach(row => { row.top += 80 })
    scope.reportContentGrowth(virtualized ? 'measurement' : 'observer', 80)
    if (virtualized) scope.applyLayoutAdjustment(80)
    settle()
    expect(scope.scroller.scrollTop).toBe(780)
    expect((observed.mock.contexts.at(-1) as ViewportSession).observedRowIdFor(conversationId)).toBe('earlier-12')
    scope.nativeScroll(400)
    settle()
    scope.geometry.height += 50
    scope.geometry.targetTop += 50
    rows.slice(14).forEach(row => { row.top += 50 })
    scope.reportContentGrowth(virtualized ? 'measurement' : 'observer', 50)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    observed.mockRestore()
  })

  it('does not fetch newer history for delayed typing correction and clamp events', () => {
    const scope = harness(virtualized, 2000, 0, true)
    expect(scope.loadNewer).toHaveBeenCalledTimes(1)
    scope.loadNewer.mockClear()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(1443)
    scope.resize(600)
    settle()
    expect(scope.scroller.scrollTop).toBe(1400)
    act(() => vi.advanceTimersByTime(5000))
    scope.setScrollDelivery(true)
    scope.nativeScroll(1400)
    settle()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.nativeScroll(1000)
    settle()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.nativeScroll(1398)
    settle()
    expect(scope.loadNewer).toHaveBeenCalledTimes(1)
  })
})


describe.each([false, true])('observed resize boundary (virtualized: %s)', virtualized => {
  it.each([false, true])('keeps repeated typing clamps out of movement and history (coalesced: %s)', coalesced => {
    const scope = harness(virtualized, 1000, 0, true)
    scope.loadNewer.mockClear()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    for (let i = 0; i < 3; i++) {
      scope.queueResize(600)
      expect(scope.scroller.scrollTop).toBe(400)
      if (!coalesced) settle()
      scope.queueResize(557)
      settle()
      expect(scope.scroller.scrollTop).toBe(443)
    }
    act(() => vi.advanceTimersByTime(5000))
    scope.setScrollDelivery(true)
    scope.nativeScroll(scope.scroller.scrollTop)
    settle()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.nativeScroll(300)
    settle()
    scope.nativeScroll(441)
    settle()
    expect(scope.loadNewer).toHaveBeenCalledTimes(1)
  })
})

it('retains the rendered row when navigating through its archive reference', () => {
  const scope = harness(true)
  scope.target.dataset.stanzaId = 'archive:closed-poll'
  scope.retained.mockClear()
  scope.request('archive:closed-poll')
  settle()
  expect(scope.target).toHaveClass('message-highlight')
  expect(scope.retained).toHaveBeenLastCalledWith('selected')
})


describe.each([false, true])('observed movement before clamping (virtualized: %s)', virtualized => {
  it('preserves independently observed takeover through a later clamp', () => {
    const scope = harness(virtualized, 1000, 0, true)
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.wheel(-20)
    act(() => { scope.scroller.scrollTop = 423 })
    scope.wheel(0)
    scope.queueResize(600)
    expect(scope.scroller.scrollTop).toBe(400)
    settle()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
  })
})


describe.each([false, true])('upward intent policy (virtualized: %s)', virtualized => {
  it.each([false, true])('cancels protection when a clamp erases movement (moved: %s)', moved => {
    const scope = harness(virtualized, 1000, 0, true)
    scope.resize(557)
    settle()
    scope.loadNewer.mockClear()
    expect(scope.scroller.scrollTop).toBe(443)
    scope.wheel(-20)
    if (moved) act(() => { scope.scroller.scrollTop = 423 })
    scope.queueResize(600)
    expect(scope.scroller.scrollTop).toBe(400)
    settle()
    act(() => vi.advanceTimersByTime(5000))
    scope.nativeScroll(400)
    settle()
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    scope.append(60)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.nativeScroll(300)
    settle()
    scope.nativeScroll(503)
    settle()
    expect(scope.loadNewer).toHaveBeenCalledTimes(1)
  })

  it.each(['wheel-native', 'wheel-react', 'ArrowUp', 'PageUp', 'shift-space', 'touch', 'scrollbar'] as const)(
    'cancels on a nonmoving upward %s attempt without fetching', kind => {
      const scope = harness(virtualized, 1000, 0, true)
      scope.loadNewer.mockClear()
      if (kind === 'wheel-native' || kind === 'wheel-react') scope.wheel(-20, kind === 'wheel-native' ? 'native' : 'react')
      else if (kind === 'touch' || kind === 'scrollbar') {
        const gesture = movingGesture(scope.scroller, kind)
        gesture.move(-20)
        gesture.end()
      } else {
        const key = kind === 'shift-space' ? ' ' : kind
        fireEvent.keyDown(scope.scroller, { key, shiftKey: kind === 'shift-space' })
        fireEvent.keyUp(window, { key })
      }
      settle()
      act(() => vi.advanceTimersByTime(5000))
      scope.nativeScroll(400)
      settle()
      expect(scope.loadNewer).not.toHaveBeenCalled()
      scope.resize(557)
      settle()
      expect(scope.scroller.scrollTop).toBe(400)
      scope.append(60)
      settle()
      expect(scope.scroller.scrollTop).toBe(400)
      expect(scope.loadNewer).not.toHaveBeenCalled()
      scope.assertNoNavigationSideEffects()
    },
  )

  it.each(['zero-wheel', 'down-wheel', 'ArrowDown', 'unrelated-key', 'touch-contact', 'scrollbar-contact', 'outside-key'] as const)(
    'preserves protection for nonmoving %s', kind => {
      const scope = harness(virtualized, 1000, 0, true)
      scope.loadNewer.mockClear()
      if (kind === 'zero-wheel' || kind === 'down-wheel') scope.wheel(kind === 'zero-wheel' ? 0 : 20, 'native')
      else if (kind === 'touch-contact' || kind === 'scrollbar-contact') {
        const end = startInput(scope.scroller, kind === 'touch-contact' ? 'touch' : 'scrollbar')
        end()
      } else {
        const key = kind === 'unrelated-key' ? 'a' : kind === 'outside-key' ? 'ArrowUp' : kind
        fireEvent.keyDown(kind === 'outside-key' ? document.body : scope.scroller, { key })
        fireEvent.keyUp(window, { key })
      }
      settle()
      scope.resize(557)
      settle()
      expect(scope.scroller.scrollTop).toBe(443)
      act(() => vi.advanceTimersByTime(5000))
      scope.nativeScroll(443)
      settle()
      expect(scope.loadNewer).not.toHaveBeenCalled()
    },
  )
})


describe.each([false, true])('upward intent at resident top (virtualized: %s)', virtualized => {
  it('fetches older history for a blocked upward wheel', () => {
    const scope = harness(virtualized, 600, 0, true)
    scope.loadOlder.mockClear()
    scope.loadNewer.mockClear()
    scope.wheel(-20)
    settle()
    act(() => vi.advanceTimersByTime(5000))
    scope.nativeScroll(0)
    settle()
    expect(scope.loadOlder).toHaveBeenCalledTimes(1)
    expect(scope.loadNewer).not.toHaveBeenCalled()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(0)
  })

  it('loads older history after observed movement reaches the top', () => {
    const scope = harness(virtualized, 1000, 0, true)
    scope.loadOlder.mockClear()
    scope.nativeScroll(300)
    settle()
    scope.wheel(-300)
    scope.nativeScroll(0)
    settle()
    expect(scope.loadOlder).toHaveBeenCalledTimes(1)
  })
})


describe.each([false, true])('handled upward keys (virtualized: %s)', virtualized => {
  it.each(['ArrowUp', 'PageUp'])('cancels protection before a message handler consumes %s', key => {
    const scope = harness(virtualized, 1000, 0, true)
    scope.loadNewer.mockClear()
    scope.scroller.addEventListener('keydown', event => {
      event.preventDefault()
      event.stopPropagation()
    })
    fireEvent.keyDown(scope.scroller, { key })
    fireEvent.keyUp(window, { key })
    settle()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(400)
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it('preserves the existing policy for a consumed downward key', () => {
    const scope = harness(virtualized)
    scope.scroller.addEventListener('keydown', event => {
      event.preventDefault()
      event.stopPropagation()
    })
    fireEvent.keyDown(scope.scroller, { key: 'ArrowDown' })
    fireEvent.keyUp(window, { key: 'ArrowDown' })
    settle()
    scope.resize(557)
    settle()
    expect(scope.scroller.scrollTop).toBe(443)
  })
})


describe.each([false, true])('pending media takeover (virtualized: %s)', virtualized => {
  function historicalTarget() {
    const scope = harness(virtualized, 1240, 0, true)
    scope.append(600)
    settle()
    scope.nativeScroll(640)
    settle()
    scope.loadOlder.mockClear()
    scope.loadNewer.mockClear()
    expect(scope.scroller.scrollTop).toBe(640)
    return scope
  }

  it.each(['scroll', 'input-read', 'viewport-read', 'content-read'] as const)(
    'keeps the observed 590 position after growth and %s delivery', delivery => {
      const scope = historicalTarget()
      scope.mediaLoad()
      scope.geometry.height += 100
      scope.mediaLoad()
      act(() => { scope.scroller.scrollTop = 590 })
      if (delivery === 'input-read') scope.wheel(0)
      if (delivery === 'viewport-read') scope.queueResize(600)
      if (delivery === 'content-read') scope.reportContentGrowth(virtualized ? 'measurement' : 'observer', 100)
      scope.nativeScroll(590)
      act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS))
      settle()
      expect(scope.scroller.scrollTop).toBe(590)
      scope.resize(557)
      settle()
      expect(scope.scroller.scrollTop).toBe(590)
      expect(scope.loadOlder).not.toHaveBeenCalled()
      expect(scope.loadNewer).not.toHaveBeenCalled()
    },
  )

  it('discards a pending target batch on upward intent without movement evidence', () => {
    const scope = historicalTarget()
    scope.mediaLoad()
    scope.wheel(-20)
    settle()
    scope.resize(557)
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS))
    settle()
    expect(scope.scroller.scrollTop).toBe(640)
    scope.nativeScroll(640)
    settle()
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it('preserves ordinary media anchoring for layout-only growth', () => {
    const scope = historicalTarget()
    scope.nativeScroll(590)
    settle()
    scope.mediaLoad()
    scope.growAbove(80, false)
    scope.nativeScroll(590)
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS))
    settle()
    expect(scope.scroller.scrollTop).toBe(670)
    expect(scope.loadOlder).not.toHaveBeenCalled()
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })

  it('keeps selected protection across a layout-only clamp during a media batch', () => {
    const scope = harness(virtualized, 1240, 0, true)
    scope.resize(557)
    settle()
    scope.loadNewer.mockClear()
    expect(scope.scroller.scrollTop).toBe(683)
    scope.mediaLoad()
    scope.resize(600)
    expect(scope.scroller.scrollTop).toBe(640)
    scope.nativeScroll(640)
    scope.resize(557)
    act(() => vi.advanceTimersByTime(MEDIA_LOAD_DEBOUNCE_MS))
    settle()
    expect(scope.scroller.scrollTop).toBe(683)
    expect(scope.loadNewer).not.toHaveBeenCalled()
  })
})
