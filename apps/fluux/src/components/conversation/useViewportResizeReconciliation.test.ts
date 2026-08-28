import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useViewportResizeReconciliation,
  type ViewportResizeReconciliationPorts,
} from './useViewportResizeReconciliation'

interface FakeObserver {
  target: Element | null
  fire: (height: number, width: number) => void
  disconnected: boolean
}

interface PendingFrame {
  id: number
  callback: FrameRequestCallback
  cancelled: boolean
}

let observers: FakeObserver[] = []
let frames: PendingFrame[] = []
let nextFrameId = 1
let originalVisualViewport: PropertyDescriptor | undefined
let visualViewport: EventTarget

function flushFrames() {
  const due = frames
  frames = []
  for (const frame of due) {
    if (!frame.cancelled) frame.callback(performance.now())
  }
}

beforeEach(() => {
  observers = []
  frames = []
  nextFrameId = 1
  visualViewport = new EventTarget()
  originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: visualViewport,
  })

  vi.stubGlobal('ResizeObserver', class {
    private readonly record: FakeObserver

    constructor(callback: ResizeObserverCallback) {
      this.record = {
        target: null,
        disconnected: false,
        fire: (height, width) => {
          const entry = {
            contentRect: { height, width },
          } as ResizeObserverEntry
          callback([entry], this as unknown as ResizeObserver)
        },
      }
    }

    observe(target: Element) {
      this.record.target = target
      observers.push(this.record)
    }

    disconnect() {
      this.record.disconnected = true
    }

    unobserve() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.push({ id, callback, cancelled: false })
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const frame = frames.find((candidate) => candidate.id === id)
    if (frame) frame.cancelled = true
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalVisualViewport) {
    Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  } else {
    Reflect.deleteProperty(window, 'visualViewport')
  }
})

function scrollerHarness() {
  const element = document.createElement('div')
  const geometry = {
    scrollHeight: 1_000,
    scrollTop: 400,
    clientHeight: 600,
  }
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    scrollTop: { configurable: true, get: () => geometry.scrollTop },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
  })
  return { element, geometry }
}

function mount(staticMode = false) {
  const scroller = scrollerHarness()
  const state = { atBottom: true }
  const reconcileLiveEdge = vi.fn()
  const ports: ViewportResizeReconciliationPorts = {
    getScroller: () => scroller.element,
    isAtBottom: () => state.atBottom,
    reconcileLiveEdge,
  }
  const rendered = renderHook(
    (props: { conversationId: string; staticMode: boolean }) =>
      useViewportResizeReconciliation({ ports, ...props }),
    { initialProps: { conversationId: 'room-a', staticMode } },
  )
  return { ...rendered, scroller, state, reconcileLiveEdge }
}

describe('useViewportResizeReconciliation', () => {
  it('reconciles viewport changes only while following the live edge', () => {
    const scope = mount()

    scope.state.atBottom = false
    window.dispatchEvent(new Event('resize'))
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()

    scope.state.atBottom = true
    window.dispatchEvent(new Event('resize'))
    visualViewport.dispatchEvent(new Event('resize'))
    expect(scope.reconcileLiveEdge).toHaveBeenNthCalledWith(1, 'viewport-resize', true)
    expect(scope.reconcileLiveEdge).toHaveBeenNthCalledWith(2, 'viewport-resize', true)

    scope.unmount()
    window.dispatchEvent(new Event('resize'))
    visualViewport.dispatchEvent(new Event('resize'))
    expect(scope.reconcileLiveEdge).toHaveBeenCalledTimes(2)
  })

  it('keeps viewport listeners disabled for static lists', () => {
    const scope = mount(true)
    window.dispatchEvent(new Event('resize'))
    visualViewport.dispatchEvent(new Event('resize'))
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
  })

  it('carries container-shrink eligibility beyond the plain at-bottom band', () => {
    const scope = mount()
    expect(observers).toHaveLength(1)
    expect(observers[0].target).toBe(scope.scroller.element)

    observers[0].fire(600, 800)
    flushFrames()
    scope.scroller.geometry.clientHeight = 400
    scope.scroller.geometry.scrollTop = 400
    observers[0].fire(450, 800)
    observers[0].fire(400, 800)

    expect(frames).toHaveLength(1)
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
    flushFrames()
    expect(scope.reconcileLiveEdge).toHaveBeenCalledOnce()
    expect(scope.reconcileLiveEdge).toHaveBeenCalledWith('container-shrink', true)
  })

  it('requests width-change only when the reader remains at the live edge', () => {
    const scope = mount()
    observers[0].fire(600, 800)
    flushFrames()

    observers[0].fire(600, 700)
    flushFrames()
    expect(scope.reconcileLiveEdge).toHaveBeenCalledWith('width-change', true)

    scope.reconcileLiveEdge.mockClear()
    scope.state.atBottom = false
    observers[0].fire(600, 650)
    flushFrames()
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
  })

  it('disconnects its observer and cancels a pending frame on cleanup', () => {
    const scope = mount()
    observers[0].fire(600, 800)
    const pending = frames[0]

    scope.unmount()
    expect(observers[0].disconnected).toBe(true)
    expect(pending.cancelled).toBe(true)
    flushFrames()
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
  })
})
