/**
 * StrangerRequestPreviewView - Read-only message-request preview.
 *
 * Shows the full thread from a stranger (non-contact) in the main content pane,
 * with a bottom action banner (Accept / Ignore / Block) and no composer.
 * Modelled on ActivityContextView / SearchContextView.
 */
import { useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useEvents,
  useContactIdentities,
  getBareJid,
  getLocalPart,
  type Message,
} from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { SearchContextMessageList } from './SearchContextView'
import { Avatar } from './Avatar'
import { useWindowDrag, useMode } from '@/hooks'
import { ArrowLeft } from 'lucide-react'

export interface StrangerRequestPreviewViewProps {
  strangerJid: string
  onAccept: () => void
  onIgnore: () => void
  onBlock: () => void
  onBack?: () => void
}

export function StrangerRequestPreviewView({
  strangerJid,
  onAccept,
  onIgnore,
  onBlock,
  onBack,
}: StrangerRequestPreviewViewProps) {
  const { t } = useTranslation()
  const { strangerConversations } = useEvents()
  const { dragRegionProps } = useWindowDrag()
  const { resolvedMode } = useMode()
  const isDarkMode = resolvedMode === 'dark'

  // Connection state for own messages
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const myBareJid = jid ? getBareJid(jid) : undefined

  // Contact identities for sender resolution
  const contactsByJid = useContactIdentities()

  // Scroll refs
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(false)

  // Map StrangerMessage → Message for SearchContextMessageList
  const messages = useMemo<Message[]>(() => {
    const strangerMessages = strangerConversations[strangerJid] ?? []
    return strangerMessages.map((msg) => ({
      type: 'chat' as const,
      id: msg.id,
      conversationId: strangerJid,
      from: msg.from,
      body: msg.body,
      timestamp: msg.timestamp,
      isOutgoing: false,
    }))
  }, [strangerConversations, strangerJid])

  // Display name: local part of JID
  const displayName = getLocalPart(strangerJid)

  return (
    <div className="flex flex-col h-full bg-fluux-surface/50">
      {/* Header */}
      <header
        className="h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3"
        {...dragRegionProps}
      >
        {/* Back button — mobile */}
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden tap-target"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
          </button>
        )}

        {/* Stranger avatar */}
        <Avatar
          identifier={strangerJid}
          name={displayName}
          size="header"
          className="flex-shrink-0"
        />

        {/* Conversation info */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fluux-text truncate">
            {displayName}
          </div>
          <div className="text-xs text-fluux-muted">
            {t('conversations.messageRequestPreview', 'Message request')}
          </div>
        </div>
      </header>

      {/* Message list (read-only) */}
      <div className="flex-1 flex flex-col min-h-0 p-1">
        <SearchContextMessageList
          messages={messages}
          conversationId={`request-preview:${strangerJid}`}
          isRoom={false}
          highlightedMessageId=""
          onHighlightedClick={() => {}}
          contactsByJid={contactsByJid}
          myBareJid={myBareJid}
          ownAvatar={ownAvatar}
          ownNickname={ownNickname}
          isDarkMode={isDarkMode}
          highlightTerms={[]}
          scrollerRef={scrollRef}
          isAtBottomRef={isAtBottomRef}
          isLoading={false}
          isHistoryComplete={true}
        />
      </div>

      {/* Bottom action banner */}
      <div className="p-3 border-t border-fluux-hover flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onBlock}
          className="px-4 py-2 text-sm font-medium rounded-md
                     text-fluux-muted hover:bg-fluux-hover transition-colors"
        >
          {t('common.block', 'Block')}
        </button>
        <button
          type="button"
          onClick={onIgnore}
          className="px-4 py-2 text-sm font-medium rounded-md
                     text-fluux-muted hover:bg-fluux-hover transition-colors"
        >
          {t('common.ignore', 'Ignore')}
        </button>
        <button
          type="button"
          onClick={onAccept}
          className="px-4 py-2 text-sm font-medium rounded-md
                     bg-fluux-brand text-white hover:bg-fluux-brand/90 transition-colors"
        >
          {t('common.accept', 'Accept')}
        </button>
      </div>
    </div>
  )
}
