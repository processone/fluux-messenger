/**
 * useMessageListScroll - Message-list scroll lifecycle orchestration
 *
 * DESIGN PRINCIPLES:
 * 1. Production scroll state lives in REFS, not React state (prevents render loops)
 * 2. PositioningController owns every live-list positioning generation. Directional window-load
 *    eligibility/lifetime lives in a value-only coordinator; browser writes stay imperative in
 *    leased browser adapters
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

import type { MessageRowRef } from '@fluux/sdk'
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'
import type { ControllerFrameLoopRegistration } from './controllerFrameLoop'
import { useScrollContainerBinding } from './useScrollContainerBinding'
import { useViewportResizeReconciliation } from './useViewportResizeReconciliation'
import { useAmbientAnchorPreservation } from './useAmbientAnchorPreservation'
import { useMediaGrowthPreservation } from './useMediaGrowthPreservation'
import { useDirectionalHistoryLoads } from './useDirectionalHistoryLoads'
import {
  arbitrateEntry,
  shouldSupersedeWithLateSyncedLiveEdge,
} from './entryArbitration'
import {
  decideMarkerClear,
  isMarkerAboveViewport,
  planScrollEvent,
  planWheelEvent,
} from './scrollEventDecisions'
import { findBottomAnchor } from './bottomAnchor'
import { createPinLoopClaim, type PinLoopClaim } from './pinLoopClaim'
import { decideRowGrowth } from './rowGrowthDecision'
import { decideMdsSettle } from './mdsSettleDecision'
import { decideTypingIndicator } from './typingIndicatorDecision'
import { shouldShowScrollToBottomFab } from './fabVisibility'
import type { MessageVirtualizer } from './messageVirtualizer'
import { notifyUserInput } from '@/utils/renderLoopDetector'
import { ViewportSession } from './viewportSession'
import { ScrollPersistenceAdapter } from './scrollPersistenceAdapter'
import { DirectionalHistoryWindowCoordinator } from './directionalHistoryWindowCoordinator'
import { TARGET_HIGHLIGHT_MS } from './explicitTargetBrowserAdapter'
import { useScrollExecutors } from './useScrollExecutors'
import { PositioningController } from './positioningController'
import {
  deriveAtLiveEdge,
  deriveEntryPositionFacts,
  deriveLiveEdgeNavigationFacts,
  deriveReachabilityForDesired,
  readScrollGeometry,
} from './scrollPositionFacts'
import {
  type DesiredPosition,
  type ExplicitTargetRequest,
  type ReachabilityFacts,
} from './scrollPositionModel'
import { runScrollShadowSafely } from './scrollPositionShadow'
import { findMessageTargetElement } from './messageTargetElement'
import { findMessageRowElement } from './messageRowIdentity'
import { VirtualRowGrowthBatcher } from './virtualRowGrowth'

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
const LOAD_NEWER_THRESHOLD = 4 // px from the resident-window bottom to auto-load newer (slid-up windows)

/**
 * Freeze a callback's identity while always invoking its latest version.
 *
 * Positioning callbacks close over `messageCount`, `firstMessageId`, and window state through their
 * executors, so their identity changes on every append. That is harmless for a direct call, but two
 * of them are published: `requestMessageTarget` is a context value read by EVERY message row,
 * `requestMessageTarget`/`scrollToBottom` feed the active-list registration, and the top/bottom
 * callbacks feed global keyboard listeners. An unstable identity there re-renders mounted rows or
 * rebinds listeners on each append. Forwarding through a ref keeps behaviour identical (the newest
 * implementation still runs) while the published identity stays constant.
 */
function useStableCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
): (...args: Args) => void {
  const latest = useRef(callback)
  latest.current = callback
  return useCallback((...args: Args) => latest.current(...args), [])
}

// ============================================================================
// ANCHOR HELPERS (content-stable scroll restoration)
// ============================================================================


// ============================================================================
// TYPES
// ============================================================================

export interface UseMessageListScrollOptions {
  conversationId: string
  messageCount: number
  interiorPlacementVersion?: number
  firstMessageId: string | undefined
  firstNewMessageId?: string  // Row handle of the first unread message (for new message marker)
  /** Row handle of the furthest read message, including XEP-0490 sync. */
  readPointerId?: string
  targetMessageId?: string | null  // ID of a message to scroll to (e.g., from activity log click)
  onTargetMessageConsumed?: () => void  // Called after scrolling to target message
  externalScrollerRef?: React.RefObject<HTMLElement | null>
  externalIsAtBottomRef?: React.MutableRefObject<boolean>
  clearFirstNewMessageId?: () => void  // Called when user scrolls past the new message marker
  /** Load the next-older history slice. Any returned promise is treated as the load's lifetime:
   *  it bounds how long the directional-history snapshot may claim the next window shift. */
  onScrollToTop?: () => unknown
  /**
   * Hydrate the resident message window with the cache slice CONTAINING a specific message.
   * Called by the restore path when a saved content anchor (or a navigation target) is older than
   * the latest-N slice loaded on activation, so it isn't in the loaded set and the anchor restore
   * can't resolve it. The resulting message-count growth re-runs the restore via the retry effect.
   * Returns a promise that resolves once the slice has merged (or with an empty slice when the
   * anchor isn't in the cache).
   */
  onLoadAround?: (anchorRow: MessageRowRef) => Promise<unknown> | void
  isLoadingOlder?: boolean
  /** Sliding window: load the next-newer cache slice when the reader scrolls back down to the
   *  bottom of a slid-up window (mirror of onScrollToTop for the newer direction). Fired only
   *  when windowAtLiveEdge is false. Its returned promise bounds the snapshot the same way. */
  onLoadNewer?: () => unknown
  isLoadingNewer?: boolean
  /** Sliding window: whether the resident window includes the newest message. `false` = slid up,
   *  which enables the load-newer trigger (the resident bottom is NOT the live edge). Absent/true
   *  ⇒ at the live edge — unchanged behavior. */
  windowAtLiveEdge?: boolean
  isHistoryComplete?: boolean
  /** Signature of every IN-PLACE row-height change across the resident window — a reaction, a
   *  link-preview or attachment fastening, a correction, a retraction (see rowGrowthSignature.ts).
   *  Any of them grows/shrinks a row that is already rendered; this drives an instant bottom re-pin
   *  while the reader is sticked to the bottom, so the growth is absorbed above (previous messages
   *  scroll up) instead of shoving the newest message down. */
  rowGrowthSignature: string
  /** Whether the in-flow typing-indicator band below the scrollport is currently shown. Its 0→true
   *  edge shrinks the scrollport and drives the same instant bottom re-pin as a reaction growing a
   *  row, gated on live geometry (see the typing effect) so it never fires for a reader scrolled up
   *  into history — the #918 "fight" was a stale isAtBottomRef latch. */
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
   *  DOM-based behavior. */
  virtualizer?: MessageVirtualizer
  /**
   * Reports whether the viewport is genuinely at the
   * live edge, invoked EVERY time `isAtBottomRef.current` is assigned from a
   * REAL measured geometry read (a `scrollHeight - scrollTop - clientHeight`
   * comparison against `AT_BOTTOM_THRESHOLD`, taken after the scroll write it
   * describes has already landed) — never from an assumed/decided default.
   *
   * Deliberately NOT invoked from `rememberBottomIntent` (which sets
   * `isAtBottomRef.current = true` unconditionally on a deliberate
   * scroll-to-bottom action) or from the conversation-switch entry effect's
   * pre-measurement guesses (`isAtBottomRef.current = true/false` before the
   * positioning executor has actually run) — those are exactly the unsafe
   * stale defaults this option exists to avoid feeding to the SDK: evidence
   * must stay `unknown` until the geometry has actually been read.
   */
  onLiveEdgeMeasured?: (atEdge: boolean) => void
}

export interface UseMessageListScrollResult {
  setScrollContainerRef: (element: HTMLDivElement | null) => void
  contentWrapperRef: React.RefCallback<HTMLDivElement>
  handleScroll: (e: React.UIEvent<HTMLDivElement>) => void
  handleWheel: (e: React.WheelEvent<HTMLDivElement>) => void
  handleLoadEarlier: () => void
  handleMediaLoad: () => void
  /** Reconcile a positive, virtualizer-reported row-height delta against live scroll geometry. */
  handleVirtualRowMeasuredGrowth: (conversationId: string, heightDelta: number) => void
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
   *  handleScroll gate). Ambient layout preservation uses it to keep the reader's anchor stable
   *  across insertions and divider mutations. */
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
  interiorPlacementVersion = 0,
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
  rowGrowthSignature,
  hasTypingIndicator = false,
  lastMessageIsOutgoing = false,
  lastMessageId,
  staticMode = false,
  virtualizer,
  onLiveEdgeMeasured,
}: UseMessageListScrollOptions): UseMessageListScrollResult {

  // ==========================================================================
  // REFS - All scroll state lives here, NOT in React state
  // ==========================================================================

  // The content wrapper, its ResizeObserver, the correction frame and their diagnostic monitors are
  // owned by useScrollContainerBinding; only the scroller itself is read across this hook.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // In-flight controller-owned scroll re-assert loop (rAF id + idempotent terminal cleanup). Starting any loop
  // supersedes whatever is in flight so bottom, message, restore, media, and history targets cannot
  // fight over scrollTop. Single-flight: latest accepted generation wins with a fresh budget.
  // Owned here rather than in useScrollExecutors because the scroll handler reads it to tell a
  // controller-owned scroll from genuine user input.
  const reassertLoopRef = useRef<ControllerFrameLoopRegistration | null>(null)
  // Whether a pin-bottom re-assert loop is in flight. The row-growth re-pin defers to an active loop
  // (it re-checks scrollHeight every frame and picks the change up itself) instead of restarting it
  // — the restart's synchronous forced layout + repaint is the WebKitGTK hot path. The leased frame
  // lifecycle releases this claim on every terminal path; its deadline remains browser/scheduler
  // defense in depth. See pinLoopClaim.ts.
  const pinBottomClaimRef = useRef<PinLoopClaim | null>(null)
  // Lazy-ref idiom shared with the extracted browser-adapter hook: a ref is stable, so reading it
  // at the use sites keeps the exhaustive-deps rule satisfied without a dependency.
  const pinBottomClaim = () => (pinBottomClaimRef.current ??= createPinLoopClaim())
  const measuredRowGrowthFlushRef = useRef<(conversationId: string, heightDelta: number) => void>(
    () => {},
  )
  const measuredRowGrowthBatcherRef = useRef<VirtualRowGrowthBatcher | null>(null)
  if (measuredRowGrowthBatcherRef.current === null) {
    measuredRowGrowthBatcherRef.current = new VirtualRowGrowthBatcher(
      (measuredConversationId, measuredGrowth) => {
        measuredRowGrowthFlushRef.current(measuredConversationId, measuredGrowth)
      },
    )
  }

  // Track scroll position - always create internal ref to follow rules of hooks
  const internalIsAtBottomRef = useRef(true)
  const isAtBottomRef = externalIsAtBottomRef || internalIsAtBottomRef
  const viewportSessionRef = useRef<ViewportSession | null>(null)
  if (viewportSessionRef.current === null) {
    viewportSessionRef.current = new ViewportSession(conversationId)
  }
  const scrollPersistenceRef = useRef<ScrollPersistenceAdapter | null>(null)
  if (scrollPersistenceRef.current === null) {
    scrollPersistenceRef.current = new ScrollPersistenceAdapter()
  }
  const directionalWindowRef =
    useRef<DirectionalHistoryWindowCoordinator | null>(null)
  if (directionalWindowRef.current === null) {
    directionalWindowRef.current = new DirectionalHistoryWindowCoordinator()
  }

  // Latest `onLiveEdgeMeasured` callback, read imperatively
  // by `setMeasuredAtBottom` below (never closed over directly, so a caller passing a
  // fresh inline function each render still reaches the CURRENT one).
  const onLiveEdgeMeasuredRef = useRef(onLiveEdgeMeasured)
  onLiveEdgeMeasuredRef.current = onLiveEdgeMeasured

  // Set `isAtBottomRef` from a REAL measured geometry read, AND report that same
  // measurement to the SDK's viewport-evidence channel. Every call site
  // below has just read `scrollHeight - scrollTop - clientHeight` (or an equivalent
  // virtualizer-aware distance) against `AT_BOTTOM_THRESHOLD` — never an
  // assumed/decided default. Must NOT be used for: `rememberBottomIntent` (sets
  // `true` unconditionally on a deliberate scroll-to-bottom action) or the
  // conversation-switch entry effect's pre-measurement guesses — see
  // `UseMessageListScrollOptions.onLiveEdgeMeasured`'s doc for why those stay raw
  // `isAtBottomRef.current = ...` assignments.
  const setMeasuredAtBottom = useCallback((atEdge: boolean) => {
    isAtBottomRef.current = atEdge
    viewportSessionRef.current?.recordMeasuredLiveEdge(
      activeConversationIdRef.current,
      atEdge,
    )
    onLiveEdgeMeasuredRef.current?.(atEdge)
  }, [isAtBottomRef])

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
  // see the repaint-suppression note in LiveEdgeBrowserAdapter. Updated synchronously in the render
  // body (same pattern as virtualizerRef) so it is never stale when the pin loop reads it mid-run.
  const isLoadingOlderRef = useRef(isLoadingOlder)
  isLoadingOlderRef.current = isLoadingOlder

  // Track conversation
  const activeConversationIdRef = useRef(conversationId)
  activeConversationIdRef.current = conversationId
  const prevConversationRef = useRef<string | null>(null)
  const prevMessageCountRef = useRef(0)
  const messageCountRef = useRef(messageCount)
  messageCountRef.current = messageCount
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
  // React StrictMode replays layout-effect cleanup/setup without unmounting the DOM. Defer controller
  // deactivation by one microtask and cancel it if setup replays, while real unmount still aborts.
  const unmountDeactivationTokenRef = useRef<object | null>(null)
  // Generation-aware semantic controller. All live-conversation positioning slices, including
  // directional history, are authoritative. Pixel writes stay in leased imperative executors;
  // directional-history, saved-position, unread-marker, and explicit-target mechanics live behind
  // their browser adapters. The module-private generation allocator survives StrictMode remounts.
  const positioningControllerRef = useRef<PositioningController | null | undefined>(undefined)
  if (positioningControllerRef.current === undefined) {
    positioningControllerRef.current = runScrollShadowSafely({
      event: 'controller-create',
      conversationId,
      fallback: null,
      observe: () => new PositioningController(),
    })
  }
  const reconcileLiveEdgeRef = useRef<(
    trigger: string,
    rearmEligibleFromGeometry: boolean,
  ) => boolean>(
    () => false,
  )
  // The resident window as it is NOW, for reachability probes that run outside the render that
  // created them. Executors capture their scroller and virtualizer through refs already; these
  // three scalars were the only render-time captures left, so an executor stored by the controller
  // and consulted a frame later still described the window it was born in. Assigned during render
  // (like shadowReachabilityRef below) so a probe never has to wait for an effect to catch up.
  const liveWindowRef = useRef({ messageCount, firstMessageId, windowAtLiveEdge })
  liveWindowRef.current = { messageCount, firstMessageId, windowAtLiveEdge }

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
  // Media load batching (for images, videos, link previews)
  // When multiple media elements load in quick succession, we batch them and apply
  // a single scroll correction at the end to avoid jitter.

  // Divider movement and mid-array insertion are ambient layout mutations, not navigation commands.
  // Their pre-mutation anchors and tracking live in useAmbientAnchorPreservation.

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
  // Reuses the anchor recorded by the viewport session on every scroll; updated at the same
  // throttled cadence via the prev-dedup setter, so it only re-renders when the bottom-most row
  // changes.
  const [bottomVisibleMessageId, setBottomVisibleMessageId] = useState<string | null>(null)

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  const getDistanceFromBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight

  const rememberCurrentScrollSnapshot = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    viewportSessionRef.current?.recordViewport(
      activeConversationIdRef.current,
      {
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        client: scroller.clientHeight,
      },
      findBottomAnchor(scroller),
    )
  }, [])

  const rememberBottomIntent = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const bottomTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const bottomAnchor = findBottomAnchor(scroller)
    viewportSessionRef.current?.recordViewport(
      conversationId,
      {
        top: bottomTop,
        height: scroller.scrollHeight,
        client: scroller.clientHeight,
      },
      bottomAnchor,
    )
    isAtBottomRef.current = true
    setShowScrollToBottom(false)
    setMarkerAboveViewport(false)
    // At the bottom the newest message is visible → 0 new below the fold (anchor is the last row).
    setBottomVisibleMessageId(bottomAnchor?.messageId ?? null)
    scrollPersistenceRef.current?.clearSavedPosition(conversationId)
  }, [conversationId, isAtBottomRef])

  // ==========================================================================
  // CALLBACK REFS: scroll container + content wrapper
  // ==========================================================================
  //
  // The dedicated binding owns ref identity, attach-order handling, native input listeners, and
  // the non-virtualized content observer. Its module comment documents those local invariants.

  const latestRef = useRef({ staticMode, externalScrollerRef, isAtBottomRef, conversationId, virtualizer, onLoadAround })
  useEffect(() => {
    latestRef.current = { staticMode, externalScrollerRef, isAtBottomRef, conversationId, virtualizer, onLoadAround }
  })

  // Executor construction is delegated to useScrollExecutors. Its factory identities intentionally
  // churn with the live window so dependent effects below re-run when the window moves.
  const {
    createLiveEdgeExecutor,
    emergencyLiveEdgeWrite,
    createAnchorPreservationExecutor,
    buildDirectionalHistoryExecutor,
    buildSavedPositionExecutor,
    buildUnreadMarkerExecutor,
    buildExplicitTargetExecutor,
    createResidentTopExecutor,
    emergencyResidentTopWrite,
    // Not construction: an availability probe and the one-frame settlement scheduler, both of which
    // the directional load flow drives directly.
    getDirectionalHistoryBrowser,
    resetLiveEdgeRepaintDebt,
    disposeDirectionalHistoryBrowser,
  } = useScrollExecutors({
    ports: {
      getScroller: () => scrollerRef.current,
      getVirtualizer: () => virtualizerRef.current,
      getActiveConversationId: () => activeConversationIdRef.current,
      getLiveWindow: () => liveWindowRef.current,
      getPassiveContext: () => ({
        conversationId: latestRef.current.conversationId,
        virtualizer: latestRef.current.virtualizer,
      }),
      isLoadingOlder: () => isLoadingOlderRef.current,
      getLoadAround: () => onLoadAroundRef.current,
      getStoreTargetMessageId: () => targetMessageIdRef.current,
      consumeStoreTarget: () => onTargetMessageConsumedRef.current?.(),
      recordProgrammaticWrite: (id, at) =>
        viewportSessionRef.current?.recordProgrammaticWrite(id, at),
      getDirectionalWindow: () => directionalWindowRef.current,
      syncPrevMessageCount: () => {
        prevMessageCountRef.current = messageCountRef.current
      },
      pinBottomClaim,
      reassertLoopRegistry: reassertLoopRef,
      log: debugLog,
    },
    conversationId,
    messageCount,
    firstMessageId,
    lastMessageId,
    windowAtLiveEdge,
    isLoadingNewer,
    onLoadNewer,
    isAtBottomRef,
    setMeasuredAtBottom,
    rememberBottomIntent,
    rememberCurrentScrollSnapshot,
  })

  const reconcileLiveEdge = useCallback((
    trigger: string,
    rearmEligibleFromGeometry: boolean,
  ): boolean => {
    const controller = positioningControllerRef.current
    if (!controller) return false
    return controller.reconcileLiveEdge({
      conversationId,
      executor: createLiveEdgeExecutor(trigger),
      rearmEligibleFromGeometry,
    })
  }, [conversationId, createLiveEdgeExecutor])
  reconcileLiveEdgeRef.current = reconcileLiveEdge

  measuredRowGrowthFlushRef.current = (measuredConversationId, measuredGrowth) => {
    const liveScroller = scrollerRef.current
    if (
      !liveScroller ||
      latestRef.current.staticMode ||
      !virtualizerRef.current ||
      activeConversationIdRef.current !== measuredConversationId
    ) return

    const distanceFromBottom = getDistanceFromBottom(liveScroller)
    const previousGeometry =
      viewportSessionRef.current?.snapshotFor(measuredConversationId)?.geometry ?? null
    const uncompensatedGrowth = previousGeometry
      ? Math.min(
          measuredGrowth,
          Math.max(
            0,
            distanceFromBottom -
              (previousGeometry.height - previousGeometry.top - previousGeometry.client),
          ),
        )
      : null
    const active = positioningControllerRef.current?.snapshot().active
    const decision = decideRowGrowth({
      distanceFromBottom,
      heightDelta: uncompensatedGrowth,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
      pinClaimHeld: pinBottomClaim().isHeld(),
      navigationInFlight: Boolean(
        active &&
        active.request.conversationId === activeConversationIdRef.current &&
        active.request.desired.kind !== 'live-edge' &&
        active.phase.kind !== 'settled',
      ),
    })
    if (decision === 'pin') reconcileLiveEdgeRef.current('row-growth', true)
  }

  const handleVirtualRowMeasuredGrowth = useCallback((
    measuredConversationId: string,
    heightDelta: number,
  ) => {
    // Deliberately no scroller check here. React drives the virtualizer's measure callback from
    // inside a commit, and the scroll container's ref is detached (set to null) and reattached
    // across that commit, so `scrollerRef.current` is null at this point even though the element
    // is mounted. Reading pixels is not this callback's job anyway: the batched flush one frame
    // later re-reads the scroller, once it is attached again, and owns the decision.
    if (
      staticMode ||
      !virtualizerRef.current ||
      activeConversationIdRef.current !== measuredConversationId ||
      heightDelta <= 0
    ) return
    measuredRowGrowthBatcherRef.current?.enqueue(measuredConversationId, heightDelta)
  }, [staticMode])

  useEffect(() => () => {
    measuredRowGrowthBatcherRef.current?.dispose()
  }, [])

  // Ambient layout preservation for divider movement and mid-array insertion. It owns the
  // pre-mutation anchors and their tracking; every branch decision is a pure function in
  // ambientAnchorDecisions.
  const { refreshInsertionAnchorIfStable } = useAmbientAnchorPreservation({
    ports: {
      getScroller: () => scrollerRef.current,
      getSessionBottomAnchor: (id) =>
        viewportSessionRef.current?.snapshotFor(id)?.bottomAnchor,
      recordBottomAnchor: (id, anchor) =>
        viewportSessionRef.current?.recordBottomAnchor(id, anchor),
      isDirectionalLoadLanding: (id, first) =>
        directionalWindowRef.current?.isPendingWindowShift(id, first) ?? false,
      beginLayoutPreservation: (input) =>
        positioningControllerRef.current?.beginLayoutPreservation(input),
    },
    conversationId,
    firstNewMessageId,
    showScrollToBottom,
    bottomVisibleMessageId,
    messageCount,
    firstMessageId,
    lastMessageId,
    interiorPlacementVersion,
    createAnchorPreservationExecutor,
  })

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
      executor: buildExplicitTargetExecutor(messageReference, false),
    })
  }, [
    conversationId,
    buildExplicitTargetExecutor,
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

    // FAB / scroll-to-bottom is deliberate user input. Record it for the marker/resize heuristics;
    // observeUserInput separately cancels any controller-owned history loop.
    viewportSessionRef.current?.recordUserInput(conversationId, Date.now())

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
        const messageElement = findMessageRowElement(scroller, firstNewMessageId)
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
        executor: buildUnreadMarkerExecutor(),
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
    buildUnreadMarkerExecutor,
    emergencyLiveEdgeWrite,
    firstNewMessageId,
  ])
  // Also published to the active-list registry (ChatLayout's Escape handler reaches it there), so it
  // is stabilised for the same reason as requestMessageTarget: an unstable identity re-registers the
  // list — and re-binds the ⌘/Ctrl+↓ listener — on every append.
  const scrollToBottom = useStableCallback(scrollToBottomImpl)

  const scrollToTopImpl = useCallback(() => {
    directionalWindowRef.current?.suppressAutomaticLoads(Date.now())
    if (staticMode) {
      // Search/stranger previews intentionally own neither a controller conversation nor live-list
      // persistence. Preserve their isolated one-shot Home behavior inside this scroller; routing
      // it into the live-list controller would reject the request after preventDefault().
      scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    // `triggerLoadOlder` intentionally lets explicit user travel back to the boundary bypass its
    // cooldown via this latch. Home is a positioning command, not that travel gesture: it starts
    // away from the top, so leaving the latch armed would make the smooth arrival immediately
    // prepend history and supersede the resident-top request. A later genuine move away from the
    // top re-arms the latch in handleScroll.
    viewportSessionRef.current?.clearTravel(conversationId, 'top')
    const request = positioningControllerRef.current?.beginResidentTopNavigation({
      conversationId,
      executor: createResidentTopExecutor(),
    })
    if (!request) emergencyResidentTopWrite()
  }, [
    conversationId,
    createResidentTopExecutor,
    emergencyResidentTopWrite,
    staticMode,
  ])
  // Published to MessageList's keyboard listeners. Keep the shell stable while the executor factory
  // tracks row/window facts so normal appends do not churn global keydown subscriptions.
  const scrollToTop = useStableCallback(scrollToTopImpl)

  // ==========================================================================
  // LOAD OLDER MESSAGES
  // ==========================================================================

  const {
    triggerLoadOlder,
    triggerLoadNewer,
    handleLoadEarlier,
    applyReleaseDecision: applyDirectionalReleaseDecision,
  } = useDirectionalHistoryLoads({
    ports: {
      getBrowser: getDirectionalHistoryBrowser,
      getCoordinator: () => directionalWindowRef.current,
      getActiveConversationId: () => activeConversationIdRef.current,
      getLiveWindow: () => liveWindowRef.current,
      hasTravelledAway: (id, edge) =>
        viewportSessionRef.current?.hasTravelledAway(id, edge) ?? false,
      clearTravel: (id, edge) =>
        viewportSessionRef.current?.clearTravel(id, edge),
      buildExecutor: buildDirectionalHistoryExecutor,
      beginDirectionalHistory: (input) =>
        positioningControllerRef.current?.beginDirectionalHistory(input),
      cancelWithoutShift: (input) =>
        positioningControllerRef.current?.cancelDirectionalHistoryWithoutShift(input),
      log: debugLog,
    },
    conversationId,
    firstMessageId,
    messageCount,
    windowAtLiveEdge,
    isLoadingOlder,
    isLoadingNewer,
    isHistoryComplete,
    onScrollToTop,
    onLoadNewer,
  })

  // ==========================================================================
  // MEDIA LOAD HANDLER (images, videos, link previews)
  // ==========================================================================

  const {
    handleMediaLoad: handleMediaLoadImpl,
    isBatchActive: isMediaBatchActive,
    observeScroll: observeMediaBatchScroll,
    cancelBatch: cancelMediaBatch,
  } = useMediaGrowthPreservation({
    ports: {
      getScroller: () => scrollerRef.current,
      isAtBottom: () => isAtBottomRef.current,
      reconcileLiveEdge: (trigger, rearmEligibleFromGeometry) => {
        reconcileLiveEdgeRef.current(trigger, rearmEligibleFromGeometry)
      },
      beginMediaPreservation: (input) =>
        positioningControllerRef.current?.beginMediaPreservation(input),
      log: debugLog,
    },
    conversationId,
    createAnchorPreservationExecutor,
  })

  const {
    setScrollContainerRef,
    setContentRef,
    teardownContentObserver,
    detachUserInputListeners,
  } = useScrollContainerBinding({
    setScroller: (el) => {
      scrollerRef.current = el
      const external = latestRef.current.externalScrollerRef
      if (external) {
        (external as React.MutableRefObject<HTMLElement | null>).current = el
      }
    },
    getScroller: () => scrollerRef.current,
    getVirtualizer: () => latestRef.current.virtualizer,
    isStaticMode: () => latestRef.current.staticMode,
    isAtBottom: () => latestRef.current.isAtBottomRef.current,
    getActiveConversationId: () => activeConversationIdRef.current,
    getLoggedConversationId: () => latestRef.current.conversationId,
    isDirectionalHistoryPending: (id) =>
      positioningControllerRef.current?.isDirectionalHistoryPending(id) ?? false,
    isMediaLoadBatchActive: isMediaBatchActive,
    reconcileLiveEdge: (trigger, rearmEligibleFromGeometry) => {
      reconcileLiveEdgeRef.current(trigger, rearmEligibleFromGeometry)
    },
    recordUserInput: (id, at) =>
      viewportSessionRef.current?.recordUserInput(id, at),
    observeUserInput: (id) =>
      positioningControllerRef.current?.observeUserInput(id),
    log: debugLog,
  })

  useViewportResizeReconciliation({
    ports: {
      getScroller: () => scrollerRef.current,
      isAtBottom: () => isAtBottomRef.current,
      reconcileLiveEdge: (trigger, rearmEligibleFromGeometry) => {
        reconcileLiveEdgeRef.current(trigger, rearmEligibleFromGeometry)
      },
    },
    conversationId,
    staticMode,
  })

  // The implementation must close over the current conversation and executors, so its identity
  // legitimately changes on appends/window updates. Message rows must not observe that churn: a
  // changed onMediaLoad prop bypasses their memo bailout and re-renders the whole mounted window.
  // Publish a stable shell that always invokes the latest implementation, matching the
  // requestMessageTarget/scrollToBottom contract.
  const handleMediaLoad = useStableCallback(handleMediaLoadImpl)

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
    const now = Date.now()

    // A programmatic re-assert loop (marker positioning / pin-bottom / prepend / anchor restore)
    // owns scrollTop while it runs — scroll events fired during it are NOT the user.
    const programmaticScroll = reassertLoopRef.current !== null

    // Capture the bottom-most-visible anchor on every scroll event (binary search,
    // cheap) so it reflects the latest position — at switch time the DOM is already
    // the new conversation, so this must be captured live during scroll.
    const bottomAnchor = findBottomAnchor(el)
    const viewportObservation = viewportSessionRef.current?.observeScroll({
      conversationId,
      geometry: {
        top: scrollTop,
        height: scrollHeight,
        client: clientHeight,
      },
      bottomAnchor,
      controllerOwnsPixels: programmaticScroll,
      now,
    })
    // Keep the pre-mutation insertion anchor current on the same measurement the session already
    // took. The owner applies the resident-array-unchanged gate itself.
    refreshInsertionAnchorIfStable(el, bottomAnchor)
    const plan = planScrollEvent({
      scrollTop,
      distanceFromBottom: distFromBottom,
      controllerOwnsPixels: programmaticScroll,
      growthDrivenDuringControllerScroll:
        viewportObservation?.growthDrivenDuringControllerScroll ?? false,
      genuineUserScroll: viewportObservation?.genuineUserScroll ?? false,
      staticMode,
      hasTravelledAwayFromTop:
        viewportSessionRef.current?.hasTravelledAway(conversationId, 'top') ?? false,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
      loadNewerThreshold: LOAD_NEWER_THRESHOLD,
    })

    if (plan.recordMeasuredAtBottom) setMeasuredAtBottom(plan.atBottom)

    // Track user scroll during a media load batch — the owner applies the genuine-move test.
    observeMediaBatchScroll({
      controllerOwnsPixels: programmaticScroll,
      previousScrollHeight: viewportObservation?.previousScrollHeight,
      scrollHeight,
    })

    // FAB visibility (only React state in scroll handler). Suppressed while the pin-bottom loop owns
    // scrollTop: on WebKit a tall bottom row's post-paint growth fires 'scroll' events reporting a
    // transiently large distFromBottom before the loop re-pins, which would otherwise flash the FAB
    // on open-at-bottom (intermittent race). The loop settles AT the bottom, so the FAB stays hidden.
    const shouldShowFab = shouldShowScrollToBottomFab(distFromBottom, FAB_THRESHOLD, pinBottomClaim().isHeld())
    setShowScrollToBottom(prev => prev !== shouldShowFab ? shouldShowFab : prev)

    if (firstNewMessageId) {
      const v = latestRef.current.virtualizer
      let markerOffset: number | null
      if (v) {
        markerOffset = v.getOffsetForMessageId(firstNewMessageId)
      } else {
        const markerEl = findMessageRowElement(el, firstNewMessageId)
        markerOffset = markerEl ? markerEl.offsetTop : null
      }
      const shouldShowMarkerPill = isMarkerAboveViewport(markerOffset, scrollTop)
      setMarkerAboveViewport(prev => prev !== shouldShowMarkerPill ? shouldShowMarkerPill : prev)
    } else {
      setMarkerAboveViewport(prev => prev ? false : prev)
    }

    if (plan.trackBottomVisibleMessage) {
      const bottomId = bottomAnchor?.messageId ?? null
      setBottomVisibleMessageId(prev => (prev !== bottomId ? bottomId : prev))
    }

    if (plan.observeGenuineInput) {
      const pausedGeneration =
        positioningControllerRef.current?.observeUserInput(conversationId) ?? null
      runScrollShadowSafely({
        event: 'settled-user-geometry',
        conversationId,
        fallback: undefined,
        observe: () => {
          positioningControllerRef.current?.observeSettledUserGeometry({
            conversationId,
            generation: pausedGeneration,
            atLiveEdge: deriveAtLiveEdge(readScrollGeometry(el)),
          })
        },
      })
    }

    const markerAction = decideMarkerClear({
      hasMarker: Boolean(firstNewMessageId),
      canClear: Boolean(clearFirstNewMessageId),
      controllerOwnsPixels: programmaticScroll,
      armed: userHasScrolledSinceMarkerRef.current,
      distanceFromBottom: distFromBottom,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
      lastUserIntentAt:
        viewportSessionRef.current?.lastUserIntentAt(conversationId) ?? 0,
      now,
    })
    if (markerAction === 'arm') {
      userHasScrolledSinceMarkerRef.current = true
      debugLog('MARKER CLEAR armed (first scroll)', { firstNewMessageId, distFromBottom })
    } else if (markerAction === 'clear') {
      debugLog('MARKER CLEAR (reached bottom)', { firstNewMessageId, distFromBottom })
      clearFirstNewMessageId?.()
    }

    // Persist only through the adapter. It consumes the snapshot recorded above and owns the
    // genuine-input, active-controller, conversation, and throttle gates.
    scrollPersistenceRef.current?.persistViewport({
      conversationId,
      snapshot:
        viewportSessionRef.current?.snapshotFor(conversationId) ?? null,
      readPositionId: readPointerId,
      controllerOwnsPixels: programmaticScroll,
      now,
    })

    if (plan.markTravelAwayFromTop) {
      viewportSessionRef.current?.markTravelAway(conversationId, 'top')
    }
    if (plan.markTravelAwayFromBottom) {
      viewportSessionRef.current?.markTravelAway(conversationId, 'bottom')
    }
    if (plan.loadOlder) triggerLoadOlder()
    if (plan.loadNewer) triggerLoadNewer()
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // A wheel cancels any older controller generation before a new directional request is captured
    // below; later wheel input cancels that new request.
    viewportSessionRef.current?.recordUserInput(conversationId, Date.now())
    // Genuine user scroll → open the viewport session's save gate. Mirrors the
    // native wheel listener; kept here so it fires even when wheel arrives via the React handler.
    positioningControllerRef.current?.observeUserInput(conversationId)
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
    const wheelPlan = planWheelEvent({
      scrollTop,
      distanceFromBottom: scrollHeight - scrollTop - clientHeight,
      deltaY: e.deltaY,
      staticMode,
      loadNewerThreshold: LOAD_NEWER_THRESHOLD,
    })
    if (wheelPlan.markTravelAwayFromTop) {
      viewportSessionRef.current?.markTravelAway(conversationId, 'top')
    }
    if (wheelPlan.markTravelAwayFromBottom) {
      viewportSessionRef.current?.markTravelAway(conversationId, 'bottom')
    }
    if (wheelPlan.loadOlder) triggerLoadOlder()
    if (wheelPlan.loadNewer) triggerLoadNewer()
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

    const previousViewport = prevConversationRef.current
      ? viewportSessionRef.current?.snapshotFor(prevConversationRef.current)
      : null

    // LEAVING old conversation - save position, but ONLY if the user genuinely scrolled it this
    // visit. Otherwise keep its existing saved anchor untouched (markAsLeft): the live scroll data
    // may have drifted from media/measurement after the restore, and persisting it would make the
    // position creep older on the next open.
    if (prevConversationRef.current) {
      scrollPersistenceRef.current?.leaveConversation(
        prevConversationRef.current,
        previousViewport ?? null,
        previousReadPositionRef.current,
      )
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
    viewportSessionRef.current?.enterConversation(conversationId)
    directionalWindowRef.current?.enterConversation(
      conversationId,
      windowAtLiveEdge,
    )
    pendingSyncedLiveEdgeRef.current = null
    setShowScrollToBottom(false)
    setMarkerAboveViewport(false)
    // No scroll observed in the new conversation yet → badge falls back to the full new count until
    // the first scroll re-derives the bottom-most-visible row.
    setBottomVisibleMessageId(null)

    // Clear any pending media load batch
    cancelMediaBatch()
    // Drop any repaint-burst debt from the room we're leaving so it can't flush into the new one.
    // The executor hook performs this without constructing an adapter for a list that never pinned.
    resetLiveEdgeRepaintDebt()

    // In static mode (read-only previews), skip all scroll positioning.
    // The parent component handles its own scroll-to-target.
    if (staticMode) {
      isAtBottomRef.current = false
      debugLog('CONVERSATION SWITCH: static mode, skipping scroll')
    } else {
      // Diagnostic only: is this the FIRST open of this conversation this session? The persistence
      // adapter captures it before entry flips the manager's `initialized` flag. The "synced marker only on
      // first open" concern is handled at the SOURCE — the SDK gates the XEP-0490 entry fold to the
      // first activation per session (chatStore/roomStore), so the divider here already reflects the
      // intended read position. Gating the scroll branch on first-open was the wrong layer: it could
      // not distinguish a stale/synced marker from a genuine "new message arrived while away" marker
      // and suppressed the latter on re-entry. See
      // docs/superpowers/specs/2026-06-29-mds-sync-marker-first-open-design.md.
      const persistenceEntry =
        scrollPersistenceRef.current?.enterConversation(
          conversationId,
          messageCount,
        )
      const firstOpenThisSession =
        persistenceEntry?.firstOpenThisSession ?? true
      const action = persistenceEntry?.action ?? 'scroll-to-bottom'
      const savedPos = persistenceEntry?.savedOffsetPx ?? null
      const savedAnchor = persistenceEntry?.savedAnchor ?? null
      const savedReadPositionId =
        persistenceEntry?.savedReadPositionId
      const arbitration = arbitrateEntry({
        persistedAction: action,
        savedReadPositionId,
        firstUnreadMessageId: firstNewMessageId,
        readPointerId,
        lastMessageId,
        targetMessageId,
      })
      const syncedLiveEdge = arbitration.syncedLiveEdgeSupersedes
      pendingSyncedLiveEdgeRef.current = arbitration.armPendingSyncedLiveEdge
        ? { conversationId, savedReadPositionId }
        : null
      if (arbitration.clearSavedPosition) {
        scrollPersistenceRef.current?.clearSavedPosition(conversationId)
        debugLog('MDS LIVE EDGE: synced read supersedes saved position on entry', {
          conversationId,
          savedReadPositionId,
          readPointerId,
        })
      }

      debugLog('CONVERSATION ACTION', {
        action,
        branch: arbitration.branch,
        savedPos,
        firstOpenThisSession,
        scrollHeight: scroller.scrollHeight,
      })
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

      if (arbitration.branch === 'saved-position') {
        isAtBottomRef.current = false
        const request = entryExecutionFacts
          ? positioningControllerRef.current?.beginSavedPositionEntry({
              conversationId,
              entryFacts: entryExecutionFacts,
              executor: buildSavedPositionExecutor(),
            })
          : null
        if (!request) {
          // Controller construction/instrumentation failure must degrade safely instead of leaving
          // entry half-positioned. This is the only saved-position write outside the controller and
          // exists solely as its failure boundary.
          isAtBottomRef.current = true
          emergencyLiveEdgeWrite()
        }
      } else if (arbitration.branch === 'unread-marker') {
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
            executor: buildUnreadMarkerExecutor(),
          })
          : null
        if (!request) {
          // Keep instrumentation/controller failures from stranding entry above an unresolved
          // divider. Normal marker unavailability is promoted by the controller itself.
          isAtBottomRef.current = true
          emergencyLiveEdgeWrite()
        }
      } else if (arbitration.branch === 'defer-to-target') {
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
        isAtBottomRef.current = arbitration.entersAtBottom
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
    buildSavedPositionExecutor,
    buildUnreadMarkerExecutor,
    emergencyLiveEdgeWrite,
    firstNewMessageId,
    isAtBottomRef,
    lastMessageId,
    messageCount,
    cancelMediaBatch,
    readPointerId,
    resetLiveEdgeRepaintDebt,
    staticMode,
    targetMessageId,
    windowAtLiveEdge,
  ])

  // Zero-unread twin of the divider-clear settle below. The old local position may be restored
  // before MAM resolves the other device's pointer to the newest downloaded row; with no divider,
  // observing that pointer transition is the only signal that the restore became obsolete.
  useLayoutEffect(() => {
    const pending = pendingSyncedLiveEdgeRef.current
    if (
      !shouldSupersedeWithLateSyncedLiveEdge({
        armedForConversation: pending?.conversationId,
        conversationId,
        staticMode,
        hasGenuineInput:
          viewportSessionRef.current?.hasGenuineInput(conversationId) ?? false,
        firstUnreadMessageId: firstNewMessageId,
        readPointerId,
        lastMessageId,
        armedSavedReadPositionId: pending?.savedReadPositionId,
      })
    ) {
      return
    }

    pendingSyncedLiveEdgeRef.current = null
    scrollPersistenceRef.current?.clearSavedPosition(conversationId)
    isAtBottomRef.current = true
    debugLog('MDS LIVE EDGE: late synced read supersedes restored position', {
      conversationId,
      savedReadPositionId: pending?.savedReadPositionId,
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

  // Divider-clear settle window: entry may already have positioned the view against a divider
  // when another path removes it. Before the reader moves, settle to the live edge so the list
  // does not remain parked at a landmark that no longer exists.
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
    const decision = decideMdsSettle({
      staticMode,
      sameConversation: prev.conv === conversationId,
      previousDivider: prev.divider,
      currentDivider: firstNewMessageId,
      hasGenuineInput: viewportSessionRef.current?.hasGenuineInput(conversationId) ?? false,
    })
    if (decision === 'skip') return
    debugLog('MDS SETTLE: divider cleared before reader input → settle to bottom', {
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
      executor: buildSavedPositionExecutor(),
    })) {
      prevMessageCountRef.current = messageCount
      prevLastMessageIdRef.current = lastMessageId
    }
  }, [
    conversationId,
    buildSavedPositionExecutor,
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

  // Cleanup: leave through the persistence adapter only when the message list actually unmounts.
  // The conversation-switch effect above intentionally has broad deps (message count, target,
  // marker) so it sees the current entry state, but a cleanup attached there would also run on
  // same-conversation updates and mark the underlying singleton store "left" while the room is
  // still mounted.
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
        const outgoingConversationId = prevConversationRef.current
        const viewportSnapshot = viewportSessionRef.current?.snapshotFor(
          outgoingConversationId,
        )
        // Same gate as the conversation-switch leave: only persist the live scroll data when the
        // user genuinely scrolled this visit; otherwise keep the existing saved anchor (markAsLeft)
        // so a media/measurement-induced post-restore drift can't be saved (see the ref).
        if (viewportSnapshot?.geometry && viewportSnapshot.hasGenuineInput) {
          const { top, height, client } = viewportSnapshot.geometry
          // UNMOUNT save: this is the leave path for navigations that DESTROY the message view —
          // opening Settings, switching DM↔Room, going back to the list. (DM↔DM keeps the view
          // mounted and saves via the conversation-switch effect instead.) If `top`/anchor here are
          // stale or already at-bottom, the next entry restores wrong / jumps to bottom — so this
          // shows exactly what was persisted at the moment the screen was torn down.
          debugLog('UNMOUNT leaveConversation (save)', {
            conversationId: outgoingConversationId,
            top, height, client,
            distFromBottom: height - top - client,
            anchorMessageId: viewportSnapshot.bottomAnchor?.messageId,
            anchorFraction: viewportSnapshot.bottomAnchor?.fraction,
          })
        } else {
          // No scroll data, or the user never scrolled this visit → don't overwrite the saved
          // position; just mark the conversation left so a return is detected as a switch.
          debugLog('UNMOUNT markAsLeft (no user scroll / no scroll data)', {
            conversationId: outgoingConversationId,
          })
        }
        scrollPersistenceRef.current?.leaveConversation(
          outgoingConversationId,
          viewportSnapshot ?? null,
          previousReadPositionRef.current,
        )
      }
      detachUserInputListeners()
    }
  }, [detachUserInputListeners])

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
    const executor = buildExplicitTargetExecutor(targetMessageId, true)
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
    buildExplicitTargetExecutor,
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
      cancelMediaBatch()
      teardownContentObserver()
      disposeDirectionalHistoryBrowser()
    }
  }, [cancelMediaBatch, disposeDirectionalHistoryBrowser, teardownContentObserver])

  // ==========================================================================
  // EFFECT: Returned to the live edge → drop any stale directional-load anchor.
  // ==========================================================================
  // Feed the value-only window transition to the coordinator. This passive effect still runs after
  // the layout restore, so a newer load that shifts and reaches the tail in one commit reconciles
  // first; a no-shift tail load releases only its own generation.
  useEffect(() => {
    applyDirectionalReleaseDecision(
      directionalWindowRef.current?.observeLiveEdge(
        conversationId,
        windowAtLiveEdge,
      ) ?? { kind: 'none' },
    )
  }, [applyDirectionalReleaseDecision, conversationId, windowAtLiveEdge])

  // EFFECT: Prepend complete (older messages loaded)
  // ==========================================================================
  //
  // This runs in useLayoutEffect so it happens BEFORE the browser paints.
  // We restore the user's visual position using element-based positioning,
  // falling back to distance-from-bottom math if the anchor element isn't found.

  useLayoutEffect(() => {
    if (staticMode) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const decision = directionalWindowRef.current?.observeWindow({
      conversationId,
      firstMessageId: firstMessageId ?? '',
    }) ?? { kind: 'none' as const }
    if (decision.kind === 'none') return
    const saved = decision.snapshot

    // A directional load (older OR newer) landed iff the FIRST message id changed. Sliding window:
    // a load-older OR load-newer at the resident cap prepends/appends a batch AND evicts the
    // opposite end, so messageCount stays CONSTANT — the old `countIncreased` gate then waited
    // forever and the view jumped. firstId is the reliable signal: load-older makes it older;
    // load-newer evicts the oldest so it becomes newer. The anchor-based restore below is
    // direction-agnostic (it repositions the top-visible anchor, which survives either eviction —
    // the evicted rows are at the far, off-screen end). Under the cap, load-older still changes
    // firstId AND grows the count, so this is unchanged for the common case.
    if (decision.kind === 'waiting') {
      debugLog('PREPEND WAITING', {
        messageCount,
        oldMessageCount: saved.oldMessageCount,
        firstMessageId,
        oldFirstId: saved.oldFirstId,
        loadSettled: Boolean(saved.loadSettled),
        firstIdChanged: false,
      })
      return
    }

    if (decision.kind === 'dropped') {
      debugLog('DIRECTIONAL HISTORY DROPPED (controller unavailable)', {
        oldFirstId: saved.oldFirstId,
        firstMessageId,
      })
      return
    }

    // The controller performs the first write synchronously in this layout effect, preserving the
    // pre-paint landing. Its leased executor retains kinetic cancellation, anchor/fallback geometry,
    // clamp recovery, and the full late-measurement frame budget.
    positioningControllerRef.current?.reconcileDirectionalHistory({
      conversationId,
      generation: decision.generation,
      executor: buildDirectionalHistoryExecutor(saved),
    })

  }, [
    buildDirectionalHistoryExecutor,
    conversationId,
    firstMessageId,
    messageCount,
    staticMode,
  ])

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

    // Don't interfere while a controller-owned directional restore is still waiting to land.
    // Once applied, allow new-message auto-scroll even during the snapshot cooldown period.
    if (
      positioningControllerRef.current?.isDirectionalHistoryPending(
        conversationId,
      )
    ) {
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
        reconcileLiveEdge('new-message', isAtBottomRef.current)
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
      reconcileLiveEdge('mam-catchup-complete', isAtBottomRef.current)
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
  // EFFECT: A resident row grew in place — keep the bottom glued (only when sticked)
  // ==========================================================================

  // A reaction, a link-preview or attachment fastening, a correction or a retraction grows (or
  // shrinks) a message row that is ALREADY rendered — without changing the message count or the
  // last-message id, so the new-message effect never sees it. The OGP fastening is the slowest of
  // them: it lands seconds after the send, once the metadata fetch and the round-trip complete.
  // While the reader is sticked to the bottom we keep the newest message glued to the bottom edge
  // and let the growth be absorbed ABOVE (previous messages scroll up) — rather than letting the row
  // growth shove the newest message down. This runs for a change on ANY resident row, not just the
  // last one: a row grown in the middle of the viewport would otherwise push everything below it
  // (including the newest message) down.
  //
  // We route through the controller-owned live-edge convergence that new messages and the typing
  // band use rather than a one-shot scrollToIndex, because the row's
  // ResizeObserver reports the grown height a frame or two AFTER the chip mounts — a single
  // synchronous pin would land on the pre-growth height and still let the bottom dip. The loop polls
  // scrollHeight per frame and re-pins instantly (no smooth easing, so nothing visibly animates),
  // converging in a handful of frames. It's pure imperative scroll work — no React re-render.
  //
  // Two safeguards keep it from ever fighting a scroll: (1) it's gated on geometry, not the
  // latchable isAtBottomRef — a reader scrolled up into history is never re-pinned (a stale-true
  // latch is what made a typing toggle "fight" the scroll in #918); (2) it fires only on an actual
  // row-height change WITHIN the same conversation, so a conversation switch / restore is never
  // disturbed.
  //
  // The gate must read the geometry from BEFORE the growth, which is why it subtracts the height
  // delta rather than measuring distance-from-bottom directly. By the time this layout effect runs
  // the row has already grown, and that growth lands in the distance: a ~260px preview card reads as
  // "260px from the bottom", i.e. further than the threshold, so a naive live-geometry gate refuses
  // to re-pin the very case it exists for. Worse, the post-commit geometry is not even self
  // consistent under virtualization — the grown row is absolutely positioned and overflows the
  // @tanstack spacer, so the row can hang below the fold while scrollHeight (still the pre-growth
  // spacer) reports a comfortable distance. Both engines reproduce this; see the fastening tests in
  // scripts/scroll-invariants.ts. The viewport session is refreshed on every scroll event and by
  // every bottom pin, so it is the last geometry the reader actually saw.
  //
  // A signature change is consumed EXACTLY ONCE — nothing re-runs this effect for the same
  // signature — so every skip is final. That includes the skip taken while a pin loop already claims
  // the bottom, which is a bet that the running loop absorbs the growth itself. The claim
  // self-expires, so it can never latch permanently and suppress growths forever; but expiry does
  // not replay a growth already consumed. See the accepted-gap contract on rowGrowthDecision.
  const prevRowGrowthKeyRef = useRef(rowGrowthSignature)
  const rowGrowthConvRef = useRef(conversationId)

  useLayoutEffect(() => {
    const sameConversation = rowGrowthConvRef.current === conversationId
    rowGrowthConvRef.current = conversationId
    const prevKey = prevRowGrowthKeyRef.current
    prevRowGrowthKeyRef.current = rowGrowthSignature
    if (!sameConversation) return // conversation switch → rebaseline, never re-pin
    if (prevKey === rowGrowthSignature) return // no actual row change (unrelated re-render)

    const scroller = scrollerRef.current
    if (!scroller || staticMode) return

    // Measure against the last geometry the reader actually saw, and keep the SIGN. A mounted list
    // is always at least a viewport tall, so a smaller baseline is a stale or not-yet-measured
    // snapshot — report null rather than a number, so the decision treats it as "unknown" instead of
    // trusting it. Trusting a bogus baseline would inflate the delta and make a scrolled-up reader
    // look as if they had been at the bottom, which is the harmful direction.
    const baseline =
      viewportSessionRef.current?.snapshotFor(conversationId)?.geometry?.height ?? 0
    const active = positioningControllerRef.current?.snapshot().active
    const decision = decideRowGrowth({
      distanceFromBottom: getDistanceFromBottom(scroller),
      heightDelta:
        baseline >= scroller.clientHeight ? scroller.scrollHeight - baseline : null,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
      pinClaimHeld: pinBottomClaim().isHeld(),
      navigationInFlight: Boolean(
        active &&
        active.request.conversationId === activeConversationIdRef.current &&
        active.request.desired.kind !== 'live-edge' &&
        active.phase.kind !== 'settled',
      ),
    })
    if (decision === 'pin') reconcileLiveEdgeRef.current('row-growth', true)
  }, [rowGrowthSignature, conversationId, staticMode])

  // ==========================================================================
  // EFFECT: Typing indicator appears — re-pin under the band it takes from the scrollport
  // ==========================================================================

  // The typing indicator is a band BELOW the scrollport (see MessageList), so showing it shrinks the
  // scroller by the band's height and leaves a reader who was sticked to the bottom that many pixels
  // short of it. The scroller's own ResizeObserver would also catch this, but only a frame later
  // (its correction is rAF-deferred, see the container-resize effect); re-pinning here, in the same
  // commit that mounts the band, avoids that frame of visible drift. Routed through the shared
  // controller-owned live-edge loop (the same convergence new messages use) so the virtualized path
  // re-windows rather than taking a raw scrollTop write. Two safeguards: a live-geometry gate (not
  // the latchable isAtBottomRef) and a same-conversation check. Only the false→true edge re-pins;
  // typing stopping GROWS the scroller back, which the browser clamps scrollTop for on its own.
  const prevHasTypingRef = useRef(hasTypingIndicator)
  const typingConvRef = useRef(conversationId)
  useLayoutEffect(() => {
    const sameConversation = typingConvRef.current === conversationId
    typingConvRef.current = conversationId
    const prevHasTyping = prevHasTypingRef.current
    prevHasTypingRef.current = hasTypingIndicator

    const scroller = scrollerRef.current
    const decision = decideTypingIndicator({
      staticMode,
      sameConversation,
      hasTypingIndicator,
      hadTypingIndicator: prevHasTyping,
      // No scroller is no geometry: report a distance nothing can be at the bottom of, so the
      // decision skips for the same reason a scrolled-up reader does.
      distanceFromBottom: scroller ? getDistanceFromBottom(scroller) : Number.POSITIVE_INFINITY,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
    })
    if (decision === 'skip') return

    reconcileLiveEdge('typing', decision === 'pin')
  }, [hasTypingIndicator, conversationId, reconcileLiveEdge, staticMode])

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
    viewportSessionRef.current?.recordUserInput(conversationId, Date.now())
    positioningControllerRef.current?.beginUnreadMarkerNavigation({
      conversationId,
      navigationFacts: {
        firstUnreadMessageId: firstNewMessageId,
        unreadMarkerNeedsVisit: true,
        unreadMarkerAlign: virtualizerRef.current ? 'start' : 'top-third',
      },
      executor: buildUnreadMarkerExecutor(),
    })
  }, [firstNewMessageId, conversationId, buildUnreadMarkerExecutor])

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
    handleVirtualRowMeasuredGrowth,
    scrollToBottom,
    scrollToTop,
    requestMessageTarget,
    showScrollToBottom,
    markerAboveViewport,
    bottomVisibleMessageId,
    scrollToMarker,
  }
}
