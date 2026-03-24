/**
 * SearchContextView - Read-only message context view for search results.
 *
 * When a search result is clicked, this component renders in the main content
 * area showing the conversation's messages centered on the matched message.
 * The message list is read-only (no composer, no toolbar actions).
 *
 * The user can navigate to the real conversation via:
 * - A "Go to message" button in the header
 * - Clicking the highlighted message itself
 */
import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useSearch,
  getMessages,
  getRoomMessages,
  createMessageLookup,
  getBareJid,
  getLocalPart,
  useContactIdentities,
  type Message,
  type RoomMessage,
  type BaseMessage,
  type ContactIdentity,
} from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { MessageBubble, MessageList, shouldShowAvatar, buildReplyContext } from './conversation'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useWindowDrag, useTimeFormat, useMode } from '@/hooks'
import { getConsistentTextColor } from './Avatar'
import { ArrowLeft, ExternalLink, Search } from 'lucide-react'

/** Number of messages to load on each side of the target */
const CONTEXT_BATCH_SIZE = 50

export function SearchContextView({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation()
  const { query, previewResult, setPreviewResult } = useSearch()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const { titleBarClass, dragRegionProps } = useWindowDrag()
  const { resolvedMode } = useMode()
  const isDarkMode = resolvedMode === 'dark'

  // Extract search terms for highlighting in message bodies
  const highlightTerms = query
    ? query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2)
    : []

  // Connection state for own messages
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const myBareJid = jid?.split('/')[0]

  // Contact identities for sender resolution
  const contactsByJid = useContactIdentities()

  // Message state (loaded from IndexedDB cache, not from stores)
  const [messages, setMessages] = useState<(Message | RoomMessage)[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [isHistoryComplete, setIsHistoryComplete] = useState(false)

  // Scroll refs
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(false)

  // Track the current preview to detect changes
  const prevPreviewRef = useRef<string | null>(null)

  // Load messages centered on the target
  useEffect(() => {
    if (!previewResult) {
      setMessages([])
      setIsLoading(false)
      return
    }

    const previewKey = `${previewResult.conversationId}:${previewResult.messageId}`
    if (prevPreviewRef.current === previewKey) return
    prevPreviewRef.current = previewKey

    setIsLoading(true)
    setIsHistoryComplete(false)

    const targetDate = new Date(previewResult.timestamp)

    const loadMessages = async () => {
      try {
        let before: (Message | RoomMessage)[]
        let after: (Message | RoomMessage)[]

        if (previewResult.isRoom) {
          before = await getRoomMessages(previewResult.conversationId, {
            before: targetDate,
            limit: CONTEXT_BATCH_SIZE,
          })
          after = await getRoomMessages(previewResult.conversationId, {
            after: new Date(targetDate.getTime() - 1),
            limit: CONTEXT_BATCH_SIZE,
          })
        } else {
          before = await getMessages(previewResult.conversationId, {
            before: targetDate,
            limit: CONTEXT_BATCH_SIZE,
          })
          after = await getMessages(previewResult.conversationId, {
            after: new Date(targetDate.getTime() - 1),
            limit: CONTEXT_BATCH_SIZE,
          })
        }

        // Merge and deduplicate by message ID
        const seen = new Set<string>()
        const merged: (Message | RoomMessage)[] = []
        for (const msg of [...before, ...after]) {
          if (!seen.has(msg.id)) {
            seen.add(msg.id)
            merged.push(msg)
          }
        }

        // Sort by timestamp
        merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

        setMessages(merged)
        setIsHistoryComplete(before.length < CONTEXT_BATCH_SIZE)
      } catch (err) {
        console.warn('Failed to load search context messages:', err)
        setMessages([])
      } finally {
        setIsLoading(false)
      }
    }

    void loadMessages()
  }, [previewResult])

  // Apply persistent highlight after the MessageList's targetMessageId scroll completes
  useEffect(() => {
    if (!previewResult || isLoading || messages.length === 0) return

    // Wait for useMessageListScroll's target scroll (rAF + 150ms) to finish,
    // then replace the fading highlight with a persistent one
    const timer = setTimeout(() => {
      const escapedId = CSS.escape(previewResult.messageId)
      const el = document.querySelector(`[data-message-id="${escapedId}"]`)
      if (el) {
        el.classList.remove('message-highlight')
        el.classList.add('message-highlight-persistent')
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [previewResult, isLoading, messages.length])

  // Load older messages on scroll to top
  const handleScrollToTop = useCallback(async () => {
    if (!previewResult || isLoadingOlder || isHistoryComplete || messages.length === 0) return

    setIsLoadingOlder(true)
    try {
      const oldestTimestamp = messages[0].timestamp
      let older: (Message | RoomMessage)[]

      if (previewResult.isRoom) {
        older = await getRoomMessages(previewResult.conversationId, {
          before: oldestTimestamp,
          limit: CONTEXT_BATCH_SIZE,
        })
      } else {
        older = await getMessages(previewResult.conversationId, {
          before: oldestTimestamp,
          limit: CONTEXT_BATCH_SIZE,
        })
      }

      if (older.length < CONTEXT_BATCH_SIZE) {
        setIsHistoryComplete(true)
      }

      if (older.length > 0) {
        setMessages((prev) => [...older, ...prev])
      }
    } catch (err) {
      console.warn('Failed to load older messages:', err)
    } finally {
      setIsLoadingOlder(false)
    }
  }, [previewResult, isLoadingOlder, isHistoryComplete, messages])

  // Navigate to the real conversation
  const handleGoToMessage = useCallback(() => {
    if (!previewResult) return
    setPreviewResult(null)
    if (previewResult.isRoom) {
      navigateToRoom(previewResult.conversationId, previewResult.messageId)
    } else {
      navigateToConversation(previewResult.conversationId, previewResult.messageId)
    }
  }, [previewResult, setPreviewResult, navigateToConversation, navigateToRoom])

  // Handle click on the highlighted message
  const handleHighlightedMessageClick = useCallback(() => {
    handleGoToMessage()
  }, [handleGoToMessage])

  // Handle back / close
  const handleBack = useCallback(() => {
    setPreviewResult(null)
    onBack?.()
  }, [setPreviewResult, onBack])

  if (!previewResult) return null

  // Resolve conversation name
  const conversationName = previewResult.conversationName

  return (
    <div className="flex flex-col h-full bg-fluux-surface/50">
      {/* Header */}
      <header className={`h-14 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3`} {...dragRegionProps}>
        {/* Back button - mobile */}
        {onBack && (
          <button
            onClick={handleBack}
            className="p-1 -ml-1 rounded hover:bg-fluux-hover md:hidden"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft className="w-5 h-5 text-fluux-muted" />
          </button>
        )}

        {/* Search icon */}
        <div className="w-9 h-9 bg-fluux-bg rounded-full flex items-center justify-center flex-shrink-0">
          <Search className="w-5 h-5 text-fluux-muted" />
        </div>

        {/* Conversation info */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fluux-text truncate">
            {conversationName}
          </div>
          <div className="text-xs text-fluux-muted">
            {t('search.contextView', 'Search result')}
          </div>
        </div>

      </header>

      {/* Message list (read-only) */}
      <div className="flex-1 flex flex-col min-h-0 p-1">
        <SearchContextMessageList
          messages={messages}
          conversationId={`search-preview:${previewResult.conversationId}`}
          isRoom={previewResult.isRoom}
          highlightedMessageId={previewResult.messageId}
          onHighlightedClick={handleHighlightedMessageClick}
          contactsByJid={contactsByJid}
          myBareJid={myBareJid}
          ownAvatar={ownAvatar}
          ownNickname={ownNickname}
          isDarkMode={isDarkMode}
          highlightTerms={highlightTerms}
          scrollerRef={scrollRef}
          isAtBottomRef={isAtBottomRef}
          targetMessageId={previewResult.messageId}
          onScrollToTop={handleScrollToTop}
          isLoadingOlder={isLoadingOlder}
          isHistoryComplete={isHistoryComplete}
          isLoading={isLoading}
        />
      </div>

      {/* Bottom banner — search preview indicator with Go to message action */}
      <div className="p-3 border-t border-fluux-hover flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fluux-muted">
          <Search className="w-4 h-4" />
          <span className="text-sm">{t('search.previewBanner', 'You are viewing a search result preview')}</span>
        </div>
        <button
          onClick={handleGoToMessage}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md
                     bg-fluux-brand/10 text-fluux-brand hover:bg-fluux-brand/20 transition-colors flex-shrink-0"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          {t('search.goToMessage', 'Go to message')}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// SearchContextMessageList — read-only message list
// ============================================================================

const SearchContextMessageList = memo(function SearchContextMessageList({
  messages,
  conversationId,
  isRoom,
  highlightedMessageId,
  onHighlightedClick,
  contactsByJid,
  myBareJid,
  ownAvatar,
  ownNickname,
  isDarkMode,
  highlightTerms,
  scrollerRef,
  isAtBottomRef,
  targetMessageId,
  onScrollToTop,
  isLoadingOlder,
  isHistoryComplete,
  isLoading,
}: {
  messages: (Message | RoomMessage)[]
  conversationId: string
  isRoom: boolean
  highlightedMessageId: string
  onHighlightedClick: () => void
  contactsByJid: Map<string, ContactIdentity>
  myBareJid?: string
  ownAvatar?: string | null
  ownNickname?: string | null
  isDarkMode?: boolean
  highlightTerms?: string[]
  scrollerRef: React.RefObject<HTMLElement | null>
  isAtBottomRef: React.MutableRefObject<boolean>
  targetMessageId?: string | null
  onScrollToTop?: () => void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
  isLoading?: boolean
}) {
  const { t } = useTranslation()
  const { formatTime, effectiveTimeFormat } = useTimeFormat()

  // Build message lookup for reply context
  const messagesById = createMessageLookup(messages as BaseMessage[])

  // No-op handlers for read-only mode
  const noop = () => {}
  const noopAsync = async () => {}

  // Render function for messages
  const renderMessage = (msg: Message | RoomMessage, idx: number, groupMessages: (Message | RoomMessage)[], _showNewMarker: boolean, onMediaLoad: () => void) => {
    const isHighlighted = msg.id === highlightedMessageId

    // Resolve sender info
    let senderName: string
    let senderColor: string
    let avatarUrl: string | undefined
    let avatarIdentifier: string
    let senderJid: string | undefined

    if (isRoom && msg.type === 'groupchat') {
      const roomMsg = msg as RoomMessage
      senderName = roomMsg.nick
      avatarIdentifier = `${roomMsg.roomJid}/${roomMsg.nick}`
      senderColor = getConsistentTextColor(avatarIdentifier, isDarkMode)

      // Check if it's own message
      if (roomMsg.isOutgoing) {
        senderName = ownNickname || roomMsg.nick
        senderColor = 'var(--fluux-green)'
        avatarUrl = ownAvatar || undefined
      }
    } else {
      const contact = contactsByJid.get(msg.from.split('/')[0])
      senderName = msg.isOutgoing
        ? (ownNickname || msg.from.split('@')[0])
        : (contact?.name || msg.from.split('@')[0])
      senderColor = msg.isOutgoing
        ? 'var(--fluux-green)'
        : contact
          ? (isDarkMode ? contact.colorDark : contact.colorLight) || getConsistentTextColor(msg.from.split('/')[0], isDarkMode)
          : getConsistentTextColor(msg.from.split('/')[0], isDarkMode)
      avatarUrl = msg.isOutgoing ? (ownAvatar || undefined) : contact?.avatar
      avatarIdentifier = msg.from.split('/')[0]
      senderJid = msg.from.split('/')[0]
    }

    // Build reply context
    const replyContext = buildReplyContext(
      msg,
      messagesById,
      (originalMsg, fallbackId) => {
        if (originalMsg?.isOutgoing) return ownNickname || originalMsg.from.split('@')[0]
        if (isRoom && originalMsg?.type === 'groupchat') return (originalMsg as RoomMessage).nick
        if (originalMsg) return contactsByJid.get(originalMsg.from.split('/')[0])?.name || originalMsg.from.split('@')[0]
        return fallbackId ? fallbackId.split('@')[0] : 'Unknown'
      },
      (originalMsg, fallbackId, dark) => {
        if (originalMsg?.isOutgoing) return 'var(--fluux-green)'
        const senderId = originalMsg?.from.split('/')[0] || fallbackId?.split('/')[0]
        if (!senderId) return 'var(--fluux-brand)'
        const contact = contactsByJid.get(senderId)
        if (contact) return (dark ? contact.colorDark : contact.colorLight) || getConsistentTextColor(senderId, dark)
        return getConsistentTextColor(senderId, dark)
      },
      (originalMsg, fallbackId) => {
        const senderId = originalMsg?.from.split('/')[0] || fallbackId?.split('/')[0]
        if (senderId === myBareJid) {
          return { avatarUrl: ownAvatar || undefined, avatarIdentifier: senderId || 'unknown' }
        }
        const contact = senderId ? contactsByJid.get(senderId) : undefined
        return { avatarUrl: contact?.avatar, avatarIdentifier: senderId || 'unknown' }
      },
      isDarkMode
    )

    // Get my current reactions
    const myReactions = (() => {
      if (!msg.reactions || !myBareJid) return []
      return Object.entries(msg.reactions)
        .filter(([, reactors]) => reactors.includes(myBareJid))
        .map(([emoji]) => emoji)
    })()

    const getReactorName = (reactor: string) => {
      const bareJid = getBareJid(reactor)
      if (bareJid === myBareJid) return t('chat.you')
      return contactsByJid.get(bareJid)?.name || getLocalPart(reactor)
    }

    return (
      <div
        key={msg.id}
        onClick={isHighlighted ? onHighlightedClick : undefined}
        className={isHighlighted ? 'cursor-pointer' : undefined}
      >
        <MessageBubble
          message={msg}
          showAvatar={shouldShowAvatar(groupMessages, idx)}
          isLastOutgoing={false}
          isLastMessage={false}
          hideToolbar
          senderName={senderName}
          senderColor={senderColor}
          avatarUrl={avatarUrl}
          avatarIdentifier={avatarIdentifier || msg.from}
          senderJid={senderJid}
          myReactions={myReactions}
          getReactorName={getReactorName}
          onReply={noop}
          onEdit={noop}
          onDelete={noopAsync}
          onMediaLoad={onMediaLoad}
          isDarkMode={isDarkMode}
          replyContext={replyContext}
          formatTime={formatTime}
          timeFormat={effectiveTimeFormat}
          highlightTerms={highlightTerms}
        />
      </div>
    )
  }

  return (
    <MessageList
      messages={messages}
      conversationId={conversationId}
      scrollerRef={scrollerRef}
      isAtBottomRef={isAtBottomRef}
      targetMessageId={targetMessageId}
      onScrollToTop={onScrollToTop}
      isLoadingOlder={isLoadingOlder}
      isHistoryComplete={isHistoryComplete}
      isLoading={isLoading}
      renderMessage={renderMessage}
      loadingState={
        <div className="flex-1 flex items-center justify-center text-fluux-muted">
          <div className="flex items-center gap-2">
            <Search className="w-5 h-5 animate-pulse" />
            <span>{t('search.loadingContext', 'Loading messages…')}</span>
          </div>
        </div>
      }
    />
  )
})
