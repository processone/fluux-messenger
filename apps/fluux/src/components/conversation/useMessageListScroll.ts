/**
 * useMessageListScroll - Manages all scroll behavior for MessageList
 *
 * This hook encapsulates the complex scroll logic that was previously scattered
 * across MessageList.tsx. It handles:
 *
 * 1. CONVERSATION SWITCHING
 *    - First visit: scroll to bottom
 *    - Return visit (was at bottom): scroll to bottom
 *    - Return visit (was scrolled up): restore saved position
 *
 * 2. NEW MESSAGES
 *    - At bottom: smooth scroll to show new message
 *    - Scrolled up: don't disturb user's position
 *
 * 3. HISTORY LOADING (prepend)
 *    - Capture scroll state before loading
 *    - After prepend: adjust position to maintain visual continuity
 *
 * 4. AUTO-SCROLL TRIGGERS
 *    - Typing indicator changes (when at bottom)
 *    - Reaction changes on last message (when at bottom)
 *    - Container/content resize (when at bottom)
 *
 * 5. SCROLL-TO-TOP LOADING
 *    - Trigger onScrollToTop when user scrolls to top
 *    - Cooldown to prevent rapid re-triggering
 *    - Wheel event handling when already at scrollTop=0
 */

import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react'
import { scrollStateManager } from '@/utils/scrollStateManager'

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Minimum time between scroll-to-top load triggers */
const LOAD_COOLDOWN_MS = 500

/** Distance from bottom to show "scroll to bottom" FAB */
const SCROLL_TO_BOTTOM_THRESHOLD = 300

/** Distance from bottom to consider "at bottom" for auto-scroll */
const AT_BOTTOM_THRESHOLD = 50

/** Throttle interval for saving scroll position */
const SCROLL_SAVE_THROTTLE_MS = 100


// ============================================================================
// TYPES
// ============================================================================

export interface UseMessageListScrollOptions {
  /** Unique identifier for this conversation/room */
  conversationId: string
  /** Number of messages (used to detect new arrivals) */
  messageCount: number
  /** ID of first message (used to detect prepends) */
  firstMessageId: string | undefined
  /** External ref for scroll container (for keyboard navigation) */
  externalScrollerRef?: React.RefObject<HTMLElement>
  /** External ref for "at bottom" state (shared with parent) */
  externalIsAtBottomRef?: React.MutableRefObject<boolean>
  /** Callback when user scrolls to top (for lazy loading) */
  onScrollToTop?: () => void
  /** Whether older messages are currently loading */
  isLoadingOlder?: boolean
  /** Whether all history has been fetched */
  isHistoryComplete?: boolean
  /** Number of users typing (triggers auto-scroll when changes) */
  typingUsersCount: number
  /** Serialized reactions of last message (triggers auto-scroll when changes) */
  lastMessageReactionsKey: string
}

export interface UseMessageListScrollResult {
  /** Callback ref for the scroll container div */
  setScrollContainerRef: (element: HTMLDivElement | null) => void
  /** Ref for the content wrapper (for resize observation) */
  contentWrapperRef: React.RefObject<HTMLDivElement>
  /** Scroll event handler */
  handleScroll: (e: React.UIEvent<HTMLDivElement>) => void
  /** Wheel event handler (for scroll-to-top at boundary) */
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  /** Click handler for "load earlier" button */
  handleLoadEarlier: () => void
  /** Smooth scroll to bottom (for FAB) */
  scrollToBottom: () => void
  /** Smooth scroll to top (for keyboard shortcut) */
  scrollToTop: () => void
  /** Whether to show the "scroll to bottom" FAB */
  showScrollToBottom: boolean
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useMessageListScroll({
  conversationId,
  messageCount,
  firstMessageId,
  externalScrollerRef,
  externalIsAtBottomRef,
  onScrollToTop,
  isLoadingOlder,
  isHistoryComplete,
  typingUsersCount,
  lastMessageReactionsKey,
}: UseMessageListScrollOptions): UseMessageListScrollResult {
  // --------------------------------------------------------------------------
  // REFS: Core scroll state
  // --------------------------------------------------------------------------

  /** The scroll container DOM element */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  /** Content wrapper for resize observation */
  const contentWrapperRef = useRef<HTMLDivElement>(null)

  /** Whether user is currently at bottom (for auto-scroll decisions) */
  const internalIsAtBottomRef = useRef(true)
  const isAtBottomRef = externalIsAtBottomRef || internalIsAtBottomRef

  /** Previous conversation ID (to detect switches) */
  const prevConversationIdRef = useRef<string | null>(null)

  /** Current conversation ID as ref (for stable callbacks) */
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  /** Whether MAM was loading on the previous render (to detect completion) */
  const wasMAMLoadingRef = useRef(false)

  /** Whether we're in the initial load phase (should scroll to bottom when MAM completes) */
  const isInitialLoadPhaseRef = useRef(false)

  // --------------------------------------------------------------------------
  // REFS: Scroll-to-top loading state
  // --------------------------------------------------------------------------

  /** Last scrollTop value (to detect scroll direction) */
  const lastScrollTopRef = useRef(0)

  /** Timestamp of last load trigger (for cooldown) */
  const loadCooldownRef = useRef(0)

  /** Whether user has scrolled away from top (allows re-trigger) */
  const hasScrolledAwayRef = useRef(false)

  // --------------------------------------------------------------------------
  // REFS: Scroll position persistence
  // --------------------------------------------------------------------------

  /** Timestamp of last position save (for throttling) */
  const lastScrollSaveRef = useRef(0)

  /** Pending scroll data for cleanup (in case DOM unmounts first) */
  const pendingScrollDataRef = useRef<{
    conversationId: string
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  } | null>(null)

  // --------------------------------------------------------------------------
  // REFS: Prepend adjustment (for loading older messages)
  // --------------------------------------------------------------------------

  /** Scroll height before prepend (to calculate adjustment) */
  const prePrependScrollHeightRef = useRef(0)

  /** Scroll position before prepend */
  const prePrependScrollTopRef = useRef(0)

  /** First message ID before prepend (to detect when prepend happened) */
  const prePrependFirstMsgIdRef = useRef<string | null>(null)

  /** Flag to indicate prepend is pending (used to hide content during transition) */
  const isPrependPendingRef = useRef(false)

  // --------------------------------------------------------------------------
  // STATE
  // --------------------------------------------------------------------------

  /** Whether to show the "scroll to bottom" FAB */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  /** Track last FAB state to avoid unnecessary state updates */
  const lastShowScrollToBottomRef = useRef(false)

  // --------------------------------------------------------------------------
  // DERIVED VALUES
  // --------------------------------------------------------------------------

  /** Whether we can trigger a load (not complete, not loading, has callback) */
  const canLoadMore = !isHistoryComplete && !isLoadingOlder && !!onScrollToTop

  // --------------------------------------------------------------------------
  // CALLBACKS: Ref management
  // --------------------------------------------------------------------------

  /** Callback ref that syncs internal and external refs */
  const setScrollContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollContainerRef.current = element
      if (externalScrollerRef) {
        (externalScrollerRef as React.MutableRefObject<HTMLElement | null>).current = element
      }
    },
    [externalScrollerRef]
  )

  // --------------------------------------------------------------------------
  // CALLBACKS: Scroll actions
  // --------------------------------------------------------------------------

  /** Scroll to bottom - instant or smooth */
  const doScrollToBottom = useCallback((smooth: boolean) => {
    const scroller = scrollContainerRef.current
    if (!scroller) return

    if (smooth) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    } else {
      scroller.scrollTop = scroller.scrollHeight
    }
  }, [])

  /** Public smooth scroll to bottom (for FAB) */
  const scrollToBottom = useCallback(() => {
    doScrollToBottom(true)
  }, [doScrollToBottom])

  /** Public smooth scroll to top (for keyboard shortcut) */
  const scrollToTop = useCallback(() => {
    const scroller = scrollContainerRef.current
    if (!scroller) return

    // Set cooldown to prevent auto-load triggering
    loadCooldownRef.current = Date.now()
    scroller.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // --------------------------------------------------------------------------
  // CALLBACKS: Prepend state capture
  // --------------------------------------------------------------------------

  /** Capture scroll state before triggering a load (for prepend adjustment) */
  const captureScrollStateForPrepend = useCallback(() => {
    const scroller = scrollContainerRef.current
    if (!scroller) return

    prePrependScrollHeightRef.current = scroller.scrollHeight
    prePrependScrollTopRef.current = scroller.scrollTop
    prePrependFirstMsgIdRef.current = firstMessageId ?? null
    // Mark prepend as pending - content will be hidden until scroll is adjusted
    isPrependPendingRef.current = true
    // Clear initial load phase to prevent scroll-to-bottom after this prepend completes
    isInitialLoadPhaseRef.current = false
  }, [firstMessageId])

  // --------------------------------------------------------------------------
  // CALLBACKS: Load triggering
  // --------------------------------------------------------------------------

  /** Check cooldown and trigger load if allowed */
  const tryTriggerLoad = useCallback(() => {
    if (!canLoadMore) return

    const now = Date.now()
    const cooldownPassed = now - loadCooldownRef.current > LOAD_COOLDOWN_MS

    if (cooldownPassed || hasScrolledAwayRef.current) {
      loadCooldownRef.current = now
      hasScrolledAwayRef.current = false
      captureScrollStateForPrepend()
      onScrollToTop?.()
    }
  }, [canLoadMore, captureScrollStateForPrepend, onScrollToTop])

  /** Handle "load earlier" button click (no cooldown for explicit clicks) */
  const handleLoadEarlier = useCallback(() => {
    if (!canLoadMore) return

    loadCooldownRef.current = Date.now()
    captureScrollStateForPrepend()
    onScrollToTop?.()
  }, [canLoadMore, captureScrollStateForPrepend, onScrollToTop])

  // --------------------------------------------------------------------------
  // CALLBACKS: Event handlers
  // --------------------------------------------------------------------------

  /** Main scroll event handler */
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight

      // Update "at bottom" state
      isAtBottomRef.current = distanceFromBottom < AT_BOTTOM_THRESHOLD

      // Save scroll position (throttled) - include conversationId for verification in cleanup
      pendingScrollDataRef.current = { conversationId: conversationIdRef.current, scrollTop, scrollHeight, clientHeight }
      const now = Date.now()
      if (now - lastScrollSaveRef.current > SCROLL_SAVE_THROTTLE_MS) {
        lastScrollSaveRef.current = now
        scrollStateManager.saveScrollPosition(
          conversationIdRef.current,
          scrollTop,
          scrollHeight,
          clientHeight
        )
      }

      // Update FAB visibility (only if changed to avoid re-renders)
      const shouldShowFab = distanceFromBottom > SCROLL_TO_BOTTOM_THRESHOLD
      if (shouldShowFab !== lastShowScrollToBottomRef.current) {
        lastShowScrollToBottomRef.current = shouldShowFab
        setShowScrollToBottom(shouldShowFab)
      }

      // Track if user scrolled away from top
      if (scrollTop > 50) {
        hasScrolledAwayRef.current = true
      }

      // Trigger load when reaching top (from scrolling down)
      if (scrollTop === 0 && lastScrollTopRef.current > 0) {
        tryTriggerLoad()
      }

      lastScrollTopRef.current = scrollTop
    },
    [isAtBottomRef, tryTriggerLoad]
  )

  /** Wheel event handler - needed to detect "scroll up" intent when at top */
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const { scrollTop } = e.currentTarget

      // Upward scroll at top boundary
      if (scrollTop === 0 && e.deltaY < 0) {
        tryTriggerLoad()
      }

      // Downward scroll at top resets "scrolled away" flag
      if (scrollTop === 0 && e.deltaY > 0) {
        hasScrolledAwayRef.current = true
      }
    },
    [tryTriggerLoad]
  )

  // --------------------------------------------------------------------------
  // EFFECT: Save scroll position when leaving conversation
  // --------------------------------------------------------------------------

  useEffect(() => {
    // Cleanup runs when conversationId changes or component unmounts
    return () => {
      if (!conversationId) return

      // IMPORTANT: Prefer pendingScrollDataRef over DOM!
      // When React's cleanup runs, the DOM may already have the NEW conversation's content
      // (due to React's render cycle), but pendingScrollDataRef contains the last scroll
      // position captured during handleScroll BEFORE the conversation switch.
      const pendingData = pendingScrollDataRef.current
      if (pendingData && pendingData.conversationId === conversationId) {
        const { scrollTop, scrollHeight, clientHeight } = pendingData
        scrollStateManager.leaveConversation(conversationId, scrollTop, scrollHeight, clientHeight)
      } else {
        // Fallback: pendingRef doesn't have data for this conversation
        // This can happen if user switched away before any scroll events occurred
        // Don't save anything, but still mark as left so return is detected as switch
        scrollStateManager.markAsLeft(conversationId)
      }
    }
  }, [conversationId])

  // --------------------------------------------------------------------------
  // EFFECT: Handle conversation switch and new messages
  // --------------------------------------------------------------------------

  useEffect(() => {
    const scroller = scrollContainerRef.current
    if (!scroller || messageCount === 0) return

    const isConversationSwitch = prevConversationIdRef.current !== conversationId
    const wasInitialized = scrollStateManager.isInitialized(conversationId)
    const isNewMessage =
      !isConversationSwitch && wasInitialized && scrollStateManager.updateMessageCount(conversationId, messageCount)

    // FIRST LOAD: Messages arrived for the first time (0 → N)
    // This happens when joining a room - the view renders with 0 messages,
    // then MAM loads history. We need to scroll to bottom.
    if (!isConversationSwitch && !wasInitialized) {
      scrollStateManager.enterConversation(conversationId, messageCount)
      // Mark that we're in initial load phase - will scroll to bottom when MAM completes.
      // Only set this if MAM is actually loading; otherwise, no need to wait.
      isInitialLoadPhaseRef.current = !!isLoadingOlder
      // Reset initial scroll flag so the content resize observer will scroll
      hasInitialScrolledRef.current = false
      // Try scrolling immediately, then again after RAF
      doScrollToBottom(false)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          doScrollToBottom(false)
        })
      })
    } else if (isNewMessage) {
      // NEW MESSAGE arrived - scroll if at bottom OR if MAM is still loading during initial phase.
      // This handles the race condition when MUC history and MAM messages arrive in rapid succession.
      const shouldScrollDuringInitialLoad = isInitialLoadPhaseRef.current && isLoadingOlder
      if (isAtBottomRef.current || shouldScrollDuringInitialLoad) {
        doScrollToBottom(true)
      }
    } else if (isConversationSwitch) {
      // CONVERSATION SWITCH → ask scrollStateManager what to do
      const action = scrollStateManager.enterConversation(conversationId, messageCount)

      if (action === 'scroll-to-bottom') {
        // First visit OR was at bottom last time
        // Mark that we're in initial load phase - will scroll to bottom when MAM completes.
        // Only set this if MAM is actually loading; otherwise, no need to wait.
        isInitialLoadPhaseRef.current = !!isLoadingOlder
        // Reset initial scroll flag so the content resize observer will scroll
        hasInitialScrolledRef.current = false
        // Try scrolling immediately, then again after RAF
        doScrollToBottom(false)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            doScrollToBottom(false)
          })
        })
      } else if (action === 'restore-position') {
        // Returning to saved position
        const savedPosition = scrollStateManager.getSavedScrollTop(conversationId)
        if (savedPosition !== null) {
          // Mark NOT at bottom to prevent race with new messages
          isAtBottomRef.current = false
          // Not an initial load - don't auto-scroll when MAM completes
          isInitialLoadPhaseRef.current = false
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTop = savedPosition
              }
              scrollStateManager.clearSavedScrollState(conversationId)
            })
          })
        }
      }
      // 'no-action' means don't scroll (shouldn't happen on switch)
    }

    // Update tracking ref AFTER processing
    prevConversationIdRef.current = conversationId
  }, [conversationId, messageCount, doScrollToBottom, isAtBottomRef, isLoadingOlder])

  // --------------------------------------------------------------------------
  // EFFECT: Reset state when conversation changes
  // --------------------------------------------------------------------------

  useEffect(() => {
    // Reset prepend tracking
    prePrependScrollHeightRef.current = 0
    prePrependScrollTopRef.current = 0
    prePrependFirstMsgIdRef.current = null

    // Reset MAM loading tracking
    wasMAMLoadingRef.current = false
    isInitialLoadPhaseRef.current = false

    // Reset FAB (only if not already false)
    if (lastShowScrollToBottomRef.current) {
      lastShowScrollToBottomRef.current = false
      setShowScrollToBottom(false)
    }
  }, [conversationId])

  // --------------------------------------------------------------------------
  // EFFECT: Scroll to bottom when MAM loading completes during initial load
  // --------------------------------------------------------------------------

  useEffect(() => {
    // Detect MAM loading START (transition from false → true)
    // This handles the race condition where:
    // 1. Conversation switch sets isInitialLoadPhaseRef = !!isLoadingOlder = false
    // 2. MAM starts loading AFTER the switch effect runs
    // We need to capture this late-starting MAM load as part of initial phase
    const mamJustStarted = !wasMAMLoadingRef.current && isLoadingOlder
    if (mamJustStarted && prevConversationIdRef.current === conversationId) {
      // IMPORTANT: Only mark as initial load phase if we're NOT doing scroll-up pagination.
      // If prePrependFirstMsgIdRef is set, the user scrolled up and triggered a load -
      // we should NOT scroll to bottom when that load completes.
      const isScrollUpPagination = prePrependFirstMsgIdRef.current !== null
      if (!isScrollUpPagination) {
        // MAM started loading for the current conversation during initial phase
        // so we scroll to bottom when it completes
        isInitialLoadPhaseRef.current = true
      }
    }

    // Detect MAM loading completion (transition from true → false)
    const mamJustCompleted = wasMAMLoadingRef.current && !isLoadingOlder

    if (mamJustCompleted && isInitialLoadPhaseRef.current) {
      // MAM finished loading during initial load phase - scroll to bottom
      // This handles the case where MUC history arrives first, then MAM messages
      // arrive later. We need to scroll to show the latest messages.
      // Reset initial scroll flag so the content resize observer will also scroll
      hasInitialScrolledRef.current = false
      // Try scrolling immediately, then again after RAF for layout completion
      doScrollToBottom(false)
      requestAnimationFrame(() => {
        doScrollToBottom(false)
        requestAnimationFrame(() => {
          doScrollToBottom(false)
          // End the initial load phase now that MAM is complete and we've scrolled
          isInitialLoadPhaseRef.current = false
        })
      })
    }

    // Track current loading state for next render
    wasMAMLoadingRef.current = isLoadingOlder ?? false
  }, [isLoadingOlder, doScrollToBottom, conversationId])

  // --------------------------------------------------------------------------
  // LAYOUT EFFECT: Adjust scroll after prepend (older messages loaded)
  // --------------------------------------------------------------------------

  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current
    if (!scroller || !firstMessageId) return

    // Detect prepend: first message changed and we have saved state
    const didPrepend =
      prePrependFirstMsgIdRef.current !== null &&
      firstMessageId !== prePrependFirstMsgIdRef.current &&
      prePrependScrollHeightRef.current > 0

    if (didPrepend) {
      const previousFirstMsgId = prePrependFirstMsgIdRef.current

      // CRITICAL: Hide content during scroll adjustment to prevent visual blink.
      // Without this, the browser may paint the new messages at the wrong scroll
      // position before we can adjust it.
      if (isPrependPendingRef.current) {
        scroller.style.visibility = 'hidden'
      }

      // Force synchronous layout calculation before reading scrollHeight.
      // Without this, React may have committed DOM changes but the browser
      // hasn't calculated the new layout yet, causing scrollHeight to be stale.
      // Reading offsetHeight triggers a synchronous reflow.
      void scroller.offsetHeight

      const newScrollHeight = scroller.scrollHeight
      const heightDiff = newScrollHeight - prePrependScrollHeightRef.current

      if (heightDiff > 0) {
        // Adjust scroll to maintain visual position
        scroller.scrollTop = prePrependScrollTopRef.current + heightDiff
      } else {
        // Fallback: Height-based calculation failed (heightDiff <= 0).
        // This can happen if layout isn't fully computed yet.
        // Try to find the previous first message element and scroll to it.
        if (previousFirstMsgId) {
          const targetElement = scroller.querySelector(`[data-message-id="${previousFirstMsgId}"]`)
          if (targetElement) {
            // Position the element at the top of the viewport
            const elementTop = (targetElement as HTMLElement).offsetTop
            scroller.scrollTop = elementTop
          }
        }
      }

      // Force the browser to repaint immediately by reading scrollTop.
      // This ensures the visual update happens before any other rendering.
      void scroller.scrollTop

      // Reveal content after scroll adjustment
      if (isPrependPendingRef.current) {
        scroller.style.visibility = ''
        isPrependPendingRef.current = false
      }

      // Reset saved state
      prePrependScrollHeightRef.current = 0
      prePrependScrollTopRef.current = 0
      prePrependFirstMsgIdRef.current = firstMessageId
    }
  }, [firstMessageId, messageCount])

  // --------------------------------------------------------------------------
  // EFFECT: Auto-scroll when typing indicator changes (if at bottom)
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!scrollContainerRef.current || !isAtBottomRef.current) return
    scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
  }, [typingUsersCount, isAtBottomRef])

  // --------------------------------------------------------------------------
  // EFFECT: Auto-scroll when last message reactions change (if at bottom)
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!scrollContainerRef.current || !isAtBottomRef.current) return

    requestAnimationFrame(() => {
      if (scrollContainerRef.current && isAtBottomRef.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
      }
    })
  }, [lastMessageReactionsKey, isAtBottomRef])

  // --------------------------------------------------------------------------
  // EFFECT: Handle container resize (composer grows/shrinks)
  // --------------------------------------------------------------------------

  useEffect(() => {
    const scroller = scrollContainerRef.current
    if (!scroller) return

    // Use null to indicate we haven't received a valid height yet.
    // This handles jsdom and other environments where initial clientHeight is 0.
    let lastHeight: number | null = null

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newHeight = entry.contentRect.height

        // Skip if this is the first observation (just establishing baseline)
        if (lastHeight === null) {
          lastHeight = newHeight
          continue
        }

        const heightDiff = lastHeight - newHeight // Positive if container shrank (composer grew)

        // Only handle container shrinking (heightDiff > 0 means composer grew).
        // When container grows (composer shrinks), don't auto-scroll.
        if (heightDiff > 0 && scrollContainerRef.current) {
          const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
          const distanceFromBottom = scrollHeight - scrollTop - clientHeight

          // When composer grows by X pixels, we're pushed away from bottom by exactly X pixels.
          // Only scroll if we were within (heightDiff + threshold) of the bottom.
          // Don't use isAtBottomRef as fallback - it can be stale and cause unwanted scrolls.
          const wasNearBottom = distanceFromBottom <= heightDiff + AT_BOTTOM_THRESHOLD

          if (wasNearBottom) {
            // Scroll immediately without RAF to avoid visual jank
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
          }
        }
        lastHeight = newHeight
      }
    })

    observer.observe(scroller)
    return () => observer.disconnect()
  }, [conversationId, isAtBottomRef])

  // --------------------------------------------------------------------------
  // EFFECT: Handle content resize (images load, reactions render)
  // --------------------------------------------------------------------------

  // Track if we've done the initial scroll for this conversation
  const hasInitialScrolledRef = useRef(false)

  // Reset initial scroll flag when conversation changes
  useEffect(() => {
    hasInitialScrolledRef.current = false
  }, [conversationId])

  useEffect(() => {
    const contentWrapper = contentWrapperRef.current
    const scroller = scrollContainerRef.current
    if (!contentWrapper || !scroller) return

    let lastScrollHeight = scroller.scrollHeight

    // If this is the first time content appears and we haven't scrolled yet,
    // force an immediate scroll to bottom. This handles the race condition where
    // the double-rAF scroll happens before content is rendered.
    if (!hasInitialScrolledRef.current && scroller.scrollHeight > 0) {
      // Only scroll if we're supposed to be at bottom (not restoring a saved position)
      if (isAtBottomRef.current) {
        scroller.scrollTop = scroller.scrollHeight
        // Only mark as scrolled if we actually reached the bottom
        // This handles the case where content isn't fully rendered yet
        const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        if (distanceFromBottom < AT_BOTTOM_THRESHOLD) {
          hasInitialScrolledRef.current = true
        }
      } else {
        // Restoring position - mark as done
        hasInitialScrolledRef.current = true
      }
    }

    const observer = new ResizeObserver(() => {
      const newScrollHeight = scroller.scrollHeight

      // During initial load, keep trying to scroll to bottom until we succeed
      if (!hasInitialScrolledRef.current && isAtBottomRef.current && newScrollHeight > 0) {
        scroller.scrollTop = newScrollHeight
        const distanceFromBottom = newScrollHeight - scroller.scrollTop - scroller.clientHeight
        if (distanceFromBottom < AT_BOTTOM_THRESHOLD) {
          hasInitialScrolledRef.current = true
        }
      }
      // Scroll if content grew (normal operation after initial scroll)
      // IMPORTANT: Calculate whether user WAS at bottom based on OLD scroll height,
      // not isAtBottomRef which may have been set to false by a scroll event that
      // fired when the content grew and pushed the user away from bottom.
      else if (newScrollHeight > lastScrollHeight) {
        const { scrollTop, clientHeight } = scroller
        // Calculate distance from bottom BEFORE content grew
        const oldDistanceFromBottom = lastScrollHeight - scrollTop - clientHeight
        const wasAtBottom = oldDistanceFromBottom < AT_BOTTOM_THRESHOLD

        if (wasAtBottom) {
          requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
              // Update isAtBottomRef since we just scrolled to bottom
              isAtBottomRef.current = true
            }
          })
        }
      }
      lastScrollHeight = newScrollHeight
    })

    observer.observe(contentWrapper)
    return () => observer.disconnect()
  }, [conversationId, isAtBottomRef, messageCount])

  // --------------------------------------------------------------------------
  // EFFECT: Keyboard shortcuts (Home/End, Cmd+Up/Down)
  // --------------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if in input
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modKey = isMac ? e.metaKey : e.ctrlKey

      if (e.key === 'End' || (modKey && e.key === 'ArrowDown')) {
        e.preventDefault()
        scrollToBottom()
      }

      if (e.key === 'Home' || (modKey && e.key === 'ArrowUp')) {
        e.preventDefault()
        scrollToTop()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [scrollToBottom, scrollToTop])

  // --------------------------------------------------------------------------
  // RETURN
  // --------------------------------------------------------------------------

  return {
    setScrollContainerRef,
    contentWrapperRef,
    handleScroll,
    handleWheel,
    handleLoadEarlier,
    scrollToBottom,
    scrollToTop,
    showScrollToBottom,
  }
}
