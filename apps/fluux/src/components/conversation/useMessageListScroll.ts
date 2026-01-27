/**
 * useMessageListScroll - Simple, imperative scroll management
 *
 * DESIGN PRINCIPLES:
 * 1. All scroll state lives in REFS, not React state (prevents render loops)
 * 2. Scroll operations are IMPERATIVE (directly set scrollTop)
 * 3. Only FAB visibility uses React state (it needs to trigger UI updates)
 * 4. Logic is LINEAR and SIMPLE - no state machines, no complex transitions
 *
 * BEHAVIORS:
 * - Initial load: scroll to bottom
 * - Conversation switch: restore position or scroll to bottom
 * - New message arrives: if at bottom, stay at bottom
 * - Load older messages: preserve visual position (what user was looking at)
 * - Images load: if at bottom, stay at bottom
 */

import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react'
import { scrollStateManager } from '@/utils/scrollStateManager'

// ============================================================================
// DEBUG
// ============================================================================

const DEBUG = false

function debugLog(action: string, data?: Record<string, unknown>) {
  if (DEBUG) {
    console.log(`[Scroll] ${action}`, data ?? '')
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

const AT_BOTTOM_THRESHOLD = 50 // pixels from bottom to consider "at bottom"
const FAB_THRESHOLD = 300 // pixels from bottom to show "scroll to bottom" button
const LOAD_COOLDOWN_MS = 500 // minimum time between load triggers
const SAVE_THROTTLE_MS = 100 // minimum time between position saves
const PREPEND_COOLDOWN_MS = 500 // time to keep prepend flag after restore (prevents re-trigger)

// ============================================================================
// TYPES
// ============================================================================

export interface UseMessageListScrollOptions {
  conversationId: string
  messageCount: number
  firstMessageId: string | undefined
  externalScrollerRef?: React.RefObject<HTMLElement>
  externalIsAtBottomRef?: React.MutableRefObject<boolean>
  onScrollToTop?: () => void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
  typingUsersCount: number
  lastMessageReactionsKey: string
}

export interface UseMessageListScrollResult {
  setScrollContainerRef: (element: HTMLDivElement | null) => void
  contentWrapperRef: React.RefObject<HTMLDivElement>
  handleScroll: (e: React.UIEvent<HTMLDivElement>) => void
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  handleLoadEarlier: () => void
  scrollToBottom: () => void
  scrollToTop: () => void
  showScrollToBottom: boolean
}

// ============================================================================
// HOOK
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

  // ==========================================================================
  // REFS - All scroll state lives here, NOT in React state
  // ==========================================================================

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Track scroll position - always create internal ref to follow rules of hooks
  const internalIsAtBottomRef = useRef(true)
  const isAtBottomRef = externalIsAtBottomRef || internalIsAtBottomRef

  // Track conversation
  const prevConversationRef = useRef<string | null>(null)
  const prevMessageCountRef = useRef(0)
  const hasInitializedRef = useRef(false)

  // Track prepend (loading older messages)
  // When we load older messages, we save the anchor element position BEFORE the load,
  // then restore it AFTER React renders the new messages.
  // Using element-based positioning is more reliable than pure scroll math.
  const prependRef = useRef<{
    // Element-based: ID and offset of the anchor element (first visible message)
    anchorMessageId: string
    anchorOffsetFromTop: number
    // Fallback: distance from bottom (in case element isn't found)
    distanceFromBottom: number
    oldFirstId: string
    oldMessageCount: number
    restored?: boolean  // Set after restore, cleared after cooldown
    restoredAt?: number // Timestamp of restore
  } | null>(null)

  // Throttling/cooldown
  const lastSaveTimeRef = useRef(0)
  const lastLoadTimeRef = useRef(0)
  const lastRestoreTimeRef = useRef(0) // Track when we last restored position
  const scrolledAwayFromTopRef = useRef(false)

  // Last scroll data (for saving on conversation switch)
  const lastScrollDataRef = useRef<{ top: number; height: number; client: number } | null>(null)

  // ==========================================================================
  // REACT STATE - Only for things that need to trigger UI updates
  // ==========================================================================

  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  const canLoadMore = !isHistoryComplete && !isLoadingOlder && !!onScrollToTop

  const getDistanceFromBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight

  // ==========================================================================
  // REF SETTER (connects external ref if provided)
  // ==========================================================================

  const setScrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el
    if (externalScrollerRef) {
      (externalScrollerRef as React.MutableRefObject<HTMLElement | null>).current = el
    }
  }, [externalScrollerRef])

  // ==========================================================================
  // SCROLL ACTIONS
  // ==========================================================================

  const scrollToBottom = useCallback(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  const scrollToTop = useCallback(() => {
    lastLoadTimeRef.current = Date.now() // prevent auto-load trigger
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // ==========================================================================
  // LOAD OLDER MESSAGES
  // ==========================================================================

  // Find the first visible message element and its offset from the viewport top
  const findAnchorElement = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return null

    const scrollTop = scroller.scrollTop
    const messages = scroller.querySelectorAll('[data-message-id]')

    for (const msg of messages) {
      const element = msg as HTMLElement
      const rect = element.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const offsetFromViewportTop = rect.top - scrollerRect.top

      // First message whose top is at or below the viewport top
      if (offsetFromViewportTop >= -rect.height / 2) {
        return {
          id: element.dataset.messageId!,
          offsetFromTop: element.offsetTop - scrollTop,
        }
      }
    }
    return null
  }, [])

  const triggerLoadOlder = useCallback(() => {
    if (!canLoadMore) return
    const scroller = scrollerRef.current
    if (!scroller) return

    const now = Date.now()
    const cooldownOk = now - lastLoadTimeRef.current > LOAD_COOLDOWN_MS
    const recentlyRestored = now - lastRestoreTimeRef.current < LOAD_COOLDOWN_MS

    // Don't trigger if we just restored scroll position (prevents rapid re-loading)
    if (recentlyRestored) {
      debugLog('LOAD BLOCKED (recently restored)', {
        timeSinceRestore: now - lastRestoreTimeRef.current,
      })
      return
    }

    if (cooldownOk || scrolledAwayFromTopRef.current) {
      lastLoadTimeRef.current = now
      scrolledAwayFromTopRef.current = false

      const distFromBottom = getDistanceFromBottom(scroller)
      const anchor = findAnchorElement()

      // SAVE position before load - we'll restore this distance after messages render
      prependRef.current = {
        anchorMessageId: anchor?.id || '',
        anchorOffsetFromTop: anchor?.offsetFromTop || 0,
        distanceFromBottom: distFromBottom,
        oldFirstId: firstMessageId || '',
        oldMessageCount: messageCount,
      }

      debugLog('PREPEND START', {
        anchor,
        distanceFromBottom: distFromBottom,
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
        firstMessageId,
        messageCount,
      })

      onScrollToTop?.()
    }
  }, [canLoadMore, findAnchorElement, firstMessageId, messageCount, onScrollToTop])

  const handleLoadEarlier = useCallback(() => {
    if (!canLoadMore) return
    const scroller = scrollerRef.current
    if (!scroller) return

    lastLoadTimeRef.current = Date.now()

    const distFromBottom = getDistanceFromBottom(scroller)
    const anchor = findAnchorElement()

    // SAVE position before load
    prependRef.current = {
      anchorMessageId: anchor?.id || '',
      anchorOffsetFromTop: anchor?.offsetFromTop || 0,
      distanceFromBottom: distFromBottom,
      oldFirstId: firstMessageId || '',
      oldMessageCount: messageCount,
    }

    debugLog('LOAD EARLIER', {
      anchor,
      distanceFromBottom: distFromBottom,
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      firstMessageId,
      messageCount,
    })

    onScrollToTop?.()
  }, [canLoadMore, findAnchorElement, firstMessageId, messageCount, onScrollToTop])

  // ==========================================================================
  // SCROLL EVENT HANDLER
  // ==========================================================================

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const { scrollTop, scrollHeight, clientHeight } = el
    const distFromBottom = scrollHeight - scrollTop - clientHeight

    // Update refs (NO React state updates here except FAB)
    lastScrollDataRef.current = { top: scrollTop, height: scrollHeight, client: clientHeight }
    isAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD

    // FAB visibility (only React state in scroll handler)
    const shouldShowFab = distFromBottom > FAB_THRESHOLD
    setShowScrollToBottom(prev => prev !== shouldShowFab ? shouldShowFab : prev)

    // Save position for cross-conversation persistence (throttled)
    const now = Date.now()
    if (now - lastSaveTimeRef.current > SAVE_THROTTLE_MS) {
      lastSaveTimeRef.current = now
      scrollStateManager.saveScrollPosition(conversationId, scrollTop, scrollHeight, clientHeight)
    }

    // Track if user scrolled away from top (allows re-trigger of load)
    if (scrollTop > 50) scrolledAwayFromTopRef.current = true

    // Auto-trigger load when at top
    if (scrollTop === 0) triggerLoadOlder()
  }, [conversationId, triggerLoadOlder, isAtBottomRef])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const { scrollTop } = e.currentTarget
    if (scrollTop === 0 && e.deltaY < 0) triggerLoadOlder()
    if (scrollTop === 0 && e.deltaY > 0) scrolledAwayFromTopRef.current = true
  }, [triggerLoadOlder])

  // ==========================================================================
  // EFFECT: Conversation switch
  // ==========================================================================

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    if (prevConversationRef.current === conversationId) return

    debugLog('CONVERSATION SWITCH', {
      from: prevConversationRef.current,
      to: conversationId,
      messageCount,
    })

    // LEAVING old conversation - save position
    if (prevConversationRef.current && lastScrollDataRef.current) {
      const { top, height, client } = lastScrollDataRef.current
      scrollStateManager.leaveConversation(prevConversationRef.current, top, height, client)
    }

    // ENTERING new conversation - reset state
    hasInitializedRef.current = false
    scrolledAwayFromTopRef.current = false
    lastScrollDataRef.current = null
    prependRef.current = null
    setShowScrollToBottom(false)

    // Decide: restore position or scroll to bottom?
    const action = scrollStateManager.enterConversation(conversationId, messageCount)
    const savedPos = scrollStateManager.getSavedScrollTop(conversationId)

    debugLog('CONVERSATION ACTION', { action, savedPos, scrollHeight: scroller.scrollHeight })

    if (action === 'restore-position' && savedPos !== null) {
      scroller.scrollTop = savedPos
      isAtBottomRef.current = false
      scrollStateManager.clearSavedScrollState(conversationId)
    } else {
      scroller.scrollTop = scroller.scrollHeight
      isAtBottomRef.current = true
    }

    // Update tracking
    hasInitializedRef.current = true
    prevConversationRef.current = conversationId
    prevMessageCountRef.current = messageCount
  }, [conversationId, messageCount, isAtBottomRef])

  // ==========================================================================
  // EFFECT: Prepend complete (older messages loaded)
  // ==========================================================================
  //
  // This runs in useLayoutEffect so it happens BEFORE the browser paints.
  // We restore the user's visual position using pure math:
  //   newScrollTop = scrollHeight - clientHeight - savedDistanceFromBottom

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const saved = prependRef.current
    if (!scroller || !saved) return

    // Already restored? Skip.
    if (saved.restored) return

    // Check if messages were actually prepended:
    // 1. Message count must have increased
    // 2. First message ID must have changed (new messages at the beginning)
    const countIncreased = messageCount > saved.oldMessageCount
    const firstIdChanged = firstMessageId !== saved.oldFirstId

    if (!countIncreased || !firstIdChanged) {
      debugLog('PREPEND WAITING', {
        messageCount,
        oldMessageCount: saved.oldMessageCount,
        firstMessageId,
        oldFirstId: saved.oldFirstId,
        countIncreased,
        firstIdChanged,
      })
      return
    }

    // Try element-based positioning first (more reliable)
    let newScrollTop: number | null = null

    if (saved.anchorMessageId) {
      const anchorElement = scroller.querySelector(
        `[data-message-id="${saved.anchorMessageId}"]`
      ) as HTMLElement | null

      if (anchorElement) {
        // Position the anchor element at the same offset from viewport top as before
        newScrollTop = anchorElement.offsetTop - saved.anchorOffsetFromTop

        debugLog('PREPEND RESTORE (element-based)', {
          anchorMessageId: saved.anchorMessageId,
          anchorOffsetTop: anchorElement.offsetTop,
          savedOffsetFromTop: saved.anchorOffsetFromTop,
          newScrollTop,
        })
      }
    }

    // Fallback to distance-from-bottom math if element not found
    if (newScrollTop === null) {
      newScrollTop = scroller.scrollHeight - scroller.clientHeight - saved.distanceFromBottom

      debugLog('PREPEND RESTORE (math-based fallback)', {
        newScrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        savedDistanceFromBottom: saved.distanceFromBottom,
      })
    }

    debugLog('PREPEND RESTORE FINAL', {
      newScrollTop,
      oldFirstId: saved.oldFirstId,
      newFirstId: firstMessageId,
      messageCount,
      scrollHeightBefore: scroller.scrollHeight,
      scrollTopBefore: scroller.scrollTop,
    })

    // Force reflow to ensure browser has calculated new layout
    void scroller.offsetHeight

    // Set scroll position synchronously - this happens before browser paint
    scroller.scrollTop = Math.max(0, newScrollTop)

    debugLog('PREPEND RESTORE APPLIED', {
      scrollTopAfter: scroller.scrollTop,
      scrollHeightAfter: scroller.scrollHeight,
    })

    // Mark as restored but keep the ref for a cooldown period
    // This prevents ResizeObserver from interfering
    saved.restored = true
    saved.restoredAt = Date.now()
    lastRestoreTimeRef.current = Date.now() // Track restore time to prevent rapid re-loading

    // Clear after cooldown
    setTimeout(() => {
      if (prependRef.current?.restoredAt === saved.restoredAt) {
        debugLog('PREPEND CLEAR')
        prependRef.current = null
      }
    }, PREPEND_COOLDOWN_MS)
  }, [messageCount, firstMessageId])

  // ==========================================================================
  // EFFECT: New message arrives
  // ==========================================================================

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !hasInitializedRef.current) return

    // Don't interfere with prepend (either in progress or just restored)
    if (prependRef.current) {
      debugLog('NEW MSG SKIP (prepend active)', { messageCount, prevCount: prevMessageCountRef.current })
      prevMessageCountRef.current = messageCount
      return
    }

    const isNewMessage = messageCount > prevMessageCountRef.current
    if (isNewMessage && isAtBottomRef.current) {
      debugLog('NEW MSG SCROLL TO BOTTOM', { messageCount, isAtBottom: isAtBottomRef.current })
      scroller.scrollTop = scroller.scrollHeight
    }

    prevMessageCountRef.current = messageCount
  }, [messageCount, isAtBottomRef])

  // ==========================================================================
  // EFFECT: Typing indicator / reactions change
  // ==========================================================================

  useEffect(() => {
    if (isAtBottomRef.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
    }
  }, [typingUsersCount, isAtBottomRef])

  useEffect(() => {
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => {
        if (scrollerRef.current) {
          scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
        }
      })
    }
  }, [lastMessageReactionsKey, isAtBottomRef])

  // ==========================================================================
  // EFFECT: Container resize (composer grows/shrinks)
  // NOTE: This effect MUST come before content resize so tests can find it at instances[0]
  // ==========================================================================

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    let lastHeight: number | null = null

    const observer = new ResizeObserver((entries) => {
      const newHeight = entries[0].contentRect.height
      if (lastHeight === null) { lastHeight = newHeight; return }

      const shrunk = lastHeight - newHeight
      if (shrunk > 0 && scrollerRef.current) {
        const wasNear = getDistanceFromBottom(scrollerRef.current) <= shrunk + AT_BOTTOM_THRESHOLD
        if (wasNear) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
      }

      lastHeight = newHeight
    })

    observer.observe(scroller)
    return () => observer.disconnect()
  }, [conversationId])

  // ==========================================================================
  // EFFECT: Content resize (images loading, etc.)
  // ==========================================================================

  useEffect(() => {
    const content = contentRef.current
    const scroller = scrollerRef.current
    if (!content || !scroller) return

    let lastHeight = scroller.scrollHeight

    const observer = new ResizeObserver(() => {
      const newHeight = scroller.scrollHeight

      // Skip during prepend (in progress or just restored)
      if (prependRef.current) {
        debugLog('RESIZE SKIP (prepend)', {
          newHeight,
          lastHeight,
          restored: prependRef.current.restored,
        })
        lastHeight = newHeight
        return
      }

      // Content grew and we were at bottom -> stay at bottom
      if (newHeight > lastHeight && isAtBottomRef.current) {
        debugLog('RESIZE SCROLL TO BOTTOM', {
          newHeight,
          lastHeight,
          isAtBottom: isAtBottomRef.current,
        })
        scroller.scrollTop = newHeight
      }

      lastHeight = newHeight
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [conversationId, isAtBottomRef])

  // ==========================================================================
  // EFFECT: Keyboard shortcuts
  // ==========================================================================

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

      const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey

      if (e.key === 'End' || (mod && e.key === 'ArrowDown')) {
        e.preventDefault()
        scrollToBottom()
      }
      if (e.key === 'Home' || (mod && e.key === 'ArrowUp')) {
        e.preventDefault()
        scrollToTop()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [scrollToBottom, scrollToTop])

  // ==========================================================================
  // RETURN
  // ==========================================================================

  return {
    setScrollContainerRef,
    contentWrapperRef: contentRef,
    handleScroll,
    handleWheel,
    handleLoadEarlier,
    scrollToBottom,
    scrollToTop,
    showScrollToBottom,
  }
}
