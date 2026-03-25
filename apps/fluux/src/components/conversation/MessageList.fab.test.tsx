/**
 * @vitest-environment jsdom
 *
 * Tests for the scroll-to-bottom FAB (floating action button):
 * - Badge count derived from firstNewMessageId marker position
 * - Two-step scroll behavior (marker first, then bottom)
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
   * Simulate the user scrolling up by dispatching a scroll event.
   * This updates the FAB visibility state inside the hook.
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

  describe('unread badge derived from marker', () => {
    it('should not show badge when no firstNewMessageId is set', () => {
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

    it('should show badge count matching messages from marker to end', () => {
      const messages = createTestMessages(10) // msg-0 through msg-9
      // Place marker at msg-7 → 3 messages (msg-7, msg-8, msg-9)
      const firstNewMessageId = 'msg-7'

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId={firstNewMessageId}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return

      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      expect(fab).toBeTruthy()

      // Badge should show 3 (messages from marker to end)
      const badge = fab?.querySelector('span')
      expect(badge).toBeTruthy()
      expect(badge?.textContent).toBe('3')
    })

    it('should not show badge when firstNewMessageId is not found in messages', () => {
      const messages = createTestMessages(10)

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId="nonexistent-id"
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return

      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      const badge = fab?.querySelector('span')
      expect(badge).toBeNull()
    })

    it('should cap badge at 99+ for large counts', () => {
      const messages = createTestMessages(150)
      // Place marker at msg-0 → 150 messages
      const firstNewMessageId = 'msg-0'

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId={firstNewMessageId}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return

      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      const badge = fab?.querySelector('span')
      expect(badge?.textContent).toBe('99+')
    })

    it('should update badge when firstNewMessageId changes', () => {
      const messages = createTestMessages(10)

      const { rerender } = render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId="msg-7"
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer()
      if (!scrollCtx) return

      simulateScrollUp(scrollCtx.container)

      // Verify initial badge: msg-7 through msg-9 = 3
      let fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      let badge = fab?.querySelector('span')
      expect(badge?.textContent).toBe('3')

      // Move marker earlier: msg-5 through msg-9 = 5
      rerender(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId="msg-5"
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]')
      badge = fab?.querySelector('span')
      expect(badge?.textContent).toBe('5')
    })
  })

  describe('two-step scroll behavior', () => {
    it('should scroll to bottom directly when there is no firstNewMessageId', () => {
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

    it('should scroll to new message marker on first click when firstNewMessageId exists', () => {
      const messages = createTestMessages(10)
      // Place the marker at message 5
      const firstNewMessageId = 'msg-5'

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId={firstNewMessageId}
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

      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      if (!fab) return

      act(() => { fireEvent.click(fab) })

      if (markerElement) {
        // Should scroll to marker position (offsetTop - viewport/3 = 800 - 500/3 ≈ 633)
        expect(scrollCtx.scrollToSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            top: expect.any(Number),
            behavior: 'smooth',
          })
        )
        // First call should NOT be to bottom
        const firstCallTop = scrollCtx.scrollToSpy.mock.calls[0]?.[0]?.top
        expect(firstCallTop).not.toBe(2000)
      }
    })

    it('should scroll to bottom on second click after scrolling to marker', () => {
      const messages = createTestMessages(10)
      const firstNewMessageId = 'msg-5'

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId={firstNewMessageId}
          renderMessage={(msg) => <div key={msg.id}>{msg.body}</div>}
        />
      )

      const scrollCtx = setupScrollContainer({ scrollHeight: 2000, clientHeight: 500 })
      if (!scrollCtx) return

      const markerElement = scrollCtx.container.querySelector('[data-message-id="msg-5"]') as HTMLElement
      if (markerElement) {
        Object.defineProperty(markerElement, 'offsetTop', { value: 800, configurable: true })
      }

      simulateScrollUp(scrollCtx.container)

      const fab = scrollCtx.container.parentElement?.querySelector('button[aria-label="chat.scrollToBottom"]') as HTMLButtonElement
      if (!fab) return

      // First click - goes to marker
      act(() => { fireEvent.click(fab) })
      scrollCtx.scrollToSpy.mockClear()

      // Second click - should go to bottom
      act(() => { fireEvent.click(fab) })

      expect(scrollCtx.scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 2000, behavior: 'smooth' })
      )
    })

    it('should scroll to bottom directly when marker element is not found in DOM', () => {
      const messages = createTestMessages(10)
      // Use a non-existent message ID
      const firstNewMessageId = 'msg-nonexistent'

      render(
        <MessageList
          messages={messages}
          conversationId="conv-1"
          clearFirstNewMessageId={vi.fn()}
          firstNewMessageId={firstNewMessageId}
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
