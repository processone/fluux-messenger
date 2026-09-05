import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAnomalyObservationHandler,
  setAnomalyObservationHandler,
  type AnomalyObservation,
} from '@/utils/anomalyObservation'
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
  const reconcileLiveEdge = vi.fn(() => true)
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

  /**
   * The shrink direction has no engine backstop — a browser clamps `scrollTop` only
   * downward — so a re-pin that never runs leaves the reader short until they scroll.
   * `scroll/live-edge-pin-short` cannot see that, because it needs a run that reached
   * `settled`. These prove the fact leaves the hook at all: a control that never
   * registered a handler would keep the whole path unproven.
   */
  describe('shrink observations', () => {
    let observed: AnomalyObservation[]

    beforeEach(() => {
      observed = []
      setAnomalyObservationHandler((observation) => observed.push(observation))
    })

    afterEach(() => {
      clearAnomalyObservationHandler()
    })

    const shrinks = () => observed.filter((o) => o.kind === 'scrollport-shrank')

    it('reports the shrink it reconciled, with what it cost', () => {
      const scope = mount()
      observers[0].fire(600, 800)
      flushFrames()

      scope.scroller.geometry.clientHeight = 560
      scope.scroller.geometry.scrollTop = 400
      observers[0].fire(560, 800)
      flushFrames()

      expect(scope.reconcileLiveEdge).toHaveBeenCalledWith('container-shrink', true)
      expect(shrinks()).toEqual([
        {
          kind: 'scrollport-shrank',
          conversationId: 'room-a',
          shrunkPx: 40,
          distFromBottom: 40,
          scrollHeight: 1000,
          repin: 'ran',
          tolerancePx: 4,
        },
      ])
    })

    it('reports when the positioning controller refuses the re-pin', () => {
      const scope = mount()
      scope.reconcileLiveEdge.mockReturnValue(false)
      observers[0].fire(600, 800)
      flushFrames()

      scope.scroller.geometry.clientHeight = 560
      scope.scroller.geometry.scrollTop = 400
      observers[0].fire(560, 800)
      flushFrames()

      expect(scope.reconcileLiveEdge).toHaveBeenCalledWith('container-shrink', true)
      expect(shrinks()).toEqual([
        {
          kind: 'scrollport-shrank',
          conversationId: 'room-a',
          shrunkPx: 40,
          distFromBottom: 40,
          scrollHeight: 1000,
          repin: 'refused',
          tolerancePx: 4,
        },
      ])
    })

    it('reports when no re-pin was needed', () => {
      const scope = mount()
      observers[0].fire(600, 800)
      flushFrames()

      scope.scroller.geometry.clientHeight = 560
      scope.scroller.geometry.scrollTop = 0
      observers[0].fire(560, 800)
      flushFrames()

      expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
      expect(shrinks()).toEqual([
        {
          kind: 'scrollport-shrank',
          conversationId: 'room-a',
          shrunkPx: 40,
          distFromBottom: 440,
          scrollHeight: 1000,
          repin: null,
          tolerancePx: 4,
        },
      ])
    })

    it('says nothing about a growth', () => {
      const scope = mount()
      observers[0].fire(600, 800)
      flushFrames()

      scope.scroller.geometry.clientHeight = 640
      observers[0].fire(640, 800)
      flushFrames()

      expect(shrinks()).toEqual([])
    })
  })

  it('reconciles a container growth that left the view short of the bottom', () => {
    const scope = mount()
    observers[0].fire(400, 800)
    flushFrames()

    // The composer collapses: the scroller grows back, but content measured in the same commit
    // leaves the view below the bottom. The at-bottom latch already reads that drifted distance,
    // so the branch must not consult it.
    scope.state.atBottom = false
    scope.scroller.geometry.clientHeight = 600
    scope.scroller.geometry.scrollHeight = 1_286
    scope.scroller.geometry.scrollTop = 400
    observers[0].fire(600, 800)
    flushFrames()

    // `false`: re-open an existing follow only. Post-resize geometry cannot tell a follower from a
    // reader who scrolled up, so it must never mint a new one.
    expect(scope.reconcileLiveEdge).toHaveBeenCalledWith('container-growth', false)
  })

  it('leaves a container growth alone once the view is already at the bottom', () => {
    const scope = mount()
    observers[0].fire(400, 800)
    flushFrames()

    scope.scroller.geometry.clientHeight = 600
    scope.scroller.geometry.scrollTop = 400
    observers[0].fire(600, 800)
    flushFrames()

    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
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
