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

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function scrollerElement(scrollHeight = 1_000) {
  const el = document.createElement('div')
  document.body.append(el)
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
  const observeUserInputEnd = vi.fn()
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
    reconcileMessageTargetAfterResize: () => false,
    recordUserInput,
    observeUserInput,
    observeUserInputEnd,
    log: vi.fn(),
    ...overrides,
  }
  return { ports, state, reconcileLiveEdge, recordUserInput, observeUserInput, observeUserInputEnd }
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
  it.each([
    { key: 'PageUp', direction: -1 },
    { key: 'PageDown', direction: 1 },
    { key: 'ArrowUp', direction: -1 },
    { key: 'ArrowDown', direction: 1 },
    { key: ' ', direction: 1 },
    { key: ' ', shiftKey: true, direction: -1 },
  ])('forwards scrolling intent for $key with shift $shiftKey', ({ key, shiftKey, direction }) => {
    const { result, observeUserInput, recordUserInput, observeUserInputEnd } = mount()
    const el = scrollerElement().el
    result.current.setScrollContainerRef(el)
    const target = el.appendChild(document.createElement('span'))
    target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
    expect(observeUserInput).toHaveBeenCalledWith('room-a', expect.objectContaining({ deltaY: direction, source: 'keyboard' }))
    expect(observeUserInput).toHaveBeenCalledOnce()
    expect(recordUserInput).toHaveBeenCalledOnce()
    window.dispatchEvent(new KeyboardEvent('keyup', { key }))
    window.dispatchEvent(new Event('blur'))
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
    result.current.detachUserInputListeners()
  })

  it.each(['input', 'textarea', 'select', 'editable', 'button', 'cancelled', 'pre-cancelled', 'outside', 'letter', 'modified'])(
    'ignores %s keyboard input without opening a lifecycle', (kind) => {
      const { result, recordUserInput, observeUserInputEnd } = mount()
      const el = scrollerElement().el
      result.current.setScrollContainerRef(el)
      const target = (kind === 'outside' ? document.body : el).appendChild(document.createElement(['input', 'textarea', 'select', 'button'].includes(kind) ? kind : 'span'))
      if (kind === 'editable') target.setAttribute('contenteditable', 'true')
      if (kind === 'cancelled') el.addEventListener('keydown', event => event.preventDefault())
      const key = kind === 'letter' ? 'a' : kind === 'button' ? ' ' : kind === 'cancelled' ? 'PageDown' : 'PageUp'
      const event = new KeyboardEvent('keydown', { key, ctrlKey: kind === 'modified', bubbles: true, cancelable: true })
      if (kind === 'pre-cancelled') event.preventDefault()
      target.dispatchEvent(event)
      window.dispatchEvent(new KeyboardEvent('keyup', { key }))
      window.dispatchEvent(new Event('blur'))
      expect(recordUserInput).not.toHaveBeenCalled()
      expect(observeUserInputEnd).not.toHaveBeenCalled()
      result.current.detachUserInputListeners()
    },
  )

  it('ends abandoned input once on blur and removes its listener on detach', () => {
    const { result, observeUserInputEnd } = mount()
    const el = scrollerElement().el
    result.current.setScrollContainerRef(el)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    el.dispatchEvent(new TouchEvent('touchstart'))
    window.dispatchEvent(new Event('blur'))
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'PageDown' }))
    window.dispatchEvent(new TouchEvent('touchend'))
    flushFrames()
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    result.current.resetPendingInput()
    window.dispatchEvent(new Event('blur'))
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    result.current.detachUserInputListeners()
    window.dispatchEvent(new Event('blur'))
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
  })

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
    const { result, recordUserInput, observeUserInput, observeUserInputEnd } = mount()
    const first = scrollerElement().el
    result.current.setScrollContainerRef(first)
    first.dispatchEvent(new Event('wheel'))
    expect(recordUserInput).toHaveBeenCalledTimes(1)
    expect(observeUserInput).toHaveBeenCalledTimes(1)
    flushFrames()
    expect(observeUserInputEnd).toHaveBeenCalledTimes(1)

    const second = scrollerElement().el
    result.current.setScrollContainerRef(second)
    // The old node must be silent, or a detached scroller keeps opening the persistence gate.
    first.dispatchEvent(new Event('wheel'))
    expect(recordUserInput).toHaveBeenCalledTimes(1)
    second.dispatchEvent(new TouchEvent('touchstart'))
    window.dispatchEvent(new TouchEvent('touchend'))
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(recordUserInput).toHaveBeenCalledTimes(3)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }))
    expect(observeUserInputEnd).toHaveBeenCalledTimes(3)
    second.dispatchEvent(new Event('wheel'))
    expect(recordUserInput).toHaveBeenCalledTimes(4)

    result.current.detachUserInputListeners()
    second.dispatchEvent(new Event('wheel'))
    window.dispatchEvent(new Event('pointerup'))
    window.dispatchEvent(new TouchEvent('touchend'))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }))
    flushFrames()
    expect(recordUserInput).toHaveBeenCalledTimes(4)
    expect(observeUserInputEnd).toHaveBeenCalledTimes(3)
  })

  it.each(['touch', 'scrollbar'] as const)('observes only moving %s input and releases its coordinate tracking', (kind) => {
    const { result, observeUserInput } = mount()
    const scroller = scrollerElement().el
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
    Object.defineProperty(scroller, 'clientWidth', { value: 794 })
    result.current.setScrollContainerRef(scroller)
    const touch = (clientY: number, identifier = 1) => ({ identifier, clientY }) as Touch
    const move = (clientY: number, id = 1) => {
      if (kind === 'touch') scroller.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(clientY, id)] }))
      else window.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, clientY }))
    }
    const start = () => {
      if (kind === 'touch') scroller.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(300)] }))
      else scroller.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 795, clientY: 300 }))
    }
    move(320)
    expect(observeUserInput).not.toHaveBeenCalled()
    start()
    observeUserInput.mockClear()
    move(300)
    move(320, 2)
    expect(observeUserInput).not.toHaveBeenCalled()
    move(320)
    expect(observeUserInput).toHaveBeenLastCalledWith('room-a', expect.objectContaining({
      deltaY: kind === 'touch' ? -20 : 20,
      source: 'gesture',
    }))
    window.dispatchEvent(kind === 'touch' ? new TouchEvent('touchend') : new PointerEvent('pointerup', { pointerId: 1 }))
    observeUserInput.mockClear()
    move(340)
    expect(observeUserInput).not.toHaveBeenCalled()
    start()
    result.current.resetPendingInput()
    observeUserInput.mockClear()
    move(360)
    expect(observeUserInput).not.toHaveBeenCalled()
    start()
    result.current.detachUserInputListeners()
    observeUserInput.mockClear()
    move(380)
    expect(observeUserInput).not.toHaveBeenCalled()
  })

  it('keeps touch ownership through native pointer cancellation and unrelated key release', () => {
    const { result, observeUserInput, observeUserInputEnd } = mount()
    const scroller = scrollerElement().el
    result.current.setScrollContainerRef(scroller)
    const touch = (id: number, clientY = 300) => ({ identifier: id, clientY }) as Touch
    scroller.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(1)] }))
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: 1 }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }))
    window.dispatchEvent(new TouchEvent('touchend', { touches: [touch(1)], changedTouches: [touch(2)] }))
    expect(observeUserInputEnd).not.toHaveBeenCalled()
    scroller.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(1, 400)] }))
    expect(observeUserInput).toHaveBeenLastCalledWith('room-a', expect.objectContaining({ deltaY: -100, source: 'gesture' }))
    window.dispatchEvent(new TouchEvent('touchend', { changedTouches: [touch(1, 400)] }))
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
    observeUserInput.mockClear()
    scroller.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(1, 450)] }))
    expect(observeUserInput).not.toHaveBeenCalled()
  })

  it.each(['pointerup', 'pointercancel'] as const)('matches scrollbar %s to its pointer and waits for held keys', (endEvent) => {
    const { result, observeUserInputEnd } = mount()
    const scroller = scrollerElement().el
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
    Object.defineProperty(scroller, 'clientWidth', { value: 794 })
    result.current.setScrollContainerRef(scroller)
    scroller.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button: 0, clientX: 795, clientY: 300 }))
    window.dispatchEvent(new PointerEvent(endEvent, { pointerId: 8 }))
    window.dispatchEvent(new TouchEvent('touchcancel'))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }))
    expect(observeUserInputEnd).not.toHaveBeenCalled()
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }))
    flushFrames()
    window.dispatchEvent(new PointerEvent(endEvent, { pointerId: 7 }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' }))
    expect(observeUserInputEnd).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }))
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
  })

  it('clears pending input on conversation and element replacement', () => {
    const { result, observeUserInputEnd } = mount()
    const first = scrollerElement().el
    result.current.setScrollContainerRef(first)
    first.dispatchEvent(new TouchEvent('touchstart'))
    result.current.resetPendingInput()
    window.dispatchEvent(new TouchEvent('touchend'))
    expect(observeUserInputEnd).not.toHaveBeenCalled()

    first.dispatchEvent(new Event('wheel'))
    result.current.resetPendingInput()
    flushFrames()
    expect(observeUserInputEnd).not.toHaveBeenCalled()

    first.dispatchEvent(new TouchEvent('touchstart'))
    const second = scrollerElement().el
    result.current.setScrollContainerRef(second)
    window.dispatchEvent(new TouchEvent('touchend'))
    expect(observeUserInputEnd).not.toHaveBeenCalled()
    second.dispatchEvent(new TouchEvent('touchstart'))
    window.dispatchEvent(new TouchEvent('touchend'))
    expect(observeUserInputEnd).toHaveBeenCalledOnce()
  })

  it.each(['left', 'right'])('accepts only the %s scrollbar gutter as pointer takeover', (side) => {
    const { result, recordUserInput } = mount()
    const makeScroller = () => {
      const element = scrollerElement().el
      element.style.border = '2px solid black'
      element.getBoundingClientRect = () => new DOMRect(100, 50, 804, 604)
      Object.defineProperties(element, {
        clientWidth: { get: () => 794 },
        clientLeft: { get: () => side === 'left' ? 8 : 2 },
        clientTop: { get: () => 2 },
      })
      document.body.append(element)
      return element
    }
    const press = { button: 0, clientX: side === 'left' ? 105 : 899, clientY: 100 }
    const first = makeScroller()
    const message = document.createElement('div')
    first.append(message)
    result.current.setScrollContainerRef(first)
    message.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    first.dispatchEvent(new PointerEvent('pointerdown', { ...press, button: 2 }))
    first.dispatchEvent(new PointerEvent('pointerdown', { ...press, clientX: 120 }))
    first.dispatchEvent(new PointerEvent('pointerdown', { ...press, clientX: 903 }))
    first.dispatchEvent(new PointerEvent('pointerdown', { ...press, clientX: 101 }))
    first.dispatchEvent(new PointerEvent('pointerdown', { ...press, clientY: 51 }))
    expect(recordUserInput).not.toHaveBeenCalled()
    first.dispatchEvent(new PointerEvent('pointerdown', press))
    expect(recordUserInput).toHaveBeenCalledOnce()

    const second = makeScroller()
    result.current.setScrollContainerRef(second)
    first.dispatchEvent(new PointerEvent('pointerdown', press))
    expect(recordUserInput).toHaveBeenCalledOnce()
    second.dispatchEvent(new PointerEvent('pointerdown', press))
    expect(recordUserInput).toHaveBeenCalledTimes(2)
    result.current.detachUserInputListeners()
    second.dispatchEvent(new PointerEvent('pointerdown', press))
    expect(recordUserInput).toHaveBeenCalledTimes(2)
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
