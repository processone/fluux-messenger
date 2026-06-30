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
import { scrollStateManager, AT_BOTTOM_THRESHOLD, type ScrollAnchor } from '@/utils/scrollStateManager'
import { createResizeLoopMonitor } from './resizeLoopMonitor'
import { createSlowCorrectionMonitor } from './slowCorrectionMonitor'
import { createReassertLoopMonitor } from './reassertLoopMonitor'
import type { ReassertLoopHandle } from './reassertLoopMonitor'
import type { MessageVirtualizer } from './messageVirtualizer'
import { notifyUserInput } from '@/utils/renderLoopDetector'

// ============================================================================
// DEBUG
// ============================================================================

// Off by default. Toggle at runtime from the devtools console without a rebuild:
//   __fluuxScrollDebug(true)   → start logging
//   __fluuxScrollDebug(false)  → stop
// Or persist across reloads with: localStorage.setItem('fluux:scroll-debug', '1')
let DEBUG = (() => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage?.getItem('fluux:scroll-debug') === '1'
  } catch {
    return false
  }
})()

if (typeof window !== 'undefined') {
  ;(window as Window & { __fluuxScrollDebug?: (on?: boolean) => void }).__fluuxScrollDebug = (
    on = true
  ) => {
    DEBUG = on
    // Shared flag so sibling modules (scrollStateManager) log in the same trace.
    ;(window as Window & { __fluuxScrollDebugOn?: boolean }).__fluuxScrollDebugOn = on
    console.warn(`[Scroll] debug ${on ? 'ENABLED' : 'disabled'}`)
  }
  // SEPARATE toggle for the high-volume per-row `[Estimate]` trace, so the scroll-decision trace
  // above stays readable. Enable only when auditing estimate accuracy.
  ;(window as Window & { __fluuxEstimateDebug?: (on?: boolean) => void }).__fluuxEstimateDebug = (
    on = true
  ) => {
    ;(window as Window & { __fluuxEstimateDebugOn?: boolean }).__fluuxEstimateDebugOn = on
    console.warn(`[Estimate] debug ${on ? 'ENABLED' : 'disabled'}`)
  }
}

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
// AT_BOTTOM_THRESHOLD is imported from scrollStateManager (shared with wasAtBottom persistence).
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
// Sub-row tolerance for the marker re-assert: only re-scroll when the resolved target moves more
// than this (rows measuring jitter the offset by a few px every frame; a 1px threshold would
// re-scroll — and re-render — every frame and never stabilize).
const MARKER_DRIFT_PX = 16
// Target jumps (reply/search/activity) need the same measurement-aware behavior as unread-marker
// entry, but for a shorter window: the target row is explicitly requested and should settle fast.
const TARGET_REASSERT_FRAMES = 30
const TARGET_STABLE_FRAMES = 4
const TARGET_DRIFT_PX = 16
// Saved-position (content-anchor) restore needs the SAME measurement-aware re-assert as the marker
// path. A one-shot scrollToIndex(anchor,'end') lands on the rows' ESTIMATED sizes; those rows then
// measure TALLER over the next frames (media, wrapping), the content above the anchor grows, and the
// anchor slides below the fold — the view drifts OLDER. handleScroll then saves that drifted position
// and the (now older) bottom-visible message becomes the next anchor, so each re-open drifts further
// back ("goes back in time on every open"). Re-pinning the anchor across frames lands it on settled
// measurements, and registering the loop gates the save so the transient can't compound.
const RESTORE_REASSERT_FRAMES = 90
const RESTORE_STABLE_FRAMES = 8
const RESTORE_DRIFT_PX = 8
// While re-pinning, treat the list as not-yet-pinned whenever it sits more than this many pixels
// above the true bottom. The change-detection guard (re-pin only when scrollHeight moved) can miss
// the frame where the last row's measurement settles — coalesced height deltas, or a height delta
// captured into the previous frame's baseline — leaving the view a row short with no further change
// to react to. WebKit (the desktop WKWebView) hits this intermittently; Chromium masks it via
// overflow-anchor. Re-asserting on measured distance self-heals it: scrollToIndex(last,'end') is a
// no-op once truly pinned, so this converges and cannot oscillate. Sub-row tolerance keeps it from
// firing on harmless subpixel rounding.
const BOTTOM_PIN_TOLERANCE = 4

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

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Capture a CONTENT anchor: the bottom-most visible message and the FRACTION (0..1) of its
 * height at which the viewport bottom sits. fraction=1 → the message's bottom edge is at the
 * window bottom; 0.5 → the window bottom cuts its middle.
 *
 * Storing a fraction (not a pixel gap) makes the position INDEPENDENT OF RENDERING: on return we
 * re-derive pixels from the message's CURRENT measured height, so a re-measure, a width change, or
 * a virtualization re-window can't corrupt it. The previous implementation stored a pixel gap found
 * via a BINARY SEARCH over `offsetTop` assuming rows were in sorted document order — false under
 * virtualization (the DOM holds an unsorted/stale window), which produced a wildly wrong gap and
 * flung the view to the bottom on return. This is a linear max-scan over the (small) rendered
 * window using each row's own `offsetTop`/`offsetHeight`, so DOM order no longer matters.
 */
function findBottomAnchor(scroller: HTMLElement): ScrollAnchor | null {
  const rows = scroller.querySelectorAll('.message-row[data-message-id]')
  if (rows.length === 0) return null
  // Measure with getBoundingClientRect (relative to the scroller), NOT offsetTop. Under
  // virtualization each `.message-row` sits inside its own `position:absolute` `[data-index]`
  // wrapper, which is the row's offsetParent — so `offsetTop` is ~0 for EVERY row and the old
  // "greatest offsetTop" pick always returned the top-most MOUNTED row instead of the bottom-most
  // visible one. That wrong anchor was saved/restored (masked by consistency-only tests) and is a
  // root cause of the conversation-switch "drifts back in time" report. Bounding rects reflect the
  // real on-screen position for both the virtualized and the normal-flow paths.
  const sTop = scroller.getBoundingClientRect().top
  const viewportH = scroller.clientHeight
  // Bottom-most row whose TOP is still within the viewport (greatest scroller-relative top < height).
  let best: HTMLElement | null = null
  let bestTop = -Infinity
  for (const node of rows) {
    const el = node as HTMLElement
    if (el.offsetHeight <= 0) continue
    const top = el.getBoundingClientRect().top - sTop
    if (top < viewportH && top > bestTop) {
      best = el
      bestTop = top
    }
  }
  if (best === null) best = rows[rows.length - 1] as HTMLElement
  const messageId = best.dataset.messageId
  if (!messageId) return null
  const rect = best.getBoundingClientRect()
  const height = rect.height || 1
  const topRel = rect.top - sTop
  return { messageId, fraction: clamp01((viewportH - topRel) / height) }
}

/**
 * Restore scroll so the viewport bottom sits at the saved FRACTION through the anchor message,
 * using the message's CURRENT measured height. Returns false if the anchor message isn't currently
 * mounted (scrolled up beyond the re-hydrated/virtualized window) so the caller can fall back.
 */
function restoreToAnchor(scroller: HTMLElement, anchor: ScrollAnchor): boolean {
  const el = scroller.querySelector(
    `.message-row[data-message-id="${CSS.escape(anchor.messageId)}"]`
  ) as HTMLElement | null
  if (!el || el.offsetHeight <= 0) return false
  scroller.scrollTop = el.offsetTop + anchor.fraction * el.offsetHeight - scroller.clientHeight
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
  /**
   * Hydrate the resident message window with the cache slice CONTAINING a specific message.
   * Called by the restore path when a saved content anchor (or a navigation target) is older than
   * the latest-N slice loaded on activation, so it isn't in the loaded set and the anchor restore
   * can't resolve it. The resulting message-count growth re-runs the restore via the retry effect.
   * Returns a promise that resolves once the slice has merged (or with an empty slice when the
   * anchor isn't in the cache).
   */
  onLoadAround?: (anchorMessageId: string) => Promise<unknown> | void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
  typingUsersCount: number
  lastMessageReactionsKey: string
  /** Whether the newest message is the local user's own (outgoing). When a NEW such message
   *  appears we scroll to the bottom regardless of position — you always want to see what you
   *  just sent — whereas an incoming message only auto-follows when already near the bottom. */
  lastMessageIsOutgoing?: boolean
  /** Id of the newest message. A send can REPLACE the last row in place (optimistic →
   *  reconciled) without growing messageCount, so "did the bottom change?" must key off this
   *  id, not just the count — otherwise a just-sent message fails to stick to the bottom. */
  lastMessageId?: string
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

type RestoreSavedPositionResult = 'restored' | 'pending' | 'bottom'

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
  onLoadAround,
  isLoadingOlder,
  isHistoryComplete,
  typingUsersCount,
  lastMessageReactionsKey,
  lastMessageIsOutgoing = false,
  lastMessageId,
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
  // Diagnostic-only monitor for the rAF scroll re-assert loops (pin-bottom / marker / prepend):
  // surfaces a non-converging loop or two overlapping loops fighting over scrollTop on WebKit
  // (frame-coupled, so invisible to the headless harness and the other monitors). Never cancels.
  const reassertMonitorRef = useRef<ReturnType<typeof createReassertLoopMonitor> | null>(null)
  // In-flight scroll re-assert loop (rAF id + monitor handle), SHARED across pin-bottom and the
  // MAM-prepend re-assert. Starting any re-assert loop supersedes whatever is in-flight, so only
  // one ever runs: two loops fight over scrollTop (the overlap the monitor warns about), and
  // pin-bottom vs prepend target opposite positions (bottom vs a history anchor). Single-flight:
  // latest call wins with a fresh settle window.
  const reassertLoopRef = useRef<{ raf: number; handle: ReassertLoopHandle } | null>(null)
  // Supersede any in-flight re-assert loop. Held in a ref (read as `.current()`) so callers in
  // useCallback / useLayoutEffect don't need it as a dependency — react-hooks treats refs as stable.
  const supersedeReassertLoopRef = useRef(() => {
    if (reassertLoopRef.current) {
      cancelAnimationFrame(reassertLoopRef.current.raf)
      reassertLoopRef.current.handle.end()
      reassertLoopRef.current = null
    }
  })

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
  const prevLastMessageIdRef = useRef<string | undefined>(lastMessageId)
  const hasInitializedRef = useRef(false)
  const pendingRestoreConversationRef = useRef<string | null>(null)
  // Whether the user has GENUINELY scrolled since entering this conversation (wheel / touch /
  // keyboard / FAB). Reset on every conversation switch. The saved scroll position is only
  // overwritten once this is true: a restore can drift on its own as rows below the fold load media
  // and re-measure, and persisting that spontaneous shift made the position creep older on every
  // re-open ("goes back in time on switch"). Gating the save on real user intent keeps the saved
  // anchor at the user's actual reading position, so re-opens are stable regardless of media timing.
  const userHasScrolledSinceEntryRef = useRef(false)
  // scrollHeight at the previous scroll event, to tell a genuine user scroll (content height
  // unchanged) from a media/measurement-driven shift (height changed). Complements the input-event
  // listeners below so scrollbar-drag — which fires no wheel/touch — still counts. Reset per entry.
  const prevScrollHeightRef = useRef<number | null>(null)
  // Teardown for the native user-input listeners attached to the scroller (set them via addEventListener
  // so touch/keyboard scrolls — which don't go through the React onWheel handler — also count).
  const userInputCleanupRef = useRef<(() => void) | null>(null)
  // Per-anchor status for the on-demand "load the cache slice around the anchor" request used when
  // a saved content anchor (or navigation target) is older than the latest-N slice loaded on
  // activation. 'loading' → request in flight (stay pending); 'done' → attempted (resolved by the
  // index path, or the anchor wasn't in the cache → fall through to the legacy fallback). Keyed by
  // `${conversationId}:${anchorMessageId}` and cleared on conversation switch so returning to the
  // same conversation re-requests. Prevents re-issuing the load on every retry frame.
  const aroundLoadStatusRef = useRef<Map<string, 'loading' | 'done'>>(new Map())
  // Last target message id we requested an around-load for (search / activity navigation to a
  // message older than the loaded window). Prevents re-issuing the load while the target effect
  // re-fires waiting for the slice to merge.
  const targetAroundRequestedRef = useRef<string | null>(null)
  // Stable indirection so the async around-load completion can re-run restore without making
  // restoreSavedPosition a dependency of itself.
  const restoreSavedPositionRef = useRef<((source: 'entry' | 'retry') => RestoreSavedPositionResult) | null>(null)

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
  const mediaLoadSnapshotRef = useRef<{ wasAtBottom: boolean; userScrolled: boolean; anchor: ScrollAnchor | null } | null>(null)
  const mediaLoadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Last scroll data (for saving on conversation switch)
  const lastScrollDataRef = useRef<{ top: number; height: number; client: number; width: number } | null>(null)
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

  const rememberCurrentScrollSnapshot = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    lastScrollDataRef.current = {
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      client: scroller.clientHeight,
      width: scroller.clientWidth,
    }
    lastAnchorRef.current = findBottomAnchor(scroller)
  }, [])

  const rememberBottomIntent = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const bottomTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    lastScrollDataRef.current = {
      top: bottomTop,
      height: scroller.scrollHeight,
      client: scroller.clientHeight,
      width: scroller.clientWidth,
    }
    lastAnchorRef.current = findBottomAnchor(scroller)
    isAtBottomRef.current = true
    setShowScrollToBottom(false)
    scrollStateManager.clearSavedScrollState(conversationId)
  }, [conversationId, isAtBottomRef])

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

  const latestRef = useRef({ staticMode, externalScrollerRef, isAtBottomRef, conversationId, virtualizer, onLoadAround })
  useEffect(() => {
    latestRef.current = { staticMode, externalScrollerRef, isAtBottomRef, conversationId, virtualizer, onLoadAround }
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
          // Guard: useLayoutEffect may have set isAtBottomRef=false if restoring
          // a mid-conversation scroll position (e.g. returning from Settings).
          // Re-check here so we don't override the position restore.
          if (scrollerRef.current && isAtBottomRef.current) {
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
        // Native user-input listeners: mark a GENUINE user scroll so the save gate (see
        // userHasScrolledSinceEntryRef) opens. wheel covers mouse/trackpad, touchstart covers
        // mobile, keydown covers PageUp/Down/arrows/Space when the list is focused. These are
        // distinct from media/measurement-driven scroll events, which must NOT open the gate.
        userInputCleanupRef.current?.()
        userInputCleanupRef.current = null
        if (el) {
          const markUserScrolled = () => { userHasScrolledSinceEntryRef.current = true }
          el.addEventListener('wheel', markUserScrolled, { passive: true })
          el.addEventListener('touchstart', markUserScrolled, { passive: true })
          el.addEventListener('keydown', markUserScrolled)
          userInputCleanupRef.current = () => {
            el.removeEventListener('wheel', markUserScrolled)
            el.removeEventListener('touchstart', markUserScrolled)
            el.removeEventListener('keydown', markUserScrolled)
          }
          trySetupContentObserver()
        }
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

    // Single-flight: supersede any re-assert loop still running (pin-bottom OR prepend) so two
    // never run at once and fight over scrollTop (the overlap the reassert monitor warns about,
    // and the suspected cause of a just-sent message not sticking to the bottom on WebKit). This
    // call restarts with a fresh settle window. reassertBottom fires from several sites
    // (new-message, typing, composer/viewport resize, media load) that can land within the ~1s
    // window — and a send can land mid-prepend — so re-entry is routine.
    supersedeReassertLoopRef.current()

    // WebKit at-bottom stick. Rows are absolutely positioned, so the scroller's scrollHeight is the
    // spacer's declared height (= @tanstack getTotalSize), which grows only once a just-added row's
    // ResizeObserver delivers — and WebKit (Safari + Tauri) delivers that LATE. When you are already
    // AT the bottom there is no scroll motion to trigger the re-window/measure, so scrollHeight reads
    // stale-short by exactly the new row's height, the pin sees distFromBottom 0 against content that
    // has not grown, and the new message is stranded a row below the fold. (Scrolled UP, a send still
    // works: the large scroll re-windows and measures on the way down — confirmed in the field.)
    //
    // Diagnosed via the observer effect: a console loop reading row geometry every frame made the bug
    // vanish, because reading a message row's getBoundingClientRect forces the layout that makes the
    // observer deliver, so getTotalSize/scrollHeight catch up. We replicate exactly that — read the
    // tail message rows' rects each settle frame — and let the existing scrollHeight-delta re-pin
    // below scroll to the freshly-grown bottom. Strictly read-only (no scroll, no state), so it can't
    // thrash; a no-op on Chromium, where the observer was already prompt. Reading the last few rows
    // covers a grouping-height change in the row above the new one.
    const flushTailLayout = () => {
      const ss = scrollerRef.current
      if (!ss) return
      ss.getBoundingClientRect()
      const rows = ss.querySelectorAll('[data-message-id]')
      for (let i = Math.max(0, rows.length - 3); i < rows.length; i++) {
        rows[i].getBoundingClientRect()
      }
    }

    // Immediate pin (pre-paint when called from a layout effect).
    flushTailLayout()
    virt.scrollToIndex(virt.itemCount - 1, { align: 'end' })
    debugLog('PIN start', {
      itemCount: virt.itemCount,
      distFromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    })

    const startedAt = Date.now()
    const loop = (reassertMonitorRef.current ??= createReassertLoopMonitor()).begin('pin-bottom', performance.now())
    let framesLeft = BOTTOM_REASSERT_FRAMES
    let lastHeight = scroller.scrollHeight
    const finish = () => {
      loop.end()
      reassertLoopRef.current = null
    }
    const step = () => {
      const s = scrollerRef.current
      if (framesLeft-- <= 0) {
        // Loop ran its full budget. Re-derive isAtBottom from REAL geometry so downstream consumers
        // (FAB, auto-follow on the next message, position save) are left accurate even if WebKit
        // withheld the final settle scroll event — the pin no longer trusts the position-derived flag
        // mid-loop (see the removed bail above), so it must leave a correct one behind here. If dist
        // is still > tolerance the pin never converged (the just-sent message ended up below the fold).
        if (s) {
          flushTailLayout()
          const dist = s.scrollHeight - s.scrollTop - s.clientHeight
          isAtBottomRef.current = dist < AT_BOTTOM_THRESHOLD
          debugLog('PIN settled (frames exhausted)', { distFromBottom: dist })
        }
        finish()
        return
      }
      const v = virtualizerRef.current
      if (!s || !v || v.itemCount === 0) { finish(); return }
      // The ONLY reason to stop pinning is a genuine user takeover — a FAB tap or a wheel scroll,
      // both of which stamp userScrollIntentAtRef AFTER we started. We deliberately do NOT also bail
      // on a position-derived `!isAtBottomRef.current`: on WebKit a tall bottom row's post-paint
      // growth fires extra `scroll` events that transiently report a large distFromBottom, and the
      // height-unchanged discriminator in handleScroll cannot catch every one — a growth that settles
      // across TWO scroll events (the second at the now-unchanged height) slips it, flips isAtBottom
      // false, and used to strand the just-sent message below the fold (the recurring send-stick bug).
      // The pin instead keeps converging on REAL geometry (the dist check below) and yields only to
      // real input intent. See scroll-invariants "...growth that settles across TWO scroll events".
      if (userScrollIntentAtRef.current > startedAt) {
        debugLog('PIN bail (user scroll intent)', {
          distFromBottom: s.scrollHeight - s.scrollTop - s.clientHeight,
        })
        finish()
        return
      }
      // Force the tail rows to lay out this frame (the field-proven flush) so WebKit's late
      // ResizeObserver delivers and getTotalSize/scrollHeight grow to include the just-added row,
      // BEFORE we read scrollHeight below.
      flushTailLayout()
      const h = s.scrollHeight
      // Re-pin when the layout grew/shrank (the common case) OR when we're still measurably short of
      // the true bottom. The flush above makes the at-bottom growth show up here within a frame or
      // two, so the send no longer settles a row low on WebKit. Idempotent at the bottom.
      const dist = h - s.scrollTop - s.clientHeight
      let wrote = false
      if (h !== lastHeight || dist > BOTTOM_PIN_TOLERANCE) {
        debugLog('PIN re-assert', { distFromBottom: dist, heightChanged: h !== lastHeight })
        lastHeight = h
        v.scrollToIndex(v.itemCount - 1, { align: 'end' })
        wrote = true
      }
      const warning = loop.frame(performance.now(), wrote)
      if (warning) console.warn(warning)
      reassertLoopRef.current = { raf: requestAnimationFrame(step), handle: loop }
    }
    reassertLoopRef.current = { raf: requestAnimationFrame(step), handle: loop }
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
    rememberBottomIntent()
  }, [pinVirtualizedBottom, rememberBottomIntent])

  // Re-pin a VIRTUALIZED list to a saved CONTENT ANCHOR and keep it pinned as rows measure — the
  // restore counterpart of pinVirtualizedBottom. A one-shot scrollToIndex(anchor,'end') lands on the
  // rows' estimated sizes; they then measure taller and the anchor drifts below the fold (see the
  // RESTORE_* constants). Re-deriving the anchor's pixel target each frame (align:'end' + the saved
  // fraction, both from CURRENT measurements) lands it on settled layout. Registering the loop in
  // reassertLoopRef makes handleScroll treat these scrolls as programmatic — so the drifting
  // transient is NOT saved (which is what made the drift compound across re-opens). Bails on a user
  // scroll or a conversation switch; converges (and stops early) once the landing position is stable.
  const pinVirtualizedAnchor = useCallback((anchor: ScrollAnchor, anchorConvId: string) => {
    const scroller = scrollerRef.current
    if (!virtualizerRef.current || !scroller) return

    supersedeReassertLoopRef.current()

    // Re-derive and apply the anchor's pixel position from the CURRENT measured layout. Returns the
    // resulting scrollTop, or null when the anchor row is no longer resolvable.
    const applyAnchor = (): number | null => {
      const v = virtualizerRef.current
      const s = scrollerRef.current
      if (!v || !s) return null
      const idx = v.getIndexForMessageId(anchor.messageId)
      if (idx === null) return null
      v.scrollToIndex(idx, { align: 'end' })
      if (anchor.fraction < 1) {
        const start = v.getOffsetForMessageId(anchor.messageId)
        const size = v.getVirtualItems().find((vi) => vi.index === idx)?.size
        if (start !== null && size) {
          v.scrollToOffset(Math.max(0, start + anchor.fraction * size - s.clientHeight))
        }
      }
      return s.scrollTop
    }

    // Immediate pin (pre-paint when called from the restore path's layout effect).
    applyAnchor()

    const startedAt = Date.now()
    const loop = (reassertMonitorRef.current ??= createReassertLoopMonitor()).begin('restore-anchor', performance.now())
    let framesLeft = RESTORE_REASSERT_FRAMES
    let stableFrames = 0
    let landed = -1
    const finish = () => {
      loop.end()
      reassertLoopRef.current = null
      // Capture the settled position so a leave right after restore saves the anchor we LANDED on,
      // not a mid-settle transient.
      const s = scrollerRef.current
      if (s) {
        isAtBottomRef.current = (s.scrollHeight - s.scrollTop - s.clientHeight) < AT_BOTTOM_THRESHOLD
        rememberCurrentScrollSnapshot()
      }
    }
    const step = () => {
      const s = scrollerRef.current
      if (!s) { finish(); return }
      if (framesLeft-- <= 0) { finish(); return }
      // Stale loop must never scroll the new conversation (prevConversationRef is set synchronously
      // at the end of the conversation-switch effect).
      if (prevConversationRef.current !== anchorConvId) { finish(); return }
      // User took over → stop fighting them.
      if (userScrollIntentAtRef.current > startedAt) { finish(); return }

      const st = applyAnchor()
      if (st === null) { finish(); return }

      let wrote = false
      if (landed >= 0 && Math.abs(st - landed) <= RESTORE_DRIFT_PX) {
        if (++stableFrames >= RESTORE_STABLE_FRAMES) { finish(); return }
      } else {
        wrote = true
        stableFrames = 0
      }
      landed = st

      const warning = loop.frame(performance.now(), wrote)
      if (warning) console.warn(warning)
      reassertLoopRef.current = { raf: requestAnimationFrame(step), handle: loop }
    }
    reassertLoopRef.current = { raf: requestAnimationFrame(step), handle: loop }
  }, [isAtBottomRef, rememberCurrentScrollSnapshot])

  const restoreSavedPosition = useCallback((source: 'entry' | 'retry'): RestoreSavedPositionResult => {
    const scroller = scrollerRef.current
    if (!scroller) return 'pending'

    const savedPos = scrollStateManager.getSavedScrollTop(conversationId)
    const savedAnchor = scrollStateManager.getSavedAnchor(conversationId)
    const hasSavedState = savedPos !== null || savedAnchor !== null

    if (!hasSavedState) {
      // No saved scrolled-up position → caller scrolls to bottom. This is the silent path behind a
      // "jumps to bottom on return" report: it means the leave-side SAVE did not persist a
      // scrolled-up anchor (saved as wasAtBottom, throttled-out, or cleared as stale). Log it so the
      // trace shows restore was ASKED to restore but had nothing to restore TO — distinct from a
      // restore that ran and landed wrong.
      debugLog('RESTORE: no saved state, scrolling to bottom', { source, conversationId })
      return 'bottom'
    }

    // Rooms often mount once with a loading/empty message set, then hydrate from
    // cache/MAM. A saved scrolled-up position is still valid, just not restorable
    // until there is at least one row/virtualizer item to target.
    if (messageCount === 0 || !firstMessageId) {
      isAtBottomRef.current = false
      debugLog('RESTORE pending (no rows yet)', { source, savedPos, savedAnchor })
      return 'pending'
    }

    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
    const virtRestore = virtualizerRef.current
    const finishRestore = (
      action: string,
      data: Record<string, unknown>
    ): RestoreSavedPositionResult => {
      isAtBottomRef.current = getDistanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD
      rememberCurrentScrollSnapshot()
      debugLog(action, { source, ...data })
      return 'restored'
    }

    // The saved anchor message is not in the currently-loaded window (the user had scrolled deep
    // into history, so it sits OLDER than the latest-N slice rehydrated on activation). Request the
    // cache slice that CONTAINS it; the merge grows messageCount, which re-runs this restore via the
    // retry effect, and the anchor then resolves through the virtualizer-index path below. Without
    // this the restore fell through to the saved scrollTop on the short rehydrated list and landed
    // near the top at the load-more trigger — the reported bug. Returns true while the load should
    // hold the restore in 'pending'; false when there's no loader or the load already completed
    // without recovering the anchor (then the legacy fallbacks run).
    const requestAnchorAroundLoad = (anchorMessageId: string): boolean => {
      const loader = latestRef.current.onLoadAround
      if (!loader) return false
      const key = `${conversationId}:${anchorMessageId}`
      const status = aroundLoadStatusRef.current.get(key)
      if (status === 'done') return false
      if (status === 'loading') return true
      aroundLoadStatusRef.current.set(key, 'loading')
      isAtBottomRef.current = false
      debugLog('RESTORE: anchor not loaded, requesting cache slice around it', { source, anchorMessageId, conversationId })
      void Promise.resolve(loader(anchorMessageId)).finally(() => {
        aroundLoadStatusRef.current.set(key, 'done')
        // The merge bumps messageCount → the retry effect re-runs restore. Force one attempt too,
        // covering the empty-slice case (anchor not in cache → no count change → no retry) so the
        // restore can fall through to its bottom fallback instead of hanging in 'pending'.
        if (pendingRestoreConversationRef.current === conversationId) {
          restoreSavedPositionRef.current?.('retry')
        }
      })
      return true
    }

    // Exact restore when the layout is UNCHANGED since save (same-session navigate-back, including
    // eviction+rehydrate that reproduces identical content): the saved scrollTop is exact and
    // layout-independent precisely because the content is the same, so the ratio-based anchor isn't
    // needed — and a corrupt/degenerate anchor can't override a perfectly good saved position (the
    // "jump to bottom on return" report). The fraction anchor below is for a CHANGED height (MAM
    // prepend, width change). Tolerance covers sub-pixel measurement noise only.
    const savedHeight = scrollStateManager.getSavedScrollHeight(conversationId)
    const savedWidth = scrollStateManager.getSavedClientWidth(conversationId)
    // A width change rewraps bubbles, so the absolute scrollTop is meaningless even if the total
    // height coincidentally matches — only take the exact fast-path when the width is unchanged (or
    // unknown, for legacy saves). Otherwise fall through to the rendering-independent fraction anchor.
    const widthUnchanged = savedWidth === null || scroller.clientWidth === savedWidth
    if (
      savedPos !== null &&
      savedHeight !== null &&
      widthUnchanged &&
      Math.abs(scroller.scrollHeight - savedHeight) <= 4
    ) {
      if (virtRestore) virtRestore.scrollToOffset(savedPos)
      else scroller.scrollTop = savedPos
      return finishRestore('RESTORE via savedPos (layout unchanged)', { savedPos, savedHeight, savedWidth })
    }

    if (savedAnchor && restoreToAnchor(scroller, savedAnchor)) {
      if (virtRestore) virtRestore.scrollToOffset(scroller.scrollTop)
      return finishRestore('RESTORE via anchor', { savedAnchor })
    }

    if (virtRestore && savedAnchor) {
      const anchorIndex = virtRestore.getIndexForMessageId(savedAnchor.messageId)
      if (anchorIndex !== null) {
        // Position the anchor's bottom at the viewport bottom (align:'end') refined to the saved
        // fraction, and KEEP it pinned across frames as the just-windowed rows measure taller. A
        // one-shot landing here drifts older (and compounds across re-opens) because it lands on
        // estimated sizes — see pinVirtualizedAnchor / the RESTORE_* constants.
        pinVirtualizedAnchor(savedAnchor, conversationId)
        return finishRestore('RESTORE via virtualizer index', { savedAnchor, anchorIndex })
      }

      // Anchor is older than the loaded window — pull in the slice that contains it, then retry.
      if (requestAnchorAroundLoad(savedAnchor.messageId)) {
        return 'pending'
      }

      if (savedPos !== null) {
        virtRestore.scrollToOffset(savedPos)
        return finishRestore('RESTORE via savedPos (virt, anchor not indexed)', { savedPos })
      }

      debugLog('RESTORE: anchor not indexed, no savedPos, scrolling to bottom', { source, savedAnchor })
      reassertBottom()
      return 'bottom'
    }

    // Non-virtualized: all loaded rows are in the DOM, so a missing anchor row means the anchor
    // isn't loaded. Pull in its slice and retry before falling back to the saved scrollTop.
    if (!virtRestore && savedAnchor && requestAnchorAroundLoad(savedAnchor.messageId)) {
      return 'pending'
    }

    if (virtRestore && savedPos !== null) {
      // Virtualized, no anchor: use savedPos without bounds check because the
      // initial estimated scrollHeight may be smaller than the real saved offset.
      virtRestore.scrollToOffset(savedPos)
      return finishRestore('RESTORE via savedPos (virtualized, no anchor)', { savedPos })
    }

    if (savedPos !== null && savedPos <= maxScrollTop && maxScrollTop > 0) {
      scroller.scrollTop = savedPos
      return finishRestore('RESTORE via savedPos', { savedPos })
    }

    debugLog('RESTORE out of bounds / anchor missing, scrolling to bottom', {
      source, savedPos, maxScrollTop, scrollHeight: scroller.scrollHeight,
    })
    reassertBottom()
    return 'bottom'
  }, [
    conversationId,
    firstMessageId,
    isAtBottomRef,
    messageCount,
    pinVirtualizedAnchor,
    reassertBottom,
    rememberCurrentScrollSnapshot,
  ])

  // Stable handle so the async around-load completion can re-run restore (see
  // requestAnchorAroundLoad) without restoreSavedPosition depending on itself. Updated each render.
  restoreSavedPositionRef.current = restoreSavedPosition

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
    // Deliberate user action → open the save gate so the resulting position persists.
    userHasScrolledSinceEntryRef.current = true

    // Two-step behavior: scroll to the new message marker only when it exists AND
    // is still further down than the current viewport (not yet visible). Otherwise —
    // including when the marker is already on screen or scrolled above — go straight
    // to the bottom. This is a live position check rather than a one-shot latch, so a
    // single click always makes progress toward the bottom: no wasted click when the
    // user is already sitting at the marker (e.g. right after opening a conversation,
    // where the init effect auto-scrolls to the marker).
    if (firstNewMessageId) {
      const virt = latestRef.current.virtualizer
      // Two-step: scroll to the marker first, then bottom on a second click.
      // Virtualized: use getIndexForMessageId (works for unmounted rows) + scrollToIndex.
      // Non-virtualized: DOM querySelector + offsetTop (all rows are always mounted).
      if (virt) {
        const markerIdx = virt.getIndexForMessageId(firstNewMessageId)
        if (markerIdx !== null) {
          const markerOffset = virt.getOffsetForMessageId(firstNewMessageId)
          const viewportBottom = scroller.scrollTop + scroller.clientHeight
          if (markerOffset === null || markerOffset > viewportBottom) {
            virt.scrollToIndex(markerIdx, { align: 'start', behavior: 'smooth' })
            return
          }
        }
      } else {
        const messageElement = scroller.querySelector(`[data-message-id="${CSS.escape(firstNewMessageId)}"]`)
        if (messageElement) {
          const elementTop = (messageElement as HTMLElement).offsetTop
          const viewportBottom = scroller.scrollTop + scroller.clientHeight
          if (elementTop > viewportBottom) {
            scroller.scrollTo({ top: Math.max(0, elementTop - scroller.clientHeight / 3), behavior: 'smooth' })
            return
          }
        }
      }
    }

    if (firstNewMessageId) {
      clearFirstNewMessageId?.()
    }

    const virtFab = latestRef.current.virtualizer
    if (virtFab && virtFab.itemCount > 0) {
      reassertBottom()
      return
    }

    rememberBottomIntent()
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [firstNewMessageId, clearFirstNewMessageId, reassertBottom, rememberBottomIntent])

  const scrollToTop = useCallback(() => {
    lastLoadTimeRef.current = Date.now() // prevent auto-load trigger
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // Re-pin to the bottom when the VIEWPORT itself shrinks (or grows) under a list
  // that is following along — most importantly when the mobile on-screen keyboard
  // deploys. The keyboard shrinks the scroller's clientHeight WITHOUT changing the
  // content height, so the content ResizeObserver above never fires and the latest
  // message slides out of view behind the composer/keyboard. window 'resize' fires
  // when the layout viewport resizes (Android, resizing webviews); visualViewport
  // 'resize' covers the overlay-keyboard case (iOS). Reasserts directly (no rAF
  // coalescing) to match the new-message / typing re-pin sites — a window 'resize'
  // handler is not a ResizeObserver callback, so a synchronous scroll write here is
  // safe. Gated on isAtBottomRef so a reader who scrolled up to history is not
  // yanked back down.
  useEffect(() => {
    if (staticMode) return
    const onViewportResize = () => {
      if (isAtBottomRef.current) reassertBottom()
    }
    window.addEventListener('resize', onViewportResize)
    const vv = window.visualViewport
    vv?.addEventListener('resize', onViewportResize)
    return () => {
      window.removeEventListener('resize', onViewportResize)
      vv?.removeEventListener('resize', onViewportResize)
    }
  }, [staticMode, isAtBottomRef, reassertBottom])

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

    // Capture snapshot on first load in batch (user's intent at start of batch). Also snapshot the
    // bottom-most-visible reading anchor BEFORE the media grows the layout, so a scrolled-up reader
    // can be re-pinned to it once the batch settles (media above the viewport would otherwise push
    // their position down/out — the conversation-switch "drifts back in time" bug).
    if (!mediaLoadSnapshotRef.current) {
      mediaLoadSnapshotRef.current = {
        wasAtBottom: isAtBottomRef.current,
        userScrolled: false,
        anchor: findBottomAnchor(scroller),
      }
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

      const { wasAtBottom, userScrolled, anchor } = mediaLoadSnapshotRef.current

      if (wasAtBottom) {
        if (!userScrolled) {
          // User didn't scroll during the batch - scroll to bottom
          debugLog('MEDIA LOAD: batch complete, scrolling to bottom', {
            wasAtBottom,
            userScrolled,
            scrollHeight: currentScroller.scrollHeight,
          })
          reassertBottom()
        } else {
          // User actively scrolled during the batch - respect their position
          debugLog('MEDIA LOAD: batch complete, user scrolled away', {
            wasAtBottom,
            userScrolled,
          })
        }
      } else if (!userScrolled && anchor) {
        // Scrolled up and the user did NOT genuinely scroll during the batch: media that decoded
        // ABOVE the viewport grew the content and pushed the reading position down/out. Re-pin to the
        // anchor captured BEFORE the growth so the reader stays put (the conversation-switch + media
        // "drifts back in time" bug). Mirrors the at-bottom reassertBottom, but for a held position.
        debugLog('MEDIA LOAD: batch complete, re-anchoring scrolled-up position', {
          wasAtBottom,
          anchorId: anchor.messageId,
        })
        if (virtualizerRef.current) pinVirtualizedAnchor(anchor, conversationId)
        else restoreToAnchor(currentScroller, anchor)
      } else {
        debugLog('MEDIA LOAD: batch complete, was not at bottom (user scrolled / no anchor)', {
          wasAtBottom,
          userScrolled,
        })
      }

      // Clear for next batch
      mediaLoadSnapshotRef.current = null
      mediaLoadDebounceRef.current = null
    }, MEDIA_LOAD_DEBOUNCE_MS)
  }, [isAtBottomRef, reassertBottom, pinVirtualizedAnchor, conversationId])

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
    const { scrollTop, scrollHeight, clientHeight, clientWidth } = el
    const distFromBottom = scrollHeight - scrollTop - clientHeight

    // A programmatic re-assert loop (marker positioning / pin-bottom / prepend / anchor restore)
    // owns scrollTop while it runs — scroll events fired during it are NOT the user.
    const programmaticScroll = reassertLoopRef.current !== null

    // Update refs (NO React state updates here except FAB)
    lastScrollDataRef.current = { top: scrollTop, height: scrollHeight, client: clientHeight, width: clientWidth }
    // Capture the bottom-most-visible anchor on every scroll event (binary search,
    // cheap) so it reflects the latest position — at switch time the DOM is already
    // the new conversation, so this must be captured live during scroll.
    lastAnchorRef.current = findBottomAnchor(el)
    // Do NOT recompute at-bottom from a GROWTH-driven scroll event fired while a programmatic loop
    // owns scrollTop. The pin-bottom comment's assumption that "programmatic growth doesn't move
    // scrollTop, so it never flips isAtBottom" is FALSE on WebKitGTK (Tauri): when the just-pinned
    // bottom row measures taller than its estimate AFTER paint (a group-START send — avatar + sender
    // header, ± a date separator — or media), scrollHeight grows and the engine fires a 'scroll'
    // event at the same scrollTop, so distFromBottom is transiently large. Reading it here flipped
    // isAtBottomRef false and the pin loop BAILED, stranding the send below the fold (the reported
    // Tauri send-stick bug). We skip the write ONLY when a loop is running AND scrollHeight grew —
    // the measurement-noise signature. A genuine user scroll-UP during a loop (e.g. scrolling back
    // while the entry pin is still settling) leaves scrollHeight unchanged, so it still registers
    // and correctly flips isAtBottom false. The loops also detect deliberate takeover via
    // userScrollIntentAtRef. Mirrors the same height-unchanged discriminator used by the save gate.
    const growthDrivenDuringLoop =
      programmaticScroll && prevScrollHeightRef.current !== null && scrollHeight > prevScrollHeightRef.current
    if (!growthDrivenDuringLoop) {
      isAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD
    }

    // Track user scroll during a media load batch — but ONLY a GENUINE user scroll, not the
    // measurement/growth-driven scroll events the media itself produces (same height-unchanged +
    // not-programmatic discriminator the save gate below uses). A growth event marking userScrolled
    // is exactly what made the media handler "respect" a position the user never moved — leaving the
    // view drifted (at the bottom: no re-pin; scrolled up: no re-anchor).
    if (mediaLoadSnapshotRef.current && !programmaticScroll && prevScrollHeightRef.current === scrollHeight) {
      mediaLoadSnapshotRef.current.userScrolled = true
    }

    // FAB visibility (only React state in scroll handler)
    const shouldShowFab = distFromBottom > FAB_THRESHOLD
    setShowScrollToBottom(prev => prev !== shouldShowFab ? shouldShowFab : prev)

    // `programmaticScroll` (computed above) also gates the marker-clear and position-save below: a
    // re-assert loop owns scrollTop while it runs, so its scroll events must not (a) clear the marker
    // (the marker-positioning loop scrolls TO the marker, momentarily landing at/near the bottom for
    // a last-message marker, which would trip the "reached bottom" clear), nor (b) save the position
    // (the transient scrollTop:0 of the virtualized initial render was saved as a "scrolled-up"
    // position, poisoning the next re-entry into restore-position and bypassing the marker entirely).

    // Open the save gate when this is a genuine user scroll: content height UNCHANGED from the
    // previous scroll event (a media/measurement-driven shift changes the height; a wheel / touch /
    // scrollbar-drag does not). Complements the input-event listeners so scrollbar-drag — which
    // fires no wheel/touch — also counts. Programmatic loop scrolls are excluded.
    if (!programmaticScroll && prevScrollHeightRef.current === scrollHeight) {
      userHasScrolledSinceEntryRef.current = true
    }
    prevScrollHeightRef.current = scrollHeight

    // Clear new message marker when user scrolls past it or reaches the bottom.
    // Skip on the very first scroll events after marker setup to avoid clearing
    // the marker before the user has a chance to see it.
    if (firstNewMessageId && clearFirstNewMessageId && !programmaticScroll) {
      const recentUserScrollIntent =
        userScrollIntentAtRef.current > 0 && Date.now() - userScrollIntentAtRef.current < 1500
      if (
        !userHasScrolledSinceMarkerRef.current &&
        !(distFromBottom < AT_BOTTOM_THRESHOLD && recentUserScrollIntent)
      ) {
        // First scroll after marker was set — arm the flag for next time
        userHasScrolledSinceMarkerRef.current = true
        debugLog('MARKER CLEAR armed (first scroll)', { firstNewMessageId, distFromBottom })
      } else if (distFromBottom < AT_BOTTOM_THRESHOLD) {
        // User reached the bottom — all new messages are visible
        debugLog('MARKER CLEAR (reached bottom)', { firstNewMessageId, distFromBottom })
        clearFirstNewMessageId()
      } else {
        const escapedId = CSS.escape(firstNewMessageId)
        const markerEl = el.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null
        if (markerEl) {
          const scrollerRect = el.getBoundingClientRect()
          const markerRect = markerEl.getBoundingClientRect()
          // Marker is "scrolled past" when its bottom edge is above the viewport
          if (markerRect.bottom < scrollerRect.top) {
            debugLog('MARKER CLEAR (scrolled past)', { firstNewMessageId })
            clearFirstNewMessageId()
          }
        } else {
          // Marker element not in DOM (trimmed) — clear it
          debugLog('MARKER CLEAR (not in DOM/trimmed)', { firstNewMessageId, distFromBottom })
          clearFirstNewMessageId()
        }
      }
    }

    // Save position for cross-conversation persistence (throttled). Capture the
    // bottom-most-visible anchor here too — throttled so the DOM query is bounded,
    // and during scroll because at switch time the DOM is already the new room.
    // Skipped while a programmatic loop is positioning the list (see programmaticScroll above):
    // saving the transient entry position would poison the next re-entry's restore decision.
    // Also skipped until the user has GENUINELY scrolled this entry: a post-restore scroll caused
    // by media/measurement settling must not overwrite the saved anchor (that drift compounded
    // across re-opens — see userHasScrolledSinceEntryRef).
    const now = Date.now()
    if (!programmaticScroll && userHasScrolledSinceEntryRef.current && now - lastSaveTimeRef.current > SAVE_THROTTLE_MS) {
      lastSaveTimeRef.current = now
      scrollStateManager.saveScrollPosition(conversationId, scrollTop, scrollHeight, clientHeight, lastAnchorRef.current ?? undefined, clientWidth)
    }

    // Track if user scrolled away from top (allows re-trigger of load)
    if (scrollTop > 50) scrolledAwayFromTopRef.current = true

    // Auto-trigger load when at top (disabled in static mode — preview starts at scrollTop=0).
    // Gate on scrolledAwayFromTop: a PASSIVE scroll reaching the top must only auto-load when the
    // user genuinely scrolled up to it (was away from the top and returned). On a fresh entry the
    // list briefly renders at scrollTop=0 before the auto-scroll-to-bottom settles; that transient
    // must NOT spuriously load older — doing so prepends a batch and clears isAtBottom, breaking
    // bottom-stick for the next incoming message. A wheel-up (handleWheel) is explicit intent and
    // is intentionally NOT gated this way.
    if (scrollTop === 0 && !staticMode && scrolledAwayFromTopRef.current) triggerLoadOlder()
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // A wheel is a deliberate user scroll — record it so the prepend re-assert loop yields if
    // the user keeps scrolling after a load (rather than fighting a content-shrink clamp). The
    // wheel that triggers the load itself is recorded BEFORE the loop starts, so it won't bail.
    userScrollIntentAtRef.current = Date.now()
    // Genuine user scroll → open the save gate (see userHasScrolledSinceEntryRef). Mirrors the
    // native wheel listener; kept here so it fires even when wheel arrives via the React handler.
    userHasScrolledSinceEntryRef.current = true
    const { scrollTop } = e.currentTarget
    if (scrollTop === 0 && e.deltaY < 0 && !staticMode) triggerLoadOlder()
    if (scrollTop === 0 && e.deltaY > 0) scrolledAwayFromTopRef.current = true
  }

  // Mount marker (diagnostic). Fires once when the message view is freshly created — i.e. after a
  // navigation that UNMOUNTED it (Settings, DM↔Room, back-to-list). Pairs with 'UNMOUNT
  // leaveConversation (save)' so the trace shows the full tear-down → rebuild cycle around a screen
  // change. A DM↔DM switch does NOT mount fresh (no marker here), only the conversation-switch
  // effect fires — that absence is itself the signal for which navigation path ran.
  const mountLoggedRef = useRef(false)
  useEffect(() => {
    if (mountLoggedRef.current) return
    mountLoggedRef.current = true
    debugLog('MOUNT', { conversationId, messageCount, virtualized: !!virtualizerRef.current, staticMode })
  }, [conversationId, messageCount, staticMode])

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

    // LEAVING old conversation - save position, but ONLY if the user genuinely scrolled it this
    // visit. Otherwise keep its existing saved anchor untouched (markAsLeft): the live scroll data
    // may have drifted from media/measurement after the restore, and persisting it would make the
    // position creep older on the next open (see userHasScrolledSinceEntryRef).
    if (prevConversationRef.current && lastScrollDataRef.current && userHasScrolledSinceEntryRef.current) {
      const { top, height, client, width } = lastScrollDataRef.current
      scrollStateManager.leaveConversation(prevConversationRef.current, top, height, client, lastAnchorRef.current ?? undefined, width)
    } else if (prevConversationRef.current) {
      scrollStateManager.markAsLeft(prevConversationRef.current)
    }

    // ENTERING new conversation - reset state
    hasInitializedRef.current = false
    userHasScrolledSinceMarkerRef.current = false
    scrolledAwayFromTopRef.current = false
    lastScrollDataRef.current = null
    lastAnchorRef.current = null
    prependRef.current = null
    pendingRestoreConversationRef.current = null
    // Returning to this conversation later must be free to re-request its anchor slice.
    aroundLoadStatusRef.current.clear()
    // Fresh entry: the saved position is locked until the user genuinely scrolls (see the ref).
    userHasScrolledSinceEntryRef.current = false
    prevScrollHeightRef.current = null
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
      // Diagnostic only: is this the FIRST open of this conversation this session? (Captured BEFORE
      // enterConversation, which flips the manager's `initialized` flag.) The "synced marker only on
      // first open" concern is handled at the SOURCE — the SDK gates the XEP-0490 entry fold to the
      // first activation per session (chatStore/roomStore), so the divider here already reflects the
      // intended read position. Gating the scroll branch on first-open was the wrong layer: it could
      // not distinguish a stale/synced marker from a genuine "new message arrived while away" marker
      // and suppressed the latter on re-entry. See
      // docs/superpowers/specs/2026-06-29-mds-sync-marker-first-open-design.md.
      const firstOpenThisSession = !scrollStateManager.isInitialized(conversationId)

      // Decide: restore position or scroll to bottom?
      const action = scrollStateManager.enterConversation(conversationId, messageCount)
      const savedPos = scrollStateManager.getSavedScrollTop(conversationId)

      debugLog('CONVERSATION ACTION', { action, savedPos, firstOpenThisSession, scrollHeight: scroller.scrollHeight })

      if (action === 'restore-position') {
        const restoreResult = restoreSavedPosition('entry')
        pendingRestoreConversationRef.current =
          restoreResult === 'pending' ? conversationId : null
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
        // Single-flight (shared with pin-bottom / prepend): the marker positioning loop owns
        // scrollTop while it runs, so it supersedes any in-flight re-assert and registers itself.
        supersedeReassertLoopRef.current()
        const markerLoop = (reassertMonitorRef.current ??= createReassertLoopMonitor()).begin('marker', performance.now())
        const finishMarker = () => {
          markerLoop.end()
          reassertLoopRef.current = null
        }
        let framesLeft = MARKER_REASSERT_FRAMES
        let stableFrames = 0
        let landedTarget = -1
        let resolved = false
        const stepToMarker = () => {
          if (framesLeft-- <= 0) {
            // Marker never resolved at all (e.g. trimmed from the loaded set) — don't strand the
            // view at the top; fall back to the bottom. End first so the handoff to reassertBottom
            // (which begins a pin-bottom loop) is not miscounted as an overlap.
            finishMarker()
            if (!resolved) reassertBottom()
            return
          }
          const s = scrollerRef.current
          if (!s) { finishMarker(); return }
          // Conversation switched away while this loop was still running → stop (a stale loop must
          // never scroll the new conversation). prevConversationRef is set synchronously below.
          if (prevConversationRef.current !== markerConvId) { finishMarker(); return }
          // User took over (FAB/wheel) or scrolled away from where we landed → stop fighting them.
          if (userScrollIntentAtRef.current > startedAt) { finishMarker(); return }
          if (landedTarget >= 0 && Math.abs(s.scrollTop - landedTarget) > FAB_THRESHOLD) { finishMarker(); return }

          const viewportHeight = s.clientHeight
          const v = latestRef.current.virtualizer
          const markerIndex = v ? v.getIndexForMessageId(markerId) : null
          let offset: number | null = null
          if (v) {
            offset = v.getOffsetForMessageId(markerId)
          } else {
            const el = s.querySelector(`[data-message-id="${CSS.escape(markerId)}"]`) as HTMLElement | null
            if (el) offset = el.offsetTop
          }

          let wrote = false
          if (offset != null && (!v || markerIndex != null)) {
            resolved = true
            // Marker sits in the top third of the content (vh/3-from-top would be above the content
            // top, so the only valid scroll target is 0). Scrolling to 0 would spuriously fire
            // triggerLoadOlder (handleScroll keys load-older on scrollTop===0) and churn — the
            // regression that consumed the older-message backlog on entry. This is the all/mostly-
            // unread case; fall back to the bottom (the prior behavior) rather than paginating.
            if (offset <= viewportHeight / 3) {
              isAtBottomRef.current = true
              finishMarker()
              reassertBottom()
              return
            }
            // Position the marker row via the virtualizer's measurement-aware scrollToIndex.
            // A raw scrollToOffset to the ESTIMATED offset lands SHORT and never windows the marker
            // row in, so its height never measures and the offset estimate never sharpens — the loop
            // then sees a "stable" (wrong) target and stops with the marker stranded below the fold
            // (the bug). scrollToIndex windows the marker region in (mount + measure), so each frame
            // lands closer and re-asserting converges, exactly like pinVirtualizedBottom. align:'start'
            // puts the divider near the top to read forward, and clamps to the bottom when the marker
            // is the last message (so a single new message lands at the bottom, fully visible).
            if (v) v.scrollToIndex(markerIndex!, { align: 'start' })
            else s.scrollTop = Math.max(0, offset - viewportHeight / 3)

            const st = s.scrollTop
            // Converged when the landing position stops moving (rows have finished measuring).
            if (landedTarget >= 0 && Math.abs(st - landedTarget) <= MARKER_DRIFT_PX) {
              if (++stableFrames >= MARKER_STABLE_FRAMES) {
                finishMarker()
                return
              }
            } else {
              wrote = true
              stableFrames = 0
              const distFromBottom = s.scrollHeight - st - viewportHeight
              isAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD
              debugLog('CONVERSATION SWITCH: scrolling to new message marker', {
                firstNewMessageId: markerId, markerIndex, offset, scrollTop: st,
                distFromBottom, isAtBottom: isAtBottomRef.current,
              })
            }
            landedTarget = st
          }
          const warning = markerLoop.frame(performance.now(), wrote)
          if (warning) console.warn(warning)
          reassertLoopRef.current = { raf: requestAnimationFrame(stepToMarker), handle: markerLoop }
        }
        reassertLoopRef.current = { raf: requestAnimationFrame(stepToMarker), handle: markerLoop }
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

    // Update tracking. Sync prevLastMessageIdRef to the entered conversation's newest message so
    // the new-message effect (which keys "did the bottom change?" off lastMessageId) does not
    // mistake the switch itself for a fresh send and override the marker/restore positioning.
    hasInitializedRef.current = true
    prevConversationRef.current = conversationId
    prevMessageCountRef.current = messageCount
    prevLastMessageIdRef.current = lastMessageId

  }, [conversationId, messageCount, firstNewMessageId, targetMessageId, lastMessageId, isAtBottomRef, staticMode, pinVirtualizedBottom, reassertBottom, restoreSavedPosition])

  // Retry a saved-position restore that entered before any rows were mounted.
  // This is common for rooms: the MessageList mounts in a loading state, then
  // cache/MAM rows arrive in the same conversation id. Until the restore lands,
  // keep isAtBottom=false so the async message-count growth does not auto-pin.
  useLayoutEffect(() => {
    if (staticMode) return
    if (pendingRestoreConversationRef.current !== conversationId) return

    const restoreResult = restoreSavedPosition('retry')
    if (restoreResult !== 'pending') {
      pendingRestoreConversationRef.current = null
      prevMessageCountRef.current = messageCount
      prevLastMessageIdRef.current = lastMessageId
    }
  }, [conversationId, messageCount, lastMessageId, staticMode, restoreSavedPosition])

  // Cleanup: properly leave conversation in scrollStateManager only when the message list
  // actually unmounts. The conversation-switch effect above intentionally has broad deps
  // (message count, target, marker) so it sees the current entry state, but a cleanup attached
  // there would also run on same-conversation updates and mark the singleton manager "left"
  // while the room is still mounted.
  useLayoutEffect(() => {
    return () => {
      if (prevConversationRef.current) {
        // Same gate as the conversation-switch leave: only persist the live scroll data when the
        // user genuinely scrolled this visit; otherwise keep the existing saved anchor (markAsLeft)
        // so a media/measurement-induced post-restore drift can't be saved (see the ref).
        if (lastScrollDataRef.current && userHasScrolledSinceEntryRef.current) {
          const { top, height, client, width } = lastScrollDataRef.current
          // UNMOUNT save: this is the leave path for navigations that DESTROY the message view —
          // opening Settings, switching DM↔Room, going back to the list. (DM↔DM keeps the view
          // mounted and saves via the conversation-switch effect instead.) If `top`/anchor here are
          // stale or already at-bottom, the next entry restores wrong / jumps to bottom — so this
          // shows exactly what was persisted at the moment the screen was torn down.
          debugLog('UNMOUNT leaveConversation (save)', {
            conversationId: prevConversationRef.current,
            top, height, client,
            distFromBottom: height - top - client,
            anchorMessageId: lastAnchorRef.current?.messageId,
            anchorFraction: lastAnchorRef.current?.fraction,
          })
          scrollStateManager.leaveConversation(prevConversationRef.current, top, height, client, lastAnchorRef.current ?? undefined, width)
        } else {
          // No scroll data, or the user never scrolled this visit → don't overwrite the saved
          // position; just mark the conversation left so a return is detected as a switch.
          debugLog('UNMOUNT markAsLeft (no user scroll / no scroll data)', { conversationId: prevConversationRef.current })
          scrollStateManager.markAsLeft(prevConversationRef.current)
        }
      }
      userInputCleanupRef.current?.()
      userInputCleanupRef.current = null
    }
  }, [])

  // ==========================================================================
  // EFFECT: Scroll to target message (from activity log click, etc.)
  // ==========================================================================
  //
  // When targetMessageId is set (e.g., user clicked a reaction in the activity log),
  // scroll to that specific message. Uses the same data-message-id attribute pattern
  // as the unread marker scroll. Clears the target after consumption.

  useEffect(() => {
    if (!targetMessageId || staticMode) {
      // Target cleared (consumed or navigated away): allow a future jump to the same id to
      // re-request its slice (it may have been evicted again in the meantime).
      if (!targetMessageId) targetAroundRequestedRef.current = null
      return
    }
    const scroller = scrollerRef.current
    if (!scroller) return

    const virt = latestRef.current.virtualizer
    const escapedId = CSS.escape(targetMessageId)
    let highlightRafId: number | null = null

    const highlight = (el: Element) => {
      el.classList.add('message-highlight')
      setTimeout(() => el.classList.remove('message-highlight'), 1500)
    }

    if (virt) {
      // Virtualized: resolve the row by index (works whether or not the row is mounted)
      // and let the virtualizer window it in. No DOM query or retry timeouts needed.
      // messageCount is in deps so this effect re-fires if the message isn't in the list
      // yet (e.g., search opens a conversation before messages finish loading from cache).
      const idx = virt.getIndexForMessageId(targetMessageId)
      if (idx === null) {
        // The target isn't in the loaded window — pull in the cache slice that contains it (search /
        // activity jump to a message older than the latest-N slice). The merge grows messageCount,
        // re-firing this effect with the target now resolvable. Request once per target.
        const loader = latestRef.current.onLoadAround
        if (loader && targetAroundRequestedRef.current !== targetMessageId) {
          targetAroundRequestedRef.current = targetMessageId
          debugLog('TARGET MESSAGE: not loaded, requesting cache slice around it', { targetMessageId })
          void Promise.resolve(loader(targetMessageId))
        } else {
          debugLog('TARGET MESSAGE: not in item set yet, waiting for load', { targetMessageId })
        }
        return
      }
      const targetConvId = conversationId
      const startedAt = Date.now()
      supersedeReassertLoopRef.current()
      const targetLoop = (reassertMonitorRef.current ??= createReassertLoopMonitor()).begin('target', performance.now())
      let framesLeft = TARGET_REASSERT_FRAMES
      let stableFrames = 0
      let landedTarget = -1
      let targetRafId: number | null = null
      let finished = false
      let consumed = false

      const finishTarget = () => {
        if (finished) return
        finished = true
        targetLoop.end()
        if (reassertLoopRef.current?.handle === targetLoop) {
          if (targetRafId !== null) cancelAnimationFrame(targetRafId)
          reassertLoopRef.current = null
        }
      }

      const consumeAndHighlight = () => {
        if (consumed) return
        consumed = true
        highlightRafId = requestAnimationFrame(() => {
          const el = scrollerRef.current?.querySelector(`[data-message-id="${escapedId}"]`)
          if (el) highlight(el)
        })
        onTargetMessageConsumed?.()
      }

      const stepToTarget = () => {
        if (framesLeft-- <= 0) {
          finishTarget()
          consumeAndHighlight()
          return
        }
        const s = scrollerRef.current
        const v = latestRef.current.virtualizer
        if (!s || !v) { finishTarget(); return }
        if (prevConversationRef.current !== targetConvId) { finishTarget(); return }
        if (userScrollIntentAtRef.current > startedAt) {
          finishTarget()
          consumeAndHighlight()
          return
        }

        const currentIdx = v.getIndexForMessageId(targetMessageId)
        if (currentIdx === null) {
          finishTarget()
          return
        }

        v.scrollToIndex(currentIdx, { align: 'start' })
        const st = s.scrollTop
        const distFromBottom = s.scrollHeight - st - s.clientHeight
        isAtBottomRef.current = distFromBottom < AT_BOTTOM_THRESHOLD

        let wrote = false
        if (landedTarget >= 0 && Math.abs(st - landedTarget) <= TARGET_DRIFT_PX) {
          if (++stableFrames >= TARGET_STABLE_FRAMES) {
            finishTarget()
            consumeAndHighlight()
            return
          }
        } else {
          wrote = true
          stableFrames = 0
          debugLog('TARGET MESSAGE: reasserting virtualizer index', {
            targetMessageId,
            idx: currentIdx,
            scrollTop: st,
            distFromBottom,
            isAtBottom: isAtBottomRef.current,
          })
        }
        landedTarget = st

        const warning = targetLoop.frame(performance.now(), wrote)
        if (warning) console.warn(warning)
        targetRafId = requestAnimationFrame(stepToTarget)
        reassertLoopRef.current = { raf: targetRafId, handle: targetLoop }
      }

      debugLog('TARGET MESSAGE: scrolling via virtualizer index', { targetMessageId, idx })
      stepToTarget()

      return () => {
        finishTarget()
        if (highlightRafId !== null) cancelAnimationFrame(highlightRafId)
      }
    } else {
      // Non-virtualized: all rows are always in the DOM.
      const el = scroller.querySelector(`[data-message-id="${escapedId}"]`)
      if (!el) {
        const loader = latestRef.current.onLoadAround
        if (loader && targetAroundRequestedRef.current !== targetMessageId) {
          targetAroundRequestedRef.current = targetMessageId
          debugLog('TARGET MESSAGE: not loaded (non-virtualized), requesting cache slice around it', { targetMessageId })
          void Promise.resolve(loader(targetMessageId))
        } else {
          debugLog('TARGET MESSAGE: element not found (non-virtualized), waiting for load', { targetMessageId })
        }
        return
      }
      const elementTop = (el as HTMLElement).offsetTop
      const targetScrollTop = Math.max(0, elementTop - scroller.clientHeight / 3)
      scroller.scrollTop = targetScrollTop
      isAtBottomRef.current = (scroller.scrollHeight - targetScrollTop - scroller.clientHeight) < AT_BOTTOM_THRESHOLD
      highlight(el)
      debugLog('TARGET MESSAGE: scrolled to target', { targetMessageId, elementTop, targetScrollTop })
      onTargetMessageConsumed?.()
    }

    return () => { if (highlightRafId !== null) cancelAnimationFrame(highlightRafId) }

    // messageCount is in deps so this re-fires when messages load from async sources
    // (e.g., IndexedDB in search context view)
  }, [targetMessageId, messageCount, conversationId, isAtBottomRef, onTargetMessageConsumed, staticMode])

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

    // Account for the prepended rows in the new-message baseline. This layout effect runs BEFORE
    // the new-message effect in the same commit and flips `restored` true, so that effect no
    // longer takes its `!restored` skip branch. Without syncing the count here it would compare
    // the post-prepend messageCount against the STALE pre-prepend count, misread the load-older as
    // a new message, and (in a short conversation, where the top is still within AT_BOTTOM_THRESHOLD
    // so isAtBottom stays true) pin the view to the bottom — the reported "scroll up to the top
    // jumps back to the bottom". A genuine new message arriving later still grows the count past
    // this and scrolls normally.
    prevMessageCountRef.current = messageCount

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
    // Single-flight (shared with pin-bottom): supersede any re-assert loop still in-flight so two
    // never run at once. This loop has no early-stable exit, so a second MAM prepend (fast
    // scroll-up through history) would otherwise start a second 'prepend' loop against a different
    // anchor while this one runs; and a pin-bottom from a send can land mid-prepend. Both fight
    // over scrollTop. The latest re-assert wins.
    supersedeReassertLoopRef.current()
    const assertLoop = (reassertMonitorRef.current ??= createReassertLoopMonitor()).begin('prepend', performance.now())
    const finishAssert = () => {
      assertLoop.end()
      reassertLoopRef.current = null
    }
    const runMeasureAssert = () => {
      if (framesLeft-- <= 0) { finishAssert(); return }
      // Deliberate user scroll (FAB / wheel) since the loop started → the user took over;
      // stop re-pinning and yield. A content-shrink clamp does NOT set this, so we keep going.
      if (userScrollIntentAtRef.current > assertStartedAt) {
        debugLog('PREPEND ASSERT CANCELLED (user scroll intent)', { scrollTop: scrollerRef.current?.scrollTop })
        finishAssert()
        return
      }
      let wrote = false
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
            wrote = true
          } else if (Math.abs(scrollDrift) > 5) {
            // scrollTop diverged from the (stable) anchor target — a content-shrink clamp
            // pinned us to the bottom, or the browser nudged us. Re-pin the anchor. We do NOT
            // bail on a big drift here: that previously mistook the clamp for a user scroll and
            // left the view stuck at the bottom (the reported "jump to bottom"). Genuine user
            // scrolls are handled by the intent check at the top of the loop instead.
            virt.scrollToOffset(newTarget)
            wrote = true
          }
        }
      }
      const warning = assertLoop.frame(performance.now(), wrote)
      if (warning) console.warn(warning)
      reassertLoopRef.current = { raf: requestAnimationFrame(runMeasureAssert), handle: assertLoop }
    }
    reassertLoopRef.current = { raf: requestAnimationFrame(runMeasureAssert), handle: assertLoop }

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

    if (pendingRestoreConversationRef.current === conversationId) {
      debugLog('NEW MSG SKIP (restore pending)', {
        messageCount,
        prevCount: prevMessageCountRef.current,
      })
      isAtBottomRef.current = false
      prevMessageCountRef.current = messageCount
      prevLastMessageIdRef.current = lastMessageId
      return
    }

    // Don't interfere with prepend that's actively in progress (not yet restored)
    // Once restored, allow new message auto-scroll even during cooldown period
    if (prependRef.current && !prependRef.current.restored) {
      debugLog('NEW MSG SKIP (prepend in progress)', {
        messageCount,
        prevCount: prevMessageCountRef.current,
      })
      prevMessageCountRef.current = messageCount
      prevLastMessageIdRef.current = lastMessageId
      return
    }

    // "Did the bottom row change?" must key off the last message ID, not just messageCount: a
    // send REPLACES the optimistic last row in place (reconciled to the server id) without growing
    // the count, so a count-only check misses it and the just-sent message fails to stick to the
    // bottom. Either a count increase OR a new last-message id is a fresh bottom row.
    const countIncreased = messageCount > prevMessageCountRef.current
    const lastMessageChanged = lastMessageId !== undefined && lastMessageId !== prevLastMessageIdRef.current
    const newBottomRow = countIncreased || lastMessageChanged

    // Scroll to the bottom when a new bottom row appears AND either we're already near the bottom
    // (auto-follow) OR it's the user's own send — you always want to see what you just sent, even
    // from a scrolled-up position. An incoming message while scrolled up does NOT yank the reader.
    if (newBottomRow && (isAtBottomRef.current || lastMessageIsOutgoing)) {
      debugLog('NEW MSG SCROLL TO BOTTOM', {
        messageCount,
        prevCount: prevMessageCountRef.current,
        countIncreased,
        lastMessageChanged,
        isAtBottom: isAtBottomRef.current,
        outgoing: lastMessageIsOutgoing,
        scrollTopBefore: scroller.scrollTop,
        distFromBottomBefore:
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      })
      isAtBottomRef.current = true // a send from a scrolled-up position lands us at the bottom
      reassertBottom()
    } else if (newBottomRow) {
      debugLog('NEW MSG NO SCROLL (incoming, not at bottom)', {
        messageCount,
        prevCount: prevMessageCountRef.current,
        countIncreased,
        lastMessageChanged,
        isAtBottom: isAtBottomRef.current,
      })
    } else {
      // The effect ran but saw NO new bottom row (count unchanged AND lastMessageId unchanged).
      // This is the blind spot behind "I sent a message but it didn't scroll to the bottom": if the
      // just-sent row's props (lastMessageId / messageCount) haven't propagated by the time this
      // effect fires — e.g. an optimistic row reconciled to its server id on a later commit — the
      // send is never recognized here and (without this log) nothing is emitted at all. Logging the
      // current-vs-previous identifiers makes a missed send visible in the trace.
      debugLog('NEW MSG (no bottom-row change)', {
        messageCount,
        prevCount: prevMessageCountRef.current,
        lastMessageId,
        prevLastMessageId: prevLastMessageIdRef.current,
        outgoing: lastMessageIsOutgoing,
        isAtBottom: isAtBottomRef.current,
      })
    }

    prevMessageCountRef.current = messageCount
    prevLastMessageIdRef.current = lastMessageId
  }, [conversationId, messageCount, lastMessageId, isAtBottomRef, staticMode, lastMessageIsOutgoing, reassertBottom])

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
