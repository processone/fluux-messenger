/**
 * useViewportObserver — Tracks the bottom-most visible ROW in the viewport.
 *
 * Uses IntersectionObserver on the scroll container to detect which messages
 * are visible, then reports the bottom-most one via the `onMessageSeen` callback.
 *
 * What it reports is the ROW HANDLE (`data-message-row-id`), not the client id:
 * a reused MUC nick can put two rows under one client id, and the read pointer
 * that this feeds must land on the row the reader actually reached.
 *
 * Design decisions:
 * - Observes all `[data-message-id]` elements inside the scroll container
 * - Tracks the bottom-most visible message (closest to the scroll bottom)
 * - Throttles callbacks to avoid excessive store updates
 * - Re-observes when messages change (new messages added, conversation switch)
 * - Refreshes intersections on focus recovery so hidden reports can be retried
 * - Cleanup on unmount or conversation switch
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

/** Minimum interval (ms) between onMessageSeen calls. */
export const THROTTLE_MS = 300

/** Shared cover rule for the observer's recovery and the publication boundary. */
export function isViewportCovered(element: HTMLElement): boolean {
  return !!document.querySelector('[data-modal="true"], [aria-modal="true"]')
    || !!element.closest('[inert], [aria-hidden="true"]')
}

interface UseViewportObserverOptions {
  /** Ref to the scroll container element */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Unique identifier for the conversation/room (resets observer on change) */
  conversationId: string
  /** Callback when the bottom-most visible row changes; receives the row handle. */
  onMessageSeen?: (rowId: string) => void
  /** Independent focused-view evidence; never flushed during conversation teardown. */
  onVisibleRows?: (rowIds: readonly string[]) => void
  /** Whether the observer is active (e.g., skip while loading) */
  enabled?: boolean
}

export function useViewportObserver({
  scrollContainerRef,
  conversationId,
  onMessageSeen,
  onVisibleRows,
  enabled = true,
}: UseViewportObserverOptions) {
  const lastReportedRef = useRef<string | null>(null)
  const lastReportedTimeRef = useRef(0)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingMessageIdRef = useRef<string | null>(null)
  const afterReadRef = useRef<(() => void) | null>(null)
  const watchesViews = !!onVisibleRows

  // Stable callback ref to avoid re-creating the observer when onMessageSeen changes
  const onMessageSeenRef = useRef(onMessageSeen)
  onMessageSeenRef.current = onMessageSeen
  const onVisibleRowsRef = useRef(onVisibleRows)
  useLayoutEffect(() => { onVisibleRowsRef.current = onVisibleRows }, [onVisibleRows])

  const resetReporting = useCallback(() => {
    lastReportedRef.current = null
    lastReportedTimeRef.current = 0
    pendingMessageIdRef.current = null
    afterReadRef.current = null
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = null
    }
  }, [])

  // Wrapped in useCallback so it can be listed in useEffect deps.
  // Only reads refs — no state dependencies, so the empty dep array is correct.
  const reportMessageSeen = useCallback((rowId: string) => {
    if (!onMessageSeenRef.current) return
    if (rowId === lastReportedRef.current) return

    const now = Date.now()
    const elapsed = now - lastReportedTimeRef.current

    if (elapsed >= THROTTLE_MS) {
      // Enough time has passed, report immediately
      lastReportedRef.current = rowId
      lastReportedTimeRef.current = now
      onMessageSeenRef.current(rowId)
    } else {
      // Throttle: schedule the report
      pendingMessageIdRef.current = rowId
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null
          const pending = pendingMessageIdRef.current
          pendingMessageIdRef.current = null
          if (pending && pending !== lastReportedRef.current) {
            lastReportedRef.current = pending
            lastReportedTimeRef.current = Date.now()
            onMessageSeenRef.current?.(pending)
          }
          const afterRead = afterReadRef.current
          afterReadRef.current = null
          afterRead?.()
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
    // conversation, causing readPointerId to never advance and the
    // "new messages" marker to lag behind by one or two activations.
    const callbackForFlush = onMessageSeenRef.current

    return () => {
      // Flush pending report using the callback captured at setup time,
      // ensuring readPointerId is updated for the CORRECT conversation
      // before onDeactivate() clears the marker.
      if (pendingMessageIdRef.current && pendingMessageIdRef.current !== lastReportedRef.current) {
        callbackForFlush?.(pendingMessageIdRef.current)
      }
      // Reset tracking state on conversation switch
      resetReporting()
    }
  }, [conversationId, resetReporting])

  useEffect(() => {
    if (!enabled || (!onMessageSeenRef.current && !onVisibleRowsRef.current)) return

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
        // The observed set includes the row wrapper and the bubble nested inside it,
        // which carries only `data-message-id`. Resolving the enclosing row's handle
        // means either element reports the same, occupant-qualified row.
        const element = entry.target as HTMLElement
        const rowId =
          element.closest<HTMLElement>('[data-message-row-id]')?.dataset.messageRowId ??
          element.dataset.messageId
        if (!rowId) continue

        const rect = entry.target.getBoundingClientRect()
        if (rect.bottom > bottomMostBottom) {
          bottomMostBottom = rect.bottom
          bottomMostId = rowId
        }
      }
      return bottomMostId
    }

    // Track all currently visible entries
    const visibleEntries = new Map<Element, IntersectionObserverEntry>()

    let viewingTimer: ReturnType<typeof setTimeout> | undefined
    const measureVisibleRows = () => {
      // Re-measure at delivery, including after a deferred read write. Map
      // insertion order is not screen order when scrolling up through rows.
      const viewport = scrollContainer.getBoundingClientRect()
      const rows = new Map<string, number>()
      for (const entry of visibleEntries.values()) {
        const element = (entry.target as HTMLElement).closest<HTMLElement>('[data-message-row-id]')
        const rowId = element?.dataset.messageRowId
        if (!rowId || !element?.isConnected || rows.has(rowId)) continue
        const rect = element.getBoundingClientRect()
        const overlap = Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top)
        if (rect.height > 0 && viewport.height > 0 && overlap >= Math.min(rect.height, viewport.height) / 2) rows.set(rowId, rect.bottom)
      }
      const bottom = findBottomMostVisible([...visibleEntries.values()])
      if (bottom) reportMessageSeen(bottom)
      if (pendingMessageIdRef.current && pendingMessageIdRef.current !== lastReportedRef.current) {
        afterReadRef.current = measureVisibleRows
        return
      }
      onVisibleRowsRef.current?.([...rows].sort((a, b) => a[1] - b[1]).map(([id]) => id))
    }
    const reportVisibleRows = () => {
      if (!onVisibleRowsRef.current || viewingTimer !== undefined) return
      viewingTimer = setTimeout(() => { viewingTimer = undefined; measureVisibleRows() }, THROTTLE_MS)
    }

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

        reportVisibleRows()
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

    // Track which rows the message list mounts/unmounts. With virtualization, only the
    // visible window + overscan is mounted: rows scroll in (added) and out (removed) as
    // the user scrolls, so the observer must follow the window, not assume rows persist.
    let covered = isViewportCovered(scrollContainer)
    const mutationObserver = new MutationObserver((mutations) => {
      const wasCovered = covered
      covered = isViewportCovered(scrollContainer)
      if (wasCovered && !covered) reportVisibleRows()
      for (const mutation of mutations) {
        if (mutation.target !== scrollContainer && !scrollContainer.contains(mutation.target)) continue
        // Newly mounted rows start being observed; the IO fires automatically for any
        // that are already visible (e.g. when the user is pinned to the bottom).
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.dataset.messageId) observer.observe(node)
            node.querySelectorAll('[data-message-id]').forEach((el) => observer.observe(el))
          }
        }
        // Unmounted rows stop being observed and are pruned from the visible set. Without
        // this the IO's observed set and visibleEntries grow unbounded as a large room is
        // scrolled, and a detached row could linger as a stale "bottom-most visible"
        // candidate (its mocked/last rect still comparing > 0).
        for (const node of mutation.removedNodes) {
          if (node instanceof HTMLElement) {
            if (node.dataset.messageId) {
              observer.unobserve(node)
              visibleEntries.delete(node)
            }
            node.querySelectorAll('[data-message-id]').forEach((el) => {
              observer.unobserve(el)
              visibleEntries.delete(el)
            })
          }
        }
      }
    })

    mutationObserver.observe(scrollContainer, {
      childList: true,
      subtree: true,
    })
    if (watchesViews) mutationObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-modal', 'aria-modal', 'inert', 'aria-hidden'],
    })

    // Re-evaluate bottom-most visible message on scroll.
    // After height changes cause a scroll correction, the IO may not fire for
    // all entries. This listener uses live rects to ensure the read marker
    // advances after scroll-to-bottom corrections.
    const handleScroll = () => {
      if (visibleEntries.size === 0) return
      reportVisibleRows()
      const allVisible = Array.from(visibleEntries.values())
      const bottomMostId = findBottomMostVisible(allVisible)
      if (bottomMostId) {
        reportMessageSeen(bottomMostId)
      }
    }

    // FLM-250: a row reported while unfocused is correctly ignored by the SDK.
    // It can remain visible across focus recovery without another IO transition.
    // Forget that report and ask IO for CURRENT intersections, rather than replay
    // a cached row (the reader may have scrolled while the window was hidden).
    // The SDK still owns focus, live-window and current bottom-evidence guards.
    const handleFocus = () => {
      if (!document.hasFocus()) return
      resetReporting()
      visibleEntries.clear()
      observer.takeRecords()
      observer.disconnect()
      scrollContainer.querySelectorAll('[data-message-id]').forEach(el => observer.observe(el))
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleFocus)
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleFocus)
      observer.disconnect()
      if (viewingTimer !== undefined) clearTimeout(viewingTimer)
      mutationObserver.disconnect()
      scrollContainer.removeEventListener('scroll', handleScroll)
      visibleEntries.clear()
      resetReporting()
    }
  }, [conversationId, enabled, watchesViews, scrollContainerRef, reportMessageSeen, resetReporting])
}
