import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { MessageVirtualizer } from './messageVirtualizer'
import {
  useScrollContainerBinding,
  type ScrollContainerBindingPorts,
} from './useScrollContainerBinding'

interface FakeObserver {
  target: Element | null
  fire: () => void
  disconnected: boolean
}

let observers: FakeObserver[] = []
let rafQueue: Array<{ id: number; cb: () => void; cancelled: boolean }> = []
let nextRafId = 1

function flushFrames() {
  const due = rafQueue
  rafQueue = []
  for (const frame of due) if (!frame.cancelled) frame.cb()
}

beforeEach(() => {
  observers = []
  rafQueue = []
  nextRafId = 1
  vi.stubGlobal('ResizeObserver', class {
    private readonly record: FakeObserver
    constructor(callback: () => void) {
      this.record = { target: null, fire: callback, disconnected: false }
    }
    observe(target: Element) {
      this.record.target = target
      observers.push(this.record)
    }
    disconnect() { this.record.disconnected = true }
    unobserve() {}
  })
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    const id = nextRafId++
    rafQueue.push({ id, cb, cancelled: false })
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const frame = rafQueue.find((f) => f.id === id)
    if (frame) frame.cancelled = true
  })
})

afterEach(() => { vi.unstubAllGlobals() })

function scrollerElement(scrollHeight = 1_000) {
  const el = document.createElement('div')
  let height = scrollHeight
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => 0, set: () => {} },
    clientHeight: { configurable: true, get: () => 600 },
  })
  return { el, grow: (to: number) => { height = to } }
}

function portsHarness(overrides: Partial<ScrollContainerBindingPorts> = {}) {
  let attached: HTMLDivElement | null = null
  const state = {
    virtualizer: undefined as MessageVirtualizer | undefined,
    staticMode: false,
    atBottom: true,
    directionalPending: false,
    mediaBatch: false,
  }
  const reconcileLiveEdge = vi.fn()
  const recordUserInput = vi.fn()
  const observeUserInput = vi.fn()
  const ports: ScrollContainerBindingPorts = {
    setScroller: (el) => { attached = el },
    getScroller: () => attached,
    getVirtualizer: () => state.virtualizer,
    isStaticMode: () => state.staticMode,
    isAtBottom: () => state.atBottom,
    getActiveConversationId: () => 'room-a',
    getLoggedConversationId: () => 'room-a',
    isDirectionalHistoryPending: () => state.directionalPending,
    isMediaLoadBatchActive: () => state.mediaBatch,
    reconcileLiveEdge,
    recordUserInput,
    observeUserInput,
    log: vi.fn(),
    ...overrides,
  }
  return { ports, state, reconcileLiveEdge, recordUserInput, observeUserInput }
}

function mount(overrides: Partial<ScrollContainerBindingPorts> = {}) {
  const harness = portsHarness(overrides)
  const rendered = renderHook(
    (p: ScrollContainerBindingPorts) => useScrollContainerBinding(p),
    { initialProps: harness.ports },
  )
  return { ...harness, ...rendered }
}

describe('useScrollContainerBinding attachment', () => {
  it('keeps both setters identical across renders', () => {
    const { result, rerender, ports } = mount()
    const first = { ...result.current }

    // A fresh ports object every render is the expected calling convention.
    rerender({ ...ports })
    rerender({ ...ports })

    // An unstable callback ref makes React detach+reattach on EVERY render, tearing down and
    // rebuilding the observer each time — a forced-reflow amplifier in busy rooms.
    expect(result.current.setScrollContainerRef).toBe(first.setScrollContainerRef)
    expect(result.current.setContentRef).toBe(first.setContentRef)
    expect(result.current.teardownContentObserver).toBe(first.teardownContentObserver)
    expect(result.current.detachUserInputListeners).toBe(first.detachUserInputListeners)
  })

  it('completes late-bound setup whichever node attaches last', () => {
    // React attaches refs child-first: with messages already present the content wrapper lands
    // BEFORE the scroller, so setup must not be tied to one particular arrival order.
    const contentFirst = mount()
    const content = document.createElement('div')
    contentFirst.result.current.setContentRef(content)
    expect(observers).toHaveLength(0)
    contentFirst.result.current.setScrollContainerRef(scrollerElement().el)
    expect(observers).toHaveLength(1)
    expect(observers[0].target).toBe(content)

    observers = []
    const scrollerFirst = mount()
    scrollerFirst.result.current.setScrollContainerRef(scrollerElement().el)
    expect(observers).toHaveLength(0)
    const otherContent = document.createElement('div')
    scrollerFirst.result.current.setContentRef(otherContent)
    expect(observers).toHaveLength(1)
    expect(observers[0].target).toBe(otherContent)
  })

  it('rebuilds the observer only when the content node actually changes', () => {
    const { result } = mount()
    result.current.setScrollContainerRef(scrollerElement().el)
    const content = document.createElement('div')
    result.current.setContentRef(content)
    expect(observers).toHaveLength(1)

    result.current.setContentRef(content)
    expect(observers).toHaveLength(1)
    expect(observers[0].disconnected).toBe(false)

    result.current.setContentRef(document.createElement('div'))
    expect(observers).toHaveLength(2)
    expect(observers[0].disconnected).toBe(true)
  })

  it('moves the user-input listeners with the scroller and releases them on teardown', () => {
    const { result, recordUserInput, observeUserInput } = mount()
    const first = scrollerElement().el
    result.current.setScrollContainerRef(first)
    first.dispatchEvent(new Event('wheel'))
    expect(recordUserInput).toHaveBeenCalledTimes(1)
    expect(observeUserInput).toHaveBeenCalledTimes(1)

    const second = scrollerElement().el
    result.current.setScrollContainerRef(second)
    // The old node must be silent, or a detached scroller keeps opening the persistence gate.
    first.dispatchEvent(new Event('wheel'))
    expect(recordUserInput).toHaveBeenCalledTimes(1)
    second.dispatchEvent(new Event('touchstart'))
    second.dispatchEvent(new Event('keydown'))
    expect(recordUserInput).toHaveBeenCalledTimes(3)

    result.current.detachUserInputListeners()
    second.dispatchEvent(new Event('wheel'))
    expect(recordUserInput).toHaveBeenCalledTimes(3)
  })
})

describe('useScrollContainerBinding growth correction', () => {
  function attached(overrides: Partial<ScrollContainerBindingPorts> = {}) {
    const scope = mount(overrides)
    const scroller = scrollerElement()
    scope.result.current.setScrollContainerRef(scroller.el)
    scope.result.current.setContentRef(document.createElement('div'))
    return { ...scope, scroller }
  }

  it('re-opens the live-edge generation when content grows at the bottom', () => {
    const scope = attached()
    scope.scroller.grow(1_400)
    observers[0].fire()
    flushFrames()
    expect(scope.reconcileLiveEdge).toHaveBeenCalledWith('content-growth', true)
  })

  it('coalesces a burst of observer fires into a single correction frame', () => {
    const scope = attached()
    scope.scroller.grow(1_400)
    observers[0].fire()
    observers[0].fire()
    observers[0].fire()
    // The read-scrollHeight -> write-scrollTop -> reflow -> re-fire feedback is what this caps.
    expect(rafQueue).toHaveLength(1)
    flushFrames()
    expect(scope.reconcileLiveEdge).toHaveBeenCalledTimes(1)
  })

  it('never corrects while reading history, mid-prepend, mid-media-batch, or in a preview', () => {
    for (const mutate of [
      (s: ReturnType<typeof attached>) => { s.state.atBottom = false },
      (s: ReturnType<typeof attached>) => { s.state.directionalPending = true },
      (s: ReturnType<typeof attached>) => { s.state.mediaBatch = true },
      (s: ReturnType<typeof attached>) => { s.state.staticMode = true },
    ]) {
      observers = []
      rafQueue = []
      const scope = attached()
      mutate(scope)
      scope.scroller.grow(1_400)
      observers[0].fire()
      flushFrames()
      expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
    }
  })

  it('does not correct when the content merely shrinks', () => {
    const scope = attached()
    scope.scroller.grow(600)
    observers[0].fire()
    flushFrames()
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
  })

  it('skips the observer entirely while virtualized', () => {
    const scope = attached()
    scope.state.virtualizer = {} as MessageVirtualizer
    scope.scroller.grow(1_400)
    observers[0].fire()
    // The wrapper IS the @tanstack spacer: scheduling a frame here loops back into the virtualizer
    // (re-measure -> spacer change -> RO -> scroll -> re-render).
    expect(rafQueue).toHaveLength(0)
    flushFrames()
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
  })

  it('abandons an already-queued correction when virtualization flips on before the frame runs', () => {
    const scope = attached()
    scope.scroller.grow(1_400)
    observers[0].fire()
    expect(rafQueue).toHaveLength(1)

    // The observer callback's early return cannot cover this: the frame was queued while the list
    // was still non-virtualized. Correcting now writes scrollTop against the @tanstack spacer.
    scope.state.virtualizer = {} as MessageVirtualizer
    flushFrames()
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
  })

  it('drops a pending correction frame when the observer is torn down', () => {
    const scope = attached()
    scope.scroller.grow(1_400)
    observers[0].fire()
    expect(rafQueue).toHaveLength(1)

    scope.result.current.teardownContentObserver()
    flushFrames()
    expect(scope.reconcileLiveEdge).not.toHaveBeenCalled()
    expect(observers[0].disconnected).toBe(true)
  })
})
