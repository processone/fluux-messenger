/**
 * MessageList - Renders a scrollable list of messages with date separators.
 *
 * Features:
 * - Date separators between message groups
 * - New message markers for unread messages
 * - Scroll position preservation across conversation switches
 * - Auto-scroll on new messages (when at bottom)
 * - Lazy loading of older messages via scroll-to-top
 * - Typing indicator at bottom
 *
 * Scroll behavior is handled by useMessageListScroll hook.
 */
import { useMemo, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BaseMessage } from '@fluux/sdk'
import { useMessageCopyFormatter, useMessageRangeSelection } from '@/hooks'
import { useViewportObserver } from '@/hooks/useViewportObserver'
import { useRenderCostProbe } from '@/hooks/useRenderCostProbe'
import { detectRenderLoop, notifyUserInput } from '@/utils/renderLoopDetector'
import { DateSeparator } from './DateSeparator'
import { NewMessageMarker } from './NewMessageMarker'
import { HistoryStartMarker } from './HistoryStartMarker'
import { HistoryGapMarker } from './HistoryGapMarker'
import { TypingIndicator } from './TypingIndicator'
import { groupMessagesByDate, shouldShowAvatar } from './messageGrouping'
import { useMessageListScroll } from './useMessageListScroll'
import { MessageWidthProvider } from './messageWidthContext'
import { OwnGroupWidthProvider } from './messageGroupWidth'
import { isFeatureEnabled } from '@/utils/featureFlags'
import { useSettingsStore } from '@/stores/settingsStore'
import type { CopyMessageMeta } from '@/utils/buildCopyText'
import { buildMessageListItems, type RenderItem } from './messageListItems'
import { fabAnimationClass } from './fabAnimationClass'
import { FloatingDateHeader } from './FloatingDateHeader'
import { JumpToLastReadPill } from './JumpToLastReadPill'
import { getTopVisibleDate } from './getTopVisibleDate'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import {
  setActiveMessageListController,
  getActiveMessageListController,
  type ActiveMessageListController,
} from './activeMessageListController'
import { useRowMetrics } from './useRowMetrics'
import { estimateRowHeight } from './rowHeightEstimator'
import { isEstimateDebugEnabled, estimateDebugLog } from '@/utils/scrollDebug'
import {
  getCachedHeights,
  recordMeasuredHeight,
  heightCacheKey,
  noteConversationWidthBucket,
  getConversationWidthBucket,
  getCachedHeight,
  persistHeightSnapshot,
  hydrateHeightCache,
} from './messageHeightCache'
import { collectSettledRowHeights } from './settledRowSnapshot'
import { Loader2, ChevronUp, ChevronDown, MessageCircle } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { MessageSelectionBar } from './MessageSelectionBar'

// ============================================================================
// TYPES
// ============================================================================

export interface MessageListProps<T extends BaseMessage> {
  /** Messages to display */
  messages: T[]
  /** Unique identifier for this conversation/room */
  conversationId: string
  /** ID of the first unread message (for new message marker) */
  firstNewMessageId?: string
  /** Divider derived while a synced XEP-0490 read position is still unresolved — rendered muted */
  firstNewMessageIsProvisional?: boolean
  /** ID of a specific message to scroll to (e.g., from activity log click) */
  targetMessageId?: string | null
  /** Called after scrolling to target message (to clear the store value) */
  onTargetMessageConsumed?: () => void
  /** Callback to clear the first new message ID (used by viewport observer) */
  clearFirstNewMessageId?: () => void
  /** Users currently typing */
  typingUsers?: string[]
  /** Format function for typing user display */
  formatTypingUser?: (user: string) => string
  /**
   * Render function for each message.
   * The onMediaLoad callback should be passed to image/video components to enable
   * batched scroll correction when media loads.
   */
  renderMessage: (message: T, index: number, groupMessages: T[], showNewMarker: boolean, onMediaLoad: () => void) => ReactNode
  /** Extra content to render after all messages */
  extraContent?: ReactNode
  /** Content to show when messages array is empty */
  emptyState?: ReactNode
  /** If true, show a placeholder while loading */
  isLoading?: boolean
  /** Content to show while loading */
  loadingState?: ReactNode
  /** Ref to the scroll container element (for keyboard navigation) */
  scrollerRef?: React.RefObject<HTMLElement | null>
  /** Ref to track if scroll is at bottom (shared with keyboard navigation) */
  isAtBottomRef?: React.MutableRefObject<boolean>
  /** Callback when user scrolls to top (for lazy loading older messages) */
  onScrollToTop?: () => void
  /**
   * Hydrate the resident message window with the cache slice CONTAINING a specific message.
   * Used by scroll-position restore (and search/target navigation) when the saved anchor / target
   * is older than the latest-N slice loaded on activation, so the existing anchor restore can land.
   */
  onLoadAround?: (anchorMessageId: string) => Promise<unknown> | void
  /** If true, show loading indicator at top while fetching older messages */
  isLoadingOlder?: boolean
  /** Sliding window: load the next-newer cache slice when the reader scrolls back down to the
   *  bottom of a slid-up window. Fired only when windowAtLiveEdge is false. */
  onLoadNewer?: () => void
  /** If true, a newer-slice load is already in flight (throttles the load-newer trigger) */
  isLoadingNewer?: boolean
  /** Sliding window: whether the resident window includes the newest message. false = slid up
   *  (enables the load-newer trigger); absent/true = at the live edge (unchanged behavior). */
  windowAtLiveEdge?: boolean
  /** Sliding window: reset the resident window to the newest slice (jump-to-latest). Invoked by the
   *  scroll-to-bottom FAB when the window is slid up, before scrolling to the bottom. */
  onJumpToLatest?: () => Promise<unknown> | void
  /** If true, all history has been fetched - disable scroll-to-top trigger */
  isHistoryComplete?: boolean
  /** Callback when the bottom-most visible message changes (viewport tracking) */
  onMessageSeen?: (messageId: string) => void
  /** Disables all auto-scroll behaviors. Used by read-only preview views
   *  (search context, activity context) that manage their own scroll positioning. */
  staticMode?: boolean
  /** ID of the last message sent by the user (for send animation) */
  lastSentMessageId?: string | null
  /** Epoch ms of the newest message before a history gap (incomplete forward catch-up) */
  forwardGapTimestamp?: number
  /** Callback to continue loading missing messages from the gap */
  onCatchUpHistory?: () => void
  /** If true, show loading indicator on the gap marker */
  isCatchingUp?: boolean
  /**
   * Maps a message to its clipboard metadata, faithful to the rendered bubble (the
   * caller resolves the display name / time the same way it builds each row). Only
   * consumed on the virtualized path: a multi-message copy is reconstructed from the
   * in-memory array so the rows carry correct dates/names (the virtualized DOM splits
   * date separators into separate windowed items the pure-DOM copy can't follow).
   */
  formatMessageForCopy?: (message: T) => CopyMessageMeta
}

// ============================================================================
// COMPONENT
// ============================================================================

export function MessageList<T extends BaseMessage>({
  messages,
  conversationId,
  firstNewMessageId,
  firstNewMessageIsProvisional = false,
  clearFirstNewMessageId,
  targetMessageId,
  onTargetMessageConsumed,
  typingUsers = [],
  formatTypingUser,
  renderMessage,
  extraContent,
  emptyState,
  isLoading,
  loadingState,
  scrollerRef: externalScrollerRef,
  isAtBottomRef: externalIsAtBottomRef,
  onScrollToTop,
  onLoadAround,
  isLoadingOlder,
  onLoadNewer,
  isLoadingNewer,
  windowAtLiveEdge,
  onJumpToLatest,
  isHistoryComplete,
  onMessageSeen,
  staticMode,
  lastSentMessageId,
  forwardGapTimestamp,
  onCatchUpHistory,
  isCatchingUp,
  formatMessageForCopy,
}: MessageListProps<T>) {
  // Detect render loops before they freeze the UI
  detectRenderLoop('MessageList')

  // A density change re-measures every visible row once; arm the interaction
  // grace window so the virtualizer's re-window burst is not flagged as a loop.
  const densityMode = useSettingsStore((s) => s.densityMode)
  useEffect(() => {
    notifyUserInput()
  }, [densityMode])

  // Attribute slow message-list renders (room-entry stall triage on WebKitGTK):
  // splits the cost into React commit vs browser layout/paint in fluux.log.
  useRenderCostProbe('MessageList', () => `rows=${messages.length}, conversation=${conversationId}`)

  const { t } = useTranslation()

  // --------------------------------------------------------------------------
  // MESSAGE PROCESSING
  // --------------------------------------------------------------------------

  // Deduplicate messages by ID (safety net for any race conditions in store).
  // Only real ids participate: `id` is typed string but demo echoes / persisted
  // state can miss it, and two distinct id-less messages are not duplicates.
  const deduplicatedMessages = useMemo(() => {
    const seen = new Set<string>()
    return messages.filter((msg) => {
      if (!msg.id) {
        return true
      }
      if (seen.has(msg.id)) {
        return false
      }
      seen.add(msg.id)
      return true
    })
  }, [messages])

  // Derive badge count from the marker position so FAB badge and marker are
  // always consistent. The store's unreadCount is 0 for active conversations.
  const markerUnreadCount = useMemo(() => {
    if (!firstNewMessageId) return 0
    const idx = deduplicatedMessages.findIndex((m) => m.id === firstNewMessageId)
    if (idx === -1) return 0
    return deduplicatedMessages.length - idx
  }, [firstNewMessageId, deduplicatedMessages])

  // Group messages by date for rendering with separators. Memoized so the virtualizer
  // (and the legacy map) receive a stable array when messages are unchanged — an unstable
  // ref here amplifies the @tanstack measure-settling into a render burst.
  const groupedMessages = useMemo(() => groupMessagesByDate(deduplicatedMessages), [deduplicatedMessages])

  // Compute derived values for scroll hook
  const firstMessageId = deduplicatedMessages[0]?.id
  const lastMessage = messages[messages.length - 1]
  // Signature of the last message's reactions — changes when a reaction is added/removed on it, which
  // grows/shrinks its row. Used only to give a gentle bottom nudge while the reader is sticked to the
  // bottom (see the reactions effect in useMessageListScroll).
  const lastMessageReactionsKey = lastMessage
    ? JSON.stringify(lastMessage.reactions || {})
    : ''

  // --------------------------------------------------------------------------
  // SCROLL BEHAVIOR (delegated to hook)
  // --------------------------------------------------------------------------

  // Local ref for multi-message selection (scroll hook has its own internal ref)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // --------------------------------------------------------------------------
  // VIRTUALIZATION (behind the enableMessageVirtualization flag, default ON)
  // --------------------------------------------------------------------------

  const showLoading = !!(isLoading && loadingState)
  const showEmpty = !showLoading && messages.length === 0
  const hasContent = !showLoading && !showEmpty
  const showHeader = hasContent && (!!isHistoryComplete || !!onScrollToTop)
  const showFooter = hasContent

  // Disabled in staticMode (search/activity previews manage their own scroll).
  // NOTE: the non-virtualized path this forces is a hard dependency of the search
  // result preview (SearchContextView) and StrangerRequestPreviewView, which mount
  // one MessageList per result and rely on every message rendering directly (no
  // virtualizer cache to leak between results). Removing this guard breaks them —
  // MessageList.staticMode.test.tsx pins the invariant.
  const virtualized = isFeatureEnabled('enableMessageVirtualization') && !staticMode

  // Built unconditionally (hooks rule); empty when not virtualized, so the
  // virtualizer below is inert and the flag-OFF render path is unchanged.
  const { items: virtualItems, indexById } = useMemo(
    () =>
      virtualized && hasContent
        ? buildMessageListItems(groupedMessages, {
            firstNewMessageId,
            showAvatar: shouldShowAvatar,
            showHeader,
            showFooter,
          })
        : { items: [] as RenderItem<T>[], indexById: new Map<string, number>() },
    [virtualized, hasContent, groupedMessages, firstNewMessageId, showHeader, showFooter],
  )
  // Sample live row metrics for the per-item height estimator. Returns a ref (no re-render);
  // falls back to ROW_METRICS_FALLBACK under jsdom / before any rows are mounted.
  const rowMetricsRef = useRowMetrics(scrollContainerRef)

  // --------------------------------------------------------------------------
  // PERSISTENT HEIGHT CACHE (virtualized path only)
  // --------------------------------------------------------------------------
  // Current font scale (a number; e.g. 100, 125). Subscribe so widthBucket changes
  // when the user adjusts font size — different scale = different heights.
  const scalePct = useSettingsStore((s) => s.fontSize)

  // Per-index estimate: drives the virtualizer's initial size guess so prepend-restore lands
  // accurately instead of snapping. Only used when virtualized (passed unconditionally since the
  // adapter is always constructed; the non-virtualized path ignores it). Guard the index: @tanstack
  // only probes valid indices in steady state, but a stale window during a count change could probe
  // out of range, and estimateRowHeight reads item.kind immediately (the signature is not nullable).
  // Cached-first: rows that appear AFTER mount (messages streaming in from MAM on a reload)
  // are not covered by the mount-time initialMeasurements seed, so estimateSize consults the
  // height cache (hydrated from the persisted snapshot) before predicting from text. A cache
  // hit is the row's real settled height — no reflow, no bottom-pin re-assert when it mounts.
  const estimateSize = useCallback(
    (index: number) => {
      const item = virtualItems[index]
      if (item === undefined) {
        return rowMetricsRef.current.chrome.continuation // safe fallback for any out-of-range probe
      }
      const mountBucketPx = Math.round(rowMetricsRef.current.contentWidthPx / 20) * 20
      const cached = getCachedHeight(conversationId, item.key, scalePct, mountBucketPx)
      return cached ?? estimateRowHeight(item, rowMetricsRef.current)
    },
    [virtualItems, rowMetricsRef, conversationId, scalePct],
  )

  // Build the initialMeasurements seed from the persistent cache. Only when virtualized —
  // flag-OFF path is unchanged. Filter to keys that match the width bucket + scale so stale
  // entries from a different viewport/font-size are not applied.
  // Use a ref so it is evaluated once at mount without needing eslint-disable on empty deps.
  // MOUNT-SCOPED: this builds the seed exactly once per mount and relies on MessageList
  // remounting on every conversation switch (the cache is the whole point — it survives that
  // remount). It will NOT rebuild if MessageList is ever reused across conversations without a
  // remount; that is not the case today.
  const initialMeasurementsRef = useRef<ReadonlyMap<string, number> | undefined>(undefined)
  const initialMeasurementsBuiltRef = useRef(false)
  if (!initialMeasurementsBuiltRef.current && virtualized) {
    initialMeasurementsBuiltRef.current = true
    // One-shot per page load: fill the module cache from the persisted snapshot so the
    // FIRST mount after a reload seeds real heights (the in-memory cache alone dies with
    // the page, which made every conversation re-open on estimates → the reload blink).
    hydrateHeightCache()
    // The mount-time content width is still the 560 fallback here (useRowMetrics samples the real
    // width in a rAF after layout), so prefer the REAL bucket persisted by a prior write-back. The
    // common case — re-entering at the same viewport — then hits; a genuine width change falls back
    // to the mount-time bucket and just re-measures on mount as before.
    const mountWidthBucketPx = Math.round(rowMetricsRef.current.contentWidthPx / 20) * 20
    const widthBucketPx = getConversationWidthBucket(conversationId) ?? mountWidthBucketPx
    const stored = getCachedHeights(conversationId)
    if (stored.size > 0) {
      const suffix = `@${widthBucketPx}@${scalePct}`
      // Iterate the stored map; for each stored key that matches bucket+scale, extract messageId
      // (strip `@bucket@scale` suffix) and include it if the messageId is a key in virtualItems.
      const virtualKeys = new Set(virtualItems.map((item) => item.key))
      const result = new Map<string, number>()
      for (const [k, size] of stored) {
        if (k.endsWith(suffix)) {
          const messageId = k.slice(0, k.length - suffix.length)
          if (virtualKeys.has(messageId)) {
            result.set(messageId, size)
          }
        }
      }
      if (result.size > 0) initialMeasurementsRef.current = result
    }
    estimateDebugLog('seed', {
      conversationId,
      bucket: widthBucketPx,
      scale: scalePct,
      seeded: initialMeasurementsRef.current?.size ?? 0,
      candidates: stored.size,
      rows: virtualItems.length,
    })
  }
  const initialMeasurements = initialMeasurementsRef.current

  // Write-back: record each row's measured height to the persistent cache.
  // scalePct/conversationId are captured via a ref so the stable callback identity
  // is preserved (no virtualizer re-creation on every render).
  const onMeasuredParamsRef = useRef({ conversationId, scalePct, rowMetricsRef, indexById, virtualItems })
  onMeasuredParamsRef.current = { conversationId, scalePct, rowMetricsRef, indexById, virtualItems }
  const onMeasured = useMemo(
    () =>
      virtualized
        ? (key: string, size: number) => {
            const { conversationId: cid, scalePct: scale, rowMetricsRef: metricsRef, indexById: idMap, virtualItems: items } = onMeasuredParamsRef.current
            // Real sampled bucket. Persist it alongside the entry so the next mount's seed (which
            // runs before the real width is sampled) can filter by this same bucket and hit.
            const widthBucketPx = Math.round(metricsRef.current.contentWidthPx / 20) * 20
            recordMeasuredHeight(cid, heightCacheKey(key, widthBucketPx, scale), size)
            noteConversationWidthBucket(cid, widthBucketPx)
            // Estimate-accuracy trace (estimate-debug only): predicted vs first-measured per row.
            // Gated up front so the predict (which may call pretext) is skipped when debug is off.
            if (isEstimateDebugEnabled()) {
              const idx = idMap.get(key)
              const item = idx != null ? items[idx] : undefined
              const predicted = item ? estimateRowHeight(item, metricsRef.current) : undefined
              estimateDebugLog('row', key, {
                kind: item?.kind,
                predicted,
                measured: size,
                delta: predicted != null ? Math.round(size - predicted) : undefined,
              })
            }
          }
        : undefined,
    [virtualized],
  )

  const virtualizer = useTanstackMessageVirtualizer({ items: virtualItems, indexById, scrollRef: scrollContainerRef, estimateSize, initialMeasurements, onMeasured })
  const activeVirtualizer = virtualized ? virtualizer : undefined

  // Settled-height snapshot on unmount (conversation switch). @tanstack measures each row via a
  // ResizeObserver and onMeasured writes that height to the persistent cache. On WebKit the SETTLED
  // measurement is delivered late — often after the row has been windowed out or the list unmounted —
  // so the cache keeps the row's TRANSIENT (pre-settle) height. On the next entry the seed is that
  // transient value, the visible rows reflow to their real height right after the first paint, and the
  // bottom-pin re-asserts: a one-time content jump (visible on WebKit, smooth on Chromium). Reading
  // each mounted row's live offsetHeight here — when it is fully settled in the DOM — overrides the
  // transient with the settled value, so the NEXT seed matches the render and there is no reflow.
  //
  // useLayoutEffect (not useEffect) so the cleanup runs during the unmount commit while the rows are
  // still attached (a passive cleanup runs after the DOM is removed → offsetHeight would read 0). Reads
  // only, once per switch (~window+overscan rows). Keyed via data-index → virtualItems[i].key, so it
  // covers every mounted row kind (messages, date separators, footer), matching the seed's key space.
  //
  // The same snapshot also runs on pagehide: a reload never runs unmount cleanups, so without it
  // the ACTIVE conversation — the one visibly blinking after the reload — would never persist.
  // persistHeightSnapshot mirrors the settled window to localStorage for the next session's seed.
  useLayoutEffect(() => {
    if (!virtualized) return
    const scroller = scrollContainerRef.current
    const snapshotSettledRows = () => {
      if (!scroller) return
      const { conversationId: cid, scalePct: scale, rowMetricsRef: metricsRef, virtualItems: items } = onMeasuredParamsRef.current
      const widthBucketPx = Math.round(metricsRef.current.contentWidthPx / 20) * 20
      const settled = collectSettledRowHeights(scroller, items, widthBucketPx, scale)
      for (const [key, height] of settled) {
        recordMeasuredHeight(cid, key, height)
      }
      if (settled.size > 0) noteConversationWidthBucket(cid, widthBucketPx)
      persistHeightSnapshot(cid, settled, widthBucketPx)
    }
    window.addEventListener('pagehide', snapshotSettledRows)
    return () => {
      window.removeEventListener('pagehide', snapshotSettledRows)
      snapshotSettledRows()
    }
  }, [virtualized])

  // Ref-backed so FloatingDateHeader subscribes once. Reads the live virtualizer
  // window + scrollTop each call; returns null to suppress (separator at top / no
  // date above). MessageList itself does not re-render on scroll.
  const getTopVisibleDateRef = useRef<() => string | null>(() => null)
  getTopVisibleDateRef.current = () => {
    const v = activeVirtualizer
    const scroller = scrollContainerRef.current
    if (!v || !scroller) return null
    return getTopVisibleDate(v.getVirtualItems(), virtualItems, scroller.scrollTop)
  }
  const getTopDate = useCallback(() => getTopVisibleDateRef.current(), [])

  // Dev-only: expose virtualizer offset lookup for Playwright test assertions (invariant-1).
  // Allows tests to check anchor position without requiring the row to be in the DOM window.
  useEffect(() => {
    if (!import.meta.env.DEV || !activeVirtualizer || typeof window === 'undefined') return

    const devWindow = window as unknown as Record<string, unknown>
    const getVirtOffset = (id: string) => activeVirtualizer.getOffsetForMessageId(id)
    devWindow.__fluuxGetVirtOffset = getVirtOffset
    return () => {
      if (devWindow.__fluuxGetVirtOffset === getVirtOffset) {
        delete devWindow.__fluuxGetVirtOffset
      }
    }
  }, [activeVirtualizer])

  // Gap marker position: the first chronological message past the forward-catch-up
  // boundary (the per-group computation in the legacy render reduces to this).
  const gapMarkerMessageId = useMemo(() => {
    if (!forwardGapTimestamp || !onCatchUpHistory) return undefined
    for (const g of groupedMessages) {
      for (const m of g.messages) {
        if (m.timestamp.getTime() > forwardGapTimestamp) return m.id
      }
    }
    return undefined
  }, [groupedMessages, forwardGapTimestamp, onCatchUpHistory])

  const {
    setScrollContainerRef: setScrollContainerRefFromHook,
    contentWrapperRef,
    handleScroll,
    handleWheel,
    handleLoadEarlier,
    handleMediaLoad,
    scrollToBottom,
    showScrollToBottom,
    markerAboveViewport,
    scrollToMarker,
  } = useMessageListScroll({
    conversationId,
    messageCount: messages.length,
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
    onLoadNewer,
    isLoadingNewer,
    windowAtLiveEdge,
    isHistoryComplete,
    lastMessageReactionsKey,
    hasTypingIndicator: typingUsers.length > 0,
    lastMessageIsOutgoing: lastMessage?.isOutgoing ?? false,
    lastMessageId: lastMessage?.id,
    staticMode,
    virtualizer: activeVirtualizer,
  })

  // Combined ref setter for scroll container
  const setScrollContainerRef = (element: HTMLDivElement | null) => {
    (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = element
    setScrollContainerRefFromHook(element)
  }

  // Register this list so outside code can reach it without threading a prop through
  // every caller: scrollToMessage (reply-quote taps, find-on-page, poll and reaction
  // jumps) windows an off-screen row in before its DOM read, and ChatLayout's Escape
  // handler (spec §3 step 3, conversation catch-up) triggers the same scroll-to-bottom
  // as the ⌘/Ctrl+↓ shortcut and FAB. hasMessage/ensureMessageMounted are virtualized-only
  // (non-virtualized lists keep every row mounted, so scrollToMessage's plain DOM path
  // works unchanged); scrollToBottom is always available. Identity-checked cleanup so a
  // fast conversation switch can't clear the newly mounted list's registration.
  useEffect(() => {
    const controller: ActiveMessageListController = {
      hasMessage: (id) => activeVirtualizer ? activeVirtualizer.getIndexForMessageId(id) !== null : false,
      ensureMessageMounted: (id) => { void activeVirtualizer?.ensureMessageMounted(id) },
      // Reuse the same cache-slice loader as the targetMessageId jump so scrollToMessage can reach a
      // target that scrolled out of the loaded item set entirely (issue #955: reply-quote / poll).
      loadAround: onLoadAround,
      scrollToBottom,
    }
    setActiveMessageListController(controller)
    return () => {
      if (getActiveMessageListController() === controller) setActiveMessageListController(null)
    }
  }, [activeVirtualizer, scrollToBottom, onLoadAround])

  // Dev-only: expose the full load-earlier trigger (saves anchor + calls onScrollToTop)
  // so tests can fire it without scrolling to 0, which would change findAnchorElement's
  // anchor to firstMessageId instead of the actual top-visible message at that scrollTop.
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return

    const devWindow = window as unknown as Record<string, unknown>
    devWindow.__fluuxTriggerLoadOlder = handleLoadEarlier
    // Also expose the media-load handler so tests can fire a media batch (image decode) without a
    // real <img> onLoad, which is timing- and approval-gated and not reproducible headless.
    devWindow.__fluuxTriggerMediaLoad = handleMediaLoad
    return () => {
      if (devWindow.__fluuxTriggerLoadOlder === handleLoadEarlier) {
        delete devWindow.__fluuxTriggerLoadOlder
      }
      if (devWindow.__fluuxTriggerMediaLoad === handleMediaLoad) {
        delete devWindow.__fluuxTriggerMediaLoad
      }
    }
  }, [handleLoadEarlier, handleMediaLoad])

  // --------------------------------------------------------------------------
  // VIEWPORT OBSERVER (tracks bottom-most visible message for lastSeenMessageId)
  // --------------------------------------------------------------------------

  useViewportObserver({
    scrollContainerRef,
    conversationId,
    onMessageSeen,
    enabled: !isLoading && messages.length > 0,
  })

  // --------------------------------------------------------------------------
  // COPY FORMATTING (ensures date is always included)
  // --------------------------------------------------------------------------

  // Store-backed copy is virtualized-only: when off-screen rows are unmounted, a
  // spanning selection is reconstructed from `deduplicatedMessages` via the caller's
  // faithful formatter. Passing `undefined` on the flag-OFF path keeps the legacy
  // pure-DOM copy behavior byte-for-byte unchanged.
  useMessageCopyFormatter({
    containerRef: scrollContainerRef,
    messages: virtualized ? deduplicatedMessages : undefined,
    formatForCopy: virtualized ? formatMessageForCopy : undefined,
  })

  // Virtualization-friendly bulk copy: Cmd/Ctrl+A selects the whole loaded conversation,
  // Shift-click defines a range; copy reconstructs from the in-memory array via the caller's
  // formatter. Decoupled from DOM text selection (which can't span unmounted rows).
  const { copySelectedIds, selectionCount, copySelected, clearSelection } =
    useMessageRangeSelection({
      containerRef: scrollContainerRef,
      messages: deduplicatedMessages,
      formatForCopy: formatMessageForCopy,
      conversationId,
      enabled: !staticMode,
    })

  const rowClass = (id: string) =>
    copySelectedIds.has(id) ? 'message-row copy-selected' : 'message-row'

  // --------------------------------------------------------------------------
  // RENDER: Message list (always render scroll container to preserve position)
  // --------------------------------------------------------------------------

  // No mutable tracking needed — firstNewMessageId uniquely identifies one message

  // Detect Mac for keyboard shortcut display
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

  // renderItem: render one flattened item by kind (virtualized path). Faithful to the
  // legacy JSX so the only difference is windowing. NOT memoized — closes over the
  // current handlers/props.
  const renderItem = (item: RenderItem<T>): ReactNode => {
    switch (item.kind) {
      case 'header':
        return isHistoryComplete ? (
          <div data-row-kind="header">
            <HistoryStartMarker />
          </div>
        ) : onScrollToTop ? (
          <div data-row-kind="header" className="flex justify-center py-3">
            <button
              onClick={handleLoadEarlier}
              disabled={isLoadingOlder}
              className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-full transition-colors ${
                isLoadingOlder
                  ? 'text-fluux-muted cursor-wait'
                  : 'text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover'
              }`}
            >
              {isLoadingOlder ? <Loader2 className="size-4 animate-spin" /> : <ChevronUp className="size-4" />}
              {t('chat.loadEarlierMessages')}
            </button>
          </div>
        ) : null
      case 'date':
        return (
          <div data-row-kind="date" data-date-separator={item.date}>
            <DateSeparator date={item.date} />
          </div>
        )
      case 'message': {
        const msg = item.message
        return (
          <div
            className={rowClass(msg.id)}
            data-message-id={msg.id}
            data-stanza-id={msg.stanzaId}
            data-origin-id={msg.originId}
            style={msg.id === lastSentMessageId ? { animation: 'message-send var(--fluux-duration-slow) var(--fluux-ease-standard)' } : undefined}
          >
            {msg.id === gapMarkerMessageId && onCatchUpHistory && (
              <HistoryGapMarker onLoadMore={onCatchUpHistory} isLoading={isCatchingUp ?? false} />
            )}
            {item.isFirstNew && <NewMessageMarker provisional={firstNewMessageIsProvisional} />}
            {renderMessage(msg, item.indexInGroup, item.groupMessages, item.isFirstNew, handleMediaLoad)}
          </div>
        )
      }
      case 'footer':
        // Typing indicator is NOT rendered here — it floats over the list (see below). The footer's
        // padding grows to pb-12 (clears the pill's ~46px height) only while it's shown, and shrinks
        // back to pb-2 otherwise, so idle conversations don't carry the pill's clearance as dead
        // space. The grow edge is paired with a live-geometry-gated nudge in useMessageListScroll
        // (only when already at the bottom) so this never re-pins a reader scrolled up into history —
        // the #918 bug was a stale isAtBottomRef latch, not a reactive footer height per se.
        return (
          <div data-row-kind="footer">
            {extraContent}
            <div className={typingUsers.length > 0 ? 'pb-12' : 'pb-2'} />
          </div>
        )
    }
  }

  // Sliding window: when the window is slid up (not at the live edge) the FAB becomes "jump to
  // latest" — recenter the resident window to the newest slice, then scroll to the bottom. Shown
  // whenever the window is slid up (newer content exists off-screen), not only past the FAB threshold.
  const windowSlidUp = windowAtLiveEdge === false
  const fabVisible = showScrollToBottom || windowSlidUp
  // Track whether the FAB has ever been shown in this mount so the exit animation (whose first
  // keyframe is fully-visible) never runs on a fresh open-at-bottom, which would flash the FAB.
  // MessageList is remounted per conversation via `key`, so this ref resets on every open.
  const hasFabBeenVisibleRef = useRef(false)
  if (fabVisible) hasFabBeenVisibleRef.current = true
  const handleJumpToBottom = () => {
    if (windowSlidUp && onJumpToLatest) {
      // Recenter the resident window to the newest slice, then scroll to the bottom. If the
      // recenter rejects, still scroll to the current resident bottom rather than doing nothing.
      Promise.resolve(onJumpToLatest())
        .then(() => scrollToBottom())
        .catch(() => scrollToBottom())
    } else {
      scrollToBottom()
    }
  }

  return (
    <MessageWidthProvider containerRef={scrollContainerRef}>
    <OwnGroupWidthProvider>
    <div className="relative flex-1 flex flex-col min-h-0">
      {/* Scrollable message container - always mounted to preserve scroll position */}
      <div
        ref={setScrollContainerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4 pb-0 overscroll-contain"
        style={{ overflowAnchor: 'auto' }}
        data-message-list
      >
        {/* Loading state */}
        {showLoading && loadingState}

        {/* Empty state */}
        {showEmpty && (
          emptyState || (
            <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted h-full gap-3">
              <div className="size-16 rounded-full bg-fluux-brand/10 border border-fluux-brand/25 flex items-center justify-center">
                <MessageCircle className="size-7 text-fluux-brand" />
              </div>
              <p className="text-sm">{t('chat.noMessages')}</p>
            </div>
          )
        )}

        {/* Content wrapper for resize observation - only render when we have messages */}
        {hasContent && (virtualized ? (
        /* Virtualized: the wrapper is the spacer; only the visible window mounts. */
        <div
          ref={contentWrapperRef}
          data-virtualizer-spacer
          style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
        >
          {virtualizer.getVirtualItems().map((v) => (
            <div
              key={virtualItems[v.index].key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              // `top` (not transform) so each row's offsetTop reflects its real position —
              // the scroll hook's offset math (anchor/jump/restore) depends on offsetTop.
              style={{ position: 'absolute', top: v.start, left: 0, width: '100%' }}
            >
              {renderItem(virtualItems[v.index])}
            </div>
          ))}
        </div>
        ) : (
        <div ref={contentWrapperRef}>
          {/* History start marker - shown when all server history has been loaded */}
          {isHistoryComplete && <HistoryStartMarker />}

          {/* Load earlier messages button - shown when more history available */}
          {!isHistoryComplete && onScrollToTop && (
            <div className="flex justify-center py-3">
              <button
                onClick={handleLoadEarlier}
                disabled={isLoadingOlder}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-full transition-colors ${
                  isLoadingOlder
                    ? 'text-fluux-muted cursor-wait'
                    : 'text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover'
                }`}
              >
                {isLoadingOlder ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ChevronUp className="size-4" />
                )}
                {t('chat.loadEarlierMessages')}
              </button>
            </div>
          )}

          {/* Messages grouped by date */}
          {groupedMessages.map((group, groupIndex) => (
            <div key={`${group.date}-${groupIndex}`}>
              <div data-date-separator={group.date}>
                <DateSeparator date={group.date} />
              </div>
              {group.messages.map((msg, idx) => {
                const showNewMarker = firstNewMessageId === msg.id

                // Show gap marker at the boundary where the forward catch-up stopped.
                // The marker appears before the first message whose timestamp exceeds
                // the gap boundary, signaling that messages between the two may be missing.
                const showGapMarker = !!(
                  forwardGapTimestamp &&
                  onCatchUpHistory &&
                  msg.timestamp.getTime() > forwardGapTimestamp &&
                  (idx === 0
                    ? (groupIndex === 0 || (groupedMessages[groupIndex - 1]?.messages.at(-1)?.timestamp.getTime() ?? 0) <= forwardGapTimestamp)
                    : group.messages[idx - 1].timestamp.getTime() <= forwardGapTimestamp)
                )

                // `key={undefined}` counts as a MISSING key for React (it warns
                // and falls back to positional reconciliation), so an id-less
                // message needs another stable identifier.
                const rowKey = msg.id || msg.stanzaId || msg.originId || `${group.date}-pos-${idx}`

                return (
                  <div
                    key={rowKey}
                    className={rowClass(msg.id)}
                    data-message-id={msg.id}
                    data-stanza-id={msg.stanzaId}
                    data-origin-id={msg.originId}
                    style={msg.id === lastSentMessageId ? { animation: 'message-send var(--fluux-duration-slow) var(--fluux-ease-standard)' } : undefined}
                  >
                    {showGapMarker && <HistoryGapMarker onLoadMore={onCatchUpHistory} isLoading={isCatchingUp ?? false} />}
                    {showNewMarker && <NewMessageMarker provisional={firstNewMessageIsProvisional} />}
                    {renderMessage(msg, idx, group.messages, showNewMarker, handleMediaLoad)}
                  </div>
                )
              })}
            </div>
          ))}

          {/* Extra content after messages */}
          {extraContent}

          {/* Bottom breathing room. The typing indicator floats over the list (see below) rather
              than living here. The padding grows to pb-12 (clears the pill) only while it's shown
              and shrinks back to pb-2 otherwise — see the footer render case above for the safety
              rationale (live-geometry-gated nudge, never re-pins a reader scrolled up). */}
          <div className={typingUsers.length > 0 ? 'pb-12' : 'pb-2'} />
        </div>
        ))}
      </div>

      {/* Floating date pill — appears while scrolling the virtualized list */}
      {virtualized && hasContent && (
        <FloatingDateHeader scrollerRef={scrollContainerRef} getTopDate={getTopDate} />
      )}

      {/* Jump-to-last-read pill — shown while the "New messages" divider sits above the viewport */}
      <JumpToLastReadPill
        visible={!!firstNewMessageId && markerAboveViewport}
        count={markerUnreadCount}
        onJump={scrollToMarker}
      />

      {/* Floating typing indicator — anchored to the bottom of the message area rather than living
          inside the scroll content, so it (a) stays visible whether the user is at the bottom or
          scrolled up in history, and (b) never changes the scroll height (toggling it inline used to
          re-pin the viewport and fight an upward scroll — issue #918). Bottom-start keeps it clear of
          the bottom-end FAB; pointer-events-none so it never intercepts taps on the message beneath. */}
      {typingUsers.length > 0 && (
        <div className="absolute bottom-4 start-4 z-30 max-w-[calc(100%-5rem)] pointer-events-none animate-toast-in">
          <div className="rounded-full bg-fluux-float border border-fluux-border shadow-lg px-3 py-1.5">
            <TypingIndicator typingUsers={typingUsers} formatUser={formatTypingUser} variant="compact" />
          </div>
        </div>
      )}

      {/* Scroll to bottom FAB with spring animation */}
      <div
        className={`absolute bottom-4 end-4 z-40 ${fabAnimationClass(fabVisible, hasFabBeenVisibleRef.current)}`}
        inert={!fabVisible}
      >
        <Tooltip content={t('chat.scrollToBottom') + ` (${isMac ? '⌘↓' : 'Ctrl+↓'})`} position="left">
          <button
            onClick={handleJumpToBottom}
            data-fab="scroll-to-bottom"
            className="size-10 rounded-full bg-fluux-float border border-fluux-border shadow-lg flex items-center justify-center text-fluux-muted hover:text-fluux-text hover:bg-fluux-float-hover transition-colors duration-200 hover:scale-105 active:scale-95"
            aria-label={t('chat.scrollToBottom')}
            tabIndex={fabVisible ? 0 : -1}
          >
            {markerUnreadCount > 0 && (
              <span className="absolute -top-1.5 -end-1.5 min-w-5 h-5 px-1 rounded-full bg-fluux-badge text-fluux-badge-text text-xs font-semibold flex items-center justify-center">
                {markerUnreadCount > 99 ? '99+' : markerUnreadCount}
              </span>
            )}
            <ChevronDown className="size-5" />
          </button>
        </Tooltip>
      </div>
      <MessageSelectionBar count={selectionCount} onCopy={copySelected} onClear={clearSelection} />
    </div>
    </OwnGroupWidthProvider>
    </MessageWidthProvider>
  )
}
