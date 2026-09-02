/**
 * @vitest-environment jsdom
 *
 * Tests for the scroll-to-bottom FAB (floating action button):
 * - Badge shows the ONE canonical `unreadCount` prop — never a
 *   recount of the resident/below-viewport message array. Scrolling is navigation, not read
 *   state: the badge must not react to scroll position at all.
 * - Two-step scroll behavior (marker first, then bottom) — geometry-driven, unchanged by the
 *   count model switch.
 *
 * This file previously tested `countNewBelowViewport` (`unreadBadge.ts`), which recomputed the
 * badge from the resident array + scroll position. Both the helper and that model are deleted;
 * the badge now reads `unreadCount` directly and is asserted to be scroll- and
 * resident-array-independent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
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
function createTestMessages(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    from: 'user@example.com',
    body: `Message ${i}`,
    timestamp: new Date(2024, 0, 1, 12, i),
    isOutgoing: i % 2 === 0,
    type: 'chat' as const,
  }))
}

// Mock ResizeObserver
class MockResizeObserver {
  callback: ResizeObserverCallback
  static instances: MockResizeObserver[] = []

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {
    const index = MockResizeObserver.instances.indexOf(this)
    if (index > -1) MockResizeObserver.instances.splice(index, 1)
  }
}

describe('MessageList FAB badge and scroll behavior', () => {
  let originalRAF: typeof requestAnimationFrame

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    MockResizeObserver.instances = []

    // These tests cover FAB badge counts and two-step scroll UX which are agnostic to the
    // virtualizer. Run with virtualization OFF so the non-virtualized scrollTo path is
    // exercised and the tests remain focused on FAB behavior, not virtualizer internals.
    localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')

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
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    window.requestAnimationFrame = originalRAF
    localStorage.clear()
  })

  /**
   * Set up a scrollable container by defining scroll properties on the rendered element.
   * Returns the container and a spy for scrollTo calls.
   */
  function setupScrollContainer(options: {
    scrollHeight?: number
    clientHeight?: number
    initialScrollTop?: number
  } = {}) {
    const { scrollHeight = 2000, clientHeight = 500, initialScrollTop = 0 } = options
    const container = document.querySelector('.overflow-y-auto') as HTMLDivElement

    if (!container) return null

    let scrollTopValue = initialScrollTop
    const scrollToSpy = vi.fn((opts: ScrollToOptions) => {
      scrollTopValue = opts.top ?? scrollTopValue
    })

    Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true })
    Object.defineProperty(container, 'scrollTop', {
      get: () => scrollTopValue,
      set: (v) => { scrollTopValue = v },
      configurable: true,
    })
    Object.defineProperty(container, 'scrollTo', { value: scrollToSpy, configurable: true })

    return { container, scrollToSpy, getScrollTop: () => scrollTopValue }
  }

  /**
   * jsdom reports 0 for offsetHeight and getBoundingClientRect, so the hook's findBottomAnchor
   * (which picks the bottom-most visible .message-row to feed the FAB badge count) can't resolve a
   * realistic row without explicit geometry. Lay the rows out at a fixed height and position them
   * relative to scrollTop so the bottom-most-visible message is deterministic. rowHeight=100,
   * clientHeight=500 (from setupScrollContainer) ⇒ five rows fit; at scrollTop=0 the bottom-most
   * visible row is index 4.
   */
  function layoutRows(container: HTMLDivElement, scrollTop: number, rowHeight = 100) {
    const rows = container.querySelectorAll('.message-row[data-message-id]')
    rows.forEach((node, i) => {
      const el = node as HTMLElement
      Object.defineProperty(el, 'offsetHeight', { value: rowHeight, configurable: true })
      Object.defineProperty(el, 'offsetTop', { value: i * rowHeight, configurable: true })
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => {
          const top = i * rowHeight - scrollTop
          return { top, bottom: top + rowHeight, height: rowHeight, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect
        },
        configurable: true,
      })
    })
  }

  /**
   * Scroll to an explicit position: lay out row geometry for that scrollTop, then dispatch the
   * scroll event so the hook recomputes FAB visibility AND the bottom-most-visible message.
   */
  function simulateScrollTo(container: HTMLDivElement, scrollTop: number) {
    Object.defineProperty(container, 'scrollTop', {
      get: () => scrollTop,
      set: () => {},
      configurable: true,
    })
    layoutRows(container, scrollTop)
    act(() => {
      container.dispatchEvent(new Event('scroll'))
    })
  }

  /**
   * Simulate the user scrolling up by dispatching a scroll event, WITHOUT laying out row geometry.
   * Used by the two-step-scroll and flash tests, which set their own marker offsetTop and only care
   * about FAB visibility / scroll-target math — not the badge count. (Badge-count tests use
   * simulateScrollTo, which adds row geometry so the bottom-most-visible message resolves.)
   */
  function simulateScrollUp(container: HTMLDivElement) {
    // Set scrollTop to a position far from bottom to trigger FAB
    Object.defineProperty(container, 'scrollTop', {
      get: () => 0,
      set: () => {},
      configurable: true,
    })
    act(() => {
      container.dispatchEvent(new Event('scroll'))
    })
  }

  describe('FAB badge reflects the canonical unreadCount prop', () => {
    it('should not show badge when unreadCount is omitted (0)', () => {
      const messages = createTestMessages(10)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return

      // Scroll up to make FAB visible
      simulateScrollUp(scrollCtx.container)

      // FAB should be visible but no badge
      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      expect(fab).toBeTruthy()

      // Badge should not exist
      const badge = fab?.querySelector('span')
      expect(badge).toBeNull()
    })

    it('shows the unreadCount prop verbatim as the badge text', () => {
      const messages = createTestMessages(10)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-7' }}
          unreadCount={3}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return
      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      const badge = fab?.querySelector('span')
      expect(badge?.textContent).toBe('3')
    })

    it('shows the badge even when there is no divider (firstNewMessageRow absent) — the badge does not depend on the divider', () => {
      const messages = createTestMessages(10)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          unreadCount={5}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return
      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      expect(fab?.querySelector('span')?.textContent).toBe('5')
    })

    // Break check for the deleted `countNewBelowViewport`/`markerUnreadCount` resident-array
    // derivation: with the OLD code, this exact setup — firstNewMessageRow='msg-3',
    // readPointerId='msg-6' — computed a badge of 3 (msg-7..msg-9 below the read pointer, see the
    // deleted unreadBadge.test.ts fixture this is adapted from). Passing a canonical `unreadCount`
    // that DISAGREES with that resident-array math (11, not 3) proves the badge no longer
    // recomputes from messages/readPointerId at all — if it still did, this would show '3'.
    it('ignores the resident array and read pointer entirely — only unreadCount drives the badge', () => {
      const messages = createTestMessages(10) // msg-0 .. msg-9
      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-3' }}
          readPointerRow={{ id: 'msg-6' }}
          unreadCount={11}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )
      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return
      simulateScrollUp(scrollCtx.container)

      const badge = scrollCtx.container.parentElement
        ?.querySelector('button[aria-label="chat.scrollToBottom"]')?.querySelector('span')
      expect(badge?.textContent).toBe('11')
    })

    // Acceptance scenario 3 ("scroll down and back up without advancing the read pointer"):
    // the canonical count must not react to scroll position at all.
    // Break check: drive scroll events only (no prop change) and assert the count is unchanged —
    // a viewport-derived badge (the deleted model) would have ticked down as the reader scrolled.
    it('does not change when the viewport/scroll position changes (scenario 3)', () => {
      const messages = createTestMessages(10)
      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-3' }}
          unreadCount={4}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )
      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return
      const badge = () => scrollCtx.container.parentElement
        ?.querySelector('button[aria-label="chat.scrollToBottom"]')?.querySelector('span')

      simulateScrollTo(scrollCtx.container, 0)
      expect(badge()?.textContent).toBe('4')

      // Scroll toward the bottom (past the divider) — a below-viewport recount would drop this.
      simulateScrollTo(scrollCtx.container, 900)
      expect(badge()?.textContent).toBe('4')

      // ...and back up — a resident-array count would restore a possibly-different number here too.
      simulateScrollTo(scrollCtx.container, 0)
      expect(badge()?.textContent).toBe('4')
    })

    it('updates when the unreadCount prop changes (e.g. the pointer advances)', () => {
      const messages = createTestMessages(10)

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-3' }}
          unreadCount={7}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return
      simulateScrollUp(scrollCtx.container)

      const badge = () => scrollCtx.container.parentElement
        ?.querySelector('button[aria-label="chat.scrollToBottom"]')?.querySelector('span')
      expect(badge()?.textContent).toBe('7')

      rerender(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-3' }}
          unreadCount={3}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )
      expect(badge()?.textContent).toBe('3')
    })

    // Each numeric surface needs a 998/999/1000 test: the store
    // saturates at 999 and never reaches 1000, so `formatUnreadCount` must render 999 as "999+",
    // not the exact "999".
    it('caps the badge at 999+ for a saturated canonical count (998/999/1000)', () => {
      const messages = createTestMessages(10)
      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-0' }}
          unreadCount={998}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )
      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return
      simulateScrollUp(scrollCtx.container)
      const badge = () => scrollCtx.container.parentElement
        ?.querySelector('button[aria-label="chat.scrollToBottom"]')?.querySelector('span')
      expect(badge()?.textContent).toBe('998')

      rerender(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-0' }}
          unreadCount={999}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )
      expect(badge()?.textContent).toBe('999+')

      rerender(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={{ id: 'msg-0' }}
          unreadCount={1000}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )
      expect(badge()?.textContent).toBe('999+')
    })
  })

  describe('no flash on fresh open at bottom', () => {
    it('does not play the spring-out exit animation on initial mount', () => {
      // When a conversation opens already at the bottom, the FAB should be hidden with NO
      // animation. The exit keyframe (fab-spring-out) starts at opacity:1 (fully visible), so
      // running it on mount paints the FAB visible on frame 0 and springs it away — a flash.
      const messages = createTestMessages(10)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      setupScrollContainer()

      // Do NOT dispatch a scroll event — this is the fresh open-at-bottom state.
      const fab = document.querySelector('button[aria-label="chat.scrollToBottom"]')
      expect(fab).toBeTruthy()

      const wrapper = fab!.closest('div.z-40') as HTMLElement
      expect(wrapper).toBeTruthy()
      // Must not run the exit animation on a FAB that was never shown.
      expect(wrapper.className).not.toContain('fab-spring-out')
      // Must be statically hidden and non-interactive instead.
      expect(wrapper.className).toContain('opacity-0')
      expect(wrapper.className).toContain('pointer-events-none')
    })

    it('plays the spring-out exit animation only after the FAB has been shown', () => {
      const messages = createTestMessages(10)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return

      // Scroll up: FAB springs in.
      simulateScrollUp(scrollCtx.container)
      let fab = document.querySelector('button[aria-label="chat.scrollToBottom"]')
      let wrapper = fab!.closest('div.z-40') as HTMLElement
      expect(wrapper.className).toContain('fab-spring-in')

      // Scroll back to bottom: now that it has been shown, the exit animation is allowed.
      Object.defineProperty(scrollCtx.container, 'scrollTop', {
        get: () => 1500, // scrollHeight 2000 - clientHeight 500 = bottom
        set: () => {},
        configurable: true,
      })
      act(() => { scrollCtx.container.dispatchEvent(new Event('scroll')) })

      fab = document.querySelector('button[aria-label="chat.scrollToBottom"]')
      wrapper = fab!.closest('div.z-40') as HTMLElement
      expect(wrapper.className).toContain('fab-spring-out')
    })
  })

  describe('two-step scroll behavior', () => {
    it('should scroll to bottom directly when there is no firstNewMessageRow', () => {
      const messages = createTestMessages(10)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500 })
      if (!scrollCtx) return

      simulateScrollUp(scrollCtx.container)

      // Click the FAB
      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      expect(fab).toBeTruthy()

      act(() => { fireEvent.click(fab) })

      // Should scroll to bottom (scrollHeight = 2000)
      expect(scrollCtx.scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 2000, behavior: 'smooth' })
      )
    })

    it('should scroll to new message marker on first click when firstNewMessageRow exists', () => {
      const messages = createTestMessages(10)
      // Place the marker at message 5
      const firstNewMessageRow = { id: 'msg-5' }

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={firstNewMessageRow}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500 })
      if (!scrollCtx) return

      // Set up the marker message element's offsetTop
      const markerElement = scrollCtx.container.querySelector('[data-message-id="msg-5"]') as HTMLElement
      if (markerElement) {
        Object.defineProperty(markerElement, 'offsetTop', { value: 800, configurable: true })
      }

      act(() => {
        scrollCtx.container.dispatchEvent(new Event('scroll'))
      })

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      if (!fab) return

      act(() => { fireEvent.click(fab) })

      if (markerElement) {
        // Controller-owned convergence uses immediate writes so each frame observes the actual
        // landing instead of repeatedly restarting a native smooth animation.
        expect(scrollCtx.getScrollTop()).toBeCloseTo(800 - 500 / 3, 0)
        expect(scrollCtx.scrollToSpy).not.toHaveBeenCalled()
      }
    })

    it('should scroll straight to bottom in one click when the marker is already visible', () => {
      const messages = createTestMessages(10)
      const firstNewMessageRow = { id: 'msg-5' }

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={firstNewMessageRow}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // Marker is at offsetTop 800; the user is positioned just above it (633),
      // so the marker is already within the viewport — NOT further down. This is
      // the on-open state (init auto-scrolls to the marker). A single click must
      // reach the bottom, with no wasted "scroll to marker" step.
      const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500, initialScrollTop: 633 })
      if (!scrollCtx) return

      const markerElement = scrollCtx.container.querySelector('[data-message-id="msg-5"]') as HTMLElement
      if (markerElement) {
        Object.defineProperty(markerElement, 'offsetTop', { value: 800, configurable: true })
      }

      // Make the FAB visible by dispatching a scroll event at the current position.
      act(() => { scrollCtx.container.dispatchEvent(new Event('scroll')) })

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      expect(fab).toBeTruthy()

      act(() => { fireEvent.click(fab) })

      expect(scrollCtx.scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 2000, behavior: 'smooth' })
      )
    })

    it('should NOT clear the unread marker when the FAB intentionally goes to bottom (#870)', () => {
      // The FAB jump-to-present must scroll to the live bottom WITHOUT clearing
      // firstNewMessageRow — the per-visit divider anchor has to survive the jump so the
      // jump-to-last-read pill can appear afterward. See useMessageListScroll's
      // scrollToBottom callback and the "reached bottom" clear guarded by !programmaticScroll.
      const messages = createTestMessages(10)
      const clearFirstNewMessageId = vi.fn()

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={clearFirstNewMessageId}
          firstNewMessageRow={{ id: 'msg-5' }}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500, initialScrollTop: 633 })
      if (!scrollCtx) return

      const markerElement = scrollCtx.container.querySelector('[data-message-id="msg-5"]') as HTMLElement
      if (markerElement) {
        Object.defineProperty(markerElement, 'offsetTop', { value: 800, configurable: true })
      }

      act(() => { scrollCtx.container.dispatchEvent(new Event('scroll')) })

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      expect(fab).toBeTruthy()

      act(() => { fireEvent.click(fab) })

      expect(clearFirstNewMessageId).not.toHaveBeenCalled()
      expect(scrollCtx.scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 2000, behavior: 'smooth' })
      )
    })

    it('should scroll to bottom on second click after scrolling to marker', () => {
      const messages = createTestMessages(10)
      const firstNewMessageRow = { id: 'msg-5' }

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={firstNewMessageRow}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      // Start above the marker (scrollTop 0, marker at offsetTop 800) so the marker
      // is genuinely further down. The scrollTo spy updates scrollTop, so the second
      // click sees the post-first-click position — just like the real DOM.
      const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500, initialScrollTop: 0 })
      if (!scrollCtx) return

      const markerElement = scrollCtx.container.querySelector('[data-message-id="msg-5"]') as HTMLElement
      if (markerElement) {
        Object.defineProperty(markerElement, 'offsetTop', { value: 800, configurable: true })
      }

      // Make the FAB visible at the current (top) position.
      act(() => { scrollCtx.container.dispatchEvent(new Event('scroll')) })

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      if (!fab) return

      // First click - goes to marker (marker is below the viewport)
      act(() => { fireEvent.click(fab) })
      const firstCallTop = scrollCtx.scrollToSpy.mock.calls[0]?.[0]?.top
      expect(firstCallTop).not.toBe(2000)
      scrollCtx.scrollToSpy.mockClear()

      // Second click - marker is now within the viewport, so go to bottom
      act(() => { fireEvent.click(fab) })

      expect(scrollCtx.scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 2000, behavior: 'smooth' })
      )
    })

    it('should scroll to bottom directly when marker element is not found in DOM', () => {
      const messages = createTestMessages(10)
      // Use a non-existent message ID
      const firstNewMessageRow = { id: 'msg-nonexistent' }

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageRow={firstNewMessageRow}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500 })
      if (!scrollCtx) return

      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      if (!fab) return

      act(() => { fireEvent.click(fab) })

      // Should fall through to bottom scroll since element not found
      expect(scrollCtx.scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 2000, behavior: 'smooth' })
      )
    })
  })
})
