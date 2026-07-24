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
  createMessageLookup,
  getBareJid,
  getLocalPart,
  getMyReactions,
  useContactIdentities,
  type Message,
  type RoomMessage,
  type BaseMessage,
  type ContactIdentity,
} from '@fluux/sdk'
import { getMessages, getRoomMessages } from '@fluux/sdk/cache'
import { getSearchClient } from '@fluux/sdk/stores'
import { useConnectionStore, useRoomStore } from '@fluux/sdk/react'
import { MessageBubble, MessageList, shouldShowAvatar, buildReplyContext } from './conversation'
import { resolveRoomAvatar } from './conversation/roomSenderResolution'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useWindowDrag, useTimeFormat, useMode } from '@/hooks'
import { auroraSenderColor } from '@/utils/senderColor'
import { ArrowLeft, ExternalLink, Search } from 'lucide-react'

/** Number of messages to load on each side of the target */
const CONTEXT_BATCH_SIZE = 50

/**
 * Re-assert budget for the scroll-to-target loop (see the scroll effect below).
 * The target row and its neighbours size asynchronously (avatars, media, link
 * previews), so a single scroll lands off-position; we recompute across frames
 * until the landing point stops moving. ~1.5s at 60fps covers typical settling.
 */
const SCROLL_REASSERT_FRAMES = 90
/** Consecutive stable frames before we consider the target settled. */
const SCROLL_STABLE_FRAMES = 3
/** Landing-point drift (px) treated as "not moved" between frames. */
const SCROLL_DRIFT_PX = 2

export function SearchContextView({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation()
  const { query, previewResult, setPreviewResult } = useSearch()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const { dragRegionProps } = useWindowDrag()
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
  const myBareJid = jid ? getBareJid(jid) : undefined

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

        // If local cache has insufficient context for a MAM result, fetch from server
        const totalLocal = before.length + after.length
        if (previewResult.source === 'mam' && totalLocal < 5) {
          const client = getSearchClient()
          if (client) {
            try {
              const mamContext = await client.mam.fetchContext(
                previewResult.conversationId,
                previewResult.isRoom,
                targetDate.toISOString(),
                CONTEXT_BATCH_SIZE
              )
              // Use MAM results as the context
              before = mamContext.messages as (Message | RoomMessage)[]
              after = []

              // Trigger background catch-up to fill the gap (non-blocking)
              void client.mam.catchUpToTimestamp(
                previewResult.conversationId,
                previewResult.isRoom,
                targetDate.toISOString(),
              )
            } catch {
              // MAM fetch failed — use whatever local context we have
            }
          }
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

  // Scroll to the target message and apply persistent highlight.
  // We handle this here instead of passing targetMessageId to MessageList/useMessageListScroll
  // because the scroll hook's live-conversation behaviors (ResizeObserver auto-scroll,
  // new message scroll-to-bottom, scroll state persistence) interfere with the static preview.
  //
  // The target row and the rows above it size asynchronously (avatars, media, link previews),
  // so a single scroll computed from the first, unsettled layout lands the target off-position
  // — often well above the fold once the content grows. We therefore re-assert the position
  // across frames until the landing point stops moving (mirrors the live path's marker/pin
  // re-assert loops in useMessageListScroll), bailing the moment the user takes over.
  // Keyed on the TARGET (previewResult) + the initial load flag — NOT on messages.length.
  // loadMessages sets `messages` and clears `isLoading` in one batched update, so this fires
  // exactly once when the target's context is ready. Loading OLDER context on scroll-to-top
  // uses a separate `isLoadingOlder` flag, so paginating never re-triggers this — the loop must
  // not yank the user back to the target after they deliberately scrolled up.
  useEffect(() => {
    if (!previewResult || isLoading) return

    const scroller = scrollRef.current
    if (!scroller) return

    const escapedId = CSS.escape(previewResult.messageId)

    let raf = 0
    let framesLeft = SCROLL_REASSERT_FRAMES
    let stableFrames = 0
    let landed = -1
    let lastScrollHeight = -1
    let userTookOver = false

    // Any manual scroll gesture stops the loop so we never fight the user (e.g. once they
    // scroll up to read context). Programmatic scrollTop writes never fire these events;
    // covers wheel/trackpad, touch, and scrollbar drag.
    const onUserTakeover = () => { userTookOver = true }
    scroller.addEventListener('wheel', onUserTakeover, { passive: true })
    scroller.addEventListener('touchstart', onUserTakeover, { passive: true })
    scroller.addEventListener('mousedown', onUserTakeover, { passive: true })

    const step = () => {
      raf = 0
      if (userTookOver) return
      if (framesLeft-- <= 0) return

      const el = scroller.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null
      if (!el) {
        // Rows not mounted yet — keep waiting within the frame budget.
        raf = requestAnimationFrame(step)
        return
      }

      // Apply persistent highlight (no fade animation — this is a static preview).
      el.classList.add('message-highlight-persistent')

      // Position the target message ~1/3 down from the viewport top.
      const scrollerRect = scroller.getBoundingClientRect()
      const elementRect = el.getBoundingClientRect()
      const elementTop = elementRect.top - scrollerRect.top + scroller.scrollTop
      const desired = Math.max(0, elementTop - scroller.clientHeight / 3)
      scroller.scrollTop = desired

      // Converged once the landing point and content height both stop changing (rows have
      // finished measuring). Use the post-write scrollTop (the browser clamps near the end).
      const settledPos = landed >= 0 && Math.abs(scroller.scrollTop - landed) <= SCROLL_DRIFT_PX
      const settledHeight = scroller.scrollHeight === lastScrollHeight
      if (settledPos && settledHeight) {
        if (++stableFrames >= SCROLL_STABLE_FRAMES) return
      } else {
        stableFrames = 0
      }
      landed = scroller.scrollTop
      lastScrollHeight = scroller.scrollHeight
      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener('wheel', onUserTakeover)
      scroller.removeEventListener('touchstart', onUserTakeover)
      scroller.removeEventListener('mousedown', onUserTakeover)
      // Clean up highlight when switching results
      const el = scroller?.querySelector(`[data-message-id="${escapedId}"]`)
      el?.classList.remove('message-highlight-persistent')
    }
  }, [previewResult, isLoading])

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
      <header className="h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3" {...dragRegionProps}>
        {/* Back button - mobile */}
        {onBack && (
          <button
            type="button"
            onClick={handleBack}
            className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden tap-target"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
          </button>
        )}

        {/* Search icon */}
        <div className="size-9 bg-fluux-bg rounded-full flex items-center justify-center flex-shrink-0">
          <Search className="size-5 text-fluux-muted" />
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
          onScrollToTop={handleScrollToTop}
          isLoadingOlder={isLoadingOlder}
          isHistoryComplete={isHistoryComplete}
          isLoading={isLoading}
        />
      </div>

      {/* Bottom banner — search preview indicator with Go to message action */}
      <div className="p-3 border-t border-fluux-hover flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fluux-muted">
          <Search className="size-4" />
          <span className="text-sm">{t('search.previewBanner', 'You are viewing a search result preview')}</span>
        </div>
        <button
          type="button"
          onClick={handleGoToMessage}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md
                     bg-fluux-brand/10 text-fluux-brand hover:bg-fluux-brand/20 transition-colors flex-shrink-0"
        >
          <ExternalLink className="size-3.5" />
          {t('search.goToMessage', 'Go to message')}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// SearchContextMessageList — read-only message list
// ============================================================================

export const SearchContextMessageList = memo(function SearchContextMessageList({
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
  onScrollToTop?: () => void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
  isLoading?: boolean
}) {
  const { t } = useTranslation()
  const { formatTime, effectiveTimeFormat } = useTimeFormat()
  const roomJid = isRoom
    ? messages.find((message): message is RoomMessage => message.type === 'groupchat')?.roomJid
    : undefined
  const room = useRoomStore((state) => roomJid ? state.rooms.get(roomJid) : undefined)

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
      const avatar = room
        ? resolveRoomAvatar(
            { nick: roomMsg.nick, occupantId: roomMsg.occupantId, isOwn: roomMsg.isOutgoing },
            room,
            contactsByJid,
            ownAvatar,
          )
        : undefined
      const contact = avatar?.senderBareJid
        ? contactsByJid.get(avatar.senderBareJid)
        : undefined
      senderName = avatar?.matchedNick || contact?.name || roomMsg.nick
      avatarIdentifier = avatar?.avatarIdentifier
        || roomMsg.occupantId
        || `${roomMsg.roomJid}/${roomMsg.nick}`
      avatarUrl = avatar?.avatarUrl
      senderColor = auroraSenderColor(
        roomMsg.occupantId || avatar?.senderBareJid || roomMsg.nick,
        isDarkMode ?? true,
      )
      senderJid = avatar?.senderBareJid

      // Check if it's own message
      if (roomMsg.isOutgoing) {
        senderName = ownNickname || roomMsg.nick
        senderColor = 'var(--fluux-text-self)'
      }
    } else {
      const senderBareJid = getBareJid(msg.from)
      const contact = contactsByJid.get(senderBareJid)
      senderName = msg.isOutgoing
        ? (ownNickname || getLocalPart(msg.from))
        : (contact?.name || getLocalPart(msg.from))
      senderColor = msg.isOutgoing
        ? 'var(--fluux-text-self)'
        : auroraSenderColor(senderBareJid, isDarkMode ?? true)
      avatarUrl = msg.isOutgoing ? (ownAvatar || undefined) : contact?.avatar
      avatarIdentifier = senderBareJid
      senderJid = senderBareJid
    }

    // Build reply context. The search context is a fixed result set rendered
    // once (not a live, paginating list), so resolving from the local lookup at
    // render is safe here — no memoized-row freeze to worry about.
    const replyContext = buildReplyContext(
      msg,
      msg.replyTo ? messagesById.get(msg.replyTo.id) : undefined,
      (originalMsg, fallbackId) => {
        if (originalMsg?.isOutgoing) return ownNickname || getLocalPart(originalMsg.from)
        if (isRoom && originalMsg?.type === 'groupchat') return (originalMsg as RoomMessage).nick
        if (originalMsg) return contactsByJid.get(getBareJid(originalMsg.from))?.name || getLocalPart(originalMsg.from)
        return fallbackId ? getLocalPart(fallbackId) : 'Unknown'
      },
      (originalMsg, fallbackId, dark) => {
        if (originalMsg?.isOutgoing) return 'var(--fluux-text-self)'
        const senderId = (originalMsg ? getBareJid(originalMsg.from) : undefined) || (fallbackId ? getBareJid(fallbackId) : undefined)
        if (!senderId) return 'var(--fluux-brand)'
        return auroraSenderColor(senderId, dark ?? true)
      },
      (originalMsg, fallbackId) => {
        if (isRoom && room && originalMsg?.type === 'groupchat') {
          const roomMessage = originalMsg as RoomMessage
          const avatar = resolveRoomAvatar(
            {
              nick: roomMessage.nick,
              occupantId: roomMessage.occupantId,
              isOwn: roomMessage.isOutgoing,
            },
            room,
            contactsByJid,
            ownAvatar,
          )
          return {
            avatarUrl: avatar.avatarUrl,
            avatarIdentifier: avatar.avatarIdentifier,
          }
        }
        const senderId = (originalMsg ? getBareJid(originalMsg.from) : undefined) || (fallbackId ? getBareJid(fallbackId) : undefined)
        if (senderId === myBareJid) {
          return { avatarUrl: ownAvatar || undefined, avatarIdentifier: senderId || 'unknown' }
        }
        const contact = senderId ? contactsByJid.get(senderId) : undefined
        return { avatarUrl: contact?.avatar, avatarIdentifier: senderId || 'unknown' }
      },
      isDarkMode
    )

    // Get my current reactions (room messages use nicks, 1:1 use bare JIDs)
    const myReactions = getMyReactions(msg.reactions, ownNickname ?? undefined, myBareJid, isRoom && msg.type === 'groupchat')

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
          isGroupEnd={idx === groupMessages.length - 1 || shouldShowAvatar(groupMessages, idx + 1)}
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
      // Remount per previewed message so shared scroll-hook refs don't bleed between previews.
      // Keyed on the preview identity (conversation + anchor message), not conversationId alone,
      // since different results within one conversation must each get a fresh view. (staticMode
      // here disables virtualization, so there is no virtualizer cache to leak.)
      key={`${conversationId}:${highlightedMessageId}`}
      messages={messages}
      conversationId={conversationId}
      scrollerRef={scrollerRef}
      isAtBottomRef={isAtBottomRef}
      onScrollToTop={onScrollToTop}
      isLoadingOlder={isLoadingOlder}
      isHistoryComplete={isHistoryComplete}
      isLoading={isLoading}
      staticMode
      renderMessage={renderMessage}
      loadingState={
        <div className="flex-1 flex items-center justify-center text-fluux-muted">
          <div className="flex items-center gap-2">
            <Search className="size-5 animate-pulse" />
            <span>{t('search.loadingContext', 'Loading messages…')}</span>
          </div>
        </div>
      }
    />
  )
})
