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
import { createPinRunTracker, readPinRepaintMode, shouldForceRepaint } from './pinBottomRun'
import { createPinRepaintBurst, pinBurstProbeLine, type PinRepaintBurst } from './pinRepaintBurst'
import { createRenderCostProbe, type RenderCostProbe } from '@/utils/renderCostProbe'
import { isProgrammaticScroll } from './scrollGate'
import { shouldShowScrollToBottomFab } from './fabVisibility'
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
const LOAD_NEWER_THRESHOLD = 4 // px from the resident-window bottom to auto-load newer (slid-up windows)
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
// A pin run whose cumulative forced work (layout flushes + scroll writes + repaints) reaches this
// is worth one rate-limited [PinLoopProbe] line in fluux.log — it attributes the layoutPaint cost
// RenderCostProbe can only measure in aggregate. ~3 frame budgets; healthy runs stay far below.
const PIN_PROBE_THRESHOLD_MS = 50
// Pin triggers that represent NEW CONTENT landing at the bottom (as opposed to a user/layout event
// like a conversation switch, FAB tap, or viewport resize). Only these feed the repaint-burst
// coalescer: a rapid run of them — live chatter, a reaction storm, images decoding, or a reconnect
// flushing queued messages — is exactly the burst whose per-arrival forced repaints freeze WebKitGTK.
const CONTENT_ARRIVAL_TRIGGERS: ReadonlySet<string> = new Set([
  'new-message',
  'content-growth',
  'media-load',
  'reaction',
  'mam-catchup-complete',
])

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
  /** Forward-only local id of the furthest read message, including XEP-0490 sync. */
  lastSeenMessageId?: string
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
  /** Sliding window: load the next-newer cache slice when the reader scrolls back down to the
   *  bottom of a slid-up window (mirror of onScrollToTop for the newer direction). Fired only
   *  when windowAtLiveEdge is false. */
  onLoadNewer?: () => void
  isLoadingNewer?: boolean
  /** Sliding window: whether the resident window includes the newest message. `false` = slid up,
   *  which enables the load-newer trigger (the resident bottom is NOT the live edge). Absent/true
   *  ⇒ at the live edge — unchanged behavior. */
  windowAtLiveEdge?: boolean
  isHistoryComplete?: boolean
  /** Signature of the reactions across the resident window. Changes when a reaction is added/removed on
   *  ANY row (growing/shrinking it); drives an instant bottom re-pin while the reader is sticked to the
   *  bottom, so the growth is absorbed above (previous messages scroll up) instead of shoving the
   *  newest message down. */
  reactionsSignature: string
  /** Whether the floating typing-indicator pill is currently shown. The footer reserves extra bottom
   *  padding to clear the pill only while this is true; the 0→true edge drives the same instant
   *  bottom re-pin as a reaction growing a row, gated on live geometry (see the reactions
   *  effect) so it never fires for a reader scrolled up into history — the #918 "fight" was a stale
   *  isAtBottomRef latch, not the padding change itself. */
  hasTypingIndicator?: boolean
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
  /** Whether the first-new-message divider is currently scrolled above the viewport. Drives the
   *  jump-to-last-read pill. */
  markerAboveViewport: boolean
  /** Id of the bottom-most message whose top is within the viewport (the row peeking in at the
   *  bottom edge), or null before the first scroll (or during programmatic positioning — see the
   *  handleScroll gate). Drives the divider-snap trigger in MessageList (snap the "New messages"
   *  divider to the read pointer on genuine user scroll); the FAB badge count reads the pointer
   *  directly instead. */
  bottomVisibleMessageId: string | null
  /** Scroll to (and re-assert toward) the first-new-message marker. Used by the jump-to-last-read
   *  pill's click handler; also the routine the conversation-switch entry effect uses. No-op when
   *  there is no current marker. */
  scrollToMarker: () => void
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
  lastSeenMessageId,
  clearFirstNewMessageId,
  targetMessageId,
  onTargetMessageConsumed,
  externalScrollerRef,
  externalIsAtBottomRef,
  onScrollToTop,
  onLoadAround,
  isLoadingOlder,
  onLoadNewer,
  isLoadingNewer,
  windowAtLiveEdge,
  isHistoryComplete,
  reactionsSignature,
  hasTypingIndicator = false,
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
  // True while a pin-bottom re-assert loop is in flight. The typing/reactions re-pin defers to an
  // active loop (it re-checks scrollHeight every frame and picks the change up itself) instead of
  // restarting it — the restart's synchronous forced layout + repaint is the WebKitGTK hot path.
  const pinBottomActiveRef = useRef(false)
  // Rate-limits the [PinLoopProbe] fluux.log line to one per cooldown (like RenderCostProbe).
  const pinRunProbeRef = useRef<RenderCostProbe | null>(null)
  // Coalesces forced repaints across a BURST of content-arrival pins (each superseding the last).
  // On WebKitGTK the overflow-toggle repaint is ~50–150ms; without this, a burst of new messages /
  // reactions / images fires one per arrival and freezes the main thread. Suppresses the
  // intermediate repaints (scroll position still written, layout stays correct) and forces exactly
  // one trailing repaint once arrival quiesces — see pinRepaintBurst.ts.
  const pinRepaintBurstRef = useRef<PinRepaintBurst | null>(null)
  // Supersede any in-flight re-assert loop. Held in a ref (read as `.current()`) so callers in
  // useCallback / useLayoutEffect don't need it as a dependency — react-hooks treats refs as stable.
  const supersedeReassertLoopRef = useRef(() => {
    if (reassertLoopRef.current) {
      cancelAnimationFrame(reassertLoopRef.current.raf)
      reassertLoopRef.current.handle.end()
      reassertLoopRef.current = null
    }
    pinBottomActiveRef.current = false
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

  // Latest MAM-loading state (forward catch-up on entry, or backward "load older" pagination) for
  // the active conversation, read imperatively inside pinVirtualizedBottom's stable useCallback —
  // see the repaint-suppression note in writePin below. Updated synchronously in the render body
  // (same pattern as virtualizerRef) so it is never stale when the pin loop reads it mid-run.
  const isLoadingOlderRef = useRef(isLoadingOlder)
  isLoadingOlderRef.current = isLoadingOlder

  // Track conversation
  const prevConversationRef = useRef<string | null>(null)
  const prevMessageCountRef = useRef(0)
  const prevLastMessageIdRef = useRef<string | undefined>(lastMessageId)
  const hasInitializedRef = useRef(false)
  const pendingRestoreConversationRef = useRef<string | null>(null)
  const pendingSyncedLiveEdgeRef = useRef<{
    conversationId: string
    savedReadPositionId: string | undefined
  } | null>(null)
  const previousReadPositionRef = useRef(lastSeenMessageId)
  useEffect(() => {
    previousReadPositionRef.current = lastSeenMessageId
  }, [conversationId, lastSeenMessageId])
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
  // Timestamp of the last programmatic scroll WRITE (one-shot restore, or the frame the re-pin loop
  // ends). Scroll events within PROGRAMMATIC_SETTLE_MS of it are the virtualizer's measurement settle,
  // not the user, so they must NOT open the save gate — see scrollGate.isProgrammaticScroll. Without
  // it, that settle (height unchanged, no loop running) looks exactly like a scrollbar drag, opens the
  // gate, and the drifted position is persisted → the reading position creeps older on every re-open.
  const lastProgrammaticScrollAtRef = useRef(0)
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
  // Mirror of scrolledAwayFromTopRef for the newer direction: only auto-load newer once the reader
  // has genuinely scrolled away from the resident bottom and returned to it (guards spurious fires).
  const scrolledAwayFromBottomRef = useRef(false)
  // Tracks the previous windowAtLiveEdge so we can detect the false→true transition (returning to
  // the live edge) and drop a stale prepend/append anchor — see the effect below.
  const prevWindowAtLiveEdgeRef = useRef(windowAtLiveEdge)
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
  // Whether the first-new-message divider currently sits ABOVE the viewport (scrolled past it, or
  // it hasn't scrolled into view yet). Drives the jump-to-last-read pill. Recomputed in the same
  // scroll-handler cadence as showScrollToBottom — no separate listener.
  const [markerAboveViewport, setMarkerAboveViewport] = useState(false)
  // Id of the bottom-most message whose top is within the viewport (the row peeking in at the bottom
  // edge). Drives the scroll-to-bottom FAB badge so it counts DOWN as new messages scroll into view.
  // Reuses the anchor already computed every scroll (lastAnchorRef); updated at the same throttled
  // cadence via the prev-dedup setter, so it only re-renders when the bottom-most row changes.
  const [bottomVisibleMessageId, setBottomVisibleMessageId] = useState<string | null>(null)

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  const canLoadMore = !isHistoryComplete && !isLoadingOlder && !!onScrollToTop
  // Sliding window: load-newer is possible only when the window is slid up (windowAtLiveEdge === false)
  // — otherwise the resident bottom IS the live edge and there is nothing newer to fetch.
  const canLoadNewer = windowAtLiveEdge === false && !isLoadingNewer && !!onLoadNewer

  const getDistanceFromBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight

  const rememberCurrentScrollSnapshot = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    lastScrollDataRef.current = {
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
      client: scroller.clientHeight,
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
    }
    lastAnchorRef.current = findBottomAnchor(scroller)
    isAtBottomRef.current = true
    setShowScrollToBottom(false)
    setMarkerAboveViewport(false)
    // At the bottom the newest message is visible → 0 new below the fold (anchor is the last row).
    setBottomVisibleMessageId(lastAnchorRef.current?.messageId ?? null)
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

      const { staticMode, isAtBottomRef, virtualizer } = latestRef.current

      // On mount: if we should be at bottom, scroll there immediately.
      //
      // NON-VIRTUALIZED ONLY. Under virtualization the conversation-switch layout effect (which
      // also runs on this same fresh mount — MessageList is keyed by conversation id, so every
      // entry remounts and prevConversationRef starts null) owns the initial bottom positioning
      // via pinVirtualizedBottom() → scrollToIndex(last,'end'). That target is MEASUREMENT-AWARE;
      // this legacy raw `scrollTop = scrollHeight` predates virtualization and lands on the
      // @tanstack spacer's ESTIMATED total instead — a different pixel. Running both on entry (the
      // raw write here, plus its one-frame-later rAF, against the pin's scrollToIndex) positions
      // the view twice at two slightly different bottoms, so it visibly nudges up/down before it
      // settles. Gating on !virtualizer leaves the non-virtualized path byte-identical while
      // letting the (virtualization-aware) switch effect be the single source of bottom positioning
      // — the same migration already applied to the switch effect's own else branch.
      if (isAtBottomRef.current && !staticMode && !virtualizer) {
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
          reassertBottom('content-growth')
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
  const pinVirtualizedBottom = useCallback((trigger: string = 'unknown') => {
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

    // Repaint-burst coalescing. A content-arrival trigger (new message / reaction / media / catch-up)
    // landing in quick succession with others is a BURST: its per-arrival forced repaint is the
    // WebKitGTK freeze. note() it BEFORE the loop so writePin below can suppress the intermediate
    // repaints (position still written, layout stays correct) and let convergence force one trailing
    // repaint. User/layout triggers (switch, fab, resize) are not content and never suppress.
    const burst = (pinRepaintBurstRef.current ??= createPinRepaintBurst())
    if (CONTENT_ARRIVAL_TRIGGERS.has(trigger)) burst.note(performance.now())

    // Per-run forced-work accounting + convergence tracking. On WebKitGTK the forced layouts and
    // repaints below are the dominant main-thread cost in busy rooms (RenderCostProbe layoutPaint
    // 189–359ms with react as low as 2ms) — the tracker attributes them in fluux.log.
    const run = createPinRunTracker()
    const repaintMode = readPinRepaintMode(
      typeof window === 'undefined' ? undefined : window.localStorage
    )

    // Prompt WebKit's LATE row measure. Rows are absolutely positioned, so scrollHeight is the spacer's
    // declared height (= @tanstack getTotalSize), which grows only once a just-added row's ResizeObserver
    // delivers — and WebKit (Safari + Tauri) delivers that late. Reading a row's getBoundingClientRect
    // forces the layout that makes the observer deliver, so scrollHeight catches up before we read it in
    // the re-pin below. Strictly read-only; a no-op on Chromium. (NB: this only fixes the scrollHeight
    // *value*; the actual send-stick was a stale PAINT — see forceRepaint below.)
    const flushTailLayout = () => {
      const ss = scrollerRef.current
      if (!ss) return
      const started = performance.now()
      ss.getBoundingClientRect()
      const rows = ss.querySelectorAll('[data-message-id]')
      for (let i = Math.max(0, rows.length - 3); i < rows.length; i++) {
        rows[i].getBoundingClientRect()
      }
      run.addMs('flush', performance.now() - started)
    }

    // THE ACTUAL SEND-STICK FIX — force a repaint after a programmatic scroll. On the Tauri WKWebView,
    // setting scrollTop (via scrollToIndex) updates the LAYOUT correctly — scrollTop, the row rects and
    // distFromBottom all land at the bottom — but the compositor does NOT repaint, so the pixels on
    // screen keep showing the OLD position and the just-sent message looks stranded below the fold until
    // a real user scroll forces a recomposite. This is why every geometry probe read "at bottom": the
    // layout IS at the bottom; only the paint is stale (confirmed on-device — toggling overflow made the
    // already-correctly-positioned message appear without any scroll). Toggling overflow forces the
    // scroll container to re-layout and repaint at the current position; `overflowY = ''` yields the
    // property back to the CSS class (overflow-y-auto) and scrollTop is preserved. A cheap extra reflow
    // on Chromium, which repaints on its own — but a FULL re-layout + repaint of the scroller on
    // WebKitGTK, which is why writePin gates it on the scroll actually having moved.
    const forceRepaint = () => {
      const ss = scrollerRef.current
      if (!ss) return
      const started = performance.now()
      ss.style.overflowY = 'hidden'
      void ss.offsetHeight // forced reflow → WebKit repaints the scrolled content
      ss.style.overflowY = ''
      run.addMs('repaint', performance.now() - started)
    }

    // Forced repaint, coalesced across a content-arrival BURST. When the pin would normally repaint
    // but a burst is in flight (this arrival plus others within PIN_BURST_WINDOW_MS), skip it and
    // record the debt: the position is already written so the layout is correct — only the paint is
    // deferred to the single trailing repaint that convergence forces once arrival quiesces. This
    // collapses a burst's N WebKitGTK repaints (~50–150ms each) to ~1. The 'always'/'off' A/B
    // overrides stay unconditional (they must, to measure the un-coalesced cost on-device).
    const repaintCoalesced = (moved: boolean) => {
      if (!shouldForceRepaint(moved, repaintMode, isLoadingOlderRef.current)) return
      if (repaintMode === 'on-write' && burst.suppress(performance.now())) {
        burst.markSuppressed()
        return
      }
      forceRepaint()
    }

    // Pin write + gated repaint. The stale-paint bug is specific to a PROGRAMMATIC SCROLL, so when
    // scrollToIndex lands on the scrollTop the scroller already had (a no-op re-assert — typing
    // toggles, resize re-pins) there is nothing stale to draw and the expensive repaint is skipped.
    // `fluux:pin-repaint` = 'always' | 'off' overrides the gate for on-device A/B on Linux.
    let wroteAny = false
    const writePin = (): boolean => {
      const ss = scrollerRef.current
      const v = virtualizerRef.current
      if (!ss || !v || v.itemCount === 0) return false
      const before = ss.scrollTop
      const started = performance.now()
      v.scrollToIndex(v.itemCount - 1, { align: 'end' })
      run.addMs('scroll', performance.now() - started)
      const moved = ss.scrollTop !== before
      if (moved) wroteAny = true
      repaintCoalesced(moved)
      return moved
    }

    // Flush a repaint debt owed by burst coalescing: force the single trailing repaint that draws the
    // final settled position, and emit the [PinBurstProbe] line attributing how many repaints were
    // coalesced (each ~50–150ms of WebKitGTK freeze avoided). No-op when nothing was suppressed.
    const flushOwedRepaint = () => {
      if (!burst.owed()) return
      forceRepaint()
      console.warn(pinBurstProbeLine(trigger, burst.settle()))
    }

    // Immediate pin (pre-paint when called from a layout effect).
    flushTailLayout()
    writePin()
    debugLog('PIN start', {
      trigger,
      itemCount: virt.itemCount,
      distFromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    })

    const startedAt = Date.now()
    const loop = (reassertMonitorRef.current ??= createReassertLoopMonitor()).begin('pin-bottom', performance.now())
    pinBottomActiveRef.current = true
    let framesLeft = BOTTOM_REASSERT_FRAMES
    let lastHeight = scroller.scrollHeight
    const finish = () => {
      loop.end()
      reassertLoopRef.current = null
      pinBottomActiveRef.current = false
      // One rate-limited fluux.log line attributing this run's forced work (flush/scroll/repaint),
      // so the next on-device freeze report says which pin trigger paid what.
      const probe = (pinRunProbeRef.current ??= createRenderCostProbe({ thresholdMs: PIN_PROBE_THRESHOLD_MS }))
      if (probe.record(run.totalForcedMs(), performance.now())) {
        console.warn(run.summaryLine(trigger))
      }
    }
    const step = () => {
      const s = scrollerRef.current
      if (framesLeft-- <= 0) {
        // Loop ran its full budget without converging. Re-derive isAtBottom from geometry (accurate —
        // the position is correct even when WebKit withheld the paint) and force one final repaint —
        // if anything was written — so the settled position is actually drawn. Still suppressed while
        // a MAM catch-up is in flight: more content is coming, so this isn't the settled position yet —
        // the catch-up-complete effect below forces the real final repaint once it finishes.
        if (s) {
          flushTailLayout()
          const dist = s.scrollHeight - s.scrollTop - s.clientHeight
          isAtBottomRef.current = dist < AT_BOTTOM_THRESHOLD
          // One final repaint draws the settled position. A burst debt takes precedence (it forces the
          // repaint AND logs the coalesced count) and subsumes the normal on-write repaint, so at most
          // one overflow toggle fires here.
          if (burst.owed()) flushOwedRepaint()
          else if (shouldForceRepaint(wroteAny, repaintMode, isLoadingOlderRef.current)) forceRepaint()
          debugLog('PIN settled (frames exhausted)', { distFromBottom: dist })
        }
        finish()
        return
      }
      const v = virtualizerRef.current
      if (!s || !v || v.itemCount === 0) { finish(); return }
      // The ONLY reason to stop pinning is a genuine user takeover — a FAB tap or a wheel scroll, both
      // of which stamp userScrollIntentAtRef AFTER we started. We do NOT bail on a position-derived
      // `!isAtBottomRef.current`: on WebKit a tall bottom row's post-paint growth fires extra `scroll`
      // events reporting a large distFromBottom that the height-unchanged discriminator can't always
      // catch, and flipping isAtBottom false used to strand the send. The pin keeps converging on
      // geometry and yields only to real input intent.
      if (userScrollIntentAtRef.current > startedAt) {
        debugLog('PIN bail (user scroll intent)', {
          distFromBottom: s.scrollHeight - s.scrollTop - s.clientHeight,
        })
        // User took over: the bottom-pin debt is void (their scroll itself repaints), so drop it
        // rather than force a trailing repaint that would fight the position they scrolled to.
        burst.reset()
        finish()
        return
      }
      // Force the tail rows to lay out this frame so WebKit's late ResizeObserver delivers and
      // scrollHeight grows to include a just-added row before we read it below.
      flushTailLayout()
      const h = s.scrollHeight
      // Re-pin when the layout grew/shrank OR we're still measurably short of the bottom. Idempotent
      // once pinned; the repaint is gated inside writePin on the scroll actually moving.
      const dist = h - s.scrollTop - s.clientHeight
      let wrote = false
      if (h !== lastHeight || dist > BOTTOM_PIN_TOLERANCE) {
        debugLog('PIN re-assert', { distFromBottom: dist, heightChanged: h !== lastHeight })
        lastHeight = h
        writePin()
        wrote = true
      }
      const warning = loop.frame(performance.now(), wrote)
      if (warning) console.warn(warning)
      // CONVERGENCE EARLY-EXIT: once the geometry has been stable for a few consecutive frames the
      // measurement settle is over — running out the remaining budget would only burn one forced
      // layout per frame (the WebKitGTK freeze pattern). Late media loads re-pin via their own site.
      if (run.frame(wrote) === 'settled') {
        isAtBottomRef.current = dist < AT_BOTTOM_THRESHOLD
        // Arrival has quiesced (8 stable frames): flush any repaint the burst coalescer deferred, so
        // the final bottom position is drawn exactly once. Non-burst runs already painted per-frame,
        // so owed() is false and this is a no-op.
        flushOwedRepaint()
        debugLog('PIN settled (converged)', {
          distFromBottom: dist,
          framesUsed: BOTTOM_REASSERT_FRAMES - framesLeft,
        })
        finish()
        return
      }
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
  const reassertBottom = useCallback((trigger: string = 'unknown') => {
    if (virtualizerRef.current) {
      pinVirtualizedBottom(trigger)
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
      // The loop just stopped owning scrollTop; keep the brief measurement settle that follows it
      // classified as programmatic so it can't open the save gate (see lastProgrammaticScrollAtRef).
      lastProgrammaticScrollAtRef.current = Date.now()
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

  // Scroll to (and keep re-asserting toward) the first-new-message marker, re-assert-loop style —
  // shared by the conversation-switch entry effect AND the jump-to-last-read pill's click handler,
  // so there is exactly one marker-positioning routine (see the loop body comment at its original
  // call site for the full rationale: unmounted rows resolve via getOffsetForMessageId/scrollToIndex,
  // re-applied each frame as rows measure over several frames after cache rehydrate).
  const runMarkerReassertLoop = useCallback((markerId: string, markerConvId: string) => {
    const startedAt = Date.now()
    // Single-flight (shared with pin-bottom / prepend): the marker positioning loop owns
    // scrollTop while it runs, so it supersedes any in-flight re-assert and registers itself.
    supersedeReassertLoopRef.current()
    const markerLoop = (reassertMonitorRef.current ??= createReassertLoopMonitor()).begin('marker', performance.now())
    const finishMarker = () => {
      markerLoop.end()
      reassertLoopRef.current = null
    }
    // Register the ref BEFORE scheduling the frame, then patch its `raf` id in place — rather than
    // reassigning reassertLoopRef.current AFTER requestAnimationFrame returns. A mocked/synchronous
    // rAF (test harnesses) invokes the callback inline, so an outer `ref.current = { raf:
    // requestAnimationFrame(cb), ... }` evaluates the RHS (running the callback, possibly to
    // completion — including a `finishMarker()` that nulls the ref) and THEN clobbers that null back
    // to a stale non-null entry. Pre-registering means a same-tick finish's null assignment is never
    // overwritten; the `raf` id patch only mutates the (by-then-detached) local object when that
    // happens.
    const registerMarkerLoop = (cb: () => void) => {
      const entry: { raf: number; handle: typeof markerLoop } = { raf: 0, handle: markerLoop }
      reassertLoopRef.current = entry
      entry.raf = requestAnimationFrame(cb)
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
        if (!resolved) reassertBottom('marker-fallback')
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
          reassertBottom('marker-fallback')
          return
        }
        // Position the marker row via the virtualizer's measurement-aware scrollToIndex.
        // A raw scrollToOffset to the ESTIMATED offset lands SHORT and never windows the marker
        // row in, so its height never measures and the offset estimate never sharpens — the loop
        // then sees a "stable" (wrong) target and stops with the marker stranded below the fold
        // (the bug). scrollToIndex windows the marker region in (mount + measure), so each frame
        // lands closer and re-asserting converges, exactly like pinVirtualizedBottom. align:'start'
        // puts the divider near the top to read forward, and clamps to the bottom when the marker
        // is the last message (so a single new message lands at the bottom, fully visible — do NOT
        // shift up by viewportHeight/3 here: getOffsetForMessageId clamps to the scrollable range
        // for a near-bottom marker, so the shift would scroll past the new message and hide it).
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
      registerMarkerLoop(stepToMarker)
    }
    registerMarkerLoop(stepToMarker)
  }, [isAtBottomRef, reassertBottom])

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
      // We just wrote scrollTop programmatically; the measurement settle that follows must not be
      // mistaken for a user scroll and open the save gate (see lastProgrammaticScrollAtRef).
      lastProgrammaticScrollAtRef.current = Date.now()
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

    // THE CONTENT ANCHOR IS AUTHORITATIVE. The saved fraction anchor — re-derived from the anchor
    // message's CURRENT measured height on every restore — is correct in every case: identical
    // layout, MAM prepend, font-size change, view-density change, or a viewport-width change (which
    // rewraps bubbles and so invalidates any saved pixel). We therefore try the anchor FIRST and
    // UNCONDITIONALLY — no "layout unchanged" height/width gate. The saved scrollTop is only a pixel
    // PROXY that holds when the layout is byte-identical; it is demoted to a last-resort fallback,
    // used solely when there is NO usable anchor (a legacy save with no captured anchor, or an
    // anchor message that is no longer in the loaded set). Pixel correctness is covered by the
    // real-engine scroll-invariants e2e — jsdom/happy-dom have no layout, so the captured fraction
    // degenerates (last row, fraction 1) and cannot be exercised in a unit test.
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
      reassertBottom('restore-fallback')
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
    reassertBottom('restore-fallback')
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

    const virtFab = latestRef.current.virtualizer
    if (virtFab && virtFab.itemCount > 0) {
      reassertBottom('fab')
      return
    }

    rememberBottomIntent()
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [firstNewMessageId, reassertBottom, rememberBottomIntent])

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
      if (isAtBottomRef.current) reassertBottom('viewport-resize')
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

  // Sliding window: mirror of triggerLoadOlder for the newer direction. Fires when the reader
  // scrolls back down to the bottom of a slid-up window (canLoadNewer gates on windowAtLiveEdge ===
  // false). Loading newer APPENDS a batch and EVICTS the oldest (opposite end), so it shifts every
  // offset up; we save the same anchor prepend uses and let the shared restore effect hold the
  // viewport steady. The evicted rows are the OLDEST — far above the viewport — so the top-visible
  // anchor survives, making the anchor-based restore direction-agnostic.
  const triggerLoadNewer = () => {
    if (!canLoadNewer) return
    const scroller = scrollerRef.current
    if (!scroller) return

    const now = Date.now()
    const cooldownOk = now - lastLoadTimeRef.current > LOAD_COOLDOWN_MS
    if (!cooldownOk && !scrolledAwayFromBottomRef.current) return

    lastLoadTimeRef.current = now
    scrolledAwayFromBottomRef.current = false

    const anchor = findAnchorElement()
    prependRef.current = {
      anchorMessageId: anchor?.id || '',
      anchorOffsetFromTop: anchor?.offsetFromTop || 0,
      distanceFromBottom: getDistanceFromBottom(scroller),
      oldFirstId: firstMessageId || '',
      oldMessageCount: messageCount,
    }

    onLoadNewer?.()
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
          reassertBottom('media-load')
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
    const { scrollTop, scrollHeight, clientHeight } = el
    const distFromBottom = scrollHeight - scrollTop - clientHeight

    // A programmatic re-assert loop (marker positioning / pin-bottom / prepend / anchor restore)
    // owns scrollTop while it runs — scroll events fired during it are NOT the user.
    const programmaticScroll = reassertLoopRef.current !== null

    // Update refs (NO React state updates here except FAB)
    lastScrollDataRef.current = { top: scrollTop, height: scrollHeight, client: clientHeight }
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

    // FAB visibility (only React state in scroll handler). Suppressed while the pin-bottom loop owns
    // scrollTop: on WebKit a tall bottom row's post-paint growth fires 'scroll' events reporting a
    // transiently large distFromBottom before the loop re-pins, which would otherwise flash the FAB
    // on open-at-bottom (intermittent race). The loop settles AT the bottom, so the FAB stays hidden.
    const shouldShowFab = shouldShowScrollToBottomFab(distFromBottom, FAB_THRESHOLD, pinBottomActiveRef.current)
    setShowScrollToBottom(prev => prev !== shouldShowFab ? shouldShowFab : prev)

    // Jump-to-last-read pill visibility: is the first-new-message divider currently scrolled
    // ABOVE the viewport? Same cadence as the FAB above — no separate listener. Compare the
    // marker's pixel offset (content-relative, from the content top) against the live scrollTop
    // — works whether or not the marker row is currently mounted. NOTE: this intentionally does
    // NOT compare against getVirtualItems()[0].index: for a short/medium conversation the
    // rendered window (visible range + overscan) can cover the ENTIRE item list, so the first
    // rendered item's index stays 0 regardless of scroll position — an index comparison would
    // never fire the pill for such conversations. The offset comparison is windowing-agnostic.
    if (firstNewMessageId) {
      const v = latestRef.current.virtualizer
      let shouldShowMarkerPill = false
      if (v) {
        const offset = v.getOffsetForMessageId(firstNewMessageId)
        shouldShowMarkerPill = offset != null && offset < scrollTop
      } else {
        const escapedId = CSS.escape(firstNewMessageId)
        const markerEl = el.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null
        shouldShowMarkerPill = markerEl != null && markerEl.offsetTop < scrollTop
      }
      setMarkerAboveViewport(prev => prev !== shouldShowMarkerPill ? shouldShowMarkerPill : prev)
    } else {
      setMarkerAboveViewport(prev => prev ? false : prev)
    }

    // Track the bottom-most-visible message ONLY on genuine (non-programmatic) user scroll — this
    // drives the divider-snap trigger in MessageList (snap the "New messages" divider to the read
    // pointer when the reader scrolls back up). Skipping programmatic scrolls (the entry
    // scroll-to-marker re-assert, FAB jumps) prevents the divider from drifting during entry
    // positioning. Conversation switch resets this to null, so the snap can't fire until the reader
    // actually scrolls.
    if (!programmaticScroll) {
      const bottomId = lastAnchorRef.current?.messageId ?? null
      setBottomVisibleMessageId(prev => (prev !== bottomId ? bottomId : prev))
    }

    // `programmaticScroll` (computed above) also gates the marker-clear and position-save below: a
    // re-assert loop owns scrollTop while it runs, so its scroll events must not (a) clear the marker
    // (the marker-positioning loop scrolls TO the marker, momentarily landing at/near the bottom for
    // a last-message marker, which would trip the "reached bottom" clear), nor (b) save the position
    // (the transient scrollTop:0 of the virtualized initial render was saved as a "scrolled-up"
    // position, poisoning the next re-entry into restore-position and bypassing the marker entirely).

    // Open the save gate when this is a genuine user scroll: content height UNCHANGED from the
    // previous scroll event (a media/measurement-driven shift changes the height; a wheel / touch /
    // scrollbar-drag does not). Complements the input-event listeners so scrollbar-drag — which
    // fires no wheel/touch — also counts. Excluded: programmatic loop scrolls AND the brief
    // post-restore / post-re-pin measurement settle (isProgrammaticScroll's window) — that settle is
    // height-unchanged too, so without the window a SECOND settle event looked like a scrollbar drag,
    // opened the gate, and persisted a drifted position that crept older on every re-open. Genuine
    // user scrolls still open the gate via the input-event listeners / handleWheel, unaffected.
    if (
      !isProgrammaticScroll(programmaticScroll, Date.now(), lastProgrammaticScrollAtRef.current) &&
      prevScrollHeightRef.current === scrollHeight
    ) {
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
        // User genuinely read through to the bottom — the "skipped vs read-through" clear.
        // NOTE: gated by `!programmaticScroll` above, so a FAB jump-to-present (which drives a
        // reassert loop) does NOT clear the anchor — the jump-to-last-read pill (#870) needs the
        // per-visit divider anchor to survive a skip. Scrolled-past / DOM-trimmed no longer clear:
        // those are exactly the states where the pill must show (moved toward the present without
        // reading). The anchor now clears only on read-through, Esc, mark-all-read, or deactivation.
        debugLog('MARKER CLEAR (reached bottom)', { firstNewMessageId, distFromBottom })
        clearFirstNewMessageId()
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
      scrollStateManager.saveScrollPosition(
        conversationId,
        scrollTop,
        scrollHeight,
        clientHeight,
        lastAnchorRef.current ?? undefined,
        lastSeenMessageId,
      )
    }

    // Track if user scrolled away from top (allows re-trigger of load)
    if (scrollTop > 50) scrolledAwayFromTopRef.current = true
    // Mirror for the newer direction (sliding window): away from the resident bottom.
    if (distFromBottom > 50) scrolledAwayFromBottomRef.current = true

    // Auto-trigger load when at top (disabled in static mode — preview starts at scrollTop=0).
    // Gate on scrolledAwayFromTop: a PASSIVE scroll reaching the top must only auto-load when the
    // user genuinely scrolled up to it (was away from the top and returned). On a fresh entry the
    // list briefly renders at scrollTop=0 before the auto-scroll-to-bottom settles; that transient
    // must NOT spuriously load older — doing so prepends a batch and clears isAtBottom, breaking
    // bottom-stick for the next incoming message. A wheel-up (handleWheel) is explicit intent and
    // is intentionally NOT gated this way.
    if (scrollTop === 0 && !staticMode && scrolledAwayFromTopRef.current) triggerLoadOlder()

    // Sliding window: when the window is slid up (canLoadNewer ⇒ windowAtLiveEdge === false),
    // reaching the resident bottom means newer messages exist in cache below — load them. Gated by
    // canLoadNewer, so at the live edge this is inert and bottom-stick is unchanged.
    if (distFromBottom <= LOAD_NEWER_THRESHOLD && !staticMode) triggerLoadNewer()
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // A wheel is a deliberate user scroll — record it so the prepend re-assert loop yields if
    // the user keeps scrolling after a load (rather than fighting a content-shrink clamp). The
    // wheel that triggers the load itself is recorded BEFORE the loop starts, so it won't bail.
    userScrollIntentAtRef.current = Date.now()
    // Genuine user scroll → open the save gate (see userHasScrolledSinceEntryRef). Mirrors the
    // native wheel listener; kept here so it fires even when wheel arrives via the React handler.
    userHasScrolledSinceEntryRef.current = true
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
    const distFromBottom = scrollHeight - scrollTop - clientHeight
    if (scrollTop === 0 && e.deltaY < 0 && !staticMode) triggerLoadOlder()
    if (scrollTop === 0 && e.deltaY > 0) scrolledAwayFromTopRef.current = true
    // Sliding window mirror: a wheel-DOWN pinned at the resident bottom fires no scroll event
    // (already at max scrollTop), so trigger load-newer here — same reason handleWheel handles the
    // pinned-top load-older case above.
    if (distFromBottom <= LOAD_NEWER_THRESHOLD && e.deltaY > 0 && !staticMode) triggerLoadNewer()
    if (distFromBottom > 50 && e.deltaY < 0) scrolledAwayFromBottomRef.current = true
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
      const { top, height, client } = lastScrollDataRef.current
      scrollStateManager.leaveConversation(
        prevConversationRef.current,
        top,
        height,
        client,
        lastAnchorRef.current ?? undefined,
        previousReadPositionRef.current,
      )
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
    pendingSyncedLiveEdgeRef.current = null
    // Returning to this conversation later must be free to re-request its anchor slice.
    aroundLoadStatusRef.current.clear()
    // Fresh entry: the saved position is locked until the user genuinely scrolls (see the ref).
    userHasScrolledSinceEntryRef.current = false
    prevScrollHeightRef.current = null
    setShowScrollToBottom(false)
    setMarkerAboveViewport(false)
    // No scroll observed in the new conversation yet → badge falls back to the full new count until
    // the first scroll re-derives the bottom-most-visible row.
    setBottomVisibleMessageId(null)

    // Clear any pending media load batch
    if (mediaLoadDebounceRef.current) {
      clearTimeout(mediaLoadDebounceRef.current)
      mediaLoadDebounceRef.current = null
    }
    mediaLoadSnapshotRef.current = null
    // Drop any repaint-burst debt from the room we're leaving so it can't flush into the new one.
    pinRepaintBurstRef.current?.reset()

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
      let action = scrollStateManager.enterConversation(conversationId, messageCount)
      const savedPos = scrollStateManager.getSavedScrollTop(conversationId)
      const savedReadPositionId = scrollStateManager.getSavedReadPositionId(conversationId)

      if (action === 'restore-position') {
        pendingSyncedLiveEdgeRef.current = { conversationId, savedReadPositionId }
        // The remote pointer can resolve before this mount. When it now identifies the newest
        // downloaded row, a saved position tied to an older pointer must not win merely because
        // there was never an unread divider.
        if (
          firstNewMessageId === undefined &&
          lastSeenMessageId !== undefined &&
          lastSeenMessageId === lastMessageId &&
          lastSeenMessageId !== savedReadPositionId
        ) {
          scrollStateManager.clearSavedScrollState(conversationId)
          pendingSyncedLiveEdgeRef.current = null
          action = 'scroll-to-bottom'
          debugLog('MDS LIVE EDGE: synced read supersedes saved position on entry', {
            conversationId,
            savedReadPositionId,
            lastSeenMessageId,
          })
        }
      }

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
        // Shared with the jump-to-last-read pill's click handler — see runMarkerReassertLoop's own
        // comment.
        runMarkerReassertLoop(markerId, markerConvId)
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
          pinVirtualizedBottom('switch')
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
    previousReadPositionRef.current = lastSeenMessageId

  }, [conversationId, messageCount, firstNewMessageId, targetMessageId, lastMessageId, lastSeenMessageId, isAtBottomRef, staticMode, pinVirtualizedBottom, reassertBottom, restoreSavedPosition, runMarkerReassertLoop])

  // Zero-unread twin of the divider-clear settle below. The old local position may be restored
  // before MAM resolves the other device's pointer to the newest downloaded row; with no divider,
  // observing that pointer transition is the only signal that the restore became obsolete.
  useLayoutEffect(() => {
    const pending = pendingSyncedLiveEdgeRef.current
    if (!pending || pending.conversationId !== conversationId) return
    if (staticMode || userHasScrolledSinceEntryRef.current) return
    if (firstNewMessageId !== undefined || lastSeenMessageId === undefined) return
    if (lastSeenMessageId !== lastMessageId || lastSeenMessageId === pending.savedReadPositionId) return

    pendingSyncedLiveEdgeRef.current = null
    pendingRestoreConversationRef.current = null
    scrollStateManager.clearSavedScrollState(conversationId)
    isAtBottomRef.current = true
    debugLog('MDS LIVE EDGE: late synced read supersedes restored position', {
      conversationId,
      savedReadPositionId: pending.savedReadPositionId,
      lastSeenMessageId,
    })
    reassertBottom('mds-live-edge')
  }, [conversationId, firstNewMessageId, lastMessageId, lastSeenMessageId, staticMode, isAtBottomRef, reassertBottom])

  // XEP-0490 settle window: the fresh-session read-sync seed can land just AFTER a
  // conversation is opened. The SDK's entry fold races the async PEP fetch, so at
  // activation the divider was derived from the STALE local read position and the
  // conversation-switch effect above already positioned the view (and armed a re-assert
  // loop) against it. When the seed lands, the SDK advances lastSeenMessageId and
  // recomputes the divider live for the ACTIVE conversation (chatStore/roomStore
  // applyRemoteDisplayed); when the synced read caught the conversation up, the divider
  // clears. Settle the view to the bottom so the FIRST open lands where a later re-open
  // would — otherwise it stays stranded at the stale marker and appears to "jump to the
  // end" only on re-open.
  //
  // Tightly gated so it never fights the user or a genuine unread marker:
  //  - only a live divider CLEAR (a defined marker -> undefined) on the SAME conversation
  //    already open (a real conversation switch is owned by the effect above; we detect it
  //    via our OWN previous-conversation ref, since that effect updates prevConversationRef
  //    before this one runs),
  //  - only while the settle window is open (the user hasn't scrolled since entry),
  //  - never in static/preview mode.
  // reassertBottom() supersedes the stale marker re-assert loop (single-flight).
  const prevSettleRef = useRef({ conv: conversationId, divider: firstNewMessageId })
  useLayoutEffect(() => {
    const prev = prevSettleRef.current
    prevSettleRef.current = { conv: conversationId, divider: firstNewMessageId }
    if (staticMode) return
    if (prev.conv !== conversationId) return
    if (prev.divider === undefined || firstNewMessageId !== undefined) return
    if (userHasScrolledSinceEntryRef.current) return
    debugLog('MDS SETTLE: divider cleared by late read-sync → settle to bottom', {
      conversationId,
      prevMarker: prev.divider,
    })
    isAtBottomRef.current = true
    reassertBottom('mds-settle')
  }, [conversationId, firstNewMessageId, staticMode, isAtBottomRef, reassertBottom])

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
          const { top, height, client } = lastScrollDataRef.current
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
          scrollStateManager.leaveConversation(
            prevConversationRef.current,
            top,
            height,
            client,
            lastAnchorRef.current ?? undefined,
            previousReadPositionRef.current,
          )
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
        // Apply the highlight synchronously BEFORE clearing the target (mirrors the non-virtualized
        // branch below). onTargetMessageConsumed clears targetMessageId, which re-runs this effect and
        // fires its cleanup in the same tick; a deferred (rAF) highlight got cancelled by that cleanup
        // before it could paint, so the "go to message" flash silently vanished. The reassert loop has
        // already settled the target row into the window, so it is mounted and queryable now.
        const el = scrollerRef.current?.querySelector(`[data-message-id="${escapedId}"]`)
        if (el) highlight(el)
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

        // Center the target rather than pinning it to the top edge (align:'start'), which tucks it
        // under the sticky date header where it reads as misaligned and the highlight flash is easy
        // to miss. scrollToIndex('center') windows the (possibly far-out-of-window) row in, measures
        // it, and clamps internally — so a near-bottom target stays visible instead of being scrolled
        // past the fold (the failure mode of a manual getOffsetForMessageId − clientHeight/3 shift,
        // since getOffsetForMessageId returns an offset already clamped to the scrollable range).
        // Re-asserting each frame converges as rows settle. Matches the reply-scroll block:'center'.
        v.scrollToIndex(currentIdx, { align: 'center' })
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
      // Center the target (matches the virtualized path above and the reply-scroll convention);
      // the browser clamps scrollTop, so a near-bottom target stays fully visible.
      ;(el as HTMLElement).scrollIntoView({ block: 'center' })
      isAtBottomRef.current = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < AT_BOTTOM_THRESHOLD
      highlight(el)
      debugLog('TARGET MESSAGE: scrolled to target (center)', { targetMessageId })
      onTargetMessageConsumed?.()
    }

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
  // EFFECT: Returned to the live edge → drop any stale directional-load anchor.
  // ==========================================================================
  // A directional load that returns NOTHING never changes firstMessageId, so the restore effect
  // below never fires and never clears its prependRef — the anchor lingers. The reachable case is
  // load-newer hitting the tail: windowAtLiveEdge flips false→true with a stashed (never-restored)
  // anchor. Left in place, a LATER unrelated firstMessageId change — e.g. a live message evicting
  // the oldest at the cap — would fire that stale restore. Clearing on the false→true TRANSITION
  // targets exactly "we just returned to the live edge": normal under-cap load-older keeps
  // windowAtLiveEdge true (no transition) and a slide keeps it false, so their in-flight restores
  // are untouched. This is a passive useEffect so it runs AFTER the restore useLayoutEffect — a
  // load-newer that both slides AND reaches the tail in one batch still restores first, then this
  // clears the already-`restored` ref harmlessly.
  useEffect(() => {
    if (windowAtLiveEdge === true && prevWindowAtLiveEdgeRef.current === false) {
      if (prependRef.current && !prependRef.current.restored) {
        prependRef.current = null
      }
    }
    prevWindowAtLiveEdgeRef.current = windowAtLiveEdge
  }, [windowAtLiveEdge])

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

    // A directional load (older OR newer) landed iff the FIRST message id changed. Sliding window:
    // a load-older OR load-newer at the resident cap prepends/appends a batch AND evicts the
    // opposite end, so messageCount stays CONSTANT — the old `countIncreased` gate then waited
    // forever and the view jumped. firstId is the reliable signal: load-older makes it older;
    // load-newer evicts the oldest so it becomes newer. The anchor-based restore below is
    // direction-agnostic (it repositions the top-visible anchor, which survives either eviction —
    // the evicted rows are at the far, off-screen end). Under the cap, load-older still changes
    // firstId AND grows the count, so this is unchanged for the common case.
    const firstIdChanged = firstMessageId !== saved.oldFirstId

    if (!firstIdChanged) {
      debugLog('PREPEND WAITING', {
        messageCount,
        oldMessageCount: saved.oldMessageCount,
        firstMessageId,
        oldFirstId: saved.oldFirstId,
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
      reassertBottom('new-message')
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
  // EFFECT: Clean settle pin once a MAM catch-up completes
  // ==========================================================================

  // writePin above suppresses the forced repaint while isLoadingOlder is true (see pinBottomRun's
  // shouldForceRepaint doc) — a catch-up pages in merges every ~50-300ms, each moving scrollTop, and
  // WebKit isn't painting those intermediate positions anyway without the forced toggle. But once the
  // LAST merge lands, something has to force the final repaint or the view is stuck showing a stale
  // frame at the (geometrically correct) suppressed position. This fires exactly once on the
  // isLoadingOlder true -> false transition, while the reader is following the bottom, mirroring the
  // "new message" effect above but keyed on load completion rather than message-count growth (needed
  // because the last MAM page can land with no further count change once the switch effect's own
  // initial cache load already brought it in).
  const prevIsLoadingOlderRef = useRef(isLoadingOlder)
  useEffect(() => {
    const wasLoading = prevIsLoadingOlderRef.current
    prevIsLoadingOlderRef.current = isLoadingOlder
    if (wasLoading && !isLoadingOlder && isAtBottomRef.current && !staticMode) {
      reassertBottom('mam-catchup-complete')
    }
  }, [isLoadingOlder, isAtBottomRef, staticMode, reassertBottom])

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
  // EFFECT: Reaction added/removed — keep the bottom glued (only when sticked)
  // ==========================================================================

  // A reaction grows (or shrinks) its message row. While the reader is sticked to the bottom we keep
  // the newest message glued to the bottom edge and let the growth be absorbed ABOVE (previous
  // messages scroll up) — rather than letting the row growth shove the newest message down. This runs
  // for a reaction on ANY resident row, not just the last one: a reaction in the middle of the
  // viewport would otherwise push everything below it (including the newest message) down.
  //
  // We route through reassertBottom (the same multi-frame pinVirtualizedBottom convergence new
  // messages and the typing footer use) rather than a one-shot scrollToIndex, because the row's
  // ResizeObserver reports the grown height a frame or two AFTER the chip mounts — a single
  // synchronous pin would land on the pre-growth height and still let the bottom dip. The loop polls
  // scrollHeight per frame and re-pins instantly (no smooth easing, so nothing visibly animates),
  // converging in a handful of frames. It's pure imperative scroll work — no React re-render.
  //
  // Two safeguards keep it from ever fighting a scroll: (1) it's gated on LIVE geometry, not the
  // latchable isAtBottomRef — a reader scrolled up into history reads distFromBottom >= threshold and
  // is never re-pinned (a stale-true latch is what made a typing toggle "fight" the scroll in #918);
  // (2) it fires only on an actual reactions change WITHIN the same conversation, so a conversation
  // switch / restore is never disturbed.
  const prevReactionsKeyRef = useRef(reactionsSignature)
  const reactionsConvRef = useRef(conversationId)
  useLayoutEffect(() => {
    const sameConversation = reactionsConvRef.current === conversationId
    reactionsConvRef.current = conversationId
    const prevKey = prevReactionsKeyRef.current
    prevReactionsKeyRef.current = reactionsSignature
    if (!sameConversation) return // conversation switch → rebaseline, never re-pin
    if (prevKey === reactionsSignature) return // no actual reactions change (unrelated re-render)

    const scroller = scrollerRef.current
    if (!scroller || staticMode) return
    // Live-geometry gate: only re-pin when genuinely at/near the bottom right now.
    if (getDistanceFromBottom(scroller) >= AT_BOTTOM_THRESHOLD) return
    // A running pin loop already keeps the bottom pinned — don't stack a second one.
    if (pinBottomActiveRef.current) return

    reassertBottom('reaction')
  }, [reactionsSignature, conversationId, staticMode, reassertBottom])

  // ==========================================================================
  // EFFECT: Typing indicator appears — reveal its footer clearance while sticked
  // ==========================================================================

  // The footer reserves extra bottom padding only while the typing pill is shown (see
  // MessageList's footer render), so that clearance grows when typing starts. Unlike a reaction's
  // few-pixel growth, the virtualized footer row needs a remeasure pass before the virtualizer's
  // computed end offset accounts for the taller padding — a one-shot scrollToIndex lands short (the
  // spacer hasn't caught up yet), leaving a residual gap under the pill. So this routes through the
  // shared reassertBottom/pinVirtualizedBottom (the same multi-frame convergence new messages use)
  // instead of the reactions effect's single smooth nudge. Same two safeguards though: live-geometry
  // gate (not the latchable isAtBottomRef) and a same-conversation check. Only the false→true edge
  // nudges; typing stopping SHRINKS the footer, which the browser clamps scrollTop for on its own.
  const prevHasTypingRef = useRef(hasTypingIndicator)
  const typingConvRef = useRef(conversationId)
  useLayoutEffect(() => {
    const sameConversation = typingConvRef.current === conversationId
    typingConvRef.current = conversationId
    const prevHasTyping = prevHasTypingRef.current
    prevHasTypingRef.current = hasTypingIndicator
    if (!sameConversation) return // conversation switch → rebaseline, never nudge
    if (!hasTypingIndicator || prevHasTyping) return // only the off→on edge grows the footer

    const scroller = scrollerRef.current
    if (!scroller || staticMode) return
    // Live-geometry gate: only re-pin when genuinely at/near the bottom right now.
    if (getDistanceFromBottom(scroller) >= AT_BOTTOM_THRESHOLD) return

    reassertBottom('typing')
  }, [hasTypingIndicator, conversationId, staticMode, reassertBottom])

  // ==========================================================================
  // EFFECT: Container resize (composer grows/shrinks)
  // ==========================================================================

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    let lastHeight: number | null = null
    let pendingHeight: number | null = null
    let lastWidth: number | null = null
    let pendingWidth: number | null = null
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
      const newWidth = pendingWidth
      pendingHeight = null
      pendingWidth = null
      if (newHeight === null) return

      if (lastHeight === null) { lastHeight = newHeight; lastWidth = newWidth; return }

      const shrunk = lastHeight - newHeight
      if (shrunk > 0 && scrollerRef.current) {
        const wasNear = getDistanceFromBottom(scrollerRef.current) <= shrunk + AT_BOTTOM_THRESHOLD
        // Route through reassertBottom so the virtualized path re-windows (scrollToIndex) rather
        // than a raw scrollTop write that would leave the mounted window stale → blank/clipped.
        if (wasNear) reassertBottom('container-shrink')
      } else if (
        newWidth !== null && lastWidth !== null && newWidth !== lastWidth &&
        scrollerRef.current && isAtBottomRef.current
      ) {
        // A WIDTH change with no height shrink — most notably the occupant sidebar toggling
        // in/out at lg+, where the message column narrows/widens as the panel becomes an
        // in-flow flex sibling. That re-wraps message text and grows/shrinks row heights, but
        // fires no window 'resize' event (so the viewport-resize handler never runs) and does
        // not shrink the scroller's height (so the branch above never runs) — leaving the list
        // drifted off the bottom. Re-assert while the user is following along, mirroring the
        // window-resize handler. The scroller's own width only changes on real layout changes,
        // not on row measurement, so this cannot feed back into the @tanstack spacer churn.
        reassertBottom('width-change')
      }

      lastHeight = newHeight
      lastWidth = newWidth
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
      pendingWidth = entries[0].contentRect.width
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
    // isAtBottomRef is stable unless the caller passes a new externalIsAtBottomRef (same
    // rationale as the viewport-resize effect above).
  }, [conversationId, reassertBottom, isAtBottomRef])

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

  // Public jump-to-last-read entry point: re-run the SAME re-assert loop the conversation-switch
  // entry effect uses, targeting the CURRENT marker/conversation. No-op without a live marker.
  const scrollToMarker = useCallback(() => {
    if (!firstNewMessageId) return
    userScrollIntentAtRef.current = Date.now()
    userHasScrolledSinceEntryRef.current = true
    runMarkerReassertLoop(firstNewMessageId, conversationId)
  }, [firstNewMessageId, conversationId, runMarkerReassertLoop])

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
    markerAboveViewport,
    bottomVisibleMessageId,
    scrollToMarker,
  }
}
