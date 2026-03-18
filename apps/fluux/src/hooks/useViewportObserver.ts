/**
 * useViewportObserver — Tracks the bottom-most visible message in the viewport.
 *
 * Uses IntersectionObserver on the scroll container to detect which messages
 * are visible, then reports the bottom-most one via the `onMessageSeen` callback.
 *
 * Design decisions:
 * - Observes all `[data-message-id]` elements inside the scroll container
 * - Tracks the bottom-most visible message (closest to the scroll bottom)
 * - Throttles callbacks to avoid excessive store updates
 * - Re-observes when messages change (new messages added, conversation switch)
 * - Cleanup on unmount or conversation switch
 */
import { useCallback, useEffect, useRef } from 'react'

/** Minimum interval (ms) between onMessageSeen calls. */
const THROTTLE_MS = 300

interface UseViewportObserverOptions {
  /** Ref to the scroll container element */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Unique identifier for the conversation/room (resets observer on change) */
  conversationId: string
  /** Callback when the bottom-most visible message changes */
  onMessageSeen?: (messageId: string) => void
  /** Whether the observer is active (e.g., skip while loading) */
  enabled?: boolean
}

export function useViewportObserver({
  scrollContainerRef,
  conversationId,
  onMessageSeen,
  enabled = true,
}: UseViewportObserverOptions) {
  const lastReportedRef = useRef<string | null>(null)
  const lastReportedTimeRef = useRef(0)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingMessageIdRef = useRef<string | null>(null)

  // Stable callback ref to avoid re-creating the observer when onMessageSeen changes
  const onMessageSeenRef = useRef(onMessageSeen)
  onMessageSeenRef.current = onMessageSeen

  // Wrapped in useCallback so it can be listed in useEffect deps.
  // Only reads refs — no state dependencies, so the empty dep array is correct.
  const reportMessageSeen = useCallback((messageId: string) => {
    if (!onMessageSeenRef.current) return
    if (messageId === lastReportedRef.current) return

    const now = Date.now()
    const elapsed = now - lastReportedTimeRef.current

    if (elapsed >= THROTTLE_MS) {
      // Enough time has passed, report immediately
      lastReportedRef.current = messageId
      lastReportedTimeRef.current = now
      onMessageSeenRef.current(messageId)
    } else {
      // Throttle: schedule the report
      pendingMessageIdRef.current = messageId
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null
          if (pendingMessageIdRef.current && pendingMessageIdRef.current !== lastReportedRef.current) {
            lastReportedRef.current = pendingMessageIdRef.current
            lastReportedTimeRef.current = Date.now()
            onMessageSeenRef.current?.(pendingMessageIdRef.current)
          }
          pendingMessageIdRef.current = null
        }, THROTTLE_MS - elapsed)
      }
    }
  }, [])

  useEffect(() => {
    // Capture the callback at setup time.  When this effect is cleaned up
    // (conversationId changes or unmount), the captured callback still
    // targets the CORRECT conversation — even though onMessageSeenRef.current
    // may already point at the new conversation's callback (updated during
    // render).  Without this, the pending flush would go to the wrong
    // conversation, causing lastSeenMessageId to never advance and the
    // "new messages" marker to lag behind by one or two activations.
    const callbackForFlush = onMessageSeenRef.current

    return () => {
      // Flush pending report using the callback captured at setup time,
      // ensuring lastSeenMessageId is updated for the CORRECT conversation
      // before onDeactivate() clears the marker.
      if (pendingMessageIdRef.current && pendingMessageIdRef.current !== lastReportedRef.current) {
        callbackForFlush?.(pendingMessageIdRef.current)
      }
      // Reset tracking state on conversation switch
      lastReportedRef.current = null
      lastReportedTimeRef.current = 0
      pendingMessageIdRef.current = null
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current)
        throttleTimerRef.current = null
      }
    }
  }, [conversationId])

  useEffect(() => {
    if (!enabled || !onMessageSeenRef.current) return

    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    // Find the bottom-most visible message from a set of intersection entries.
    // Uses live getBoundingClientRect() instead of stale IO snapshots, because
    // entries that didn't fire in the current IO callback round have outdated
    // boundingClientRect values.
    const findBottomMostVisible = (entries: IntersectionObserverEntry[]): string | null => {
      let bottomMostId: string | null = null
      let bottomMostBottom = -Infinity

      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const messageId = (entry.target as HTMLElement).dataset.messageId
        if (!messageId) continue

        const rect = entry.target.getBoundingClientRect()
        if (rect.bottom > bottomMostBottom) {
          bottomMostBottom = rect.bottom
          bottomMostId = messageId
        }
      }
      return bottomMostId
    }

    // Track all currently visible entries
    const visibleEntries = new Map<Element, IntersectionObserverEntry>()

    const observer = new IntersectionObserver(
      (entries) => {
        // Update the visible entries map
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleEntries.set(entry.target, entry)
          } else {
            visibleEntries.delete(entry.target)
          }
        }

        // Find bottom-most from ALL currently visible entries
        const allVisible = Array.from(visibleEntries.values())
        const bottomMostId = findBottomMostVisible(allVisible)
        if (bottomMostId) {
          reportMessageSeen(bottomMostId)
        }
      },
      {
        root: scrollContainer,
        // A message is "seen" when at least 50% of it is visible
        threshold: 0.5,
      }
    )

    // Observe all message elements
    const messageElements = scrollContainer.querySelectorAll('[data-message-id]')
    messageElements.forEach((el) => observer.observe(el))

    // Re-observe when new messages are added (MutationObserver)
    const mutationObserver = new MutationObserver((mutations) => {
      let changed = false
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Check if the node itself has data-message-id
            if (node.dataset.messageId) {
              observer.observe(node)
              changed = true
            }
            // Check children for message elements
            const children = node.querySelectorAll('[data-message-id]')
            children.forEach((el) => {
              observer.observe(el)
              changed = true
            })
          }
        }
      }
      // If new messages were added and user is at bottom, the IO callback
      // will fire automatically for newly visible elements
      if (changed) {
        // No additional action needed — IntersectionObserver handles it
      }
    })

    mutationObserver.observe(scrollContainer, {
      childList: true,
      subtree: true,
    })

    // Re-evaluate bottom-most visible message on scroll.
    // After height changes cause a scroll correction, the IO may not fire for
    // all entries. This listener uses live rects to ensure the read marker
    // advances after scroll-to-bottom corrections.
    const handleScroll = () => {
      if (visibleEntries.size === 0) return
      const allVisible = Array.from(visibleEntries.values())
      const bottomMostId = findBottomMostVisible(allVisible)
      if (bottomMostId) {
        reportMessageSeen(bottomMostId)
      }
    }

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      observer.disconnect()
      mutationObserver.disconnect()
      scrollContainer.removeEventListener('scroll', handleScroll)
      visibleEntries.clear()
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current)
        throttleTimerRef.current = null
      }
    }
  }, [conversationId, enabled, scrollContainerRef, reportMessageSeen])
}
