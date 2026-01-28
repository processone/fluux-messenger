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
import { useNewMessageMarker, useMessageCopyFormatter } from '@/hooks'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { DateSeparator } from './DateSeparator'
import { NewMessageMarker } from './NewMessageMarker'
import { HistoryStartMarker } from './HistoryStartMarker'
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
  /** Callback to clear the first new message ID */
  clearFirstNewMessageId: () => void
  /** Users currently typing */
  typingUsers?: string[]
  /** Format function for typing user display */
  formatTypingUser?: (user: string) => string
  /** Render function for each message */
  renderMessage: (message: T, index: number, groupMessages: T[], showNewMarker: boolean) => ReactNode
  /** Extra content to render after all messages */
  extraContent?: ReactNode
  /** Content to show when messages array is empty */
  emptyState?: ReactNode
  /** If true, show a placeholder while loading */
  isLoading?: boolean
  /** Content to show while loading */
  loadingState?: ReactNode
  /** Ref to the scroll container element (for keyboard navigation) */
  scrollerRef?: React.RefObject<HTMLElement>
  /** Ref to track if scroll is at bottom (shared with keyboard navigation) */
  isAtBottomRef?: React.MutableRefObject<boolean>
  /** Callback when user scrolls to top (for lazy loading older messages) */
  onScrollToTop?: () => void
  /** If true, show loading indicator at top while fetching older messages */
  isLoadingOlder?: boolean
  /** If true, all history has been fetched - disable scroll-to-top trigger */
  isHistoryComplete?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export function MessageList<T extends BaseMessage>({
  messages,
  conversationId,
  firstNewMessageId,
  clearFirstNewMessageId,
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
}: MessageListProps<T>) {
  // Detect render loops before they freeze the UI
  detectRenderLoop('MessageList')

  const { t } = useTranslation()

  // --------------------------------------------------------------------------
  // MESSAGE PROCESSING
  // --------------------------------------------------------------------------

  // Deduplicate messages by ID (safety net for any race conditions in store)
  const deduplicatedMessages = useMemo(() => {
    const seen = new Set<string>()
    return messages.filter((msg) => {
      if (seen.has(msg.id)) {
        return false
      }
      seen.add(msg.id)
      return true
    })
  }, [messages])

  // Group messages by date for rendering with separators
  const groupedMessages = useMemo(
    () => groupMessagesByDate(deduplicatedMessages),
    [deduplicatedMessages]
  )

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
    scrollToBottom,
    showScrollToBottom,
  } = useMessageListScroll({
    conversationId,
    messageCount: messages.length,
    firstMessageId,
    externalScrollerRef,
    externalIsAtBottomRef,
    onScrollToTop,
    isLoadingOlder,
    isHistoryComplete,
    typingUsersCount: typingUsers.length,
    lastMessageReactionsKey,
  })

  // Combined ref setter for scroll container
  const setScrollContainerRef = (element: HTMLDivElement | null) => {
    (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = element
    setScrollContainerRefFromHook(element)
  }

  // --------------------------------------------------------------------------
  // COPY FORMATTING (ensures date is always included)
  // --------------------------------------------------------------------------

  useMessageCopyFormatter({ containerRef: scrollContainerRef })

  // --------------------------------------------------------------------------
  // NEW MESSAGE MARKER
  // --------------------------------------------------------------------------

  // Clear the new message marker 1 second after switching away
  useNewMessageMarker(conversationId, firstNewMessageId, clearFirstNewMessageId)

  // --------------------------------------------------------------------------
  // RENDER: Message list (always render scroll container to preserve position)
  // --------------------------------------------------------------------------

  // Track whether we've shown the new message marker
  let shownNewMarker = false

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
                const showNewMarker = !shownNewMarker && firstNewMessageId === msg.id
                if (showNewMarker) shownNewMarker = true

                return (
                  <div key={msg.id} data-message-id={msg.id}>
                    {showNewMarker && <NewMessageMarker />}
                    {renderMessage(msg, idx, group.messages, showNewMarker)}
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

      {/* Scroll to bottom FAB */}
      {showScrollToBottom && (
        <Tooltip content={t('chat.scrollToBottom') + ` (${isMac ? '⌘↓' : 'Ctrl+↓'})`} position="left">
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-40 w-10 h-10 rounded-full bg-fluux-bg border border-fluux-border shadow-lg flex items-center justify-center text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover transition-all duration-200 hover:scale-105 active:scale-95"
            aria-label={t('chat.scrollToBottom')}
          >
            <ChevronDown className="w-5 h-5" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
