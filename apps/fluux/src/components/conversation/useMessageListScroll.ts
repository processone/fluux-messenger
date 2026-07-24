/**
 * useMessageListScroll - Simple, imperative scroll management
 *
 * DESIGN PRINCIPLES:
 * 1. Production scroll state lives in REFS, not React state (prevents render loops)
 * 2. Saved-position, unread-marker, explicit-target, live-edge, and media-preservation
 *    policy/retry ownership lives in PositioningController; browser writes stay imperative in
 *    leased hook executors while directional history remains to migrate
 * 3. Only FAB visibility uses React state (it needs to trigger UI updates)
 * 4. The controller owns generations and migrated-position arbitration, not React state or geometry
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
import {
  PositioningController,
  type ExplicitTargetExecutor,
  type LiveEdgeExecutor,
  type LiveEdgeCompletion,
  type MediaPreservationExecutor,
  type PositionExecutionLease,
  type SavedPositionExecutionLease,
  type SavedPositionExecutor,
  type UnreadMarkerExecutor,
} from './positioningController'
import {
  deriveAtLiveEdge,
  deriveEntryPositionFacts,
  deriveLiveEdgeNavigationFacts,
  deriveReachabilityForDesired,
  readScrollGeometry,
} from './scrollPositionFacts'
import {
  messageFraction,
  pixelOffset,
  type DesiredPosition,
  type ExplicitTargetRequest,
  type LiveEdgeRequest,
  type MediaPreservationRequest,
  type ReachabilityFacts,
  type SavedPositionRequest,
  type UnreadMarkerRequest,
} from './scrollPositionModel'
import { runScrollShadowSafely } from './scrollPositionShadow'
import { findMessageTargetElement } from './messageTargetElement'

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
// How long a jumped-to message keeps its highlight tint, for both the controller-owned live path
// and the scoped static-preview path (they must flash identically).
const TARGET_HIGHLIGHT_MS = 1500
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

/**
 * Freeze a callback's identity while always invoking its latest version.
 *
 * Positioning callbacks close over `messageCount`, `firstMessageId`, and window state through their
 * executors, so their identity changes on every append. That is harmless for a direct call, but two
 * of them are published: `requestMessageTarget` is a context value read by EVERY message row, and
 * both are dependencies of the active-list registration. An unstable identity there re-renders every
 * mounted row on each append — context updates bypass `React.memo` — and re-registers the list.
 * Forwarding through a ref keeps behaviour identical (the newest implementation still runs) while
 * the published identity stays constant.
 */
function useStableCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
): (...args: Args) => void {
  const latest = useRef(callback)
  latest.current = callback
  return useCallback((...args: Args) => latest.current(...args), [])
}

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
  readPointerId?: string
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
  /** Submit a reply/poll/find target to the generation-aware positioning controller. */
  requestMessageTarget: (messageReference: string) => void
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

// ============================================================================
// HOOK
// ============================================================================

export function useMessageListScroll({
  conversationId,
  messageCount,
  firstMessageId,
  firstNewMessageId,
  readPointerId,
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
  // Saved-position entry runs in a layout effect, before latestRef's passive update. Keep the
  // loader synchronous with the render so a conversation switch cannot invoke the room we left.
  const onLoadAroundRef = useRef(onLoadAround)
  onLoadAroundRef.current = onLoadAround
  // Explicit-target completion may run after the render that submitted it. Keep the current target
  // and callback synchronous so a stale generation can never clear a newer search/activity target.
  const targetMessageIdRef = useRef(targetMessageId)
  targetMessageIdRef.current = targetMessageId
  const onTargetMessageConsumedRef = useRef(onTargetMessageConsumed)
  onTargetMessageConsumedRef.current = onTargetMessageConsumed
  const storeTargetRequestRef = useRef<ExplicitTargetRequest | null>(null)

  // Latest MAM-loading state (forward catch-up on entry, or backward "load older" pagination) for
  // the active conversation, read imperatively inside the live-edge executor —
  // see the repaint-suppression note in writePin below. Updated synchronously in the render body
  // (same pattern as virtualizerRef) so it is never stale when the pin loop reads it mid-run.
  const isLoadingOlderRef = useRef(isLoadingOlder)
  isLoadingOlderRef.current = isLoadingOlder

  // Track conversation
  const activeConversationIdRef = useRef(conversationId)
  activeConversationIdRef.current = conversationId
  const prevConversationRef = useRef<string | null>(null)
  const prevMessageCountRef = useRef(0)
  const prevLastMessageIdRef = useRef<string | undefined>(lastMessageId)
  const hasInitializedRef = useRef(false)
  const pendingSyncedLiveEdgeRef = useRef<{
    conversationId: string
    savedReadPositionId: string | undefined
  } | null>(null)
  const previousReadPositionRef = useRef(readPointerId)
  useEffect(() => {
    previousReadPositionRef.current = readPointerId
  }, [conversationId, readPointerId])
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
  // React StrictMode replays layout-effect cleanup/setup without unmounting the DOM. Defer controller
  // deactivation by one microtask and cancel it if setup replays, while real unmount still aborts.
  const unmountDeactivationTokenRef = useRef<object | null>(null)
  // Generation-aware semantic controller. Saved-position restoration, unread-marker positioning,
  // explicit targets, live edge, and media preservation are authoritative. Directional history
  // still reports shadow decisions. Pixel writes stay in hook executors, while the module-private
  // generation allocator survives StrictMode remounts.
  const positioningControllerRef = useRef<PositioningController | null | undefined>(undefined)
  if (positioningControllerRef.current === undefined) {
    positioningControllerRef.current = runScrollShadowSafely({
      event: 'controller-create',
      conversationId,
      fallback: null,
      observe: () => new PositioningController(),
    })
  }
  const reconcileLiveEdgeRef = useRef<(trigger: string) => boolean>(
    () => false,
  )
  const shadowReachabilityRef = useRef<(desired: DesiredPosition) => ReachabilityFacts>(
    () => ({ kind: 'empty-window' }),
  )
  shadowReachabilityRef.current = (desired) => {
    return runScrollShadowSafely({
      event: 'reachability',
      conversationId,
      fallback: { kind: 'empty-window' },
      observe: () => {
        const loadAround = onLoadAround ? 'available' : 'unavailable'
        return deriveReachabilityForDesired({
          desired,
          hasRows: messageCount > 0,
          windowAtLiveEdge: windowAtLiveEdge !== false,
          virtualizer: virtualizerRef.current,
          scroller: scrollerRef.current,
          loadAround,
          canRecenter: true,
        })
      },
    })
  }
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

      // Conversation entry owns initial bottom placement through the controller's live-edge
      // executor. In particular, its non-virtualized switch path retains the historical immediate
      // plus deferred repair, so this observer must not issue a second pair of mount-time writes.

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

        // Content grew and we were at bottom -> stay at bottom. Re-open the current live-edge
        // generation so the controller remains the only owner even on the non-virtualized path.
        if (newHeight > lastHeight && isAtBottomRef.current && !staticMode) {
          debugLog('RESIZE SCROLL TO BOTTOM', {
            newHeight,
            lastHeight,
            isAtBottom: isAtBottomRef.current,
            scrollTopBefore: currentScrollTop,
          })
          reconcileLiveEdgeRef.current('content-growth')
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
          const markUserScrolled = () => {
            userHasScrolledSinceEntryRef.current = true
            userScrollIntentAtRef.current = Date.now()
            positioningControllerRef.current?.observeUserInput(
              activeConversationIdRef.current,
            )
          }
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

  // Apply one virtualized bottom-fraction anchor write from CURRENT measurements. Saved-position
  // restoration and media preservation share this browser geometry while the positioning controller
  // owns both frame-loop lifecycles.
  const applyVirtualizedAnchorFrame = useCallback((anchor: ScrollAnchor): number | null => {
    const v = virtualizerRef.current
    const s = scrollerRef.current
    if (!v || !s) return null
    const idx = v.getIndexForMessageId(anchor.messageId)
    if (idx === null) return null
    // Issue the fractional target as the ONLY scroll write per frame. The old code ALSO called
    // scrollToIndex(idx,'end') every frame; the two targets differ by (1-fraction)*rowHeight, and
    // for a tall anchor at a mid fraction that per-frame kick knocks the row across the
    // virtualization window boundary — its height flips between estimate and measured, the offsets
    // shift, and the loop never converges ([ScrollReassertLoop] 'restore-anchor', observed as a
    // ~253px scrollTop ping-pong). scrollToOffset re-windows just like scrollToIndex, so the
    // fractional write alone both positions the anchor AND keeps it mounted, so it settles.
    const item =
      anchor.fraction < 1 ? v.getVirtualItems().find((vi) => vi.index === idx) : undefined
    const size = item?.size
    const start = size ? v.getOffsetForMessageId(anchor.messageId) : null
    if (size && start !== null) {
      v.scrollToOffset(Math.max(0, start + anchor.fraction * size - s.clientHeight))
    } else {
      // Anchor not yet in the measured window (or fraction===1): mount it / pin its bottom to the
      // viewport bottom. Once it measures in, later frames take the fractional branch above.
      v.scrollToIndex(idx, { align: 'end' })
    }
    return s.scrollTop
  }, [])

  const beginControllerFrameLoop = useCallback((
    label: string,
    lease: PositionExecutionLease,
  ) => {
    if (!lease.isCurrent()) return null
    supersedeReassertLoopRef.current()
    const monitor = (reassertMonitorRef.current ??=
      createReassertLoopMonitor()).begin(label, performance.now())
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      monitor.end()
      const activeLoop = reassertLoopRef.current
      if (activeLoop?.handle === monitor) {
        cancelAnimationFrame(activeLoop.raf)
        reassertLoopRef.current = null
      }
    }
    return {
      schedule: (callback: () => void) => {
        if (finished || !lease.isCurrent()) return
        // Register before scheduling so synchronous-rAF test harnesses cannot resurrect a loop that
        // completed from inside the callback.
        const entry = { raf: 0, handle: monitor }
        reassertLoopRef.current = entry
        entry.raf = requestAnimationFrame(callback)
      },
      recordFrame: (wrote: boolean) => {
        const warning = monitor.frame(performance.now(), wrote)
        if (warning) console.warn(warning)
      },
      finish,
    }
  }, [])

  const createLiveEdgeExecutor = useCallback((
    trigger: string,
    smoothNonVirtualized = false,
  ): LiveEdgeExecutor => {
    const burst = (pinRepaintBurstRef.current ??= createPinRepaintBurst())
    const run = createPinRunTracker()
    const repaintMode = readPinRepaintMode(
      typeof window === 'undefined' ? undefined : window.localStorage,
    )
    let initialized = false
    let lastHeight = 0
    let wroteAny = false

    const flushTailLayout = () => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const started = performance.now()
      scroller.getBoundingClientRect()
      const rows = scroller.querySelectorAll('[data-message-id]')
      for (let i = Math.max(0, rows.length - 3); i < rows.length; i++) {
        rows[i].getBoundingClientRect()
      }
      run.addMs('flush', performance.now() - started)
    }

    const forceRepaint = () => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const started = performance.now()
      scroller.style.overflowY = 'hidden'
      void scroller.offsetHeight
      scroller.style.overflowY = ''
      run.addMs('repaint', performance.now() - started)
    }

    const repaintCoalesced = (moved: boolean) => {
      if (!shouldForceRepaint(moved, repaintMode, isLoadingOlderRef.current)) return
      if (repaintMode === 'on-write' && burst.suppress(performance.now())) {
        burst.markSuppressed()
        return
      }
      forceRepaint()
    }

    const writeVirtualizedPin = (): boolean => {
      const scroller = scrollerRef.current
      const virtualizer = virtualizerRef.current
      if (!scroller || !virtualizer || virtualizer.itemCount === 0) return false
      const before = scroller.scrollTop
      const started = performance.now()
      virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })
      run.addMs('scroll', performance.now() - started)
      const moved = scroller.scrollTop !== before
      wroteAny ||= moved
      repaintCoalesced(moved)
      return moved
    }

    const flushOwedRepaint = () => {
      if (!burst.owed()) return
      forceRepaint()
      console.warn(pinBurstProbeLine(trigger, burst.settle()))
    }

    return {
      reachability: () => deriveReachabilityForDesired({
        desired: { kind: 'live-edge', follow: true },
        hasRows: messageCount > 0 && firstMessageId !== undefined,
        windowAtLiveEdge: windowAtLiveEdge !== false,
        virtualizer: virtualizerRef.current,
        scroller: scrollerRef.current,
        loadAround: 'unavailable',
        canRecenter: Boolean(onLoadNewer),
      }),
      recenterVersion: [
        windowAtLiveEdge === false ? 'slid' : 'live',
        isLoadingNewer ? 'loading' : 'idle',
        messageCount,
        lastMessageId ?? '',
      ].join(':'),
      recenter: onLoadNewer
        ? (signal) => {
            if (signal.aborted) return 'unavailable'
            if (isLoadingNewer) return 'waiting'
            onLoadNewer()
            return 'requested'
          }
        : undefined,
      beginLoop: (lease) => {
        const loop = beginControllerFrameLoop('pin-bottom', lease)
        if (!loop) return null
        pinBottomActiveRef.current = true
        return {
          ...loop,
          finish: () => {
            loop.finish()
            pinBottomActiveRef.current = false
          },
        }
      },
      positionFrame: (
        request: LiveEdgeRequest,
        lease: PositionExecutionLease,
      ) => {
        if (
          !lease.isCurrent() ||
          activeConversationIdRef.current !== request.conversationId
        ) {
          return { kind: 'unavailable' }
        }
        const scroller = scrollerRef.current
        if (!scroller) return { kind: 'unavailable' }
        const virtualizer = virtualizerRef.current

        if (!virtualizer) {
          const firstFrame = !initialized
          const before = scroller.scrollTop
          if (smoothNonVirtualized && firstFrame) {
            scroller.scrollTo({
              top: scroller.scrollHeight,
              behavior: 'smooth',
            })
          } else {
            scroller.scrollTop = scroller.scrollHeight
          }
          initialized = true
          rememberBottomIntent()
          return {
            kind: 'positioned',
            scrollTop: scroller.scrollTop,
            atLiveEdge: true,
            wrote: scroller.scrollTop !== before,
            // Conversation entry historically issued one deferred raw write after the immediate
            // layout-effect write. Keep that exact two-write edge-case repair under controller
            // scheduling; all other non-virtualized stimuli remain one-shot.
            reassert: firstFrame && trigger === 'switch',
          }
        }
        if (virtualizer.itemCount === 0) return { kind: 'unavailable' }

        if (!initialized) {
          initialized = true
          if (CONTENT_ARRIVAL_TRIGGERS.has(trigger)) {
            burst.note(performance.now())
          }
          flushTailLayout()
          writeVirtualizedPin()
          lastHeight = scroller.scrollHeight
          rememberBottomIntent()
          debugLog('PIN start', {
            trigger,
            itemCount: virtualizer.itemCount,
            distFromBottom: getDistanceFromBottom(scroller),
          })
          return {
            kind: 'positioned',
            scrollTop: scroller.scrollTop,
            atLiveEdge:
              getDistanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD,
            wrote: true,
            reassert: true,
          }
        }

        flushTailLayout()
        const height = scroller.scrollHeight
        const distance = getDistanceFromBottom(scroller)
        const needsWrite =
          height !== lastHeight || distance > BOTTOM_PIN_TOLERANCE
        if (needsWrite) {
          debugLog('PIN re-assert', {
            distFromBottom: distance,
            heightChanged: height !== lastHeight,
          })
          lastHeight = height
          writeVirtualizedPin()
        }
        run.frame(needsWrite)
        return {
          kind: 'positioned',
          scrollTop: scroller.scrollTop,
          atLiveEdge:
            getDistanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD,
          wrote: needsWrite,
          reassert: true,
        }
      },
      complete: (
        request: LiveEdgeRequest,
        outcome: LiveEdgeCompletion,
      ) => {
        if (activeConversationIdRef.current !== request.conversationId) return
        const scroller = scrollerRef.current
        if (
          outcome === 'user-takeover' ||
          outcome === 'superseded'
        ) {
          // Cancellation abandons this executor's paint obligation. Carrying the debt into a newer
          // generation could repaint after genuine user takeover or charge unrelated content.
          burst.reset()
        } else if (outcome === 'best-effort' && scroller) {
          flushTailLayout()
          if (burst.owed()) {
            flushOwedRepaint()
          } else if (
            shouldForceRepaint(
              wroteAny,
              repaintMode,
              isLoadingOlderRef.current,
            )
          ) {
            forceRepaint()
          }
        } else if (outcome === 'settled') {
          flushOwedRepaint()
        }

        if (scroller) {
          isAtBottomRef.current =
            getDistanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD
          lastProgrammaticScrollAtRef.current = Date.now()
        }
        const probe = (pinRunProbeRef.current ??= createRenderCostProbe({
          thresholdMs: PIN_PROBE_THRESHOLD_MS,
        }))
        if (probe.record(run.totalForcedMs(), performance.now())) {
          console.warn(run.summaryLine(trigger))
        }
        debugLog('PIN completed', {
          trigger,
          outcome,
          distFromBottom: scroller ? getDistanceFromBottom(scroller) : null,
        })
      },
    }
  }, [
    beginControllerFrameLoop,
    firstMessageId,
    isAtBottomRef,
    isLoadingNewer,
    lastMessageId,
    messageCount,
    onLoadNewer,
    rememberBottomIntent,
    windowAtLiveEdge,
  ])

  const reconcileLiveEdge = useCallback((trigger: string): boolean => {
    const controller = positioningControllerRef.current
    if (!controller) return false
    return controller.reconcileLiveEdge({
      conversationId,
      executor: createLiveEdgeExecutor(trigger),
    })
  }, [conversationId, createLiveEdgeExecutor])
  reconcileLiveEdgeRef.current = reconcileLiveEdge

  // Controller/instrumentation failure boundary only. Normal bottom positioning always goes through
  // a generation-bearing live-edge execution; this one-shot keeps the UI usable if that machinery
  // cannot be constructed.
  const emergencyLiveEdgeWrite = useCallback((
    smoothNonVirtualized = false,
  ) => {
    const scroller = scrollerRef.current
    const virtualizer = virtualizerRef.current
    if (!scroller) return
    if (virtualizer && virtualizer.itemCount > 0) {
      virtualizer.scrollToIndex(virtualizer.itemCount - 1, { align: 'end' })
    } else if (smoothNonVirtualized) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    } else {
      scroller.scrollTop = scroller.scrollHeight
    }
    rememberBottomIntent()
  }, [rememberBottomIntent])

  const createMediaPreservationExecutor = useCallback(
    (): MediaPreservationExecutor => ({
      reachability: (desired) => deriveReachabilityForDesired({
        desired,
        hasRows: messageCount > 0 && firstMessageId !== undefined,
        windowAtLiveEdge: windowAtLiveEdge !== false,
        virtualizer: virtualizerRef.current,
        scroller: scrollerRef.current,
        loadAround: 'unavailable',
        canRecenter: false,
      }),
      beginLoop: (lease) => beginControllerFrameLoop('media-anchor', lease),
      positionFrame: (
        request: MediaPreservationRequest,
        lease: PositionExecutionLease,
      ) => {
        if (
          !lease.isCurrent() ||
          activeConversationIdRef.current !== request.conversationId
        ) {
          return { kind: 'unavailable' }
        }
        const scroller = scrollerRef.current
        if (!scroller) return { kind: 'unavailable' }
        const anchor: ScrollAnchor = {
          messageId: request.desired.messageId,
          fraction: request.desired.placement.fraction,
        }
        if (virtualizerRef.current) {
          const scrollTop = applyVirtualizedAnchorFrame(anchor)
          return scrollTop === null
            ? { kind: 'unavailable' }
            : { kind: 'positioned', scrollTop, reassert: true }
        }
        return restoreToAnchor(scroller, anchor)
          ? {
              kind: 'positioned',
              scrollTop: scroller.scrollTop,
              reassert: false,
            }
          : { kind: 'unavailable' }
      },
      complete: (request, outcome) => {
        if (activeConversationIdRef.current !== request.conversationId) return
        const scroller = scrollerRef.current
        if (scroller) {
          isAtBottomRef.current =
            getDistanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD
          rememberCurrentScrollSnapshot()
        }
        lastProgrammaticScrollAtRef.current = Date.now()
        debugLog('MEDIA LOAD: controller completed preservation', {
          conversationId: request.conversationId,
          generation: request.generation,
          outcome,
        })
      },
    }),
    [
      applyVirtualizedAnchorFrame,
      beginControllerFrameLoop,
      firstMessageId,
      isAtBottomRef,
      messageCount,
      rememberCurrentScrollSnapshot,
      windowAtLiveEdge,
    ],
  )

  const createSavedPositionExecutor = useCallback((): SavedPositionExecutor => ({
    liveEdge: createLiveEdgeExecutor('restore-fallback'),
    reachability: (desired, loadAround) => {
      const scroller = scrollerRef.current
      const virtualizer = virtualizerRef.current
      const legacyOffsetViable =
        desired.kind !== 'legacy-offset' ||
        Boolean(
          virtualizer ||
          (
            scroller &&
            scroller.scrollHeight - scroller.clientHeight > 0 &&
            desired.offsetPx >= 0 &&
            desired.offsetPx <= scroller.scrollHeight - scroller.clientHeight
          )
        )
      return deriveReachabilityForDesired({
        desired,
        hasRows: messageCount > 0 && firstMessageId !== undefined,
        windowAtLiveEdge: windowAtLiveEdge !== false,
        virtualizer,
        scroller,
        loadAround,
        canRecenter: Boolean(onLoadNewer),
        legacyOffsetViable,
      })
    },
    loadAround: onLoadAroundRef.current
      ? (messageId, signal) => {
          if (signal.aborted) return
          isAtBottomRef.current = false
          debugLog('RESTORE: anchor not loaded, requesting cache slice around it', {
            messageId,
            conversationId,
          })
          return onLoadAroundRef.current?.(messageId)
        }
      : undefined,
    recenterVersion: [
      windowAtLiveEdge === false ? 'slid' : 'live',
      isLoadingNewer ? 'loading' : 'idle',
      messageCount,
      lastMessageId ?? '',
    ].join(':'),
    recenterLiveEdge: onLoadNewer
      ? (signal) => {
          if (signal.aborted) return 'unavailable'
          if (isLoadingNewer) return 'waiting'
          onLoadNewer()
          return 'requested'
        }
      : undefined,
    beginLoop: (lease) => beginControllerFrameLoop('restore-anchor', lease),
    positionFrame: (request: SavedPositionRequest, lease: SavedPositionExecutionLease) => {
      if (!lease.isCurrent()) return { kind: 'unavailable' }
      const scroller = scrollerRef.current
      if (!scroller) return { kind: 'unavailable' }

      let restored = false
      let reassert = false
      if (request.desired.kind === 'anchor') {
        const anchor: ScrollAnchor = {
          messageId: request.desired.messageId,
          fraction: request.desired.placement.fraction,
        }
        if (virtualizerRef.current) {
          restored = applyVirtualizedAnchorFrame(anchor) !== null
          reassert = restored
        } else {
          restored = restoreToAnchor(scroller, anchor)
        }
      } else if (request.desired.kind === 'legacy-offset') {
        const virtualizer = virtualizerRef.current
        if (virtualizer) {
          virtualizer.scrollToOffset(request.desired.offsetPx)
          restored = true
        } else {
          const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
          if (
            maxScrollTop > 0 &&
            request.desired.offsetPx >= 0 &&
            request.desired.offsetPx <= maxScrollTop
          ) {
            scroller.scrollTop = request.desired.offsetPx
            restored = true
          }
        }
      } else if (request.desired.kind === 'live-edge') {
        // Live-edge fallbacks transfer to the dedicated controller execution before this executor
        // is driven. Treat a stale call as unavailable rather than creating a second scroll owner.
        return { kind: 'unavailable' }
      }

      if (!restored || !lease.isCurrent()) return { kind: 'unavailable' }
      return {
        kind: 'positioned',
        scrollTop: scroller.scrollTop,
        reassert,
      }
    },
    complete: (request, outcome) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      isAtBottomRef.current = getDistanceFromBottom(scroller) < AT_BOTTOM_THRESHOLD
      rememberCurrentScrollSnapshot()
      lastProgrammaticScrollAtRef.current = Date.now()
      debugLog('RESTORE: controller completed position', {
        conversationId,
        generation: request.generation,
        desired: request.desired,
        outcome,
      })
    },
  }), [
    applyVirtualizedAnchorFrame,
    beginControllerFrameLoop,
    conversationId,
    createLiveEdgeExecutor,
    firstMessageId,
    isAtBottomRef,
    isLoadingNewer,
    lastMessageId,
    messageCount,
    onLoadNewer,
    rememberCurrentScrollSnapshot,
    windowAtLiveEdge,
  ])

  const createUnreadMarkerExecutor = useCallback((): UnreadMarkerExecutor => ({
    liveEdge: createLiveEdgeExecutor('marker-fallback'),
    reachability: (desired) => deriveReachabilityForDesired({
      desired,
      hasRows: messageCount > 0 && firstMessageId !== undefined,
      windowAtLiveEdge: windowAtLiveEdge !== false,
      virtualizer: virtualizerRef.current,
      scroller: scrollerRef.current,
      loadAround: 'unavailable',
      canRecenter: false,
    }),
    beginLoop: (lease: PositionExecutionLease) =>
      beginControllerFrameLoop('marker', lease),
    readScrollTop: () => scrollerRef.current?.scrollTop ?? null,
    positionFrame: (
      request: UnreadMarkerRequest,
      lease: PositionExecutionLease,
    ) => {
      if (!lease.isCurrent()) return { kind: 'unavailable' }
      const scroller = scrollerRef.current
      if (!scroller) return { kind: 'unavailable' }

      // Entry waits until the passive latest-value handoff has installed the new conversation's
      // virtualizer. Reading the synchronous render ref here can act on a transient pre-paint
      // window and advance viewport-derived read state before the new list is settled.
      const latest = latestRef.current
      if (latest.conversationId !== request.conversationId) {
        return { kind: 'waiting' }
      }
      const virtualizer = latest.virtualizer
      const markerId = request.desired.messageId
      const markerIndex = virtualizer
        ? virtualizer.getIndexForMessageId(markerId)
        : null
      let offset: number | null = null
      if (virtualizer) {
        if (markerIndex === null) return { kind: 'waiting' }
        offset = virtualizer.getOffsetForMessageId(markerId)
      } else {
        const element = scroller.querySelector(
          `[data-message-id="${CSS.escape(markerId)}"]`,
        ) as HTMLElement | null
        if (element) offset = element.offsetTop
      }
      if (offset === null) return { kind: 'waiting' }

      // Avoid a target at scrollTop=0: handleScroll treats that as an explicit request for older
      // history. For all/mostly-unread windows, preserve the established live-edge fallback.
      if (offset <= scroller.clientHeight / 3) {
        return { kind: 'unavailable' }
      }
      if (!lease.isCurrent()) return { kind: 'unavailable' }

      if (virtualizer && markerIndex !== null) {
        virtualizer.scrollToIndex(markerIndex, { align: 'start' })
      } else {
        const top =
          request.desired.align === 'top-third'
            ? Math.max(0, offset - scroller.clientHeight / 3)
            : offset
        scroller.scrollTop = top
      }

      const scrollTop = scroller.scrollTop
      const distanceFromBottom =
        scroller.scrollHeight - scrollTop - scroller.clientHeight
      const atLiveEdge = distanceFromBottom < AT_BOTTOM_THRESHOLD
      isAtBottomRef.current = atLiveEdge
      debugLog('UNREAD MARKER: controller positioned frame', {
        conversationId: request.conversationId,
        generation: request.generation,
        markerId,
        markerIndex,
        offset,
        scrollTop,
        distanceFromBottom,
        atLiveEdge,
      })
      return { kind: 'positioned', scrollTop, atLiveEdge }
    },
  }), [
    firstMessageId,
    beginControllerFrameLoop,
    createLiveEdgeExecutor,
    isAtBottomRef,
    messageCount,
    windowAtLiveEdge,
  ])

  const createExplicitTargetExecutor = useCallback((
    messageReference: string,
    consumeStoreTarget: boolean,
  ): ExplicitTargetExecutor => ({
    reachability: (desired, loadAround) => {
      const scroller = scrollerRef.current
      const virtualizer = virtualizerRef.current
      const element = scroller
        ? findMessageTargetElement(scroller, desired.messageId)
        : null
      if (element) {
        return {
          kind: 'available',
          index: virtualizer?.getIndexForMessageId(desired.messageId) ?? 0,
          mounted: true,
          placement: 'viable',
        }
      }
      const facts = deriveReachabilityForDesired({
        desired,
        hasRows: messageCount > 0 && firstMessageId !== undefined,
        windowAtLiveEdge: windowAtLiveEdge !== false,
        virtualizer,
        scroller,
        loadAround,
        canRecenter: false,
      })
      // Unlike ordinary entry hydration, an explicit target is meaningful even when the resident
      // window is empty: it can name the cache slice that must be loaded.
      return facts.kind === 'empty-window'
        ? { kind: 'target-absent', loadAround }
        : facts
    },
    loadAround: onLoadAroundRef.current
      ? (messageId, signal) => {
          if (
            signal.aborted ||
            activeConversationIdRef.current !== conversationId
          ) {
            return
          }
          isAtBottomRef.current = false
          debugLog('TARGET MESSAGE: requesting cache slice around target', {
            conversationId,
            messageId,
          })
          return onLoadAroundRef.current?.(messageId)
        }
      : undefined,
    beginLoop: (lease) => beginControllerFrameLoop('target', lease),
    readScrollTop: () => scrollerRef.current?.scrollTop ?? null,
    positionFrame: (
      request: ExplicitTargetRequest,
      lease: PositionExecutionLease,
    ) => {
      if (!lease.isCurrent()) return { kind: 'unavailable' }
      const scroller = scrollerRef.current
      if (!scroller) return { kind: 'unavailable' }

      // The request may be submitted during entry. Wait for the passive handoff so a stale
      // virtualizer from the room we left cannot receive the first center write.
      const latest = latestRef.current
      if (latest.conversationId !== request.conversationId) {
        return { kind: 'waiting' }
      }

      const targetId = request.desired.messageId
      const virtualizer = latest.virtualizer
      const index = virtualizer?.getIndexForMessageId(targetId) ?? null
      const element = findMessageTargetElement(scroller, targetId)
      if (index === null && !element) return { kind: 'waiting' }
      if (!lease.isCurrent()) return { kind: 'unavailable' }

      if (index !== null && virtualizer) {
        virtualizer.scrollToIndex(index, { align: 'center' })
      } else {
        element?.scrollIntoView({ block: 'center' })
      }
      const scrollTop = scroller.scrollTop
      const distanceFromBottom =
        scroller.scrollHeight - scrollTop - scroller.clientHeight
      isAtBottomRef.current = distanceFromBottom < AT_BOTTOM_THRESHOLD
      debugLog('TARGET MESSAGE: controller positioned frame', {
        conversationId: request.conversationId,
        generation: request.generation,
        targetId,
        index,
        scrollTop,
        distanceFromBottom,
      })
      return { kind: 'positioned', scrollTop, wrote: true }
    },
    complete: (request, outcome, applied) => {
      if (
        activeConversationIdRef.current !== request.conversationId ||
        request.desired.messageId !== messageReference
      ) {
        return
      }
      if (
        consumeStoreTarget &&
        targetMessageIdRef.current !== request.desired.messageId
      ) {
        return
      }

      const element = scrollerRef.current
        ? findMessageTargetElement(
            scrollerRef.current,
            request.desired.messageId,
          )
        : null
      if (element && applied) {
        element.classList.add('message-highlight')
        setTimeout(() => element.classList.remove('message-highlight'), TARGET_HIGHLIGHT_MS)
      }
      debugLog('TARGET MESSAGE: controller completed', {
        conversationId: request.conversationId,
        generation: request.generation,
        targetId: request.desired.messageId,
        outcome,
        highlighted: Boolean(element && applied),
      })
      if (consumeStoreTarget) onTargetMessageConsumedRef.current?.()
    },
  }), [
    beginControllerFrameLoop,
    conversationId,
    firstMessageId,
    isAtBottomRef,
    messageCount,
    windowAtLiveEdge,
  ])

  const requestMessageTargetImpl = useCallback((messageReference: string) => {
    if (staticMode) {
      // Search/activity previews mount their own non-virtualized list beside the live conversation.
      // They own no positioning controller and must never drive one, but their reply/poll rows are
      // still clickable — so resolve inside THIS scroller only. Never the document: a preview must
      // not steal (or be stolen by) another list's copy of the same message id. Every row is in the
      // DOM here (staticMode forces the non-virtualized path), so one measured write is enough and
      // no generation, frame loop, or around-load is involved.
      const scroller = scrollerRef.current
      if (!scroller) return
      const element = findMessageTargetElement(scroller, messageReference)
      if (!element) return
      element.scrollIntoView({ block: 'center' })
      element.classList.add('message-highlight')
      setTimeout(() => element.classList.remove('message-highlight'), TARGET_HIGHLIGHT_MS)
      return
    }
    isAtBottomRef.current = false
    positioningControllerRef.current?.beginExplicitTarget({
      conversationId,
      messageId: messageReference,
      executor: createExplicitTargetExecutor(messageReference, false),
    })
  }, [
    conversationId,
    createExplicitTargetExecutor,
    isAtBottomRef,
    staticMode,
  ])
  // Published to every message row through MessageTargetProvider and to the active-list registry,
  // so its identity must not track messageCount/window state (see useStableCallback).
  const requestMessageTarget = useStableCallback(requestMessageTargetImpl)

  // ==========================================================================
  // SCROLL ACTIONS
  // ==========================================================================

  const scrollToBottomImpl = useCallback(() => {
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
    const virt = latestRef.current.virtualizer
    let markerOffsetPx: number | null = null
    let markerResolvable = false
    if (firstNewMessageId) {
      // Two-step: scroll to the marker first, then bottom on a second click.
      // Virtualized: use getIndexForMessageId (works for unmounted rows) + scrollToIndex.
      // Non-virtualized: DOM querySelector + offsetTop (all rows are always mounted).
      if (virt) {
        const markerIdx = virt.getIndexForMessageId(firstNewMessageId)
        if (markerIdx !== null) {
          markerResolvable = true
          markerOffsetPx = virt.getOffsetForMessageId(firstNewMessageId)
        }
      } else {
        const messageElement = scroller.querySelector(
          `[data-message-id="${CSS.escape(firstNewMessageId)}"]`,
        ) as HTMLElement | null
        if (messageElement) {
          markerResolvable = true
          markerOffsetPx = messageElement.offsetTop
        }
      }
    }

    const viewportBottom = scroller.scrollTop + scroller.clientHeight
    const markerNeedsVisit =
      markerResolvable &&
      (virt
        ? markerOffsetPx === null || markerOffsetPx > viewportBottom
        : markerOffsetPx !== null && markerOffsetPx > viewportBottom)
    const navigationFacts = deriveLiveEdgeNavigationFacts({
      firstUnreadMessageId: markerResolvable ? firstNewMessageId : undefined,
      markerOffsetPx,
      geometry: readScrollGeometry(scroller),
      virtualized: !!virt,
    })
    if (markerNeedsVisit) {
      const request = positioningControllerRef.current?.beginUnreadMarkerNavigation({
        conversationId,
        navigationFacts,
        executor: createUnreadMarkerExecutor(),
      })
      if (request) {
        return
      }
    }

    const request = positioningControllerRef.current?.beginLiveEdgeNavigation({
      conversationId,
      navigationFacts,
      executor: createLiveEdgeExecutor('fab', true),
    })
    if (!request) emergencyLiveEdgeWrite(true)
  }, [
    conversationId,
    createLiveEdgeExecutor,
    createUnreadMarkerExecutor,
    emergencyLiveEdgeWrite,
    firstNewMessageId,
  ])
  // Also published to the active-list registry (ChatLayout's Escape handler reaches it there), so it
  // is stabilised for the same reason as requestMessageTarget: an unstable identity re-registers the
  // list — and re-binds the ⌘/Ctrl+↓ listener — on every append.
  const scrollToBottom = useStableCallback(scrollToBottomImpl)

  const scrollToTop = useCallback(() => {
    lastLoadTimeRef.current = Date.now() // prevent auto-load trigger
    const scroller = scrollerRef.current
    if (!scroller) return
    const desired = { kind: 'resident-top' } as const
    positioningControllerRef.current?.observeRequest({
      event: 'home-key',
      conversationId,
      draft: {
        source: { kind: 'user-navigation', reason: 'resident-top' },
        desired,
      },
      reachability: shadowReachabilityRef.current(desired),
      actual: { desired, phase: 'positioning' },
    })
    scroller.scrollTo({ top: 0, behavior: 'smooth' })
  }, [conversationId])

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
      if (isAtBottomRef.current) {
        reconcileLiveEdgeRef.current('viewport-resize')
      }
    }
    window.addEventListener('resize', onViewportResize)
    const vv = window.visualViewport
    vv?.addEventListener('resize', onViewportResize)
    return () => {
      window.removeEventListener('resize', onViewportResize)
      vv?.removeEventListener('resize', onViewportResize)
    }
  }, [staticMode, isAtBottomRef])

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
          reconcileLiveEdge('media-load')
        } else {
          // User actively scrolled during the batch - respect their position
          debugLog('MEDIA LOAD: batch complete, user scrolled away', {
            wasAtBottom,
            userScrolled,
          })
        }
      } else if (!userScrolled && anchor) {
        runScrollShadowSafely({
          event: 'media-preservation',
          conversationId,
          fallback: undefined,
          observe: () => {
            const desired: MediaPreservationRequest['desired'] = {
              kind: 'anchor',
              messageId: anchor.messageId,
              placement: {
                kind: 'bottom-fraction',
                fraction: messageFraction(anchor.fraction),
              },
            }
            positioningControllerRef.current?.beginMediaPreservation({
              conversationId,
              desired,
              executor: createMediaPreservationExecutor(),
            })
          },
        })
        // Scrolled up and the user did NOT genuinely scroll during the batch: media that decoded
        // ABOVE the viewport grew the content and pushed the reading position down/out. Re-pin to the
        // anchor captured BEFORE the growth so the reader stays put (the conversation-switch + media
        // "drifts back in time" bug). Mirrors live-edge reconciliation, but for a held position.
        debugLog('MEDIA LOAD: batch complete, re-anchoring scrolled-up position', {
          wasAtBottom,
          anchorId: anchor.messageId,
        })
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
  }, [
    conversationId,
    createMediaPreservationExecutor,
    isAtBottomRef,
    reconcileLiveEdge,
  ])

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

    // A height change between consecutive scroll events is a measurement settle (rows re-measuring,
    // media decoding), never a user scroll — keep the programmatic-settle window alive across it.
    // isProgrammaticScroll's window is anchored to the last programmatic WRITE, but a WebKit settle
    // can fire 'scroll' events well beyond PROGRAMMATIC_SETTLE_MS after that write; once one of them
    // happened to match the previous frame's height, the gate below mistook it for a scrollbar drag,
    // opened, and persisted a drifted anchor that crept between room visits. Re-anchoring the window
    // to the last measurement CHANGE covers a settle of any duration. A genuine scrollbar-drag leaves
    // height unchanged, so it never refreshes the window and still opens the gate.
    if (prevScrollHeightRef.current !== null && prevScrollHeightRef.current !== scrollHeight) {
      lastProgrammaticScrollAtRef.current = Date.now()
    }

    // Open the save gate when this is a genuine user scroll: content height UNCHANGED from the
    // previous scroll event (a media/measurement-driven shift changes the height; a wheel / touch /
    // scrollbar-drag does not). Complements the input-event listeners so scrollbar-drag — which
    // fires no wheel/touch — also counts. Excluded: programmatic loop scrolls AND the
    // post-restore / post-re-pin measurement settle (isProgrammaticScroll's window, refreshed on the
    // height change just above) — that settle is height-unchanged on its final frames too, so without
    // the window a settle frame looked like a scrollbar drag, opened the gate, and persisted a
    // drifted position that crept older on every re-open. Genuine user scrolls still open the gate
    // via the input-event listeners / handleWheel, unaffected.
    const genuineUserScroll =
      !isProgrammaticScroll(
        programmaticScroll,
        Date.now(),
        lastProgrammaticScrollAtRef.current,
      ) && prevScrollHeightRef.current === scrollHeight
    if (genuineUserScroll) {
      userHasScrolledSinceEntryRef.current = true
      positioningControllerRef.current?.observeUserInput(conversationId)
      runScrollShadowSafely({
        event: 'settled-user-geometry',
        conversationId,
        fallback: undefined,
        observe: () => {
          positioningControllerRef.current?.observeSettledUserGeometry({
            conversationId,
            atLiveEdge: deriveAtLiveEdge(readScrollGeometry(el)),
          })
        },
      })
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
        readPointerId,
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
    positioningControllerRef.current?.observeUserInput(conversationId)
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
    const previousShadowModel = runScrollShadowSafely({
      event: 'deactivate-snapshot',
      conversationId: prevConversationRef.current ?? conversationId,
      fallback: null,
      observe: () => positioningControllerRef.current?.snapshot() ?? null,
    })
    const previousShadowGeneration =
      previousShadowModel?.currentConversationId === prevConversationRef.current
        ? previousShadowModel.watermark
        : null

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
    if (
      prevConversationRef.current &&
      previousShadowGeneration !== null
    ) {
      positioningControllerRef.current?.deactivate(
        prevConversationRef.current,
        previousShadowGeneration,
      )
    }

    // ENTERING new conversation - reset state
    hasInitializedRef.current = false
    userHasScrolledSinceMarkerRef.current = false
    scrolledAwayFromTopRef.current = false
    lastScrollDataRef.current = null
    lastAnchorRef.current = null
    prependRef.current = null
    pendingSyncedLiveEdgeRef.current = null
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
      const savedAnchor = scrollStateManager.getSavedAnchor(conversationId)
      const savedReadPositionId = scrollStateManager.getSavedReadPositionId(conversationId)
      const syncedLiveEdge =
        action === 'restore-position' &&
        firstNewMessageId === undefined &&
        readPointerId !== undefined &&
        readPointerId === lastMessageId &&
        readPointerId !== savedReadPositionId

      if (action === 'restore-position') {
        pendingSyncedLiveEdgeRef.current = { conversationId, savedReadPositionId }
        // The remote pointer can resolve before this mount. When it now identifies the newest
        // downloaded row, a saved position tied to an older pointer must not win merely because
        // there was never an unread divider.
        if (syncedLiveEdge) {
          scrollStateManager.clearSavedScrollState(conversationId)
          pendingSyncedLiveEdgeRef.current = null
          action = 'scroll-to-bottom'
          debugLog('MDS LIVE EDGE: synced read supersedes saved position on entry', {
            conversationId,
            savedReadPositionId,
            readPointerId,
          })
        }
      }

      debugLog('CONVERSATION ACTION', { action, savedPos, firstOpenThisSession, scrollHeight: scroller.scrollHeight })
      const entryFacts = runScrollShadowSafely({
        event: 'entry-facts',
        conversationId,
        fallback: null,
        observe: () => deriveEntryPositionFacts({
          syncedLiveEdge,
          savedAnchor,
          savedOffsetPx: savedPos,
          firstUnreadMessageId: firstNewMessageId,
          unreadMarkerAlign: virtualizerRef.current ? 'start' : 'top-third',
        }),
      })
      // Observation validators must never strand production positioning. If a transient saved
      // anchor is malformed (for example a zero-height row produced NaN), retain a finite legacy
      // offset when possible and otherwise let the controller choose its live-edge fallback.
      const entryExecutionFacts = entryFacts ?? runScrollShadowSafely({
        event: 'entry-fallback-facts',
        conversationId,
        fallback: null,
        observe: () => deriveEntryPositionFacts({
          syncedLiveEdge,
          savedAnchor: null,
          savedOffsetPx: savedPos !== null && Number.isFinite(savedPos) ? savedPos : null,
          firstUnreadMessageId: firstNewMessageId,
          unreadMarkerAlign: virtualizerRef.current ? 'start' : 'top-third',
        }),
      })

      if (action === 'restore-position') {
        isAtBottomRef.current = false
        const request = entryExecutionFacts
          ? positioningControllerRef.current?.beginSavedPositionEntry({
              conversationId,
              entryFacts: entryExecutionFacts,
              executor: createSavedPositionExecutor(),
            })
          : null
        if (!request) {
          // Controller construction/instrumentation failure must degrade safely instead of leaving
          // entry half-positioned. This is the only saved-position write outside the controller and
          // exists solely as its failure boundary.
          isAtBottomRef.current = true
          emergencyLiveEdgeWrite()
        }
      } else if (firstNewMessageId) {
        // Has unread messages — position the first-unread marker ~1/3 down from the top so the
        // user reads forward from where they left off. Mark NOT at bottom up front (mirrors the
        // targetMessageId branch) so the content-growth ResizeObserver doesn't auto-pin to the
        // bottom while we're still aiming for the marker.
        debugLog('CONVERSATION SWITCH: has unread, will scroll to marker', { firstNewMessageId })
        isAtBottomRef.current = false

        const request = entryExecutionFacts
          ? positioningControllerRef.current?.beginUnreadMarkerEntry({
            conversationId,
            entryFacts: entryExecutionFacts,
            executor: createUnreadMarkerExecutor(),
          })
          : null
        if (!request) {
          // Keep instrumentation/controller failures from stranding entry above an unresolved
          // divider. Normal marker unavailability is promoted by the controller itself.
          isAtBottomRef.current = true
          emergencyLiveEdgeWrite()
        }
      } else if (targetMessageId) {
        // Has a target message to scroll to — skip scroll-to-bottom.
        // The targetMessageId effect will handle scrolling.
        // Mark as NOT at bottom so the ResizeObserver doesn't auto-scroll
        // to bottom when content grows (messages loading from IndexedDB).
        isAtBottomRef.current = false
        debugLog('CONVERSATION SWITCH: has targetMessageId, deferring to target scroll', { targetMessageId })
        if (entryExecutionFacts) {
          positioningControllerRef.current?.observeEntry({
            event: 'entry-before-explicit-target',
            conversationId,
            entryFacts: entryExecutionFacts,
            reachability: (desired) => shadowReachabilityRef.current(desired),
            actual: {
              desired: { kind: 'live-edge', follow: true },
              phase: 'positioning',
            },
          })
        }
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
        const request = entryFacts
          ? positioningControllerRef.current?.beginLiveEdgeEntry({
            conversationId,
            entryFacts,
            executor: createLiveEdgeExecutor('switch'),
          })
          : null
        if (!request) emergencyLiveEdgeWrite()
      }
    }

    // Update tracking. Sync prevLastMessageIdRef to the entered conversation's newest message so
    // the new-message effect (which keys "did the bottom change?" off lastMessageId) does not
    // mistake the switch itself for a fresh send and override the marker/restore positioning.
    hasInitializedRef.current = true
    prevConversationRef.current = conversationId
    prevMessageCountRef.current = messageCount
    prevLastMessageIdRef.current = lastMessageId
    previousReadPositionRef.current = readPointerId

  }, [
    conversationId,
    createLiveEdgeExecutor,
    createSavedPositionExecutor,
    createUnreadMarkerExecutor,
    emergencyLiveEdgeWrite,
    firstNewMessageId,
    isAtBottomRef,
    lastMessageId,
    messageCount,
    readPointerId,
    staticMode,
    targetMessageId,
  ])

  // Zero-unread twin of the divider-clear settle below. The old local position may be restored
  // before MAM resolves the other device's pointer to the newest downloaded row; with no divider,
  // observing that pointer transition is the only signal that the restore became obsolete.
  useLayoutEffect(() => {
    const pending = pendingSyncedLiveEdgeRef.current
    if (!pending || pending.conversationId !== conversationId) return
    if (staticMode || userHasScrolledSinceEntryRef.current) return
    if (firstNewMessageId !== undefined || readPointerId === undefined) return
    if (readPointerId !== lastMessageId || readPointerId === pending.savedReadPositionId) return

    pendingSyncedLiveEdgeRef.current = null
    scrollStateManager.clearSavedScrollState(conversationId)
    isAtBottomRef.current = true
    debugLog('MDS LIVE EDGE: late synced read supersedes restored position', {
      conversationId,
      savedReadPositionId: pending.savedReadPositionId,
      readPointerId,
    })
    const request = positioningControllerRef.current?.beginLiveEdgeRequest({
      conversationId,
      source: {
        kind: 'late-mds-supersession',
        reason: 'read-pointer-at-live-edge',
      },
      executor: createLiveEdgeExecutor('mds-live-edge'),
    })
    if (!request) emergencyLiveEdgeWrite()
  }, [
    conversationId,
    createLiveEdgeExecutor,
    emergencyLiveEdgeWrite,
    firstNewMessageId,
    isAtBottomRef,
    lastMessageId,
    readPointerId,
    staticMode,
  ])

  // XEP-0490 settle window: the fresh-session read-sync seed can land just AFTER a
  // conversation is opened. The SDK's entry fold races the async PEP fetch, so at
  // activation the divider was derived from the STALE local read position and the
  // conversation-switch effect above already positioned the view (and armed a re-assert
  // loop) against it. When the seed lands, the SDK advances readPointerId and
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
  // The newer live-edge generation supersedes the stale marker execution.
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
    const request = positioningControllerRef.current?.beginLiveEdgeRequest({
      conversationId,
      source: {
        kind: 'late-mds-supersession',
        reason: 'divider-cleared',
      },
      executor: createLiveEdgeExecutor('mds-settle'),
    })
    if (!request) emergencyLiveEdgeWrite()
  }, [
    conversationId,
    createLiveEdgeExecutor,
    emergencyLiveEdgeWrite,
    firstNewMessageId,
    isAtBottomRef,
    staticMode,
  ])

  // Refresh controller-owned saved positioning when cache/MAM rows or the active window change.
  // Async around-load completion also drives itself, covering an empty slice that changes no props.
  useLayoutEffect(() => {
    if (staticMode) return
    const controller = positioningControllerRef.current
    const status = controller?.savedPositionStatus(conversationId)
    if (!controller || !status) return
    if (
      status.phase.kind === 'position-applied' ||
      status.phase.kind === 'settled'
    ) {
      return
    }
    if (controller.refreshSavedPosition({
      conversationId,
      generation: status.request.generation,
      executor: createSavedPositionExecutor(),
    })) {
      prevMessageCountRef.current = messageCount
      prevLastMessageIdRef.current = lastMessageId
    }
  }, [
    conversationId,
    createSavedPositionExecutor,
    firstMessageId,
    lastMessageId,
    messageCount,
    staticMode,
    windowAtLiveEdge,
  ])

  // Pending live-edge entry/recenter work resumes when cache rows or the sliding window changes.
  // Settled follow-live requests are not restarted here; content stimuli call reconcileLiveEdge.
  useLayoutEffect(() => {
    if (staticMode) return
    positioningControllerRef.current?.refreshLiveEdge({
      conversationId,
      executor: createLiveEdgeExecutor('refresh'),
    })
  }, [
    conversationId,
    createLiveEdgeExecutor,
    firstMessageId,
    isLoadingNewer,
    lastMessageId,
    messageCount,
    staticMode,
    windowAtLiveEdge,
  ])

  // Cleanup: properly leave conversation in scrollStateManager only when the message list
  // actually unmounts. The conversation-switch effect above intentionally has broad deps
  // (message count, target, marker) so it sees the current entry state, but a cleanup attached
  // there would also run on same-conversation updates and mark the singleton manager "left"
  // while the room is still mounted.
  useLayoutEffect(() => {
    unmountDeactivationTokenRef.current = null
    return () => {
      const activeConversationId = prevConversationRef.current
      const controller = positioningControllerRef.current
      if (controller && activeConversationId) {
        const token = {}
        unmountDeactivationTokenRef.current = token
        queueMicrotask(() => {
          if (unmountDeactivationTokenRef.current !== token) return
          const controllerSnapshot = controller.snapshot()
          if (controllerSnapshot.currentConversationId === activeConversationId) {
            controller.deactivate(
              activeConversationId,
              controllerSnapshot.watermark,
            )
          }
        })
      }
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

  // Store-driven search/activity/reaction targets use the same controller execution as reply,
  // poll, and find-on-page requests. Re-renders refresh the executor for the existing generation;
  // load-around completion also re-drives it without relying on messageCount changing.
  useEffect(() => {
    const previous = storeTargetRequestRef.current
    if (!targetMessageId || staticMode) {
      if (previous) {
        positioningControllerRef.current?.cancelExplicitTarget(
          previous.conversationId,
          previous.generation,
        )
        storeTargetRequestRef.current = null
      }
      return
    }

    isAtBottomRef.current = false
    const executor = createExplicitTargetExecutor(targetMessageId, true)
    if (
      previous &&
      previous.conversationId === conversationId &&
      previous.desired.messageId === targetMessageId &&
      positioningControllerRef.current?.refreshExplicitTarget({
        conversationId,
        generation: previous.generation,
        executor,
      })
    ) {
      return
    }

    const request = positioningControllerRef.current?.beginExplicitTarget({
      conversationId,
      messageId: targetMessageId,
      executor,
    }) ?? null
    storeTargetRequestRef.current = request
  }, [
    targetMessageId,
    messageCount,
    conversationId,
    createExplicitTargetExecutor,
    isAtBottomRef,
    staticMode,
  ])

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

    const shadowWindowShiftRequest = runScrollShadowSafely({
      event: 'window-shift-preservation',
      conversationId,
      fallback: null,
      observe: () => {
        if (!saved.anchorMessageId) return null
        const desired: DesiredPosition = {
          kind: 'anchor',
          messageId: saved.anchorMessageId,
          placement: {
            kind: 'top-offset',
            offsetPx: pixelOffset(saved.anchorOffsetFromTop),
          },
        }
        return positioningControllerRef.current?.observeRequest({
          event: 'window-shift-preservation',
          conversationId,
          draft: {
            source: { kind: 'history-preservation', reason: 'window-shift' },
            desired,
            onUnavailable: {
              kind: 'distance-from-bottom',
              distancePx: pixelOffset(saved.distanceFromBottom),
            },
          },
          reachability: shadowReachabilityRef.current(desired),
          actual: {
            desired,
            phase: usedMethod === 'math-fallback' ? 'fallback' : 'positioning',
          },
        }) ?? null
      },
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
    if (shadowWindowShiftRequest) {
      positioningControllerRef.current?.markPositionApplied(
        conversationId,
        shadowWindowShiftRequest.generation,
      )
    }

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
  }, [conversationId, messageCount, firstMessageId, staticMode])

  // ==========================================================================
  // EFFECT: New message arrives
  // ==========================================================================

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !hasInitializedRef.current || staticMode) return

    if (positioningControllerRef.current?.isSavedPositionPending(conversationId)) {
      if (lastMessageIsOutgoing) {
        positioningControllerRef.current?.beginLiveEdgeRequest({
          conversationId,
          source: { kind: 'live-update', reason: 'outgoing-message' },
          executor: createLiveEdgeExecutor('new-message'),
        })
      }
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
      if (lastMessageIsOutgoing) {
        positioningControllerRef.current?.beginLiveEdgeRequest({
          conversationId,
          source: { kind: 'live-update', reason: 'outgoing-message' },
          executor: createLiveEdgeExecutor('new-message'),
        })
      }
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
      if (lastMessageIsOutgoing) {
        isAtBottomRef.current = true
        const request = positioningControllerRef.current?.beginLiveEdgeRequest({
          conversationId,
          source: { kind: 'live-update', reason: 'outgoing-message' },
          executor: createLiveEdgeExecutor('new-message'),
        })
        if (!request) emergencyLiveEdgeWrite()
      } else {
        reconcileLiveEdge('new-message')
      }
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
  }, [
    conversationId,
    createLiveEdgeExecutor,
    emergencyLiveEdgeWrite,
    isAtBottomRef,
    lastMessageId,
    lastMessageIsOutgoing,
    messageCount,
    reconcileLiveEdge,
    staticMode,
  ])

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
      reconcileLiveEdge('mam-catchup-complete')
    }
  }, [isLoadingOlder, isAtBottomRef, reconcileLiveEdge, staticMode])

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
  // We route through the controller-owned live-edge convergence that new
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

    reconcileLiveEdge('reaction')
  }, [reactionsSignature, conversationId, reconcileLiveEdge, staticMode])

  // ==========================================================================
  // EFFECT: Typing indicator appears — reveal its footer clearance while sticked
  // ==========================================================================

  // The footer reserves extra bottom padding only while the typing pill is shown (see
  // MessageList's footer render), so that clearance grows when typing starts. Unlike a reaction's
  // few-pixel growth, the virtualized footer row needs a remeasure pass before the virtualizer's
  // computed end offset accounts for the taller padding — a one-shot scrollToIndex lands short (the
  // spacer hasn't caught up yet), leaving a residual gap under the pill. So this routes through the
  // shared controller-owned live-edge loop (the same convergence new messages use)
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

    reconcileLiveEdge('typing')
  }, [hasTypingIndicator, conversationId, reconcileLiveEdge, staticMode])

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
        // Route through live-edge reconciliation so the virtualized path re-windows rather
        // than a raw scrollTop write that would leave the mounted window stale → blank/clipped.
        if (wasNear) {
          reconcileLiveEdgeRef.current('container-shrink')
        }
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
        reconcileLiveEdgeRef.current('width-change')
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
    // Re-create with the current conversation's live-edge executor.
    // isAtBottomRef is stable unless the caller passes a new externalIsAtBottomRef (same
    // rationale as the viewport-resize effect above).
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

  // Public jump-to-last-read entry point: issue the same controller-owned unread request used by
  // conversation entry. No-op without a live marker.
  const scrollToMarker = useCallback(() => {
    if (!firstNewMessageId) return
    userScrollIntentAtRef.current = Date.now()
    userHasScrolledSinceEntryRef.current = true
    positioningControllerRef.current?.beginUnreadMarkerNavigation({
      conversationId,
      navigationFacts: {
        firstUnreadMessageId: firstNewMessageId,
        unreadMarkerNeedsVisit: true,
        unreadMarkerAlign: virtualizerRef.current ? 'start' : 'top-third',
      },
      executor: createUnreadMarkerExecutor(),
    })
  }, [firstNewMessageId, conversationId, createUnreadMarkerExecutor])

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
    requestMessageTarget,
    showScrollToBottom,
    markerAboveViewport,
    bottomVisibleMessageId,
    scrollToMarker,
  }
}
