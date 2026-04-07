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
import { useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BaseMessage } from '@fluux/sdk'
import { useMessageCopyFormatter } from '@/hooks'
import { useViewportObserver } from '@/hooks/useViewportObserver'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { DateSeparator } from './DateSeparator'
import { NewMessageMarker } from './NewMessageMarker'
import { HistoryStartMarker } from './HistoryStartMarker'
import { HistoryGapMarker } from './HistoryGapMarker'
import { TypingIndicator } from './TypingIndicator'
import { groupMessagesByDate } from './messageGrouping'
import { useMessageListScroll } from './useMessageListScroll'
import { Loader2, ChevronUp, ChevronDown } from 'lucide-react'
import { Tooltip } from '../Tooltip'

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
}: MessageListProps<T>) {
  // Detect render loops before they freeze the UI
  detectRenderLoop('MessageList')

  const { t } = useTranslation()

  // --------------------------------------------------------------------------
  // MESSAGE PROCESSING
  // --------------------------------------------------------------------------

  // Deduplicate messages by ID (safety net for any race conditions in store)
  const deduplicatedMessages = (() => {
    const seen = new Set<string>()
    return messages.filter((msg) => {
      if (seen.has(msg.id)) {
        return false
      }
      seen.add(msg.id)
      return true
    })
  })()

  // Derive badge count from the marker position so FAB badge and marker are
  // always consistent. The store's unreadCount is 0 for active conversations.
  const markerUnreadCount = useMemo(() => {
    if (!firstNewMessageId) return 0
    const idx = deduplicatedMessages.findIndex((m) => m.id === firstNewMessageId)
    if (idx === -1) return 0
    return deduplicatedMessages.length - idx
  }, [firstNewMessageId, deduplicatedMessages])

  // Group messages by date for rendering with separators
  const groupedMessages = groupMessagesByDate(deduplicatedMessages)

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
    staticMode,
  })

  // Combined ref setter for scroll container
  const setScrollContainerRef = (element: HTMLDivElement | null) => {
    (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = element
    setScrollContainerRefFromHook(element)
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

  useMessageCopyFormatter({ containerRef: scrollContainerRef })

  // --------------------------------------------------------------------------
  // RENDER: Message list (always render scroll container to preserve position)
  // --------------------------------------------------------------------------

  // No mutable tracking needed — firstNewMessageId uniquely identifies one message

  // Detect Mac for keyboard shortcut display
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

  // Determine what content to show inside the scroll container
  const showLoading = isLoading && loadingState
  const showEmpty = !showLoading && messages.length === 0

  return (
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
            <div className="flex-1 flex items-center justify-center text-fluux-muted h-full">
              <p>{t('chat.noMessages')}</p>
            </div>
          )
        )}

        {/* Content wrapper for resize observation - only render when we have messages */}
        {!showLoading && !showEmpty && (
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
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ChevronUp className="w-4 h-4" />
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

                return (
                  <div
                    key={msg.id}
                    data-message-id={msg.id}
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
        )}
      </div>

      {/* Scroll to bottom FAB with spring animation */}
      <div
        className={`absolute bottom-4 end-4 z-40 ${
          showScrollToBottom
            ? 'animate-[fab-spring-in_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]'
            : 'animate-[fab-spring-out_0.25s_ease-in_forwards] pointer-events-none'
        }`}
        aria-hidden={!showScrollToBottom}
      >
        <Tooltip content={t('chat.scrollToBottom') + ` (${isMac ? '⌘↓' : 'Ctrl+↓'})`} position="left">
          <button
            onClick={scrollToBottom}
            className="w-10 h-10 rounded-full bg-fluux-bg border border-fluux-border shadow-lg flex items-center justify-center text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover transition-colors duration-200 hover:scale-105 active:scale-95"
            aria-label={t('chat.scrollToBottom')}
            tabIndex={showScrollToBottom ? 0 : -1}
          >
            {markerUnreadCount > 0 && (
              <span className="absolute -top-1.5 -end-1.5 min-w-5 h-5 px-1 rounded-full bg-fluux-red text-white text-xs font-semibold flex items-center justify-center">
                {markerUnreadCount > 99 ? '99+' : markerUnreadCount}
              </span>
            )}
            <ChevronDown className="w-5 h-5" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
