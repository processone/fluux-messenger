import { useRef, useEffect } from 'react'

interface UseMessageScrollOptions {
  /** Callback when user scrolls to top (for lazy loading older messages) */
  onScrollToTop?: () => void
  /** Threshold in pixels for detecting scroll at top (default 50) */
  topThreshold?: number
}

/**
 * Hook for managing scroll behavior in message lists.
 *
 * Features:
 * - Tracks whether scroll is at bottom (within threshold)
 * - Auto-scrolls to bottom on new content (if already at bottom)
 * - Maintains scroll position on container resize
 * - Provides unconditional scroll-to-bottom function
 * - Detects scroll-to-top for lazy loading (optional callback)
 *
 * @param dependencies - Array of values that trigger auto-scroll when changed
 * @param options - Optional callbacks and configuration
 * @returns Scroll state and control functions
 */
export function useMessageScroll(dependencies: unknown[] = [], options: UseMessageScrollOptions = {}) {
  const { onScrollToTop, topThreshold = 50 } = options
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const isAtBottomRef = useRef(true)
  const isAtTopRef = useRef(false)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const lastScrollTopRef = useRef(0)

  /**
   * Scroll to bottom only if user was already at bottom.
   * Preserves scroll position when user has scrolled up to read history.
   */
  const scrollToBottomIfNeeded = () => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }

  /**
   * Unconditionally scroll to bottom.
   * Used after sending a message or switching conversations.
   */
  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }

  /**
   * Handler for scroll events. Updates isAtBottom and isAtTop state.
   * Considers "at bottom" if within 50px of the bottom.
   * Triggers onScrollToTop callback when user scrolls to top.
   */
  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current

    // Check if at bottom
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50

    // Check if at top (scrolling up and reached the threshold)
    const wasAtTop = isAtTopRef.current
    isAtTopRef.current = scrollTop < topThreshold

    // Trigger callback when user scrolls up to reach the top
    // Only trigger once when crossing the threshold (going from not-at-top to at-top)
    // and only when scrolling up (scrollTop decreased)
    if (!wasAtTop && isAtTopRef.current && scrollTop < lastScrollTopRef.current) {
      onScrollToTop?.()
    }

    lastScrollTopRef.current = scrollTop
  }

  /**
   * Reset scroll state to bottom. Call when changing conversations/rooms.
   */
  const resetScrollState = () => {
    isAtBottomRef.current = true
    // Use requestAnimationFrame to ensure DOM has updated before scrolling
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }

  /**
   * Callback ref that sets up ResizeObserver when element is attached.
   * Use this as the ref prop on the scroll container instead of scrollRef.
   */
  const setScrollRef = (node: HTMLDivElement | null) => {
    // Clean up previous observer
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect()
      resizeObserverRef.current = null
    }

    // Update the ref
    scrollRef.current = node

    // Set up new observer if we have a node
    if (node) {
      resizeObserverRef.current = new ResizeObserver(() => {
        // Use requestAnimationFrame to ensure layout is complete before scrolling
        requestAnimationFrame(() => {
          if (scrollRef.current && isAtBottomRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
          }
        })
      })
      resizeObserverRef.current.observe(node)
    }
  }

  // Serialize caller-provided dependencies into a stable trigger string.
  // This avoids passing a dynamic array to useEffect deps, which the
  // React Compiler and exhaustive-deps rule cannot statically verify.
  const depsKey = JSON.stringify(dependencies)

  // Auto-scroll to bottom when dependencies change (only if at bottom)
  useEffect(() => {
    scrollToBottomIfNeeded()
  }, [depsKey])

  return {
    /** Ref to read the scroll container (use setScrollRef as the ref prop) */
    scrollRef,
    /** Callback ref to attach to the scrollable container - sets up ResizeObserver */
    setScrollRef,
    /** Ref tracking whether scroll is at bottom (mutable) */
    isAtBottomRef,
    /** Ref tracking whether scroll is at top (mutable) */
    isAtTopRef,
    /** Scroll to bottom only if user was already at bottom */
    scrollToBottomIfNeeded,
    /** Unconditionally scroll to bottom */
    scrollToBottom,
    /** Handler for scroll events - attach to onScroll */
    handleScroll,
    /** Reset scroll state to bottom - call when changing conversations */
    resetScrollState,
  }
}
