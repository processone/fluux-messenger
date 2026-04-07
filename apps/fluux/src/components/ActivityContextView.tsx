/**
 * ActivityContextView - Read-only message context view for activity events.
 *
 * When a reaction/vote event is clicked in the activity log, this component
 * renders in the main content area showing the conversation's messages
 * centered on the reacted message. Reuses SearchContextMessageList for
 * the read-only message list.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useActivityLog,
  getMessages,
  getRoomMessages,
  useContactIdentities,
  type Message,
  type RoomMessage,
  type ReactionReceivedPayload,
} from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { roomStore } from '@fluux/sdk'
import { SearchContextMessageList } from './SearchContextView'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { useWindowDrag, useMode } from '@/hooks'
import { ArrowLeft, ExternalLink, Heart } from 'lucide-react'

/** Number of messages to load on each side of the target */
const CONTEXT_BATCH_SIZE = 50

export function ActivityContextView({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation()
  const { previewEvent, setPreviewEvent } = useActivityLog()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  const { titleBarClass, dragRegionProps } = useWindowDrag()
  const { resolvedMode } = useMode()
  const isDarkMode = resolvedMode === 'dark'
  const hasRoom = useCallback((jid: string) => roomStore.getState().rooms.has(jid), [])

  // Connection state for own messages
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const myBareJid = jid?.split('/')[0]

  // Contact identities for sender resolution
  const contactsByJid = useContactIdentities()

  // Message state
  const [messages, setMessages] = useState<(Message | RoomMessage)[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [isHistoryComplete, setIsHistoryComplete] = useState(false)

  // Scroll refs
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(false)

  // Track the current preview to detect changes
  const prevPreviewRef = useRef<string | null>(null)

  // Extract event data
  const payload = previewEvent?.type === 'reaction-received'
    ? previewEvent.payload as ReactionReceivedPayload
    : null
  const conversationId = payload?.conversationId ?? ''
  const messageId = payload?.messageId ?? ''
  const isRoom = conversationId ? hasRoom(conversationId) : false

  // Load messages centered on the target
  useEffect(() => {
    if (!payload) {
      setMessages([])
      setIsLoading(false)
      return
    }

    const previewKey = `${conversationId}:${messageId}`
    if (prevPreviewRef.current === previewKey) return
    prevPreviewRef.current = previewKey

    setIsLoading(true)
    setIsHistoryComplete(false)

    const loadMessages = async () => {
      try {
        // We need a timestamp to query around. Find the message in the cache.
        let before: (Message | RoomMessage)[]
        let after: (Message | RoomMessage)[]

        if (isRoom) {
          // Load all recent messages and find the target to get its timestamp
          const recent = await getRoomMessages(conversationId, { limit: 200 })
          const target = recent.find((m) => m.id === messageId)
          const targetDate = target?.timestamp ?? new Date()

          before = await getRoomMessages(conversationId, {
            before: targetDate,
            limit: CONTEXT_BATCH_SIZE,
          })
          after = await getRoomMessages(conversationId, {
            after: new Date(targetDate.getTime() - 1),
            limit: CONTEXT_BATCH_SIZE,
          })
        } else {
          const recent = await getMessages(conversationId, { limit: 200 })
          const target = recent.find((m) => m.id === messageId)
          const targetDate = target?.timestamp ?? new Date()

          before = await getMessages(conversationId, {
            before: targetDate,
            limit: CONTEXT_BATCH_SIZE,
          })
          after = await getMessages(conversationId, {
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
        console.warn('Failed to load activity context messages:', err)
        setMessages([])
      } finally {
        setIsLoading(false)
      }
    }

    void loadMessages()
  }, [payload, conversationId, messageId, isRoom])

  // Resolve the DOM-usable message ID. The activity payload's messageId may be
  // a stanzaId (server-assigned), while data-message-id uses the client-generated id.
  const resolvedMessageId = useMemo(() => {
    if (!messageId || messages.length === 0) return messageId
    // Direct match by id
    if (messages.some((m) => m.id === messageId)) return messageId
    // Fallback: find by stanzaId
    const match = messages.find((m) => m.stanzaId === messageId)
    return match?.id ?? messageId
  }, [messageId, messages])

  // Scroll to the target message and apply persistent highlight.
  // We handle this here instead of passing targetMessageId to MessageList/useMessageListScroll
  // because the scroll hook's live-conversation behaviors interfere with the static preview.
  useEffect(() => {
    if (!resolvedMessageId || isLoading || messages.length === 0) return

    const scroller = scrollRef.current
    if (!scroller) return

    const escapedId = CSS.escape(resolvedMessageId)

    const scrollAndHighlight = () => {
      const el = scroller.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null
      if (!el) return false

      const scrollerRect = scroller.getBoundingClientRect()
      const elementRect = el.getBoundingClientRect()
      const elementTop = elementRect.top - scrollerRect.top + scroller.scrollTop
      const viewportHeight = scroller.clientHeight
      scroller.scrollTop = Math.max(0, elementTop - viewportHeight / 3)

      el.classList.add('message-highlight-persistent')
      return true
    }

    if (!scrollAndHighlight()) {
      requestAnimationFrame(() => {
        scrollAndHighlight()
      })
    }

    return () => {
      const el = scroller?.querySelector(`[data-message-id="${escapedId}"]`)
      el?.classList.remove('message-highlight-persistent')
    }
  }, [resolvedMessageId, isLoading, messages.length])

  // Load older messages on scroll to top
  const handleScrollToTop = useCallback(async () => {
    if (!conversationId || isLoadingOlder || isHistoryComplete || messages.length === 0) return

    setIsLoadingOlder(true)
    try {
      const oldestTimestamp = messages[0].timestamp
      let older: (Message | RoomMessage)[]

      if (isRoom) {
        older = await getRoomMessages(conversationId, {
          before: oldestTimestamp,
          limit: CONTEXT_BATCH_SIZE,
        })
      } else {
        older = await getMessages(conversationId, {
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
  }, [conversationId, isRoom, isLoadingOlder, isHistoryComplete, messages])

  // Navigate to the real conversation
  const handleGoToMessage = useCallback(() => {
    if (!conversationId) return
    setPreviewEvent(null)
    if (isRoom) {
      navigateToRoom(conversationId, messageId)
    } else {
      navigateToConversation(conversationId, messageId)
    }
  }, [conversationId, messageId, isRoom, setPreviewEvent, navigateToConversation, navigateToRoom])

  // Handle click on the highlighted message
  const handleHighlightedMessageClick = useCallback(() => {
    handleGoToMessage()
  }, [handleGoToMessage])

  // Handle back / close
  const handleBack = useCallback(() => {
    setPreviewEvent(null)
    onBack?.()
  }, [setPreviewEvent, onBack])

  if (!previewEvent || !payload) return null

  // Resolve conversation name
  const conversationName = conversationId.split('@')[0]

  return (
    <div className="flex flex-col h-full bg-fluux-surface/50">
      {/* Header */}
      <header className={`h-14 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3`} {...dragRegionProps}>
        {/* Back button - mobile */}
        {onBack && (
          <button
            onClick={handleBack}
            className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft className="w-5 h-5 text-fluux-muted rtl-mirror" />
          </button>
        )}

        {/* Event icon */}
        <div className="w-9 h-9 bg-fluux-bg rounded-full flex items-center justify-center flex-shrink-0">
          <Heart className="w-5 h-5 text-fluux-muted" />
        </div>

        {/* Conversation info */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fluux-text truncate">
            {conversationName}
          </div>
          <div className="text-xs text-fluux-muted">
            {t('activityLog.contextView', 'Event context')}
          </div>
        </div>
      </header>

      {/* Message list (read-only) */}
      <div className="flex-1 flex flex-col min-h-0 p-1">
        <SearchContextMessageList
          messages={messages}
          conversationId={`activity-preview:${conversationId}`}
          isRoom={isRoom}
          highlightedMessageId={resolvedMessageId}
          onHighlightedClick={handleHighlightedMessageClick}
          contactsByJid={contactsByJid}
          myBareJid={myBareJid}
          ownAvatar={ownAvatar}
          ownNickname={ownNickname}
          isDarkMode={isDarkMode}
          highlightTerms={[]}
          scrollerRef={scrollRef}
          isAtBottomRef={isAtBottomRef}
          onScrollToTop={handleScrollToTop}
          isLoadingOlder={isLoadingOlder}
          isHistoryComplete={isHistoryComplete}
          isLoading={isLoading}
        />
      </div>

      {/* Bottom banner — event preview indicator with Go to message action */}
      <div className="p-3 border-t border-fluux-hover flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fluux-muted">
          <Heart className="w-4 h-4" />
          <span className="text-sm">{t('activityLog.previewBanner', 'You are viewing an event preview')}</span>
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
