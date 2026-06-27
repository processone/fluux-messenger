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

import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { scrollStateManager, type ScrollAnchor } from '@/utils/scrollStateManager'
import { createResizeLoopMonitor } from './resizeLoopMonitor'
import { createSlowCorrectionMonitor } from './slowCorrectionMonitor'
import type { MessageVirtualizer } from './messageVirtualizer'
import { notifyUserInput } from '@/utils/renderLoopDetector'

// ============================================================================
// DEBUG
// ============================================================================

const DEBUG = false

function debugLog(action: string, data?: Record<string, unknown>) {
  if (DEBUG) {
    console.warn(`[Scroll] ${action}`, data ?? '')
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Pixels from the bottom still considered "at bottom" (auto-follow new messages). Generous
// on purpose: a tall last message can measure taller than the estimate and leave the view a
// little short of the real bottom; too tight a threshold would flip "at bottom" false and stop
// following. Still well under FAB_THRESHOLD so the scroll-to-bottom button only shows when the
// user has genuinely scrolled up.
const AT_BOTTOM_THRESHOLD = 150
const FAB_THRESHOLD = 300 // pixels from bottom to show "scroll to bottom" button
const LOAD_COOLDOWN_MS = 500 // minimum time between load triggers
const SAVE_THROTTLE_MS = 100 // minimum time between position saves
const PREPEND_COOLDOWN_MS = 500 // time to keep prepend flag after restore (prevents re-trigger)
const MEDIA_LOAD_DEBOUNCE_MS = 150 // debounce time for batching image load events
// Frames to keep re-pinning a virtualized list to the bottom after a scroll-to-bottom. Rows
// start at the fixed estimateSize and re-measure asynchronously over several frames (taller →
// scrollHeight grows and clips the last message; shorter → it floats above empty space), so a
// one-shot scrollToIndex isn't enough. ~1s at 60fps comfortably covers the measurement settle.
const BOTTOM_REASSERT_FRAMES = 60
// Frames to keep re-resolving the unread-marker offset after a conversation switch. On entry the
// conversation's messages were evicted on leave and rehydrate from cache asynchronously, then the
// rows measure over several frames, so the marker offset is unresolved at first and sharpens as it
// settles. ~2s comfortably covers a cache page load + measurement; the loop stops early once the
// target is stable, and bails immediately on a user scroll or a conversation switch.
const MARKER_REASSERT_FRAMES = 120
// Consecutive frames the marker target must hold steady before the re-assert loop stops early.
const MARKER_STABLE_FRAMES = 8

// ============================================================================
// KINETIC SCROLL
// ============================================================================

/**
 * Cancel an in-flight or boundary-parked kinetic (momentum) scroll on `el`.
 *
 * Toggling overflow to hidden and forcing a reflow cancels WebKit's momentum animation; the
 * caller restores the scroll position immediately after. Used by the MAM-prepend restore so a
 * fast scroll-up fling's residual velocity can't resume into the freshly prepended content and
 * overshoot the anchor (blank window / jump to bottom on Tauri WebKitGTK). `overflowY = ''`
 * yields the property back to the element's CSS class (overflow-y-auto). No-op for programmatic
 * scrolls, which carry no momentum — so it cannot be exercised by the Playwright/preview harness.
 */
export function cancelKineticScroll(el: HTMLElement): void {
  el.style.overflowY = 'hidden'
  void el.offsetHeight // force reflow so the overflow change (and momentum cancel) takes effect
  el.style.overflowY = ''
}

// ============================================================================
// ANCHOR HELPERS (content-stable scroll restoration)
// ============================================================================

/**
 * Find the bottom-most visible message row and the gap between its bottom edge
 * and the viewport bottom. This anchor survives a change in the loaded message
 * set (memory eviction + cache re-hydration), unlike a raw scrollTop.
 */
function findBottomAnchor(scroller: HTMLElement): ScrollAnchor | null {
  const rows = scroller.querySelectorAll('.message-row[data-message-id]')
  if (rows.length === 0) return null
  const viewportBottom = scroller.scrollTop + scroller.clientHeight
  // Binary search (rows are in ascending offsetTop order) for the bottom-most row
  // whose top is above the viewport bottom — the last visible row. O(log n), so
  // it's cheap to run on every scroll event (keeps the anchor at the latest pos).
  let lo = 0
  let hi = rows.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((rows[mid] as HTMLElement).offsetTop < viewportBottom) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const el = rows[found] as HTMLElement
  const messageId = el.dataset.messageId
  if (!messageId) return null
  return { messageId, bottomGap: viewportBottom - (el.offsetTop + el.offsetHeight) }
}

/**
 * Restore scroll so the anchor message's bottom sits at its saved offset from the
 * viewport bottom. Returns false if the anchor message isn't currently loaded
 * (scrolled up beyond the re-hydrated window) so the caller can fall back.
 */
function restoreToAnchor(scroller: HTMLElement, anchor: ScrollAnchor): boolean {
  const el = scroller.querySelector(
    `.message-row[data-message-id="${CSS.escape(anchor.messageId)}"]`
  ) as HTMLElement | null
  if (!el) return false
  scroller.scrollTop = el.offsetTop + el.offsetHeight + anchor.bottomGap - scroller.clientHeight
  return true
}


// ============================================================================
// TYPES
// ============================================================================

export interface UseMessageListScrollOptions {
  conversationId: string
  messageCount: number
  firstMessageId: string | undefined
  firstNewMessageId?: string  // ID of the first unread message (for new message marker)
  targetMessageId?: string | null  // ID of a message to scroll to (e.g., from activity log click)
  onTargetMessageConsumed?: () => void  // Called after scrolling to target message
  externalScrollerRef?: React.RefObject<HTMLElement | null>
  externalIsAtBottomRef?: React.MutableRefObject<boolean>
  clearFirstNewMessageId?: () => void  // Called when user scrolls past the new message marker
  onScrollToTop?: () => void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
  typingUsersCount: number
  lastMessageReactionsKey: string
  /** Whether the newest message is the local user's own (outgoing). When a NEW such message
   *  appears we scroll to the bottom regardless of position — you always want to see what you
   *  just sent — whereas an incoming message only auto-follows when already near the bottom. */
  lastMessageIsOutgoing?: boolean
  /** When true, disables all auto-scroll behaviors (conversation switch scroll,
   *  ResizeObserver auto-scroll, new message scroll-to-bottom, target message scroll).
   *  Used by read-only preview views (search context, activity context) that manage
   *  their own scroll positioning. */
  staticMode?: boolean
  /** When present (virtualization flag ON), scroll math uses this interface instead
   *  of reading the DOM directly — so it works for unmounted rows. Absent → unchanged
   *  DOM-based behavior. Wired in Task 7. */
  virtualizer?: MessageVirtualizer
}

export interface UseMessageListScrollResult {
  setScrollContainerRef: (element: HTMLDivElement | null) => void
  contentWrapperRef: React.RefCallback<HTMLDivElement>
  handleScroll: (e: React.UIEvent<HTMLDivElement>) => void
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  handleLoadEarlier: () => void
  handleMediaLoad: () => void
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
  firstNewMessageId,
  clearFirstNewMessageId,
  targetMessageId,
  onTargetMessageConsumed,
  externalScrollerRef,
  externalIsAtBottomRef,
  onScrollToTop,
  isLoadingOlder,
  isHistoryComplete,
  typingUsersCount,
  lastMessageReactionsKey,
  lastMessageIsOutgoing = false,
  staticMode = false,
  virtualizer,
}: UseMessageListScrollOptions): UseMessageListScrollResult {

  // ==========================================================================
  // REFS - All scroll state lives here, NOT in React state
  // ==========================================================================

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const contentObserverRef = useRef<ResizeObserver | null>(null)
  // Pending rAF id for the coalesced scroll correction (content ResizeObserver).
  const correctionRafRef = useRef<number | null>(null)
  // Diagnostic-only monitor for runaway ResizeObserver fire rates (WebKitGTK).
  const resizeMonitorRef = useRef<ReturnType<typeof createResizeLoopMonitor> | null>(null)
  // Diagnostic-only monitor for SLOW corrections (reflow cost, not fire rate).
  const slowCorrectionMonitorRef = useRef<ReturnType<typeof createSlowCorrectionMonitor> | null>(null)

  // Track scroll position - always create internal ref to follow rules of hooks
  const internalIsAtBottomRef = useRef(true)
  const isAtBottomRef = externalIsAtBottomRef || internalIsAtBottomRef

  // Virtualizer ref updated synchronously in the render body (before any effects).
  // This ensures useLayoutEffect sees the CURRENT render's virtualizer (with updated
  // indexById after prepend), not the stale one from latestRef (which is updated in
  // useEffect = after paint, too late for the prepend restore useLayoutEffect).
  const virtualizerRef = useRef<MessageVirtualizer | undefined>(undefined)
  virtualizerRef.current = virtualizer

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
  // Timestamp of the last DELIBERATE user scroll (FAB click / wheel). The prepend re-assert
  // loop yields to a deliberate scroll recorded after it starts, but keeps re-pinning the
  // anchor through a content-shrink clamp (which records no such intent).
  const userScrollIntentAtRef = useRef(0)

  // Media load batching (for images, videos, link previews)
  // When multiple media elements load in quick succession, we batch them and apply
  // a single scroll correction at the end to avoid jitter.
  const mediaLoadSnapshotRef = useRef<{ wasAtBottom: boolean; userScrolled: boolean } | null>(null)
  const mediaLoadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Last scroll data (for saving on conversation switch)
  const lastScrollDataRef = useRef<{ top: number; height: number; client: number } | null>(null)
  // Bottom-most-visible message anchor, captured (throttled) during scroll so it
  // survives the conversation switch (at switch time the DOM is already the new
  // conversation). Used for content-stable position restoration on return.
  const lastAnchorRef = useRef<ScrollAnchor | null>(null)

  // Track whether user has scrolled at least once since the marker was set.
  // Prevents the marker from being cleared immediately on initial load/scroll-to-marker.
  const userHasScrolledSinceMarkerRef = useRef(false)

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
  // CALLBACK REFS: scroll container + content wrapper
  // ==========================================================================
  //
  // Using a callback ref for the content wrapper ensures the ResizeObserver is
  // connected as soon as the wrapper mounts, even if it mounts after initial
  // render (e.g., MUC rooms that show a loading state before revealing
  // messages).
  //
  // Two constraints shape the implementation:
  //
  // 1. ATTACH ORDER: React attaches refs child-first within a commit. When the
  //    list mounts WITH messages already present, the content-wrapper ref runs
  //    before the scroller ref is set. Observer setup is therefore late-bound:
  //    both setters call trySetupContentObserver(), and whichever attaches
  //    last completes the setup.
  //
  // 2. IDENTITY STABILITY: both setters are created once (lazy useRef), NOT
  //    re-created per render. An unstable callback ref makes React detach
  //    (null) + reattach it on EVERY render, tearing down and recreating the
  //    observer each time — a forced-reflow amplifier in busy rooms. Per-render
  //    values they need are read through latestRef (updated each render via
  //    effect), never closed over.

  const latestRef = useRef({ staticMode, externalScrollerRef, isAtBottomRef, conversationId, virtualizer })
  useEffect(() => {
    latestRef.current = { staticMode, externalScrollerRef, isAtBottomRef, conversationId, virtualizer }
  })

  const stableSettersRef = useRef<{
    setScrollContainerRef: (el: HTMLDivElement | null) => void
    setContentRef: (el: HTMLDivElement | null) => void
  } | null>(null)

  if (stableSettersRef.current === null) {
    const teardownContentObserver = () => {
      if (contentObserverRef.current) {
        contentObserverRef.current.disconnect()
        contentObserverRef.current = null
      }
      if (correctionRafRef.current !== null) {
        cancelAnimationFrame(correctionRafRef.current)
        correctionRafRef.current = null
      }
    }

    const trySetupContentObserver = () => {
      const scroller = scrollerRef.current
      const element = contentRef.current
      if (!scroller || !element || contentObserverRef.current) return

      const { staticMode, isAtBottomRef } = latestRef.current

      // On mount: if we should be at bottom, scroll there immediately
      if (isAtBottomRef.current && !staticMode) {
        void scroller.offsetHeight // Force reflow
        scroller.scrollTop = scroller.scrollHeight
        requestAnimationFrame(() => {
          if (scrollerRef.current) {
            scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
          }
        })
      }

      // Set up content ResizeObserver
      let lastHeight = scroller.scrollHeight

      // The actual measure + scroll-correction. Run at most once per frame via
      // the rAF-coalescing in the observer callback below.
      const runCorrection = () => {
        correctionRafRef.current = null
        const currentScroller = scrollerRef.current
        if (!currentScroller) return

        // Time the whole correction (including the skip paths — the
        // scrollHeight read below is the reflow that costs, whatever branch
        // follows). The frequency monitor in the observer callback cannot see
        // this failure mode: slow corrections fire only a few times a second.
        const correctionStart = performance.now()
        try {
          runCorrectionBody(currentScroller)
        } finally {
          const correctionEnd = performance.now()
          if (!slowCorrectionMonitorRef.current) {
            slowCorrectionMonitorRef.current = createSlowCorrectionMonitor()
          }
          if (slowCorrectionMonitorRef.current.record(correctionEnd - correctionStart, correctionEnd)) {
            // Context reads are warn-path only (rate-limited): querySelectorAll
            // over the backlog is not free.
            const rows = currentScroller.querySelectorAll('.message-row').length
            console.warn(
              `[SlowScrollCorrection] scroll correction took ${Math.round(correctionEnd - correctionStart)}ms ` +
              `(rows=${rows}, scrollHeight=${currentScroller.scrollHeight}, ` +
              `conversation=${latestRef.current.conversationId}) — ` +
              `reflow cost scales with the rendered backlog.`
            )
          }
        }
      }

      const runCorrectionBody = (currentScroller: HTMLDivElement) => {
        const newHeight = currentScroller.scrollHeight

        // When virtualized, the content wrapper IS the @tanstack spacer, whose height
        // churns on every row measurement; a stick-to-bottom correction here feeds back
        // into the virtualizer and loops. Stick-to-bottom is handled by the new-message /
        // typing / reactions effects + the virtualizer instead.
        if (latestRef.current.virtualizer) {
          lastHeight = newHeight
          return
        }

        const currentScrollTop = currentScroller.scrollTop

        // Skip during prepend that's actively in progress (not yet restored)
        if (prependRef.current && !prependRef.current.restored) {
          debugLog('RESIZE SKIP (prepend in progress)', {
            newHeight,
            lastHeight,
            currentScrollTop,
          })
          lastHeight = newHeight
          return
        }

        // Skip during media load batch - let the debounced handler manage it
        if (mediaLoadSnapshotRef.current) {
          debugLog('RESIZE SKIP (media load batch in progress)', {
            newHeight,
            lastHeight,
            currentScrollTop,
          })
          lastHeight = newHeight
          return
        }

        const { staticMode, isAtBottomRef } = latestRef.current

        // Content grew and we were at bottom -> stay at bottom. Route through the shared
        // reassertBottom (the same helper the new-message / typing / composer-resize sites use)
        // so there is one place that decides how to land at the bottom. Virtualized is already
        // excluded above, so this only ever takes the raw-scrollTop branch — but keeping it
        // funnelled means a future change to the pin logic can't miss this site.
        if (newHeight > lastHeight && isAtBottomRef.current && !staticMode) {
          debugLog('RESIZE SCROLL TO BOTTOM', {
            newHeight,
            lastHeight,
            isAtBottom: isAtBottomRef.current,
            scrollTopBefore: currentScrollTop,
          })
          reassertBottom()
        } else if (newHeight !== lastHeight) {
          debugLog('RESIZE NO SCROLL', {
            newHeight,
            lastHeight,
            isAtBottom: isAtBottomRef.current,
            currentScrollTop,
          })
        }

        lastHeight = newHeight
      }

      const observer = new ResizeObserver(() => {
        // When virtualized, skip entirely: the wrapper is the @tanstack spacer whose
        // height churns on every row measurement, and correcting scroll here loops back
        // into the virtualizer (re-measure → spacer change → RO → scroll → re-render).
        if (latestRef.current.virtualizer) return
        // Diagnostic only: surface a runaway fire rate. WebKitGTK can oscillate
        // a <video controls> height continuously, firing this hundreds of times
        // a second — a pure main-thread loop the React render-loop detector
        // can't see. Log-rate-limited; never disconnects.
        if (!resizeMonitorRef.current) resizeMonitorRef.current = createResizeLoopMonitor()
        const warning = resizeMonitorRef.current.record(performance.now())
        if (warning) console.warn(warning)

        // Coalesce the measure + correction into a single rAF no matter how many
        // times the observer fires this frame. This breaks the read-scrollHeight
        // -> write-scrollTop -> reflow -> re-fire feedback and caps the expensive
        // work to once per frame.
        if (correctionRafRef.current === null) {
          correctionRafRef.current = requestAnimationFrame(runCorrection)
        }
      })

      observer.observe(element)
      contentObserverRef.current = observer
    }

    stableSettersRef.current = {
      setScrollContainerRef: (el: HTMLDivElement | null) => {
        scrollerRef.current = el
        const externalScrollerRef = latestRef.current.externalScrollerRef
        if (externalScrollerRef) {
          (externalScrollerRef as React.MutableRefObject<HTMLElement | null>).current = el
        }
        if (el) trySetupContentObserver()
      },
      setContentRef: (element: HTMLDivElement | null) => {
        if (element === contentRef.current) return
        teardownContentObserver()
        contentRef.current = element
        if (element) trySetupContentObserver()
      },
    }
  }

  const { setScrollContainerRef, setContentRef } = stableSettersRef.current

  // ==========================================================================
  // SCROLL ACTIONS
  // ==========================================================================

  const scrollToBottom = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    // FAB / scroll-to-bottom is a deliberate user action — record it so the prepend re-assert
    // loop yields instead of fighting it back to the anchor (it can fire while the loop runs:
    // entering at the top triggers a load-older, then the user clicks the FAB).
    userScrollIntentAtRef.current = Date.now()

    // Two-step behavior: scroll to the new message marker only when it exists AND
    // is still further down than the current viewport (not yet visible). Otherwise —
    // including when the marker is already on screen or scrolled above — go straight
    // to the bottom. This is a live position check rather than a one-shot latch, so a
    // single click always makes progress toward the bottom: no wasted click when the
    // user is already sitting at the marker (e.g. right after opening a conversation,
    // where the init effect auto-scrolls to the marker).
    if (firstNewMessageId) {
      // When virtualized, ensure the marker row is mounted (best-effort; falls back to
      // scroll-to-bottom below if it isn't mounted yet on this single-shot click).
      void latestRef.current.virtualizer?.ensureMessageMounted(firstNewMessageId)
      const escapedId = CSS.escape(firstNewMessageId)
      const messageElement = scroller.querySelector(`[data-message-id="${escapedId}"]`)

      if (messageElement) {
        const elementTop = (messageElement as HTMLElement).offsetTop
        const viewportHeight = scroller.clientHeight
        const viewportBottom = scroller.scrollTop + viewportHeight

        if (elementTop > viewportBottom) {
          const targetScrollTop = Math.max(0, elementTop - viewportHeight / 3)
          scroller.scrollTo({ top: targetScrollTop, behavior: 'smooth' })
          return
        }
      }
    }

    // Virtualized path: scrollToIndex(last, 'end') lands on the exact last item using
    // measured heights, not the estimated spacer height used by scrollTo({top:scrollHeight}).
    // latestRef is current here (FAB click fires after renders + useEffect run).
    const virtFab = latestRef.current.virtualizer
    if (virtFab && virtFab.itemCount > 0) {
      virtFab.scrollToIndex(virtFab.itemCount - 1, { align: 'end' })
      return
    }

    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [firstNewMessageId])

  const scrollToTop = useCallback(() => {
    lastLoadTimeRef.current = Date.now() // prevent auto-load trigger
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // Pin a VIRTUALIZED list to the bottom and keep it pinned as rows measure.
  //
  // scrollToIndex(last, 'end') uses the virtualizer's current (estimated) layout. Rows then
  // mount and re-measure over the next several frames; scrollHeight grows (rows taller than the
  // estimate → last message clipped below the fold) or shrinks (shorter → empty space below the
  // content). The content ResizeObserver that re-pins for the non-virtualized path is disabled
  // under virtualization (its feedback loops with the @tanstack spacer churn — PR #646), so we
  // re-assert across frames here instead.
  //
  // Runs entirely in rAF (NOT useLayoutEffect) to avoid the scroll→rerender→scrollTop-override
  // oscillation. Re-pins only when scrollHeight actually changed since the previous frame, and
  // yields the moment the user takes over (deliberate scroll intent, or simply scrolling away
  // from the bottom). No-op for the non-virtualized path — callers keep their direct scrollTop.
  const pinVirtualizedBottom = useCallback(() => {
    const virt = virtualizerRef.current
    const scroller = scrollerRef.current
    if (!virt || !scroller || virt.itemCount === 0) return

    // Immediate pin (pre-paint when called from a layout effect).
    virt.scrollToIndex(virt.itemCount - 1, { align: 'end' })

    const startedAt = Date.now()
    let framesLeft = BOTTOM_REASSERT_FRAMES
    let lastHeight = scroller.scrollHeight
    const step = () => {
      if (framesLeft-- <= 0) return
      const s = scrollerRef.current
      const v = virtualizerRef.current
      if (!s || !v || v.itemCount === 0) return
      // User took over (FAB/wheel intent recorded after we started, or they scrolled away from
      // the bottom) → stop fighting them. Programmatic growth doesn't move scrollTop, so it never
      // flips isAtBottom; only a genuine user scroll up does.
      if (userScrollIntentAtRef.current > startedAt || !isAtBottomRef.current) return
      const h = s.scrollHeight
      if (h !== lastHeight) {
        lastHeight = h
        v.scrollToIndex(v.itemCount - 1, { align: 'end' })
      }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [isAtBottomRef])

  // Re-pin the list to the bottom after a layout change that grows the content or shrinks the
  // scroller while the user is following along: typing indicator, reactions on the last message,
  // or a composer banner appearing/disappearing (attachment preview, whisper marker, reply/edit
  // preview). Routes through the virtualizer when active so the mounted window re-windows before
  // paint (a raw scrollTop write leaves @tanstack's offset stale → blank/clipped); otherwise a
  // direct scrollTop write. Callers must have already confirmed the user is at/near the bottom.
  const reassertBottom = useCallback(() => {
    if (virtualizerRef.current) {
      pinVirtualizedBottom()
    } else {
      const s = scrollerRef.current
      if (s) s.scrollTop = s.scrollHeight
    }
  }, [pinVirtualizedBottom])

  // ==========================================================================
  // LOAD OLDER MESSAGES
  // ==========================================================================

  // Find the first visible message element and its offset from the viewport top
  const findAnchorElement = () => {
    const scroller = scrollerRef.current
    if (!scroller) return null

    const scrollTop = scroller.scrollTop
    const virt = virtualizerRef.current

    // Virtualized path: DOM order ≠ visual order (items are absolutely positioned and
    // the DOM retains the previous render's window until React re-renders). Instead,
    // find the topmost visible message using the virtualizer's sorted item list.
    //
    // Special case: at scrollTop=0, the anchor is always firstMessageId (the topmost
    // message in the list). This is reliable even when the old virtualizer window
    // (from the previous scrollTop) hasn't been replaced yet.
    if (virt) {
      if (scrollTop === 0 && firstMessageId) {
        const virtOffset = virt.getOffsetForMessageId(firstMessageId) ?? 0
        const result = { id: firstMessageId, offsetFromTop: virtOffset }
        debugLog('FIND ANCHOR: scrollTop=0, using firstMessageId', result)
        return result
      }

      // For non-zero scrollTop, use getVirtualItems() (current window in visual order)
      // to find the first item at or near the viewport top.
      const virtualItems = virt.getVirtualItems()
      for (const vi of virtualItems) {
        const viewportOffset = vi.start - scrollTop
        if (viewportOffset >= -vi.size / 2) {
          // Find the [data-message-id] inside this virtualizer row wrapper
          const wrapper = scroller.querySelector(`[data-index="${vi.index}"]`)
          const messageEl = wrapper?.querySelector('[data-message-id]') as HTMLElement | null
          if (!messageEl) continue  // skip non-message items (header, separator, footer)
          const result = { id: messageEl.dataset.messageId!, offsetFromTop: viewportOffset }
          debugLog('FIND ANCHOR: virtualizer item', { ...result, viIndex: vi.index, viStart: vi.start, scrollTop })
          return result
        }
      }

      // Nothing found in current window (edge case: window hasn't settled yet)
      if (firstMessageId) {
        const virtOffset = virt.getOffsetForMessageId(firstMessageId) ?? 0
        const result = { id: firstMessageId, offsetFromTop: virtOffset - scrollTop }
        debugLog('FIND ANCHOR: fallback to firstMessageId', result)
        return result
      }
      return null
    }

    // Non-virtualized path: iterate DOM elements in order (they ARE in visual order)
    const messages = scroller.querySelectorAll('[data-message-id]')

    if (messages.length === 0) {
      debugLog('FIND ANCHOR: no messages found')
      return null
    }

    const scrollerRect = scroller.getBoundingClientRect()

    for (const msg of messages) {
      const element = msg as HTMLElement
      const rect = element.getBoundingClientRect()
      const offsetFromViewportTop = rect.top - scrollerRect.top

      // First message whose top is at or below the viewport top (with half-height tolerance)
      if (offsetFromViewportTop >= -rect.height / 2) {
        const result = {
          id: element.dataset.messageId!,
          offsetFromTop: element.offsetTop - scrollTop,
        }
        debugLog('FIND ANCHOR: found', {
          id: result.id,
          offsetFromTop: result.offsetFromTop,
          offsetFromViewportTop,
          scrollTop,
          elementOffsetTop: element.offsetTop,
        })
        return result
      }
    }

    // Fallback: use the first message
    const firstMsg = messages[0] as HTMLElement
    if (firstMsg) {
      const result = {
        id: firstMsg.dataset.messageId!,
        offsetFromTop: firstMsg.offsetTop - scrollTop,
      }
      debugLog('FIND ANCHOR: using first message as fallback', {
        id: result.id,
        offsetFromTop: result.offsetFromTop,
        scrollTop,
        elementOffsetTop: firstMsg.offsetTop,
      })
      return result
    }

    debugLog('FIND ANCHOR: no anchor found')
    return null
  }

  const triggerLoadOlder = () => {
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
  }

  const handleLoadEarlier = () => {
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
  }

  // ==========================================================================
  // MEDIA LOAD HANDLER (images, videos, link previews)
  // ==========================================================================
  //
  // When media loads, it can change the content height. We use a snapshot+debounce
  // pattern to batch multiple rapid loads and apply a single scroll correction:
  //
  // 1. First load in batch: capture wasAtBottom snapshot
  // 2. Each subsequent load: reset debounce timer
  // 3. After debounce: apply correction based on snapshot
  //
  // This prevents jitter from multiple images loading in sequence.

  // Stable identity (deps are all refs/constants) so it can be passed to every
  // memoized message row without breaking their `memo` bailout. React Compiler
  // does NOT memoize this (it's returned from a hook and used only in parent
  // JSX), so the manual useCallback is required — see RENDER_PERF_TESTS.md.
  const handleMediaLoad = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    // Capture snapshot on first load in batch (user's intent at start of batch)
    if (!mediaLoadSnapshotRef.current) {
      mediaLoadSnapshotRef.current = { wasAtBottom: isAtBottomRef.current, userScrolled: false }
      debugLog('MEDIA LOAD: batch started', {
        wasAtBottom: isAtBottomRef.current,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
      })
    }

    // Clear existing timer and set new one (debounce)
    if (mediaLoadDebounceRef.current) {
      clearTimeout(mediaLoadDebounceRef.current)
    }

    mediaLoadDebounceRef.current = setTimeout(() => {
      const currentScroller = scrollerRef.current
      if (!currentScroller || !mediaLoadSnapshotRef.current) return

      const { wasAtBottom, userScrolled } = mediaLoadSnapshotRef.current

      if (wasAtBottom) {
        if (!userScrolled) {
          // User didn't scroll during the batch - scroll to bottom
          debugLog('MEDIA LOAD: batch complete, scrolling to bottom', {
            wasAtBottom,
            userScrolled,
            scrollHeight: currentScroller.scrollHeight,
          })
          currentScroller.scrollTop = currentScroller.scrollHeight
        } else {
          // User actively scrolled during the batch - respect their position
          debugLog('MEDIA LOAD: batch complete, user scrolled away', {
            wasAtBottom,
            userScrolled,
          })
        }
      } else {
        debugLog('MEDIA LOAD: batch complete, was not at bottom', {
          wasAtBottom,
        })
      }

      // Clear for next batch
      mediaLoadSnapshotRef.current = null
      mediaLoadDebounceRef.current = null
    }, MEDIA_LOAD_DEBOUNCE_MS)
  }, [isAtBottomRef])

  // ==========================================================================
  // SCROLL EVENT HANDLER
  // ==========================================================================

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // Arm the render-loop interaction grace: a fast scroll legitimately re-windows the
    // virtualized MessageList ~once per frame, which would otherwise trip the loop
    // *warning*. The rolling window expires shortly after scrolling stops, so a genuine
    // post-scroll loop is still reported; the hard throw threshold is unaffected.
    notifyUserInput()

    const el = e.currentTarget
    const { scrollTop, scrollHeight, clientHeight } = el
    const distFromBottom = scrollHeight - scrollTop - clientHeight

    // Update refs (NO React state updates here except FAB)
    lastScrollDataRef.current = { top: scrollTop, height: scrollHeight, client: clientHeight }
    // Capture the bottom-most-visible anchor on every scroll event (binary search,
    // cheap) so it reflects the latest position — at switch time the DOM is already
    // the new conversation, so this must be captured live during scroll.
    lastAnchorRef.current = findBottomAnchor(el)
    isAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD

    // Track user scroll during media load batch
    if (mediaLoadSnapshotRef.current) {
      mediaLoadSnapshotRef.current.userScrolled = true
    }

    // FAB visibility (only React state in scroll handler)
    const shouldShowFab = distFromBottom > FAB_THRESHOLD
    setShowScrollToBottom(prev => prev !== shouldShowFab ? shouldShowFab : prev)

    // Clear new message marker when user scrolls past it or reaches the bottom.
    // Skip on the very first scroll events after marker setup to avoid clearing
    // the marker before the user has a chance to see it.
    if (firstNewMessageId && clearFirstNewMessageId) {
      if (!userHasScrolledSinceMarkerRef.current) {
        // First scroll after marker was set — arm the flag for next time
        userHasScrolledSinceMarkerRef.current = true
      } else if (distFromBottom < AT_BOTTOM_THRESHOLD) {
        // User reached the bottom — all new messages are visible
        clearFirstNewMessageId()
      } else {
        const escapedId = CSS.escape(firstNewMessageId)
        const markerEl = el.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null
        if (markerEl) {
          const scrollerRect = el.getBoundingClientRect()
          const markerRect = markerEl.getBoundingClientRect()
          // Marker is "scrolled past" when its bottom edge is above the viewport
          if (markerRect.bottom < scrollerRect.top) {
            clearFirstNewMessageId()
          }
        } else {
          // Marker element not in DOM (trimmed) — clear it
          clearFirstNewMessageId()
        }
      }
    }

    // Save position for cross-conversation persistence (throttled). Capture the
    // bottom-most-visible anchor here too — throttled so the DOM query is bounded,
    // and during scroll because at switch time the DOM is already the new room.
    const now = Date.now()
    if (now - lastSaveTimeRef.current > SAVE_THROTTLE_MS) {
      lastSaveTimeRef.current = now
      scrollStateManager.saveScrollPosition(conversationId, scrollTop, scrollHeight, clientHeight, lastAnchorRef.current ?? undefined)
    }

    // Track if user scrolled away from top (allows re-trigger of load)
    if (scrollTop > 50) scrolledAwayFromTopRef.current = true

    // Auto-trigger load when at top (disabled in static mode — preview starts at scrollTop=0)
    if (scrollTop === 0 && !staticMode) triggerLoadOlder()
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // A wheel is a deliberate user scroll — record it so the prepend re-assert loop yields if
    // the user keeps scrolling after a load (rather than fighting a content-shrink clamp). The
    // wheel that triggers the load itself is recorded BEFORE the loop starts, so it won't bail.
    userScrollIntentAtRef.current = Date.now()
    const { scrollTop } = e.currentTarget
    if (scrollTop === 0 && e.deltaY < 0 && !staticMode) triggerLoadOlder()
    if (scrollTop === 0 && e.deltaY > 0) scrolledAwayFromTopRef.current = true
  }

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
      scrollStateManager.leaveConversation(prevConversationRef.current, top, height, client, lastAnchorRef.current ?? undefined)
    }

    // ENTERING new conversation - reset state
    hasInitializedRef.current = false
    userHasScrolledSinceMarkerRef.current = false
    scrolledAwayFromTopRef.current = false
    lastScrollDataRef.current = null
    lastAnchorRef.current = null
    prependRef.current = null
    setShowScrollToBottom(false)

    // Clear any pending media load batch
    if (mediaLoadDebounceRef.current) {
      clearTimeout(mediaLoadDebounceRef.current)
      mediaLoadDebounceRef.current = null
    }
    mediaLoadSnapshotRef.current = null

    // In static mode (read-only previews), skip all scroll positioning.
    // The parent component handles its own scroll-to-target.
    if (staticMode) {
      isAtBottomRef.current = false
      debugLog('CONVERSATION SWITCH: static mode, skipping scroll')
    } else {
      // Decide: restore position or scroll to bottom?
      const action = scrollStateManager.enterConversation(conversationId, messageCount)
      const savedPos = scrollStateManager.getSavedScrollTop(conversationId)

      debugLog('CONVERSATION ACTION', { action, savedPos, scrollHeight: scroller.scrollHeight })

      if (action === 'restore-position') {
        const savedAnchor = scrollStateManager.getSavedAnchor(conversationId)
        const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
        const virtRestore = virtualizerRef.current
        // Prefer the content-stable anchor (survives memory eviction + cache
        // re-hydration); fall back to the legacy pixel scrollTop (bounds-checked),
        // then to bottom when neither is usable (e.g. scrolled up beyond the
        // re-hydrated window so the anchor message isn't loaded).
        //
        // VIRTUALIZED: a direct `scroller.scrollTop = …` leaves @tanstack's scrollOffset
        // stale (it syncs only from the scroll event / rAF poll), so on a fresh switch the
        // mounted window keeps the TOP rows and the restored region renders BLANK until the
        // user scrolls. Route the restored offset through the virtualizer so it re-windows
        // before paint — the same fix as the MAM-prepend restore and scroll-to-bottom paths.
        if (savedAnchor && restoreToAnchor(scroller, savedAnchor)) {
          isAtBottomRef.current = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < AT_BOTTOM_THRESHOLD
          if (virtRestore) virtRestore.scrollToOffset(scroller.scrollTop)
          debugLog('RESTORE via anchor', { savedAnchor })
        } else if (savedPos !== null && savedPos <= maxScrollTop && maxScrollTop > 0) {
          if (virtRestore) virtRestore.scrollToOffset(savedPos)
          else scroller.scrollTop = savedPos
          isAtBottomRef.current = false
        } else {
          debugLog('RESTORE out of bounds / anchor missing, scrolling to bottom', {
            savedPos, maxScrollTop, scrollHeight: scroller.scrollHeight,
          })
          if (virtRestore) pinVirtualizedBottom()
          else scroller.scrollTop = scroller.scrollHeight
          isAtBottomRef.current = true
        }
        scrollStateManager.clearSavedScrollState(conversationId)
      } else if (firstNewMessageId) {
        // Has unread messages — position the first-unread marker ~1/3 down from the top so the
        // user reads forward from where they left off. Mark NOT at bottom up front (mirrors the
        // targetMessageId branch) so the content-growth ResizeObserver doesn't auto-pin to the
        // bottom while we're still aiming for the marker.
        debugLog('CONVERSATION SWITCH: has unread, will scroll to marker', { firstNewMessageId })
        isAtBottomRef.current = false

        const markerId = firstNewMessageId
        const markerConvId = conversationId
        // When virtualized, bring the (possibly unmounted) marker row into the window so the
        // non-virtualized fallback path can find it too; the virtualized path below does not need
        // it (getOffsetForMessageId resolves unmounted rows).
        void latestRef.current.virtualizer?.ensureMessageMounted(markerId)

        // Re-assert the marker position across frames. On entry the conversation's messages were
        // evicted on leave and rehydrate from cache ASYNCHRONOUSLY, and rows then measure over
        // several frames, so the marker offset is unresolved at first and sharpens as it settles.
        // The old code read the position from `querySelector(marker).offsetTop` — null for a row
        // windowed OUT and 0 with no layout — and used a raw `scrollTop = scrollHeight` fallback
        // that the virtualizer reverts to offset 0, parking the view at the TOP with the marker
        // stranded below the fold. Resolving via getOffsetForMessageId (works for unmounted rows)
        // and re-applying each frame lands at the marker once the region mounts. Mirrors
        // pinVirtualizedBottom's re-assert loop; bails on user scroll or a conversation switch.
        const startedAt = Date.now()
        let framesLeft = MARKER_REASSERT_FRAMES
        let stableFrames = 0
        let landedTarget = -1
        const stepToMarker = () => {
          if (framesLeft-- <= 0) {
            // Marker never resolved (e.g. trimmed from the loaded set) — don't strand the view at
            // the top; fall back to the bottom.
            if (landedTarget < 0) reassertBottom()
            return
          }
          const s = scrollerRef.current
          if (!s) return
          // Conversation switched away while this loop was still running → stop (a stale loop must
          // never scroll the new conversation). prevConversationRef is set synchronously below.
          if (prevConversationRef.current !== markerConvId) return
          // User took over (FAB/wheel) or scrolled away from where we landed → stop fighting them.
          if (userScrollIntentAtRef.current > startedAt) return
          if (landedTarget >= 0 && Math.abs(s.scrollTop - landedTarget) > FAB_THRESHOLD) return

          const viewportHeight = s.clientHeight
          const v = latestRef.current.virtualizer
          let target: number | null = null
          if (v) {
            const offset = v.getOffsetForMessageId(markerId)
            if (offset != null) target = Math.max(0, offset - viewportHeight / 3)
          } else {
            const el = s.querySelector(`[data-message-id="${CSS.escape(markerId)}"]`) as HTMLElement | null
            if (el) target = Math.max(0, el.offsetTop - viewportHeight / 3)
          }

          if (target != null && Math.abs(target - landedTarget) > 1) {
            // Route through the virtualizer (scrollToOffset) so @tanstack's reactive scrollOffset
            // stays in sync — a raw scrollTop write is reverted to the top on the next re-window.
            if (v) v.scrollToOffset(target)
            else s.scrollTop = target
            landedTarget = target
            stableFrames = 0
            const distFromBottom = s.scrollHeight - target - viewportHeight
            isAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD
            debugLog('CONVERSATION SWITCH: scrolled to new message marker', {
              firstNewMessageId: markerId, target, viewportHeight, isAtBottom: isAtBottomRef.current,
            })
          } else if (landedTarget >= 0 && ++stableFrames >= MARKER_STABLE_FRAMES) {
            // Landed and the target has held steady — stop re-asserting.
            return
          }
          requestAnimationFrame(stepToMarker)
        }
        requestAnimationFrame(stepToMarker)
      } else if (targetMessageId) {
        // Has a target message to scroll to — skip scroll-to-bottom.
        // The targetMessageId effect will handle scrolling.
        // Mark as NOT at bottom so the ResizeObserver doesn't auto-scroll
        // to bottom when content grows (messages loading from IndexedDB).
        isAtBottomRef.current = false
        debugLog('CONVERSATION SWITCH: has targetMessageId, deferring to target scroll', { targetMessageId })
      } else {
        // No unread messages - scroll to bottom
        // We use both immediate and deferred scroll because:
        // 1. Immediate: Works when content is already rendered (useLayoutEffect runs after DOM mutations)
        // 2. Deferred: Catches edge cases where React's reconciliation hasn't finished
        //    (e.g., navigating via Option+U or notification click from a different view)
        //
        // Note: Async content loading (MAM) is handled by the separate "new message" effect
        // which triggers when messageCount changes.
        isAtBottomRef.current = true
        const virtSwitch = latestRef.current.virtualizer
        if (virtSwitch) {
          // Virtualizer-native bottom: uses actual measured heights, not the estimated
          // spacer height. This is the root cause of the "blank FAB" bug — estimated
          // scrollHeight undershoots when bottom rows are taller than estimateSize.
          // pinVirtualizedBottom re-asserts across frames as those rows measure, so the
          // last message isn't left clipped (taller) or floating above empty space (shorter).
          pinVirtualizedBottom()
        } else {
          void scroller.offsetHeight  // Force layout calculation
          scroller.scrollTop = scroller.scrollHeight
          requestAnimationFrame(() => {
            if (scrollerRef.current) {
              scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
              debugLog('CONVERSATION SWITCH: scrolled to bottom (deferred)', {
                scrollTop: scrollerRef.current.scrollTop,
                scrollHeight: scrollerRef.current.scrollHeight,
              })
            }
          })
        }
      }
    }

    // Update tracking
    hasInitializedRef.current = true
    prevConversationRef.current = conversationId
    prevMessageCountRef.current = messageCount

    // Cleanup: properly leave conversation in scrollStateManager when unmounting
    // This prevents stale currentConversationId from causing 'no-action' on remount
    return () => {
      if (prevConversationRef.current) {
        if (lastScrollDataRef.current) {
          const { top, height, client } = lastScrollDataRef.current
          scrollStateManager.leaveConversation(prevConversationRef.current, top, height, client, lastAnchorRef.current ?? undefined)
        } else {
          scrollStateManager.markAsLeft(prevConversationRef.current)
        }
      }
    }
  }, [conversationId, messageCount, firstNewMessageId, targetMessageId, isAtBottomRef, staticMode, pinVirtualizedBottom, reassertBottom])

  // ==========================================================================
  // EFFECT: Scroll to target message (from activity log click, etc.)
  // ==========================================================================
  //
  // When targetMessageId is set (e.g., user clicked a reaction in the activity log),
  // scroll to that specific message. Uses the same data-message-id attribute pattern
  // as the unread marker scroll. Clears the target after consumption.

  useEffect(() => {
    if (!targetMessageId || staticMode) return
    const scroller = scrollerRef.current
    if (!scroller) return

    const timeouts: ReturnType<typeof setTimeout>[] = []
    let rafId: number | null = null
    let found = false

    const scrollToTarget = () => {
      if (found) return
      const currentScroller = scrollerRef.current
      if (!currentScroller) return

      const escapedId = CSS.escape(targetMessageId)
      const messageElement = currentScroller.querySelector(`[data-message-id="${escapedId}"]`)

      if (messageElement) {
        found = true
        const elementTop = (messageElement as HTMLElement).offsetTop
        const viewportHeight = currentScroller.clientHeight
        // Center the target message in the viewport
        const targetScrollTop = Math.max(0, elementTop - viewportHeight / 3)

        currentScroller.scrollTop = targetScrollTop

        const distFromBottom = currentScroller.scrollHeight - targetScrollTop - viewportHeight
        isAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD

        // Briefly highlight the target message (same effect as reply-to navigation)
        messageElement.classList.add('message-highlight')
        setTimeout(() => messageElement.classList.remove('message-highlight'), 1500)

        debugLog('TARGET MESSAGE: scrolled to target', {
          targetMessageId,
          elementTop,
          targetScrollTop,
          viewportHeight,
          isAtBottom: isAtBottomRef.current,
        })

        onTargetMessageConsumed?.()
      } else {
        debugLog('TARGET MESSAGE: element not found', { targetMessageId })
      }
    }

    // When virtualized, bring the (possibly unmounted) target row into the window first.
    void latestRef.current.virtualizer?.ensureMessageMounted(targetMessageId)
    // Try with increasing delays to handle async rendering
    rafId = requestAnimationFrame(scrollToTarget)
    timeouts.push(setTimeout(scrollToTarget, 50))
    timeouts.push(setTimeout(scrollToTarget, 150))
    timeouts.push(setTimeout(scrollToTarget, 300))

    // Safety fallback: if target message is never found after all attempts,
    // scroll to bottom and clear the target to avoid being stuck
    timeouts.push(setTimeout(() => {
      if (found) return
      const currentScroller = scrollerRef.current
      if (!currentScroller || !targetMessageId) return
      const escapedId = CSS.escape(targetMessageId)
      const el = currentScroller.querySelector(`[data-message-id="${escapedId}"]`)
      if (!el) {
        debugLog('TARGET MESSAGE: not found after all attempts, scrolling to bottom', { targetMessageId })
        currentScroller.scrollTop = currentScroller.scrollHeight
        isAtBottomRef.current = true
        onTargetMessageConsumed?.()
      }
    }, 500))

    // Cleanup pending timeouts on re-run (e.g., when messageCount changes from async load)
    return () => {
      timeouts.forEach(clearTimeout)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }

    // messageCount is in deps so this re-fires when messages load from async sources
    // (e.g., IndexedDB in search context view)
  }, [targetMessageId, messageCount, isAtBottomRef, onTargetMessageConsumed, staticMode])

  // ==========================================================================
  // EFFECT: Cleanup on unmount
  // ==========================================================================
  //
  // Clear the media load debounce timer to prevent memory leaks and
  // attempted DOM access after the component unmounts.

  useEffect(() => {
    return () => {
      if (mediaLoadDebounceRef.current) {
        clearTimeout(mediaLoadDebounceRef.current)
      }
      if (contentObserverRef.current) {
        contentObserverRef.current.disconnect()
      }
      if (correctionRafRef.current !== null) {
        cancelAnimationFrame(correctionRafRef.current)
        correctionRafRef.current = null
      }
    }
  }, [])

  // ==========================================================================
  // EFFECT: Prepend complete (older messages loaded)
  // ==========================================================================
  //
  // This runs in useLayoutEffect so it happens BEFORE the browser paints.
  // We restore the user's visual position using element-based positioning,
  // falling back to distance-from-bottom math if the anchor element isn't found.

  useLayoutEffect(() => {
    if (staticMode) return
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

    // Force reflow first to ensure browser has calculated new layout
    void scroller.offsetHeight

    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight

    // Try element-based positioning first (more reliable)
    let newScrollTop: number | null = null
    let usedMethod = 'none'

    if (saved.anchorMessageId) {
      // Virtualized: read the anchor's offset from the CURRENT render's virtualizer
      // (virtualizerRef, updated synchronously in the render body). Using
      // latestRef.current.virtualizer here would give the STALE pre-prepend indexById
      // because latestRef is updated in useEffect (after paint) — too late for this
      // useLayoutEffect (before paint). The current virtualizer has the new indexById
      // with post-prepend indices, giving the correct anchor offset.
      const virtualOffset =
        virtualizerRef.current?.getOffsetForMessageId(saved.anchorMessageId) ?? null

      if (virtualOffset != null) {
        newScrollTop = virtualOffset - saved.anchorOffsetFromTop
        usedMethod = 'virtualizer-offset'

        debugLog('PREPEND RESTORE (virtualizer offset)', {
          anchorMessageId: saved.anchorMessageId,
          virtualOffset,
          savedOffsetFromTop: saved.anchorOffsetFromTop,
          newScrollTop,
          maxScrollTop,
        })
      } else {
        const anchorElement = scroller.querySelector(
          `[data-message-id="${saved.anchorMessageId}"]`
        ) as HTMLElement | null

        if (anchorElement) {
          // Position the anchor element at the same offset from viewport top as before
          newScrollTop = anchorElement.offsetTop - saved.anchorOffsetFromTop
          usedMethod = 'element-based'

          debugLog('PREPEND RESTORE (element-based)', {
            anchorMessageId: saved.anchorMessageId,
            anchorOffsetTop: anchorElement.offsetTop,
            savedOffsetFromTop: saved.anchorOffsetFromTop,
            newScrollTop,
            maxScrollTop,
          })
        }
      }
    }

    // Fallback to distance-from-bottom math if element not found
    if (newScrollTop === null) {
      newScrollTop = scroller.scrollHeight - scroller.clientHeight - saved.distanceFromBottom
      usedMethod = 'math-fallback'

      debugLog('PREPEND RESTORE (math-based fallback)', {
        newScrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        savedDistanceFromBottom: saved.distanceFromBottom,
        maxScrollTop,
      })
    }

    // BOUNDS CHECK: Ensure scroll position is valid
    // This prevents blank window when scroll position is out of range
    const boundedScrollTop = Math.max(0, Math.min(newScrollTop, maxScrollTop))

    if (boundedScrollTop !== newScrollTop) {
      debugLog('PREPEND RESTORE BOUNDS CLAMPED', {
        original: newScrollTop,
        bounded: boundedScrollTop,
        maxScrollTop,
        usedMethod,
      })
    }

    debugLog('PREPEND RESTORE FINAL', {
      newScrollTop: boundedScrollTop,
      usedMethod,
      oldFirstId: saved.oldFirstId,
      newFirstId: firstMessageId,
      messageCount,
      scrollHeightBefore: scroller.scrollHeight,
      scrollTopBefore: scroller.scrollTop,
      maxScrollTop,
    })

    // Cancel any parked kinetic (momentum) scroll BEFORE positioning. On a fast scroll-up
    // fling the user reaches the top boundary with residual velocity that WebKit parks and
    // then resumes once we prepend older messages — overshooting the restored anchor and
    // landing in an unmounted region (blank window) or driving scrollTop out of bounds (jump
    // to bottom). Toggling overflow off, forcing a reflow, and turning it back on cancels
    // WebKit's momentum animation. This runs inside the useLayoutEffect (pre-paint), so there
    // is no visible scrollbar flash. Programmatic scrolls carry no momentum, so this is inert
    // in the Playwright/preview harness — the fix is only observable on real hardware.
    cancelKineticScroll(scroller)

    // Set via the virtualizer's own scroll path so @tanstack's internal state stays
    // consistent and it does not re-process this as an external scroll event.
    // For the non-virtualized path, write scrollTop directly as before.
    // Use virtualizerRef (updated in render body) NOT latestRef (updated in useEffect,
    // which runs after paint — too late for this useLayoutEffect).
    const virtRestore = virtualizerRef.current
    if (virtRestore) {
      virtRestore.scrollToOffset(boundedScrollTop)
    } else {
      scroller.scrollTop = boundedScrollTop
    }

    // Verify it was applied (browser may have clamped further)
    const actualScrollTop = scroller.scrollTop
    if (Math.abs(actualScrollTop - boundedScrollTop) > 1) {
      debugLog('PREPEND RESTORE MISMATCH', {
        requested: boundedScrollTop,
        actual: actualScrollTop,
        diff: actualScrollTop - boundedScrollTop,
      })
    }

    debugLog('PREPEND RESTORE APPLIED', {
      scrollTopAfter: actualScrollTop,
      scrollHeightAfter: scroller.scrollHeight,
    })

    // Mark as restored but keep the ref for a cooldown period
    saved.restored = true
    saved.restoredAt = Date.now()
    lastRestoreTimeRef.current = Date.now()

    // Measurement-aware re-assert loop: tanstack's estimated sizes for prepended rows
    // may differ from actual heights. As ResizeObserver reports measurements,
    // getOffsetForMessageId(anchor) shifts upward. Re-apply the anchor-based target
    // on each frame until it stabilises (max 20 frames ≈ 333ms at 60fps).
    //
    // Runs entirely in rAF — NOT in useLayoutEffect — to avoid the scroll→rerender→
    // scrollTop-override oscillation (PR #646). The initial scroll was momentum-corrected
    // by frame 0; subsequent frames track measurement drift only.
    // Measurement-aware re-assert: tanstack estimated 64px per prepended row; actual
    // heights may differ. ResizeObserver fires asynchronously — often AFTER the first
    // rAF. Run unconditionally for 20 frames (≈333ms) so we track every measurement
    // update and keep the anchor at its correct viewport offset.
    //
    // Runs in rAF only (not useLayoutEffect) to avoid the scroll→rerender→override
    // oscillation from PR #646.
    // Measurement-aware re-assert: tanstack estimated 64px per prepended row; actual
    // heights may differ. ResizeObserver fires asynchronously — often AFTER the first
    // rAF. Run for up to 20 frames (≈333ms) so every measurement update is tracked.
    //
    // Runs in rAF only (not useLayoutEffect) to avoid the scroll→rerender→override
    // oscillation from PR #646.
    //
    // Large external scrolls (FAB, keyboard, conversation switch) are detected as
    // |scrollTop − prevTarget| > 200px and cancel the loop immediately.
    // Measurement-aware re-assert: tanstack estimated 64px per prepended row; actual
    // heights may differ. ResizeObserver fires asynchronously over many frames. Keep
    // tracking until stable for STABLE_FRAMES consecutive frames (max MAX_FRAMES total).
    //
    // Runs in rAF only (not useLayoutEffect) to avoid the scroll→rerender→override
    // oscillation from PR #646.
    //
    // Large external scrolls (FAB click, keyboard nav) cancel the loop immediately.
    const anchorForAssert = saved.anchorMessageId
    const offsetForAssert = saved.anchorOffsetFromTop
    // Hard stop after 60 frames (≈1 second). No early-stable exit: ResizeObserver
    // callbacks can arrive late (beyond a 5-frame window). A big one-frame drift is
    // re-pinned once (clamp recovery) and only treated as a genuine external scroll —
    // FAB / keyboard / user fling — if it persists the next frame.
    const MAX_FRAMES = 60
    let framesLeft = MAX_FRAMES
    let prevTarget = boundedScrollTop
    // Snapshot the loop start. A deliberate user scroll (FAB / wheel) recorded AFTER this means
    // the user took over → yield. A content-shrink clamp records no intent, so the loop keeps
    // re-pinning the anchor through it (clamp recovery — the "jump to bottom" fix).
    const assertStartedAt = Date.now()
    const runMeasureAssert = () => {
      if (framesLeft-- <= 0) return
      // Deliberate user scroll (FAB / wheel) since the loop started → the user took over;
      // stop re-pinning and yield. A content-shrink clamp does NOT set this, so we keep going.
      if (userScrollIntentAtRef.current > assertStartedAt) {
        debugLog('PREPEND ASSERT CANCELLED (user scroll intent)', { scrollTop: scrollerRef.current?.scrollTop })
        return
      }
      const virt = virtualizerRef.current
      const s = scrollerRef.current
      if (virt && s) {
        const currentOffset = virt.getOffsetForMessageId(anchorForAssert)
        if (currentOffset != null) {
          const newTarget = Math.max(0, Math.round(currentOffset - offsetForAssert))
          const scrollDrift = s.scrollTop - newTarget
          if (Math.abs(newTarget - prevTarget) > 2) {
            // Measurements shifted since last frame — update scroll to match
            debugLog('PREPEND MEASURE ASSERT', { newTarget, prevTarget, delta: newTarget - prevTarget })
            virt.scrollToOffset(newTarget)
            prevTarget = newTarget
          } else if (Math.abs(scrollDrift) > 5) {
            // scrollTop diverged from the (stable) anchor target — a content-shrink clamp
            // pinned us to the bottom, or the browser nudged us. Re-pin the anchor. We do NOT
            // bail on a big drift here: that previously mistook the clamp for a user scroll and
            // left the view stuck at the bottom (the reported "jump to bottom"). Genuine user
            // scrolls are handled by the intent check at the top of the loop instead.
            virt.scrollToOffset(newTarget)
          }
        }
      }
      requestAnimationFrame(runMeasureAssert)
    }
    requestAnimationFrame(runMeasureAssert)

    // Clear after cooldown
    setTimeout(() => {
      if (prependRef.current?.restoredAt === saved.restoredAt) {
        debugLog('PREPEND CLEAR')
        prependRef.current = null
      }
    }, PREPEND_COOLDOWN_MS)
  }, [messageCount, firstMessageId, staticMode])

  // ==========================================================================
  // EFFECT: New message arrives
  // ==========================================================================

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !hasInitializedRef.current || staticMode) return

    // Don't interfere with prepend that's actively in progress (not yet restored)
    // Once restored, allow new message auto-scroll even during cooldown period
    if (prependRef.current && !prependRef.current.restored) {
      debugLog('NEW MSG SKIP (prepend in progress)', {
        messageCount,
        prevCount: prevMessageCountRef.current,
      })
      prevMessageCountRef.current = messageCount
      return
    }

    const isNewMessage = messageCount > prevMessageCountRef.current
    // Scroll to the bottom when a new message arrives AND either we're already near the bottom
    // (auto-follow) OR the message is the user's own send — you always want to see what you
    // just sent, even from a scrolled-up position. An incoming message while scrolled up does
    // NOT yank the reader down.
    if (isNewMessage && (isAtBottomRef.current || lastMessageIsOutgoing)) {
      debugLog('NEW MSG SCROLL TO BOTTOM', {
        messageCount,
        prevCount: prevMessageCountRef.current,
        isAtBottom: isAtBottomRef.current,
        outgoing: lastMessageIsOutgoing,
        scrollTopBefore: scroller.scrollTop,
      })
      isAtBottomRef.current = true // a send from a scrolled-up position lands us at the bottom
      reassertBottom()
    } else if (isNewMessage) {
      debugLog('NEW MSG NO SCROLL (not at bottom)', {
        messageCount,
        prevCount: prevMessageCountRef.current,
        isAtBottom: isAtBottomRef.current,
      })
    }

    prevMessageCountRef.current = messageCount
  }, [messageCount, isAtBottomRef, staticMode, lastMessageIsOutgoing, reassertBottom])

  // ==========================================================================
  // EFFECT: Reset marker scroll tracking when firstNewMessageId changes
  // ==========================================================================

  const prevFirstNewMessageIdRef = useRef(firstNewMessageId)
  useEffect(() => {
    if (firstNewMessageId !== prevFirstNewMessageIdRef.current) {
      userHasScrolledSinceMarkerRef.current = false
      prevFirstNewMessageIdRef.current = firstNewMessageId
    }
  }, [firstNewMessageId])

  // ==========================================================================
  // EFFECT: Typing indicator / reactions change
  // ==========================================================================

  // Content grew INSIDE the scroller (typing indicator toggled, reactions added to the last
  // message): the scroller box is unchanged but scrollHeight grew, so a follower must re-pin.
  // One effect keyed on both signals — the body is identical and both mean "footer/last-row
  // height changed". useLayoutEffect runs BEFORE paint: with useEffect the browser paints a
  // frame with the gap visible and a scroll event can fire in between, flipping isAtBottomRef
  // false — which breaks auto-scroll for subsequent messages and strands a blank screen on
  // conversation switch (the stale "not at bottom" state gets persisted).
  useLayoutEffect(() => {
    if (!isAtBottomRef.current) return
    reassertBottom()
  }, [typingUsersCount, lastMessageReactionsKey, isAtBottomRef, reassertBottom])

  // ==========================================================================
  // EFFECT: Container resize (composer grows/shrinks)
  // ==========================================================================

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    let lastHeight: number | null = null
    let pendingHeight: number | null = null
    let scheduled = false
    let rafId: number | null = null
    let monitor: ReturnType<typeof createResizeLoopMonitor> | null = null

    // The measure + scroll-correction. Runs inside a rAF so the scrollTop write
    // never happens synchronously inside the ResizeObserver delivery cycle —
    // that synchronous write is the literal trigger for WebKitGTK's
    // "ResizeObserver loop completed with undelivered notifications". Parity with
    // the content observer's rAF coalescing (see setContentRef above).
    const runCorrection = () => {
      scheduled = false
      rafId = null
      const newHeight = pendingHeight
      pendingHeight = null
      if (newHeight === null) return

      if (lastHeight === null) { lastHeight = newHeight; return }

      const shrunk = lastHeight - newHeight
      if (shrunk > 0 && scrollerRef.current) {
        const wasNear = getDistanceFromBottom(scrollerRef.current) <= shrunk + AT_BOTTOM_THRESHOLD
        // Route through reassertBottom so the virtualized path re-windows (scrollToIndex) rather
        // than a raw scrollTop write that would leave the mounted window stale → blank/clipped.
        if (wasNear) reassertBottom()
      }

      lastHeight = newHeight
    }

    const observer = new ResizeObserver((entries) => {
      // Diagnostic only: surface a runaway fire rate (the composer-resize
      // observer is a second candidate for the WebKitGTK feedback loop).
      // Log-rate-limited; never disconnects.
      if (!monitor) monitor = createResizeLoopMonitor()
      const warning = monitor.record(performance.now())
      if (warning) console.warn(warning)

      // Track the latest height and coalesce the correction into one rAF per
      // frame, no matter how many times the observer fires this frame. The
      // `scheduled` flag (rather than `rafId === null`) is what guards against
      // double-scheduling: it stays correct even when rAF runs the callback
      // synchronously and reentrantly.
      pendingHeight = entries[0].contentRect.height
      if (!scheduled) {
        scheduled = true
        rafId = requestAnimationFrame(runCorrection)
      }
    })

    observer.observe(scroller)
    return () => {
      observer.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
    // reassertBottom is stable (depends only on the stable pinVirtualizedBottom), so listing it
    // re-creates the observer only on conversation change, same as conversationId alone.
  }, [conversationId, reassertBottom])

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
    contentWrapperRef: setContentRef,
    handleScroll,
    handleWheel,
    handleLoadEarlier,
    handleMediaLoad,
    scrollToBottom,
    scrollToTop,
    showScrollToBottom,
  }
}
