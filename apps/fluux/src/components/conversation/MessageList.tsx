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
import { useMemo, useRef, useEffect, useCallback, type ReactNode } from 'react'
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
import { isFeatureEnabled } from '@/utils/featureFlags'
import { useSettingsStore } from '@/stores/settingsStore'
import type { CopyMessageMeta } from '@/utils/buildCopyText'
import { buildMessageListItems, type RenderItem } from './messageListItems'
import { useTanstackMessageVirtualizer } from './tanstackMessageVirtualizer'
import { useRowMetrics } from './useRowMetrics'
import { estimateRowHeight } from './rowHeightEstimator'
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
  /** If true, show loading indicator at top while fetching older messages */
  isLoadingOlder?: boolean
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
  isLoadingOlder,
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

  // Per-index estimate: drives the virtualizer's initial size guess so prepend-restore lands
  // accurately instead of snapping. Only used when virtualized (passed unconditionally since the
  // adapter is always constructed; the non-virtualized path ignores it).
  const estimateSize = useCallback(
    (index: number) => estimateRowHeight(virtualItems[index], rowMetricsRef.current),
    [virtualItems, rowMetricsRef],
  )

  const virtualizer = useTanstackMessageVirtualizer({ items: virtualItems, indexById, scrollRef: scrollContainerRef, estimateSize })
  const activeVirtualizer = virtualized ? virtualizer : undefined

  // Dev-only: expose virtualizer offset lookup for Playwright test assertions (invariant-1).
  // Allows tests to check anchor position without requiring the row to be in the DOM window.
  if (import.meta.env.DEV && activeVirtualizer) {
    ;(window as unknown as Record<string, unknown>).__fluuxGetVirtOffset =
      (id: string) => activeVirtualizer.getOffsetForMessageId(id)
  }

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
    isLoadingOlder,
    isHistoryComplete,
    typingUsersCount: typingUsers.length,
    lastMessageReactionsKey,
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

  // Dev-only: expose the full load-earlier trigger (saves anchor + calls onScrollToTop)
  // so tests can fire it without scrolling to 0, which would change findAnchorElement's
  // anchor to firstMessageId instead of the actual top-visible message at that scrollTop.
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__fluuxTriggerLoadOlder = handleLoadEarlier
  }

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
            style={msg.id === lastSentMessageId ? { animation: 'message-send 300ms ease-out' } : undefined}
          >
            {msg.id === gapMarkerMessageId && onCatchUpHistory && (
              <HistoryGapMarker onLoadMore={onCatchUpHistory} isLoading={isCatchingUp ?? false} />
            )}
            {item.isFirstNew && <NewMessageMarker />}
            {renderMessage(msg, item.indexInGroup, item.groupMessages, item.isFirstNew, handleMediaLoad)}
          </div>
        )
      }
      case 'footer':
        return (
          <div data-row-kind="footer">
            {extraContent}
            <div className="pb-4">
              {typingUsers.length > 0 && (
                <TypingIndicator typingUsers={typingUsers} formatUser={formatTypingUser} />
              )}
            </div>
          </div>
        )
    }
  }

  return (
    <MessageWidthProvider containerRef={scrollContainerRef}>
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
                    style={msg.id === lastSentMessageId ? { animation: 'message-send 300ms ease-out' } : undefined}
                  >
                    {showGapMarker && <HistoryGapMarker onLoadMore={onCatchUpHistory} isLoading={isCatchingUp ?? false} />}
                    {showNewMarker && <NewMessageMarker />}
                    {renderMessage(msg, idx, group.messages, showNewMarker, handleMediaLoad)}
                  </div>
                )
              })}
            </div>
          ))}

          {/* Extra content after messages */}
          {extraContent}

          {/* Typing indicator */}
          <div className="pb-4">
            {typingUsers.length > 0 && (
              <TypingIndicator typingUsers={typingUsers} formatUser={formatTypingUser} />
            )}
          </div>
        </div>
        ))}
      </div>

      {/* Scroll to bottom FAB with spring animation */}
      <div
        className={`absolute bottom-4 end-4 z-40 ${
          showScrollToBottom
            ? 'animate-[fab-spring-in_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]'
            : 'animate-[fab-spring-out_0.25s_ease-in_forwards] pointer-events-none'
        }`}
        inert={!showScrollToBottom}
      >
        <Tooltip content={t('chat.scrollToBottom') + ` (${isMac ? '⌘↓' : 'Ctrl+↓'})`} position="left">
          <button
            onClick={scrollToBottom}
            data-fab="scroll-to-bottom"
            className="size-10 rounded-full bg-fluux-float border border-fluux-border shadow-lg flex items-center justify-center text-fluux-muted hover:text-fluux-text hover:bg-fluux-float-hover transition-colors duration-200 hover:scale-105 active:scale-95"
            aria-label={t('chat.scrollToBottom')}
            tabIndex={showScrollToBottom ? 0 : -1}
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
    </MessageWidthProvider>
  )
}
