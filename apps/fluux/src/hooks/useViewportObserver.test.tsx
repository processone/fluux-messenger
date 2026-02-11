import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewportObserver } from './useViewportObserver'

// ---------------------------------------------------------------------------
// Controllable IntersectionObserver mock
// ---------------------------------------------------------------------------

let ioCallback: IntersectionObserverCallback
let ioInstances: MockIntersectionObserver[] = []

class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()

  constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
    ioCallback = callback
    ioInstances.push(this)
  }
}

// ---------------------------------------------------------------------------
// Controllable MutationObserver mock
// ---------------------------------------------------------------------------

let moCallback: MutationCallback
let moInstances: MockMutationObserver[] = []

class MockMutationObserver {
  observe = vi.fn()
  disconnect = vi.fn()

  constructor(callback: MutationCallback) {
    moCallback = callback
    moInstances.push(this)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake IntersectionObserverEntry */
function makeEntry(
  messageId: string,
  isIntersecting: boolean,
  bottom: number,
): IntersectionObserverEntry {
  const target = document.createElement('div')
  target.dataset.messageId = messageId

  return {
    target,
    isIntersecting,
    boundingClientRect: { bottom, top: bottom - 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: bottom - 40, toJSON: () => ({}) },
    intersectionRatio: isIntersecting ? 0.6 : 0,
    intersectionRect: {} as DOMRectReadOnly,
    rootBounds: null,
    time: performance.now(),
  } as IntersectionObserverEntry
}

/** Build a ref object pointing at a container with message children */
function createScrollContainer(messageIds: string[]) {
  const container = document.createElement('div')
  messageIds.forEach((id) => {
    const el = document.createElement('div')
    el.dataset.messageId = id
    container.appendChild(el)
  })
  return { current: container }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ioInstances = []
  moInstances = []
  vi.useFakeTimers()
  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
  globalThis.MutationObserver = MockMutationObserver as unknown as typeof MutationObserver
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useViewportObserver', () => {
  // ========================================================================
  // Basic callback behaviour
  // ========================================================================

  it('reports the bottom-most visible message', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2', 'msg-3'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    // Simulate two messages being visible; msg-2 has a higher bottom value
    act(() => {
      ioCallback(
        [
          makeEntry('msg-1', true, 100),
          makeEntry('msg-2', true, 200),
        ],
        {} as IntersectionObserver,
      )
    })

    expect(onMessageSeen).toHaveBeenCalledWith('msg-2')
  })

  it('does not report non-intersecting entries', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    act(() => {
      ioCallback(
        [makeEntry('msg-1', false, 100)],
        {} as IntersectionObserver,
      )
    })

    expect(onMessageSeen).not.toHaveBeenCalled()
  })

  it('does not fire when the same message is still bottom-most', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(1)

    // Advance past throttle window so a second report could fire
    act(() => { vi.advanceTimersByTime(400) })

    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    // Still 1 — duplicate suppressed by lastReportedRef
    expect(onMessageSeen).toHaveBeenCalledTimes(1)
  })

  // ========================================================================
  // enabled / disabled
  // ========================================================================

  it('does not create observers when disabled', () => {
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen: vi.fn(),
        enabled: false,
      }),
    )

    // No IntersectionObserver instance should have been created by the main effect
    // (the test-setup mock may create one, but our mock tracks only ours)
    expect(ioInstances).toHaveLength(0)
  })

  it('creates observers when enabled becomes true', () => {
    const scrollContainerRef = createScrollContainer(['msg-1'])

    const { rerender } = renderHook(
      ({ enabled }) =>
        useViewportObserver({
          scrollContainerRef,
          conversationId: 'conv-1',
          onMessageSeen: vi.fn(),
          enabled,
        }),
      { initialProps: { enabled: false } },
    )

    expect(ioInstances).toHaveLength(0)

    rerender({ enabled: true })

    expect(ioInstances).toHaveLength(1)
  })

  // ========================================================================
  // Null scroll container
  // ========================================================================

  it('does nothing when scrollContainerRef is null', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = { current: null }

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef: scrollContainerRef as React.RefObject<HTMLDivElement | null>,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    expect(ioInstances).toHaveLength(0)
    expect(onMessageSeen).not.toHaveBeenCalled()
  })

  // ========================================================================
  // No callback provided
  // ========================================================================

  it('does nothing when onMessageSeen is undefined', () => {
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen: undefined,
        enabled: true,
      }),
    )

    expect(ioInstances).toHaveLength(0)
  })

  // ========================================================================
  // Throttling
  // ========================================================================

  it('throttles rapid message-seen reports', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2', 'msg-3'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    // First report — immediate
    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(1)
    expect(onMessageSeen).toHaveBeenLastCalledWith('msg-1')

    // Second report comes quickly — should be throttled
    act(() => {
      vi.advanceTimersByTime(50) // only 50ms later
      ioCallback([makeEntry('msg-2', true, 200)], {} as IntersectionObserver)
    })
    // Still only 1 call — msg-2 is pending
    expect(onMessageSeen).toHaveBeenCalledTimes(1)

    // Third report comes while still throttled — replaces pending
    act(() => {
      vi.advanceTimersByTime(50) // 100ms total
      ioCallback([makeEntry('msg-3', true, 300)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(1)

    // Throttle window expires — only msg-3 (latest pending) should fire
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(2)
    expect(onMessageSeen).toHaveBeenLastCalledWith('msg-3')
  })

  it('fires immediately after throttle window passes', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    // First report
    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(1)

    // Wait for full throttle window
    act(() => { vi.advanceTimersByTime(300) })

    // Next report should fire immediately
    act(() => {
      ioCallback([makeEntry('msg-2', true, 200)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(2)
    expect(onMessageSeen).toHaveBeenLastCalledWith('msg-2')
  })

  // ========================================================================
  // Conversation switch resets state
  // ========================================================================

  it('resets tracking state on conversation switch', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1'])

    const { rerender } = renderHook(
      ({ conversationId }) =>
        useViewportObserver({
          scrollContainerRef,
          conversationId,
          onMessageSeen,
          enabled: true,
        }),
      { initialProps: { conversationId: 'conv-1' } },
    )

    // Report msg-1 in conv-1
    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(1)

    // Switch conversation
    rerender({ conversationId: 'conv-2' })

    // Same message id in new conversation — should fire again (state was reset)
    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(2)
  })

  it('cancels pending throttled report on conversation switch', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2'])

    const { rerender } = renderHook(
      ({ conversationId }) =>
        useViewportObserver({
          scrollContainerRef,
          conversationId,
          onMessageSeen,
          enabled: true,
        }),
      { initialProps: { conversationId: 'conv-1' } },
    )

    // First report — immediate
    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    expect(onMessageSeen).toHaveBeenCalledTimes(1)

    // Quickly queue a throttled report
    act(() => {
      vi.advanceTimersByTime(50)
      ioCallback([makeEntry('msg-2', true, 200)], {} as IntersectionObserver)
    })

    // Switch conversation before throttle fires
    rerender({ conversationId: 'conv-2' })

    // Advance past throttle — the old pending should NOT fire
    act(() => { vi.advanceTimersByTime(400) })

    // Only the initial immediate call should have fired
    expect(onMessageSeen).toHaveBeenCalledTimes(1)
  })

  // ========================================================================
  // Cleanup on unmount
  // ========================================================================

  it('disconnects observers on unmount', () => {
    const scrollContainerRef = createScrollContainer(['msg-1'])

    const { unmount } = renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen: vi.fn(),
        enabled: true,
      }),
    )

    const io = ioInstances[0]
    const mo = moInstances[0]

    unmount()

    expect(io.disconnect).toHaveBeenCalled()
    expect(mo.disconnect).toHaveBeenCalled()
  })

  it('clears throttle timer on unmount', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2'])

    const { unmount } = renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    // Fire an immediate report, then queue a throttled one
    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })
    act(() => {
      vi.advanceTimersByTime(50)
      ioCallback([makeEntry('msg-2', true, 200)], {} as IntersectionObserver)
    })

    unmount()

    // Advance time — throttled callback should not fire after unmount
    act(() => { vi.advanceTimersByTime(400) })

    expect(onMessageSeen).toHaveBeenCalledTimes(1) // only the first immediate one
  })

  // ========================================================================
  // Observing elements
  // ========================================================================

  it('observes all existing message elements in the container', () => {
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2', 'msg-3'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen: vi.fn(),
        enabled: true,
      }),
    )

    const io = ioInstances[0]
    expect(io.observe).toHaveBeenCalledTimes(3)
  })

  // ========================================================================
  // MutationObserver — new messages added
  // ========================================================================

  it('observes newly added message elements via MutationObserver', () => {
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen: vi.fn(),
        enabled: true,
      }),
    )

    const io = ioInstances[0]
    // Initially observed 1 element
    expect(io.observe).toHaveBeenCalledTimes(1)

    // Simulate MutationObserver detecting a new message element
    const newEl = document.createElement('div')
    newEl.dataset.messageId = 'msg-2'

    act(() => {
      moCallback(
        [{ addedNodes: [newEl], removedNodes: [], type: 'childList' } as unknown as MutationRecord],
        {} as MutationObserver,
      )
    })

    // The new element should have been observed
    expect(io.observe).toHaveBeenCalledTimes(2)
  })

  it('observes nested message elements added via MutationObserver', () => {
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen: vi.fn(),
        enabled: true,
      }),
    )

    const io = ioInstances[0]
    expect(io.observe).toHaveBeenCalledTimes(1)

    // Add a wrapper div that contains a message element as child
    const wrapper = document.createElement('div')
    const nested = document.createElement('div')
    nested.dataset.messageId = 'msg-2'
    wrapper.appendChild(nested)

    act(() => {
      moCallback(
        [{ addedNodes: [wrapper], removedNodes: [], type: 'childList' } as unknown as MutationRecord],
        {} as MutationObserver,
      )
    })

    expect(io.observe).toHaveBeenCalledTimes(2)
  })

  it('ignores non-element added nodes', () => {
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen: vi.fn(),
        enabled: true,
      }),
    )

    const io = ioInstances[0]
    const initialCalls = io.observe.mock.calls.length

    // Add a text node (not an HTMLElement)
    const textNode = document.createTextNode('hello')

    act(() => {
      moCallback(
        [{ addedNodes: [textNode], removedNodes: [], type: 'childList' } as unknown as MutationRecord],
        {} as MutationObserver,
      )
    })

    expect(io.observe).toHaveBeenCalledTimes(initialCalls)
  })

  // ========================================================================
  // Visible entries tracking (leave/enter cycles)
  // ========================================================================

  it('tracks visible entries across multiple IO callbacks', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2', 'msg-3'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    // msg-1 and msg-2 become visible
    act(() => {
      ioCallback(
        [makeEntry('msg-1', true, 100), makeEntry('msg-2', true, 200)],
        {} as IntersectionObserver,
      )
    })
    expect(onMessageSeen).toHaveBeenLastCalledWith('msg-2')

    // Wait for throttle
    act(() => { vi.advanceTimersByTime(300) })

    // msg-2 leaves viewport, msg-3 enters — bottom-most should now be msg-3
    act(() => {
      ioCallback(
        [makeEntry('msg-2', false, 200), makeEntry('msg-3', true, 300)],
        {} as IntersectionObserver,
      )
    })
    expect(onMessageSeen).toHaveBeenLastCalledWith('msg-3')
  })

  it('reports msg-1 when msg-2 leaves and msg-1 is still visible', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1', 'msg-2'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    // Use the actual DOM elements so the visibleEntries map key matches
    const el1 = scrollContainerRef.current.querySelector('[data-message-id="msg-1"]')!
    const el2 = scrollContainerRef.current.querySelector('[data-message-id="msg-2"]')!

    const makeEntryWithTarget = (target: Element, isIntersecting: boolean, bottom: number) => ({
      target,
      isIntersecting,
      boundingClientRect: { bottom } as DOMRectReadOnly,
      intersectionRatio: isIntersecting ? 0.6 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: null,
      time: performance.now(),
    }) as IntersectionObserverEntry

    // Both visible — msg-2 is bottom-most
    act(() => {
      ioCallback(
        [makeEntryWithTarget(el1, true, 100), makeEntryWithTarget(el2, true, 200)],
        {} as IntersectionObserver,
      )
    })
    expect(onMessageSeen).toHaveBeenLastCalledWith('msg-2')

    act(() => { vi.advanceTimersByTime(300) })

    // msg-2 leaves viewport — msg-1 is now the only visible and bottom-most
    act(() => {
      ioCallback(
        [makeEntryWithTarget(el2, false, 200)],
        {} as IntersectionObserver,
      )
    })
    expect(onMessageSeen).toHaveBeenLastCalledWith('msg-1')
  })

  // ========================================================================
  // Entries without data-message-id
  // ========================================================================

  it('ignores entries without data-message-id attribute', () => {
    const onMessageSeen = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1'])

    renderHook(() =>
      useViewportObserver({
        scrollContainerRef,
        conversationId: 'conv-1',
        onMessageSeen,
        enabled: true,
      }),
    )

    // Entry with no data-message-id
    const target = document.createElement('div') // no dataset.messageId
    const entry: IntersectionObserverEntry = {
      target,
      isIntersecting: true,
      boundingClientRect: { bottom: 500 } as DOMRectReadOnly,
      intersectionRatio: 0.6,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: null,
      time: performance.now(),
    } as IntersectionObserverEntry

    act(() => {
      ioCallback([entry], {} as IntersectionObserver)
    })

    expect(onMessageSeen).not.toHaveBeenCalled()
  })

  // ========================================================================
  // Callback ref stability
  // ========================================================================

  it('uses latest onMessageSeen callback without re-creating observer', () => {
    const onMessageSeen1 = vi.fn()
    const onMessageSeen2 = vi.fn()
    const scrollContainerRef = createScrollContainer(['msg-1'])

    const { rerender } = renderHook(
      ({ onMessageSeen }) =>
        useViewportObserver({
          scrollContainerRef,
          conversationId: 'conv-1',
          onMessageSeen,
          enabled: true,
        }),
      { initialProps: { onMessageSeen: onMessageSeen1 } },
    )

    const ioCount = ioInstances.length

    // Update the callback
    rerender({ onMessageSeen: onMessageSeen2 })

    // No new observer should have been created (callback is via ref)
    expect(ioInstances).toHaveLength(ioCount)

    // The new callback should be used
    act(() => {
      ioCallback([makeEntry('msg-1', true, 100)], {} as IntersectionObserver)
    })

    expect(onMessageSeen1).not.toHaveBeenCalled()
    expect(onMessageSeen2).toHaveBeenCalledWith('msg-1')
  })
})
