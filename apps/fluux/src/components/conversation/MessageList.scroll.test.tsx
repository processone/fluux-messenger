/**
 * @vitest-environment jsdom
 *
 * Tests for MessageList auto-scroll behavior.
 * These tests verify that the scroll position is maintained correctly when:
 * - Typing indicator appears/disappears
 * - Reactions are added to the last message
 * - Container height changes (e.g., composer resize)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Asserts the non-virtualized scroll machinery (offsetTop/scrollHeight reads on the
// fully-mounted DOM — still shipping until the old path is removed). Force the flag OFF;
// virtualized scroll is verified via the scroll-hook unit tests + the real-engine pass.
vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))
import { render, screen, act } from '@testing-library/react'
import { MessageList } from './MessageList'
import type { BaseMessage } from '@fluux/sdk'

// Mock useTranslation with full i18n object
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'en',
    },
  }),
}))

// Mock hooks used by MessageList
vi.mock('@/hooks', () => ({
  useMessageCopyFormatter: vi.fn(),
  useMessageRangeSelection: vi.fn(() => ({
    copySelectedIds: new Set<string>(),
    selectionCount: 0,
    isSelecting: false,
    selectAll: vi.fn(),
    extendTo: vi.fn(),
    clearSelection: vi.fn(),
    copySelected: vi.fn(),
  })),
}))

// Import scrollStateManager to reset between tests
import { scrollStateManager } from '@/utils/scrollStateManager'

// Helper to create test messages
function createTestMessages(count: number, withReactions = false): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    from: 'user@example.com',
    body: `Message ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i),
    isOutgoing: i % 2 === 0,
    type: 'chat' as const,
    reactions: withReactions && i === count - 1 ? { '👍': ['other@example.com'] } : undefined,
  }))
}

// Mock ResizeObserver
class MockResizeObserver {
  callback: ResizeObserverCallback
  static instances: MockResizeObserver[] = []
  // Total constructions (never decremented) — `instances` only tracks live
  // observers, so it cannot detect a disconnect+recreate churn cycle.
  static constructed = 0

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
    MockResizeObserver.constructed++
  }

  targets: Element[] = []

  observe(target: Element) {
    this.targets.push(target)
  }

  // Find the live observer watching a given element. The scroll container is
  // watched by TWO observers: MessageWidthProvider's width observer (created
  // first, as a child effect) and useMessageListScroll's scroll-correction
  // observer (created last, in the parent effect). These tests target the
  // correction observer, so return the LAST match. (The content observer watches
  // the inner wrapper, not the container, so it never matches here.)
  static observing(target: Element | null): MockResizeObserver | undefined {
    if (!target) return undefined
    return [...MockResizeObserver.instances].reverse().find((inst) => inst.targets.includes(target))
  }
  unobserve() {}
  disconnect() {
    const index = MockResizeObserver.instances.indexOf(this)
    if (index > -1) MockResizeObserver.instances.splice(index, 1)
  }

  // Helper to trigger resize. Width is optional so existing height-only callers
  // are unaffected (contentRect.width stays undefined → the width branch is inert).
  triggerResize(height: number, width?: number) {
    this.callback(
      [{ contentRect: { height, width } } as ResizeObserverEntry],
      this
    )
  }
}

describe('MessageList scroll behavior', () => {
  let scrollContainer: HTMLDivElement
  let originalRAF: typeof requestAnimationFrame

  beforeEach(() => {
    vi.clearAllMocks()
    MockResizeObserver.instances = []
    MockResizeObserver.constructed = 0

    // Reset scrollStateManager to prevent state leakage between tests
    scrollStateManager.reset()

    // Mock ResizeObserver
    vi.stubGlobal('ResizeObserver', MockResizeObserver)

    // Mock requestAnimationFrame to execute immediately
    originalRAF = window.requestAnimationFrame
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }

    // Create a mock scroll container with scrollable properties
    scrollContainer = document.createElement('div')
    Object.defineProperties(scrollContainer, {
      scrollHeight: { value: 1000, writable: true, configurable: true },
      clientHeight: { value: 500, writable: true, configurable: true },
      scrollTop: { value: 500, writable: true, configurable: true },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.requestAnimationFrame = originalRAF
  })

  describe('typing indicator scroll', () => {
    // The typing indicator floats OVER the list (it is not part of the scroll content); toggling it
    // never changes scroll height on its own. But the footer reserves extra bottom padding to clear
    // the pill while it's shown, and that DOES grow the scroll content — so while genuinely sticked
    // to the bottom, reassertBottom re-pins to reveal the new clearance (same shared helper new
    // messages use — a one-shot smooth nudge lands short because a virtualized footer needs a
    // remeasure pass first). A reader scrolled up must never be yanked back (issue #918).
    it('re-pins to the bottom when typing starts while sticked', () => {
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          typingUsers={[]}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // Get the scroll container and spy on scrollTop setter
      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 0
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Simulate being at bottom (scrollTop = scrollHeight - clientHeight = 500)
        scrollTopValue = 500
        scrollSpy.mockClear()

        // Re-render with typing users
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            typingUsers={['other@example.com']}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Sticked to the bottom → the grown footer clearance is revealed by a re-pin to bottom.
        expect(scrollSpy).toHaveBeenCalledWith(1000)
      }
    })

    it('should NOT scroll when typing indicator appears and user is scrolled up', () => {
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          typingUsers={[]}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // Get the scroll container
      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 0
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Simulate user has scrolled up (distance from bottom > 50)
        scrollTopValue = 200

        // Trigger a scroll event to update isAtBottomRef
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        scrollSpy.mockClear()

        // Re-render with typing users
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            typingUsers={['other@example.com']}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Should NOT have scrolled
        expect(scrollSpy).not.toHaveBeenCalled()
      }
    })
  })

  describe('reactions scroll', () => {
    // A reaction grows the last message's row. While the reader is sticked to the bottom we keep it
    // visible with a GENTLE single smooth nudge (not the heavy multi-frame pin loop, and not the old
    // hard yank). It is gated on LIVE geometry, so a reader scrolled up into history is never nudged.
    const reactOnLast = (msgs: ReturnType<typeof createTestMessages>) => {
      const copy = [...msgs]
      copy[copy.length - 1] = { ...copy[copy.length - 1], reactions: { '👍': ['someone@example.com'] } }
      return copy
    }
    const instrument = (container: HTMLDivElement, scrollTop: number) => {
      Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
      Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
      Object.defineProperty(container, 'scrollTop', { value: scrollTop, writable: true, configurable: true })
      const scrollToSpy = vi.fn()
      container.scrollTo = scrollToSpy
      return scrollToSpy
    }

    it('gently nudges the bottom (smooth) when the last message gets a reaction while sticked', () => {
      const messages = createTestMessages(5)
      const { rerender } = render(
        <MessageList messages={messages} conversationId="conv-1" clearFirstNewMessageId={vi.fn()} renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>} />
      )
      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      // scrollTop 500 → distFromBottom 0 (< AT_BOTTOM_THRESHOLD): the reader is sticked to the bottom.
      const scrollToSpy = instrument(container, 500)

      rerender(
        <MessageList messages={reactOnLast(messages)} conversationId="conv-1" clearFirstNewMessageId={vi.fn()} renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>} />
      )

      expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 1000, behavior: 'smooth' }))
    })

    it('does NOT nudge when a reaction arrives while the reader is scrolled up', () => {
      const messages = createTestMessages(5)
      const { rerender } = render(
        <MessageList messages={messages} conversationId="conv-1" clearFirstNewMessageId={vi.fn()} renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>} />
      )
      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      // scrollTop 200 → distFromBottom 300 (>= AT_BOTTOM_THRESHOLD 150): scrolled up into history.
      const scrollToSpy = instrument(container, 200)

      rerender(
        <MessageList messages={reactOnLast(messages)} conversationId="conv-1" clearFirstNewMessageId={vi.fn()} renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>} />
      )

      expect(scrollToSpy).not.toHaveBeenCalled()
    })
  })

  describe('container resize scroll', () => {
    it('defers the scroll correction to rAF instead of writing scrollTop inside the ResizeObserver callback', () => {
      // Regression guard: writing scrollTop synchronously inside a ResizeObserver
      // callback is the literal trigger for WebKitGTK's "ResizeObserver loop
      // completed with undelivered notifications". The correction must be
      // coalesced into a requestAnimationFrame so it runs OUTSIDE the observer's
      // delivery cycle (parity with the content observer hardened in #439).
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      // Queue rAF callbacks rather than running them immediately, so we can
      // observe whether the scroll write happens synchronously or is deferred.
      const rafQueue: FrameRequestCallback[] = []
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafQueue.push(cb)
        return rafQueue.length
      }
      const flushRaf = () => act(() => { rafQueue.splice(0).forEach((cb) => cb(0)) })

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      expect(container).toBeTruthy()

      let scrollTopValue = 500 // at bottom (scrollHeight 1000 - clientHeight 500)
      Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
      Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
      Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTopValue,
        set: (v) => { scrollTopValue = v; scrollSpy(v) },
        configurable: true,
      })

      // Drain any rAF scheduled during mount, then establish the baseline height.
      // Select the container observer by its observed target — the content
      // observer (created on the same commit since #508) also exists, so
      // instances[0] is no longer reliably the container one.
      flushRaf()
      const observer = MockResizeObserver.observing(container)!
      expect(observer).toBeTruthy()
      act(() => { observer.triggerResize(500) })
      flushRaf()
      scrollSpy.mockClear()

      // Container shrinks while at bottom: the correction must NOT be applied
      // synchronously inside the observer callback...
      act(() => { observer.triggerResize(400) })
      expect(scrollSpy).not.toHaveBeenCalled()

      // ...only after the rAF flushes.
      flushRaf()
      expect(scrollSpy).toHaveBeenCalledWith(1000)
    })

    it('should scroll to bottom when container height decreases and user is at bottom', async () => {
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // Get the scroll container
      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 500
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // First trigger an initial resize to establish baseline height
        const observer = MockResizeObserver.observing(container)
        if (observer) {
          act(() => {
            observer.triggerResize(500) // Establish baseline
          })
        }

        scrollSpy.mockClear()

        // Trigger resize (simulating composer getting taller)
        if (observer) {
          act(() => {
            observer.triggerResize(400) // Height decreased from 500 to 400
          })
        }

        // Should have scrolled to bottom
        expect(scrollSpy).toHaveBeenCalledWith(1000)
      }
    })

    it('should NOT scroll when container resizes but user is scrolled up', async () => {
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // Get the scroll container
      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 200 // User scrolled up
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Trigger scroll event to update isAtBottomRef
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // First trigger an initial resize to establish baseline height
        const observer = MockResizeObserver.observing(container)
        if (observer) {
          act(() => {
            observer.triggerResize(500) // Establish baseline
          })
        }

        scrollSpy.mockClear()

        // Trigger resize
        if (observer) {
          act(() => {
            observer.triggerResize(400)
          })
        }

        // Should NOT have scrolled
        expect(scrollSpy).not.toHaveBeenCalled()
      }
    })

    it('should scroll to bottom when only the WIDTH changes (occupant sidebar toggle) and user is at bottom', () => {
      // Toggling the occupant sidebar at lg+ narrows the message column (width change,
      // same height) which re-wraps text and grows content height, but fires no window
      // 'resize' event — so only the container observer can re-pin. Regression guard for
      // the list drifting off the bottom on sidebar expand.
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 500 // at bottom
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        const observer = MockResizeObserver.observing(container)
        if (observer) {
          act(() => { observer.triggerResize(500, 800) }) // baseline: width 800, height 500
        }

        scrollSpy.mockClear()

        // Width shrinks (sidebar appears) but height is unchanged.
        if (observer) {
          act(() => { observer.triggerResize(500, 600) })
        }

        expect(scrollSpy).toHaveBeenCalledWith(1000)
      }
    })

    it('should NOT scroll on a WIDTH change when the user is scrolled up', () => {
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 200 // scrolled up
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        act(() => { container.dispatchEvent(new Event('scroll')) })

        const observer = MockResizeObserver.observing(container)
        if (observer) {
          act(() => { observer.triggerResize(500, 800) }) // baseline
        }

        scrollSpy.mockClear()

        if (observer) {
          act(() => { observer.triggerResize(500, 600) }) // width change while scrolled up
        }

        expect(scrollSpy).not.toHaveBeenCalled()
      }
    })

    it('should adjust scroll position when typing long lines expands composer (multiple resize events)', async () => {
      // This test simulates typing long text that causes the composer to grow in steps
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 500 // At bottom (scrollHeight 1000 - clientHeight 500)
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        const observer = MockResizeObserver.observing(container)
        if (observer) {
          // First establish baseline height
          act(() => {
            observer.triggerResize(500)
          })
        }

        scrollSpy.mockClear()

        if (observer) {
          // First line wrap: container shrinks by 24px (one line of text)
          act(() => {
            observer.triggerResize(476)
          })
          expect(scrollSpy).toHaveBeenCalledWith(1000)

          scrollSpy.mockClear()

          // Second line wrap: container shrinks by another 24px
          act(() => {
            observer.triggerResize(452)
          })
          expect(scrollSpy).toHaveBeenCalledWith(1000)

          scrollSpy.mockClear()

          // Third line wrap: container shrinks by another 24px
          act(() => {
            observer.triggerResize(428)
          })
          expect(scrollSpy).toHaveBeenCalledWith(1000)
        }
      }
    })

    it('should handle rapid composer resizing without losing scroll position', async () => {
      // Simulates fast typing that causes multiple rapid resize events
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 500
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        scrollSpy.mockClear()

        const observer = MockResizeObserver.observing(container)
        if (observer) {
          // Rapid resize events (composer expanding as user types)
          act(() => {
            observer.triggerResize(490)
            observer.triggerResize(480)
            observer.triggerResize(470)
            observer.triggerResize(460)
          })

          // Should have scrolled to bottom after each resize
          expect(scrollSpy).toHaveBeenCalled()
          // The last call should be scrolling to bottom
          expect(scrollSpy).toHaveBeenLastCalledWith(1000)
        }
      }
    })
  })

  describe('viewport resize (keyboard deploy)', () => {
    // The on-screen keyboard shrinks the SCROLLER viewport without changing content
    // height, so the content ResizeObserver never fires. A window/visualViewport
    // resize listener must re-pin to the bottom when the user was following along —
    // otherwise the latest message slides behind the keyboard/composer.
    function mountAtBottom(scrollSpy: ReturnType<typeof vi.fn<(v: number) => void>>) {
      const messages = createTestMessages(5)
      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )
      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      let scrollTopValue = 500 // at bottom: scrollHeight 1000 - clientHeight 500
      Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
      Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
      Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTopValue,
        set: (v) => { scrollTopValue = v; scrollSpy(v) },
        configurable: true,
      })
      return { container, setScrollTop: (v: number) => { scrollTopValue = v } }
    }

    it('re-pins to the bottom on window resize when the user is at the bottom', () => {
      const scrollSpy = vi.fn()
      const { container } = mountAtBottom(scrollSpy)

      // Confirm at-bottom state from a scroll event
      act(() => { container.dispatchEvent(new Event('scroll')) })
      scrollSpy.mockClear()

      // Keyboard deploys: viewport shrinks -> window resize fires
      act(() => { window.dispatchEvent(new Event('resize')) })

      expect(scrollSpy).toHaveBeenCalledWith(1000)
    })

    it('re-pins to the bottom on visualViewport resize when the user is at the bottom', () => {
      const realVV = window.visualViewport
      const listeners = new Set<EventListener>()
      const fakeVV = {
        addEventListener: (_t: string, cb: EventListener) => listeners.add(cb),
        removeEventListener: (_t: string, cb: EventListener) => listeners.delete(cb),
      }
      Object.defineProperty(window, 'visualViewport', { value: fakeVV, configurable: true })
      try {
        const scrollSpy = vi.fn()
        const { container } = mountAtBottom(scrollSpy)
        act(() => { container.dispatchEvent(new Event('scroll')) })
        scrollSpy.mockClear()

        act(() => { listeners.forEach((cb) => cb(new Event('resize'))) })

        expect(scrollSpy).toHaveBeenCalledWith(1000)
      } finally {
        Object.defineProperty(window, 'visualViewport', { value: realVV, configurable: true })
      }
    })

    it('does NOT re-pin on window resize when the user has scrolled up', () => {
      const scrollSpy = vi.fn()
      const { container, setScrollTop } = mountAtBottom(scrollSpy)

      // User scrolled up (distance from bottom > threshold)
      setScrollTop(200)
      act(() => { container.dispatchEvent(new Event('scroll')) })
      scrollSpy.mockClear()

      act(() => { window.dispatchEvent(new Event('resize')) })

      expect(scrollSpy).not.toHaveBeenCalled()
    })
  })

  describe('scroll-to-top lazy loading', () => {
    it('should call onScrollToTop when scrolling up while at top (wheel event)', () => {
      const messages = createTestMessages(10)
      const onScrollToTop = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        // Set up scrollable dimensions
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })

        // Set scrollTop to 0 (at very top)
        Object.defineProperty(container, 'scrollTop', {
          get: () => 0,
          configurable: true,
        })

        // Scroll up (negative deltaY) while at top triggers load
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))

        expect(onScrollToTop).toHaveBeenCalledTimes(1)
      }
    })

    it('does NOT auto-load older on a passive scroll to the top until the user has scrolled away from it', () => {
      // On a fresh entry the list briefly renders at scrollTop=0 before the auto-scroll-to-bottom
      // settles. A passive 'scroll' event at that transient top must NOT trigger load-older — doing
      // so prepends a batch and clears isAtBottom, breaking bottom-stick for the next message. Only
      // once the user has genuinely scrolled away from the top (and returned) does it auto-load.
      const messages = createTestMessages(10)
      const onScrollToTop = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        let top = 0
        Object.defineProperty(container, 'scrollTop', { get: () => top, configurable: true })

        // Fresh-entry transient top — a passive scroll must be ignored.
        container.dispatchEvent(new Event('scroll', { bubbles: true }))
        expect(onScrollToTop).not.toHaveBeenCalled()

        // User scrolls away from the top, then back to it: now it is a genuine gesture.
        top = 600
        container.dispatchEvent(new Event('scroll', { bubbles: true }))
        top = 0
        container.dispatchEvent(new Event('scroll', { bubbles: true }))
        expect(onScrollToTop).toHaveBeenCalledTimes(1)
      }
    })

    it('should NOT call onScrollToTop when isHistoryComplete is true', () => {
      const messages = createTestMessages(10)
      const onScrollToTop = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          isHistoryComplete={true}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })

        // Set at top
        Object.defineProperty(container, 'scrollTop', {
          get: () => 0,
          configurable: true,
        })

        // Scroll up at top
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))

        // Should NOT call onScrollToTop because history is complete
        expect(onScrollToTop).not.toHaveBeenCalled()
      }
    })

    it('should NOT call onScrollToTop when isLoadingOlder is true', () => {
      const messages = createTestMessages(10)
      const onScrollToTop = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          isLoadingOlder={true}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })

        // Set at top
        Object.defineProperty(container, 'scrollTop', {
          get: () => 0,
          configurable: true,
        })

        // Scroll up at top
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))

        // Should NOT call onScrollToTop because already loading
        expect(onScrollToTop).not.toHaveBeenCalled()
      }
    })

    it('should NOT call onScrollToTop when not at very top (scrollTop > 0)', () => {
      const messages = createTestMessages(10)
      const onScrollToTop = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })

        // Set scrollTop to 10 (not at very top)
        Object.defineProperty(container, 'scrollTop', {
          get: () => 10,
          configurable: true,
        })

        // Scroll up - but not at top so should not trigger
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))

        // Should NOT call because not at scrollTop === 0
        expect(onScrollToTop).not.toHaveBeenCalled()
      }
    })

    it('should show loading indicator when isLoadingOlder is true', () => {
      const messages = createTestMessages(5)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          isLoadingOlder={true}
          onScrollToTop={vi.fn()} // Required for loading indicator to render
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // The Loader2 component should be rendered with animate-spin class inside the button
      const loader = document.querySelector('.animate-spin')
      expect(loader).toBeInTheDocument()
    })

    it('should NOT show loading indicator when isLoadingOlder is false', () => {
      const messages = createTestMessages(5)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          isLoadingOlder={false}
          onScrollToTop={vi.fn()} // Ensure button renders but shows chevron, not spinner
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const loader = document.querySelector('.animate-spin')
      expect(loader).not.toBeInTheDocument()
    })

    it('should adjust scroll position when older messages are prepended', () => {
      const messages = createTestMessages(10)
      const scrollTopSetter = vi.fn()

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          isLoadingOlder={true} // Start loading
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        // Initial state: scrollHeight 1000, scrollTop 20 (near top)
        let currentScrollTop = 20
        let currentScrollHeight = 1000

        Object.defineProperty(container, 'scrollHeight', {
          get: () => currentScrollHeight,
          configurable: true,
        })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => currentScrollTop,
          set: (v) => {
            currentScrollTop = v
            scrollTopSetter(v)
          },
          configurable: true,
        })
        // Mock scrollTo method for smooth scrolling
        container.scrollTo = vi.fn(({ top }) => {
          currentScrollTop = top
          scrollTopSetter(top)
        })

        // Simulate loading complete with new messages prepended
        // New content adds 500px to scrollHeight
        currentScrollHeight = 1500

        rerender(
          <MessageList
            messages={[...createTestMessages(10, false).map((m, i) => ({ ...m, id: `old-${i}` })), ...messages]}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            isLoadingOlder={false} // Loading complete
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Scroll position should be adjusted (scrollTop setter should be called with a value > 0)
        // The exact value depends on timing, but it should be called to preserve position
        expect(scrollTopSetter).toHaveBeenCalled()
        // The new scrollTop should be greater than original (adjusted for prepended content)
        const lastCall = scrollTopSetter.mock.calls[scrollTopSetter.mock.calls.length - 1]
        if (lastCall) {
          expect(lastCall[0]).toBeGreaterThan(20)
        }
      }
    })

    it('should NOT auto-load more when scroll position is preserved (user not at top)', () => {
      const messages = createTestMessages(10)
      const onScrollToTop = vi.fn()

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          isLoadingOlder={true}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let currentScrollTop = 20
        let currentScrollHeight = 1000

        Object.defineProperty(container, 'scrollHeight', {
          get: () => currentScrollHeight,
          configurable: true,
        })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => currentScrollTop,
          set: (v) => { currentScrollTop = v },
          configurable: true,
        })

        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // After loading, scrollHeight increases
        currentScrollHeight = 1500

        act(() => {
          rerender(
            <MessageList
              messages={[...createTestMessages(10, false).map((m, i) => ({ ...m, id: `old-${i}` })), ...messages]}
              conversationId="conv-1"
              clearFirstNewMessageId={vi.fn()}
              onScrollToTop={onScrollToTop}
              isLoadingOlder={false}
              isHistoryComplete={false}
              renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
            />
          )
        })

        // After scroll position preservation, user is no longer at top (scrollTop = 520)
        // So onScrollToTop should NOT be called automatically
        expect(onScrollToTop).not.toHaveBeenCalled()
      }
    })

    it('should only trigger once due to cooldown (prevents rapid retriggering)', () => {
      const messages = createTestMessages(10)
      const onScrollToTop = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })

        // Set at top
        Object.defineProperty(container, 'scrollTop', {
          get: () => 0,
          configurable: true,
        })

        // First wheel up at top - should trigger
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))

        // Multiple wheel events in quick succession - cooldown should prevent multiple triggers
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }))

        // Should only be called once (cooldown prevents rapid retriggering)
        expect(onScrollToTop).toHaveBeenCalledTimes(1)
      }
    })
  })

  describe('scroll position restoration on conversation switch', () => {
    it('should not mark the active conversation as left on same-room message updates', () => {
      const { rerender } = render(
        <MessageList
          messages={createTestMessages(5)}
          conversationId="conv-same-room"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      expect(scrollStateManager.getCurrentConversationId()).toBe('conv-same-room')

      rerender(
        <MessageList
          messages={createTestMessages(6)}
          conversationId="conv-same-room"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      expect(scrollStateManager.getCurrentConversationId()).toBe('conv-same-room')
    })

    it('should use deferred scroll-to-bottom with RAF when switching to new conversation', () => {
      // This test verifies the fix for the bug where messages appeared aligned to top
      // when navigating via notification or Option+U. The issue was that scrollHeight
      // reflected old DOM content when the useLayoutEffect ran.
      //
      // The fix uses requestAnimationFrame to defer scroll until after React renders.
      const messages = createTestMessages(10)
      const scrollSpy = vi.fn()
      let rafCallCount = 0

      // Track RAF calls to verify deferred scrolling is used
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafCallCount++
        cb(0)
        return rafCallCount
      }

      // Render conversation A (not previously visited - will scroll to bottom)
      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-new"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 0
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Reset counters after initial render
        rafCallCount = 0
        scrollSpy.mockClear()

        // Switch to a different, never-visited conversation
        // This simulates the Option+U or notification click scenario
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-another-new"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // RAF should have been called (deferred scroll)
        expect(rafCallCount).toBeGreaterThan(0)

        // Scroll to bottom should have been called multiple times
        // (immediate + deferred via RAF)
        expect(scrollSpy).toHaveBeenCalledWith(1000)
      }
    })

    it('should restore scroll position when returning to a conversation that was scrolled up', () => {
      const messages = createTestMessages(10)
      const scrollSpy = vi.fn()

      // Render first conversation
      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 200 // Scrolled up position
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Trigger scroll event to save the scrolled-up position. A genuine user scroll fires a
        // wheel first — the save gate only persists user-driven positions (see the hook).
        act(() => {
          container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
          container.dispatchEvent(new Event('scroll'))
        })

        // Clear spy for clean assertions
        scrollSpy.mockClear()

        // Switch to a different conversation
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-2"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Switch back to original conversation
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Should restore to the saved position (200), not scroll to bottom (1000)
        const scrollCalls = scrollSpy.mock.calls.flat()
        // The last scroll position set for conv-1 should be the restored position
        expect(scrollCalls).toContain(200)
      }
    })

    it('should NOT be overridden by new message auto-scroll when restoring position (race condition fix)', () => {
      // This tests the fix for the race condition where:
      // 1. User returns to a conversation that was scrolled up
      // 2. enterConversation returns 'restore-position'
      // 3. Before RAF runs, message count changes (e.g., new message arrives)
      // 4. The fix ensures isAtBottomRef is set to false immediately,
      //    preventing the "new message" path from scrolling to bottom

      const messages = createTestMessages(10)
      const scrollSpy = vi.fn()

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 200 // Scrolled up
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Trigger scroll to mark as scrolled up and save position (wheel = genuine user scroll).
        act(() => {
          container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
          container.dispatchEvent(new Event('scroll'))
        })
        scrollSpy.mockClear()

        // Switch away
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-2"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Switch back AND add a new message at the same time (simulating race condition)
        const messagesWithNew = [...messages, {
          id: 'msg-new',
          from: 'other@example.com',
          body: 'New message',
          timestamp: new Date(),
          isOutgoing: false,
          type: 'chat' as const,
        }]

        rerender(
          <MessageList
            messages={messagesWithNew}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // The scroll should restore to 200, not go to bottom (1000)
        // Thanks to the fix: isAtBottomRef.current = false is set immediately
        const scrollCalls = scrollSpy.mock.calls.flat()
        expect(scrollCalls).toContain(200)
        // Should NOT have scrolled to bottom with smooth animation (1000 would indicate the bug)
        // The last call should be the restored position
        const lastCall = scrollCalls[scrollCalls.length - 1]
        expect(lastCall).toBe(200)
      }
    })
  })

  describe('typing indicator rendering', () => {
    it('should render typing indicator when users are typing', () => {
      const messages = createTestMessages(3)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          typingUsers={['alice@example.com']}
          formatTypingUser={(jid) => jid.split('@')[0]}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // The typing indicator should be rendered (t() returns the key)
      expect(screen.getByText('chat.typing.one')).toBeInTheDocument()
    })

    it('should NOT render typing indicator when no users are typing', () => {
      const messages = createTestMessages(3)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          typingUsers={[]}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // No typing indicator text
      expect(screen.queryByText(/typing/i)).not.toBeInTheDocument()
    })
  })

  describe('scroll-to-bottom FAB visibility', () => {
    it('should show FAB when scrolled far from bottom (> 300px)', () => {
      const messages = createTestMessages(20)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        // Set up scroll dimensions: total 2000px, visible 500px
        // At scrollTop=0, distance from bottom = 2000-0-500 = 1500px (> 300)
        let scrollTopValue = 0
        Object.defineProperty(container, 'scrollHeight', { value: 2000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => { scrollTopValue = v },
          configurable: true,
        })

        // Trigger scroll event to update FAB visibility
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // FAB should be visible (tooltip has "Scroll to bottom")
        const fab = document.querySelector('[aria-label]')
        expect(fab).toBeInTheDocument()
      }
    })

    it('should hide FAB when near bottom (< 300px)', () => {
      const messages = createTestMessages(20)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        // Set up scroll dimensions: total 1000px, visible 500px
        // At scrollTop=400, distance from bottom = 1000-400-500 = 100px (< 300)
        let scrollTopValue = 400
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => { scrollTopValue = v },
          configurable: true,
        })

        // Trigger scroll event
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // FAB should NOT be visible - wrapper div should have inert set
        const fabWrapper = document.querySelector('[data-fab="scroll-to-bottom"]')?.closest('div.z-40')
        expect(fabWrapper?.hasAttribute('inert')).toBe(true)
      }
    })

    it('should update FAB visibility when scrolling up from bottom', () => {
      const messages = createTestMessages(20)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 1500 // Start at bottom
        Object.defineProperty(container, 'scrollHeight', { value: 2000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => { scrollTopValue = v },
          configurable: true,
        })
        container.scrollTo = vi.fn() // Mock scrollTo

        // Initially at bottom - FAB should be hidden
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        let fabWrapper = document.querySelector('[data-fab="scroll-to-bottom"]')?.closest('div.z-40')
        expect(fabWrapper?.hasAttribute('inert')).toBe(true)

        // Scroll up far from bottom
        scrollTopValue = 200 // distance from bottom = 2000-200-500 = 1300px

        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // Now FAB should be visible
        fabWrapper = document.querySelector('[data-fab="scroll-to-bottom"]')?.closest('div.z-40')
        expect(fabWrapper?.hasAttribute('inert')).toBe(false)
      }
    })

    it('should update FAB visibility based on scroll position even during prepend', () => {
      // FAB visibility is driven purely by scroll position; isLoadingOlder does not
      // gate it. When the user is scrolled far from the bottom, the FAB is shown
      // regardless of whether an older-messages fetch is in flight.
      const messages = createTestMessages(20)
      const onScrollToTop = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          onScrollToTop={onScrollToTop}
          isLoadingOlder={true}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 100
        Object.defineProperty(container, 'scrollHeight', { value: 2000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => { scrollTopValue = v },
          configurable: true,
        })

        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        const fabWrapper = document.querySelector('[data-fab="scroll-to-bottom"]')?.closest('div.z-40')
        expect(fabWrapper?.hasAttribute('inert')).toBe(false)
      }
    })

    it('should call scrollToBottom when FAB is clicked', () => {
      const messages = createTestMessages(20)
      const scrollToSpy = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 100
        Object.defineProperty(container, 'scrollHeight', { value: 2000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => { scrollTopValue = v },
          configurable: true,
        })
        container.scrollTo = scrollToSpy

        // Trigger scroll to show FAB
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // Find and click FAB
        const fabButton = document.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
        if (fabButton) {
          act(() => {
            fabButton.click()
          })

          // Should have called scrollTo with behavior: smooth
          expect(scrollToSpy).toHaveBeenCalledWith(
            expect.objectContaining({ behavior: 'smooth' })
          )
        }
      }
    })
  })

  describe('conversation switch scroll position saving', () => {
    it('should save final scroll position when switching to different conversation', () => {
      const messages = createTestMessages(10)

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        // Set up scroll position (scrolled up)
        let scrollTopValue = 250
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => { scrollTopValue = v },
          configurable: true,
        })

        // Trigger a scroll event to ensure the hook has the scroll data (wheel = genuine user scroll).
        act(() => {
          container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
          container.dispatchEvent(new Event('scroll'))
        })

        // Switch to different conversation
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-2"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Switch back - should restore to saved position (250)
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // The scroll position should be restored to 250
        expect(scrollTopValue).toBe(250)
      }
    })

    it('should save position from last scroll event (not DOM state at switch time)', () => {
      // The implementation captures scroll position from scroll events,
      // not from reading DOM at switch time. This is more reliable because
      // by the time the React effect runs, the DOM may have already changed.
      const messages = createTestMessages(10)
      const scrollSpy = vi.fn()

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        let scrollTopValue = 100
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Scroll to position 100 - this gets captured (wheel = genuine user scroll).
        act(() => {
          container.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
          container.dispatchEvent(new Event('scroll'))
        })

        // Scroll to position 350 - this ALSO gets captured
        scrollTopValue = 350
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // Switch conversations - uses last captured position (350)
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-2"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        scrollSpy.mockClear()

        // Return to conv-1 - should restore to 350
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        expect(scrollSpy).toHaveBeenCalledWith(350)
      }
    })

    it('should scroll to bottom when returning to conversation that was at bottom', () => {
      const messages = createTestMessages(10)
      const scrollSpy = vi.fn()

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const container = document.querySelector('.overflow-y-auto') as HTMLDivElement
      if (container) {
        // User is at bottom: scrollHeight(1000) - scrollTop(500) - clientHeight(500) = 0
        let scrollTopValue = 500
        Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(container, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Trigger scroll to mark as at bottom
        act(() => {
          container.dispatchEvent(new Event('scroll'))
        })

        // Switch to conv-2
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-2"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        scrollSpy.mockClear()

        // Return to conv-1 - should scroll to bottom (was at bottom when leaving)
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Should scroll to bottom (scrollHeight = 1000)
        expect(scrollSpy).toHaveBeenCalledWith(1000)
      }
    })

    it('should handle multiple conversation switches and restore correct positions', () => {
      // This test validates that scrollStateManager correctly tracks
      // positions for multiple conversations independently

      // First, set up positions in scrollStateManager directly
      // This isolates the test from the complexity of DOM mocking
      scrollStateManager.enterConversation('conv-1', 10)
      scrollStateManager.saveScrollPosition('conv-1', 100, 1000, 500)
      scrollStateManager.leaveConversation('conv-1', 100, 1000, 500)

      scrollStateManager.enterConversation('conv-2', 10)
      scrollStateManager.saveScrollPosition('conv-2', 200, 1000, 500)
      scrollStateManager.leaveConversation('conv-2', 200, 1000, 500)

      scrollStateManager.enterConversation('conv-3', 10)
      scrollStateManager.saveScrollPosition('conv-3', 300, 1000, 500)
      scrollStateManager.leaveConversation('conv-3', 300, 1000, 500)

      // Verify positions are stored correctly
      expect(scrollStateManager.getSavedScrollTop('conv-1')).toBe(100)
      expect(scrollStateManager.getSavedScrollTop('conv-2')).toBe(200)
      expect(scrollStateManager.getSavedScrollTop('conv-3')).toBe(300)

      // Verify entering returns restore-position for each
      expect(scrollStateManager.enterConversation('conv-1', 10)).toBe('restore-position')
      scrollStateManager.clearSavedScrollState('conv-1')
      scrollStateManager.markAsLeft('conv-1')

      expect(scrollStateManager.enterConversation('conv-2', 10)).toBe('restore-position')
      scrollStateManager.clearSavedScrollState('conv-2')
      scrollStateManager.markAsLeft('conv-2')

      expect(scrollStateManager.enterConversation('conv-3', 10)).toBe('restore-position')
    })

    it('should preserve scroll position when user scrolls before each switch', () => {
      // This test verifies that scrollStateManager correctly handles
      // multiple conversations and returns restore-position for each

      // Test the scrollStateManager directly since the component integration
      // has complex timing with React rendering and DOM updates

      // Simulate conv-1: scrolled up to 150
      scrollStateManager.enterConversation('conv-1', 10)
      scrollStateManager.saveScrollPosition('conv-1', 150, 1000, 500)

      // Leave conv-1 (this saves the position)
      scrollStateManager.leaveConversation('conv-1', 150, 1000, 500)

      // Enter conv-2
      scrollStateManager.enterConversation('conv-2', 5)
      scrollStateManager.leaveConversation('conv-2', 0, 500, 500) // at bottom

      // Return to conv-1 - first cycle
      const action1 = scrollStateManager.enterConversation('conv-1', 10)
      expect(action1).toBe('restore-position')
      expect(scrollStateManager.getSavedScrollTop('conv-1')).toBe(150)

      // Clear the state (simulates what the hook does after restoring)
      scrollStateManager.clearSavedScrollState('conv-1')

      // User scrolls in conv-1 again, establishing position for next cycle
      scrollStateManager.saveScrollPosition('conv-1', 150, 1000, 500)
      scrollStateManager.leaveConversation('conv-1', 150, 1000, 500)

      // Enter conv-3
      scrollStateManager.enterConversation('conv-3', 8)
      scrollStateManager.leaveConversation('conv-3', 0, 500, 500)

      // Return to conv-1 - second cycle
      const action2 = scrollStateManager.enterConversation('conv-1', 10)
      expect(action2).toBe('restore-position')
      expect(scrollStateManager.getSavedScrollTop('conv-1')).toBe(150)
    })
  })

  describe('media load scroll behavior (images, videos, link previews)', () => {
    /**
     * These tests verify the snapshot + debounce pattern for media load scroll correction.
     *
     * Key behaviors:
     * 1. First image load captures snapshot (wasAtBottom)
     * 2. Multiple rapid loads are debounced (single scroll correction)
     * 3. Scroll correction respects user's scroll position
     * 4. ResizeObserver skips during media load batch
     */

    it('should provide onMediaLoad callback to renderMessage', () => {
      const messages = createTestMessages(5)
      let onMediaLoadCallback: (() => void) | null = null

      render(
        <MessageList
          messages={messages}
          conversationId="conv-media-callback"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg, _idx, _group, _showNew, onMediaLoad) => {
            onMediaLoadCallback = onMediaLoad
            return <div key={msg.id}>{msg.body}</div>
          }}
        />
      )

      // The onMediaLoad callback should be provided
      expect(onMediaLoadCallback).not.toBeNull()
      expect(typeof onMediaLoadCallback).toBe('function')
    })

    it('should scroll to bottom when media loads and user was at bottom', async () => {
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      const { container } = render(
        <MessageList
          messages={messages}
          conversationId="conv-media-at-bottom"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg, _idx, _group, _showNew, onMediaLoad) => (
            <div key={msg.id}>
              {msg.body}
              <button data-testid={`load-${msg.id}`} onClick={onMediaLoad}>Load</button>
            </div>
          )}
        />
      )

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
      if (scrollContainer) {
        // Set up at bottom: scrollHeight(1000) - scrollTop(500) - clientHeight(500) = 0
        let scrollTopValue = 500
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(scrollContainer, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Trigger scroll to establish at-bottom state
        act(() => {
          scrollContainer.dispatchEvent(new Event('scroll'))
        })
        scrollSpy.mockClear()

        // Trigger media load
        const loadButton = document.querySelector('[data-testid^="load-"]')
        act(() => {
          loadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })

        // Wait for debounce (using real timers)
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
        })

        // Should have scrolled to bottom
        expect(scrollSpy).toHaveBeenCalledWith(1000)
      }
    })

    it('should NOT scroll when user was scrolled up when media started loading', async () => {
      const messages = createTestMessages(5)
      const scrollSpy = vi.fn()

      const { container } = render(
        <MessageList
          messages={messages}
          conversationId="conv-media-scrolled-up"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg, _idx, _group, _showNew, onMediaLoad) => (
            <div key={msg.id}>
              {msg.body}
              <button data-testid={`load-${msg.id}`} onClick={onMediaLoad}>Load</button>
            </div>
          )}
        />
      )

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
      if (scrollContainer) {
        // User is scrolled up: scrollHeight(1000) - scrollTop(200) - clientHeight(500) = 300 (> 50 threshold)
        let scrollTopValue = 200
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(scrollContainer, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })

        // Trigger scroll to establish scrolled-up state
        act(() => {
          scrollContainer.dispatchEvent(new Event('scroll'))
        })
        scrollSpy.mockClear()

        // Trigger media load
        const loadButton = document.querySelector('[data-testid^="load-"]')
        act(() => {
          loadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })

        // Wait for debounce
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
        })

        // Should NOT have scrolled (user was not at bottom)
        expect(scrollSpy).not.toHaveBeenCalled()
      }
    })

    it('should batch multiple media loads with debouncing', async () => {
      const messages = createTestMessages(5)
      let scrollCount = 0

      const { container } = render(
        <MessageList
          messages={messages}
          conversationId="conv-media-batch-test"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg, _idx, _group, _showNew, onMediaLoad) => (
            <div key={msg.id}>
              {msg.body}
              <button data-testid={`load-${msg.id}`} onClick={onMediaLoad}>Load</button>
            </div>
          )}
        />
      )

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
      if (scrollContainer) {
        let scrollTopValue = 500
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(scrollContainer, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollCount++
          },
          configurable: true,
        })

        // Establish at-bottom state
        act(() => {
          scrollContainer.dispatchEvent(new Event('scroll'))
        })
        scrollCount = 0

        // Trigger multiple media loads rapidly
        const loadButtons = document.querySelectorAll('[data-testid^="load-"]')
        act(() => {
          loadButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          loadButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          loadButtons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })

        // Wait for debounce
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
        })

        // Should have only ONE scroll correction (batched via debounce)
        expect(scrollCount).toBe(1)
      }
    })
  })

  describe('MAM initial load phase behavior', () => {
    /**
     * These tests verify that the scroll behavior correctly handles the interaction
     * between MUC history (immediate) and MAM loading (async).
     *
     * Key scenarios:
     * 1. Room without MAM → scroll to bottom immediately
     * 2. Room with MAM loading → wait for MAM completion then scroll
     * 3. MAM completion detection → triggers scroll when in initial load phase
     */

    it('should scroll to bottom immediately when MAM is NOT loading (room without MAM)', () => {
      const scrollSpy = vi.fn()

      // Render first with empty messages
      const { rerender, container } = render(
        <MessageList
          messages={[] as BaseMessage[]}
          conversationId="room-no-mam"
          clearFirstNewMessageId={vi.fn()}
          isLoadingOlder={false} // No MAM loading
          isHistoryComplete={false}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // Set up spy on scroll container
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
      if (scrollContainer) {
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(scrollContainer, 'scrollTop', {
          get: () => 0,
          set: scrollSpy,
          configurable: true,
        })
        scrollContainer.scrollTo = vi.fn()

        // Now add messages (simulating MUC history arriving)
        const messages = createTestMessages(10)
        act(() => {
          rerender(
            <MessageList
              messages={messages}
              conversationId="room-no-mam"
              clearFirstNewMessageId={vi.fn()}
              isLoadingOlder={false} // No MAM loading
              isHistoryComplete={false}
              renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
            />
          )
        })

        // Should have scrolled to bottom (scrollTop set to scrollHeight)
        expect(scrollSpy).toHaveBeenCalled()
      }
    })

    it('should scroll to bottom when MAM loading completes during initial load', () => {
      const scrollSpy = vi.fn()
      const scrollToSpy = vi.fn()

      // Initial render with empty messages
      const { rerender, container } = render(
        <MessageList
          messages={[] as BaseMessage[]}
          conversationId="room-with-mam"
          clearFirstNewMessageId={vi.fn()}
          isLoadingOlder={true} // MAM is loading
          isHistoryComplete={false}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
      if (scrollContainer) {
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(scrollContainer, 'scrollTop', {
          get: () => 0,
          set: scrollSpy,
          configurable: true,
        })
        scrollContainer.scrollTo = scrollToSpy

        // Messages arrive while MAM is still loading (MUC history)
        const messages = createTestMessages(10)
        act(() => {
          rerender(
            <MessageList
              messages={messages}
              conversationId="room-with-mam"
              clearFirstNewMessageId={vi.fn()}
              isLoadingOlder={true} // Still loading
              isHistoryComplete={false}
              renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
            />
          )
        })

        // Initial scroll happens
        scrollSpy.mockClear()
        scrollToSpy.mockClear()

        // MAM completes (isLoadingOlder transitions from true to false)
        act(() => {
          rerender(
            <MessageList
              messages={[...messages, ...createTestMessages(5).map((m, i) => ({ ...m, id: `mam-${i}` }))]}
              conversationId="room-with-mam"
              clearFirstNewMessageId={vi.fn()}
              isLoadingOlder={false} // MAM completed
              isHistoryComplete={false}
              renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
            />
          )
        })

        // Should scroll to bottom after MAM completion (either via scrollTop or scrollTo)
        const scrolled = scrollSpy.mock.calls.length > 0 || scrollToSpy.mock.calls.length > 0
        expect(scrolled).toBe(true)
      }
    })

    it('should NOT wait for MAM on conversation switch when scrolled position exists', () => {
      const messages = createTestMessages(10)
      const scrollSpy = vi.fn()

      // First render with conv-1
      const { rerender, container } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          isLoadingOlder={false}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLDivElement
      if (scrollContainer) {
        let scrollTopValue = 200 // Scrolled up position
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true })
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true })
        Object.defineProperty(scrollContainer, 'scrollTop', {
          get: () => scrollTopValue,
          set: (v) => {
            scrollTopValue = v
            scrollSpy(v)
          },
          configurable: true,
        })
        scrollContainer.scrollTo = vi.fn()

        // Trigger scroll to save position (wheel = genuine user scroll).
        act(() => {
          scrollContainer.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
          scrollContainer.dispatchEvent(new Event('scroll'))
        })
        scrollSpy.mockClear()

        // Switch to different conversation
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-2"
            clearFirstNewMessageId={vi.fn()}
            isLoadingOlder={true} // This conv has MAM loading
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Switch back to conv-1 with MAM loading
        rerender(
          <MessageList
            messages={messages}
            conversationId="conv-1"
            clearFirstNewMessageId={vi.fn()}
            isLoadingOlder={true} // MAM is loading
            renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
          />
        )

        // Should restore scroll position (200), not wait for MAM
        const scrollCalls = scrollSpy.mock.calls.flat()
        expect(scrollCalls).toContain(200)
      }
    })
  })

  describe('content ResizeObserver lifecycle', () => {
    const renderList = (messages: BaseMessage[]) => (
      <MessageList
        messages={messages}
        conversationId="conv-1"
        clearFirstNewMessageId={vi.fn()}
        typingUsers={[]}
        renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
      />
    )

    // Is some LIVE observer watching the content wrapper (the direct child of
    // the scroll container)?
    const contentWrapperIsObserved = () => {
      const scroller = document.querySelector('[data-message-list]')
      return MockResizeObserver.instances.some((inst) =>
        inst.targets.some((t) => t.parentElement === scroller)
      )
    }

    // React attaches refs child-first within a commit. When MessageList mounts
    // WITH messages already present (same-commit mount of scroller + content
    // wrapper), the content ref callback runs before the scroller ref is set —
    // it must not silently skip observer setup (lost scroll correction).
    it('creates the content observer when mounted with messages already present', () => {
      render(renderList(createTestMessages(5)))
      expect(contentWrapperIsObserved()).toBe(true)
    })

    // Regression guard: the wrapper ref must be identity-stable so React does
    // not detach/reattach it per render — that would tear down and recreate
    // the observer on EVERY render (a full-reflow amplifier in busy rooms on
    // a large non-virtualized backlog).
    it('does not recreate observers when a new message re-renders the list', () => {
      const { rerender } = render(renderList(createTestMessages(5)))
      const constructedAfterMount = MockResizeObserver.constructed
      const liveAfterMount = MockResizeObserver.instances.length
      expect(contentWrapperIsObserved()).toBe(true)

      // Simulate two incoming messages (the busy-MUC case: one render each)
      rerender(renderList(createTestMessages(6)))
      rerender(renderList(createTestMessages(7)))

      expect(MockResizeObserver.constructed).toBe(constructedAfterMount)
      expect(MockResizeObserver.instances.length).toBe(liveAfterMount)
      expect(contentWrapperIsObserved()).toBe(true)
    })

    // Field diagnostic for the WebKitGTK freeze class: a SLOW correction (the
    // scrollHeight read reflows the whole backlog) must produce a rate-limited
    // contextual warning so fluux.log shows duration + backlog size.
    it('warns with context when a scroll correction is slow', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Every performance.now() call advances 50ms -> any measured correction
      // "takes" 50ms, above the 32ms threshold.
      let fakeNow = 0
      const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
        fakeNow += 50
        return fakeNow
      })

      try {
        render(renderList(createTestMessages(5)))
        const scroller = document.querySelector('[data-message-list]')!
        const wrapper = Array.from(scroller.children).find(
          (c) => c instanceof HTMLDivElement
        ) as Element
        const observer = MockResizeObserver.observing(wrapper)
        expect(observer).toBeDefined()

        act(() => {
          observer!.triggerResize(800)
        })

        const slowWarnings = warnSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('[SlowScrollCorrection]'))
        expect(slowWarnings.length).toBe(1)
        expect(slowWarnings[0]).toContain('conversation=conv-1')
        expect(slowWarnings[0]).toContain('rows=')
      } finally {
        nowSpy.mockRestore()
        warnSpy.mockRestore()
      }
    })
  })
})
