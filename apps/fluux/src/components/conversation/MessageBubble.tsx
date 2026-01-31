/**
 * Shared MessageBubble component for both 1:1 chats and MUC rooms.
 *
 * Uses composition to handle view-specific rendering while sharing
 * the common bubble structure.
 */
import { useState, memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import type { BaseMessage, MentionReference, Contact, RoomRole, RoomAffiliation } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { MessageToolbar } from './MessageToolbar'
import { MessageBody } from './MessageBody'
import { MessageReactions } from './MessageReactions'
import { scrollToMessage, isActionMessage } from './messageGrouping'
import { MessageAttachments } from '../MessageAttachments'
import { LinkPreviewCard } from '../LinkPreviewCard'
import { UserInfoPopover } from './UserInfoPopover'

export interface MessageBubbleProps {
  // Core message data (using BaseMessage interface)
  message: BaseMessage

  // Display state
  showAvatar: boolean
  isSelected?: boolean
  hasKeyboardSelection?: boolean
  showToolbarForSelection?: boolean
  hideToolbar?: boolean
  isLastOutgoing: boolean
  isLastMessage: boolean
  isDarkMode?: boolean

  // Hover state (controlled by parent for stable toolbar interaction)
  isHovered?: boolean
  onMouseEnter?: () => void
  onMouseLeave?: () => void

  // Sender info
  senderName: string
  senderColor: string
  avatarUrl?: string
  avatarIdentifier: string
  avatarFallbackColor?: string  // Optional color matching nick text for visual consistency
  avatarPresence?: 'online' | 'away' | 'dnd' | 'offline'
  /** JID to show in the click popover */
  senderJid?: string
  /** Contact object for showing connected devices in popover */
  senderContact?: Contact
  /** Room role for MUC occupants */
  senderRole?: RoomRole
  /** Room affiliation for MUC occupants */
  senderAffiliation?: RoomAffiliation

  // Nick header extras (for room moderator badge, hats)
  nickExtras?: ReactNode

  // Reactions
  myReactions: string[]
  onReaction: (emoji: string) => void
  getReactorName: (reactor: string) => string

  // Actions
  onReply: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
  onMediaLoad?: () => void

  // Reply context (view-specific rendering)
  replyContext?: {
    senderName: string
    senderColor: string
    body: string
    messageId: string
  }

  // Room-specific: mentions for highlighting
  mentions?: MentionReference[]

  // Callback when reaction picker opens/closes (for hiding other toolbars)
  onReactionPickerChange?: (isOpen: boolean) => void
}

/**
 * Custom comparison for memo - compares data props, ignores callback props.
 * This prevents re-renders when only callback references change.
 */
function arePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  // Message identity and content
  if (prev.message.id !== next.message.id) return false
  if (prev.message.body !== next.message.body) return false
  if (prev.message.isEdited !== next.message.isEdited) return false
  if (prev.message.isRetracted !== next.message.isRetracted) return false
  if (prev.message.isOutgoing !== next.message.isOutgoing) return false

  // Reactions - compare stringified since object reference will differ
  const prevReactions = JSON.stringify(prev.message.reactions ?? {})
  const nextReactions = JSON.stringify(next.message.reactions ?? {})
  if (prevReactions !== nextReactions) return false

  // My reactions array
  if (prev.myReactions.length !== next.myReactions.length) return false
  if (prev.myReactions.some((r, i) => r !== next.myReactions[i])) return false

  // Attachment and link preview (compare by reference - they shouldn't change)
  if (prev.message.attachment !== next.message.attachment) return false
  if (prev.message.linkPreview !== next.message.linkPreview) return false

  // Display state
  if (prev.showAvatar !== next.showAvatar) return false
  if (prev.isSelected !== next.isSelected) return false
  if (prev.hasKeyboardSelection !== next.hasKeyboardSelection) return false
  if (prev.showToolbarForSelection !== next.showToolbarForSelection) return false
  if (prev.hideToolbar !== next.hideToolbar) return false
  if (prev.isLastOutgoing !== next.isLastOutgoing) return false
  if (prev.isLastMessage !== next.isLastMessage) return false
  if (prev.isHovered !== next.isHovered) return false

  // Sender info
  if (prev.senderName !== next.senderName) return false
  if (prev.senderColor !== next.senderColor) return false
  if (prev.avatarUrl !== next.avatarUrl) return false
  if (prev.avatarIdentifier !== next.avatarIdentifier) return false
  if (prev.avatarFallbackColor !== next.avatarFallbackColor) return false
  if (prev.avatarPresence !== next.avatarPresence) return false
  if (prev.senderJid !== next.senderJid) return false
  if (prev.senderContact !== next.senderContact) return false
  if (prev.senderRole !== next.senderRole) return false
  if (prev.senderAffiliation !== next.senderAffiliation) return false

  // Reply context - compare by reference (parent should memoize)
  if (prev.replyContext !== next.replyContext) {
    // If references differ, do deep compare
    if (!prev.replyContext || !next.replyContext) return false
    if (prev.replyContext.messageId !== next.replyContext.messageId) return false
    if (prev.replyContext.body !== next.replyContext.body) return false
    if (prev.replyContext.senderName !== next.replyContext.senderName) return false
  }

  // Mentions - compare by reference (parent should memoize)
  if (prev.mentions !== next.mentions) return false

  // nickExtras - ReactNode, compare by reference (accept some re-renders)
  if (prev.nickExtras !== next.nickExtras) return false

  // All data props are equal - skip re-render
  // (callback props like onReply, onEdit, etc. are intentionally ignored)
  return true
}

export const MessageBubble = memo(function MessageBubble({
  message,
  showAvatar,
  isSelected,
  hasKeyboardSelection,
  showToolbarForSelection,
  hideToolbar,
  isLastOutgoing,
  isLastMessage,
  // isDarkMode is kept in interface for parent compatibility but unused in component
  isHovered,
  onMouseEnter,
  onMouseLeave,
  senderName,
  senderColor,
  avatarUrl,
  avatarIdentifier,
  avatarFallbackColor,
  avatarPresence,
  senderJid,
  senderContact,
  senderRole,
  senderAffiliation,
  nickExtras,
  myReactions,
  onReaction,
  getReactorName,
  onReply,
  onEdit,
  onDelete,
  onMediaLoad,
  replyContext,
  mentions,
  onReactionPickerChange,
}: MessageBubbleProps) {
  const { t } = useTranslation()
  const [showReactionPicker, setShowReactionPickerState] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)

  // Wrap setShowReactionPicker to notify parent
  const setShowReactionPicker = (isOpen: boolean) => {
    setShowReactionPickerState(isOpen)
    onReactionPickerChange?.(isOpen)
  }

  const handleReaction = (emoji: string) => {
    onReaction(emoji)
    setShowReactionPicker(false)
  }

  // Determine hover state: use controlled isHovered if provided, otherwise fall back to CSS hover
  const useControlledHover = isHovered !== undefined
  const hoverClass = useControlledHover
    ? (isHovered ? 'bg-fluux-hover' : '')
    : (hasKeyboardSelection ? '' : 'hover:bg-fluux-hover')

  return (
    <div
      data-message-id={message.id}
      data-message-from={senderName}
      data-message-time={format(message.timestamp, 'HH:mm')}
      data-message-body={message.body || ''}
      className={`group flex gap-4 ${hoverClass} -mx-4 px-4 py-0.5 transition-colors ${showAvatar ? 'pt-4' : ''}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Avatar, timestamp (when selected), or spacer */}
      <div className="w-10 flex-shrink-0">
        {/* /me action messages always show timestamp instead of avatar */}
        {isActionMessage(message.body) ? (
          <span className={`text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
            {format(message.timestamp, 'HH:mm')}
          </span>
        ) : showAvatar ? (
          <UserInfoPopover contact={senderContact} jid={senderJid} role={senderRole} affiliation={senderAffiliation}>
            <div className="select-none">
              <Avatar
                identifier={avatarIdentifier}
                name={senderName}
                avatarUrl={avatarUrl}
                fallbackColor={avatarFallbackColor}
                size="md"
                presence={avatarPresence}
                presenceBorderColor="border-fluux-chat"
              />
            </div>
          </UserInfoPopover>
        ) : (
          <span className={`text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
            {format(message.timestamp, 'HH:mm')}
          </span>
        )}
      </div>

      {/* Content */}
      <div className={`relative flex-1 min-w-0 ${isSelected ? 'bg-fluux-selection -my-0.5 py-0.5 -ml-2 pl-2 -mr-4 pr-4 rounded-l' : ''}`}>
        {/* Floating hover toolbar - hidden when user is composing or message is retracted */}
        {!message.isRetracted && (
          <MessageToolbar
            onReaction={handleReaction}
            onReply={onReply}
            onEdit={onEdit}
            onDelete={onDelete}
            myReactions={myReactions}
            canReply={!isLastMessage}
            canEdit={message.isOutgoing && isLastOutgoing}
            canDelete={message.isOutgoing}
            isHidden={hideToolbar || false}
            isSelected={isSelected || false}
            hasKeyboardSelection={hasKeyboardSelection || false}
            showToolbarForSelection={showToolbarForSelection || false}
            showAvatar={showAvatar}
            showReactionPicker={showReactionPicker}
            setShowReactionPicker={setShowReactionPicker}
            showMoreMenu={showMoreMenu}
            setShowMoreMenu={setShowMoreMenu}
            isHovered={isHovered}
            onToolbarMouseEnter={onMouseEnter}
          />
        )}

        {/* Nick header - hidden for /me action messages (nick is shown inline) */}
        {showAvatar && !isActionMessage(message.body) && (
          <div className="flex items-baseline gap-2 pb-1 flex-wrap">
            <UserInfoPopover contact={senderContact} jid={senderJid} role={senderRole} affiliation={senderAffiliation}>
              <span
                className="font-medium"
                style={{ color: senderColor }}
              >
                {senderName}
              </span>
            </UserInfoPopover>
            {nickExtras}
            <span className="text-xs text-fluux-muted">
              {format(message.timestamp, 'HH:mm')}
            </span>
          </div>
        )}

        {/* Reply context - show what message this is replying to (hidden for retracted messages) */}
        {!message.isRetracted && replyContext && (
          <button
            onClick={() => scrollToMessage(replyContext.messageId)}
            className="flex items-start gap-2 pb-1 pl-2 border-l-2 border-fluux-brand text-left w-full hover:bg-fluux-hover/50 rounded-r transition-colors cursor-pointer select-none"
          >
            <div className="text-xs text-fluux-muted min-w-0 flex-1">
              <span
                className="font-medium"
                style={{ color: replyContext.senderColor }}
              >{replyContext.senderName}</span>
              <p className="line-clamp-2 opacity-75">{replyContext.body}</p>
            </div>
          </button>
        )}

        {/* Message body */}
        <MessageBody
          body={message.body}
          isEdited={message.isEdited}
          originalBody={message.originalBody}
          isRetracted={message.isRetracted}
          noStyling={message.noStyling}
          senderName={senderName}
          senderColor={senderColor}
          mentions={mentions}
          hasAttachmentThumbnail={!!message.attachment?.thumbnail}
        />

        {/* File attachments (image, video, audio, text preview, document card) - hidden for retracted */}
        {!message.isRetracted && <MessageAttachments attachment={message.attachment} onMediaLoad={onMediaLoad} />}

        {/* Link preview - hidden for retracted */}
        {!message.isRetracted && message.linkPreview && <LinkPreviewCard preview={message.linkPreview} onLoad={onMediaLoad} />}

        {/* Reactions display */}
        <MessageReactions
          reactions={message.reactions ?? {}}
          myReactions={myReactions}
          onReaction={handleReaction}
          getReactorName={getReactorName}
          isRetracted={message.isRetracted}
        />
      </div>
    </div>
  )
}, arePropsEqual)

/**
 * Helper to build reply context from a message and lookup functions.
 *
 * @param message - The message that has a replyTo
 * @param messagesById - Map to look up the original message
 * @param getSenderName - Function to get display name from sender ID
 * @param getSenderColor - Function to get color from sender ID
 * @returns ReplyContext or undefined if no reply
 */
export function buildReplyContext<T extends BaseMessage>(
  message: T,
  messagesById: Map<string, T>,
  getSenderName: (msg: T | undefined, fallbackId: string | undefined) => string,
  getSenderColor: (msg: T | undefined, fallbackId: string | undefined, isDarkMode?: boolean) => string,
  isDarkMode?: boolean
): MessageBubbleProps['replyContext'] {
  if (!message.replyTo) return undefined

  const originalMessage = messagesById.get(message.replyTo.id)
  const fallbackId = message.replyTo.to
  const senderName = getSenderName(originalMessage, fallbackId)
  const senderColor = getSenderColor(originalMessage, fallbackId, isDarkMode)
  const body = originalMessage?.body || message.replyTo.fallbackBody || 'Original message not found'

  // Use the original message's actual ID for scrolling.
  // The replyTo.id may reference the stanza-id (from MAM), but the DOM uses
  // the client-generated message.id for data-message-id attributes.
  const messageId = originalMessage?.id ?? message.replyTo.id

  return {
    senderName,
    senderColor,
    body,
    messageId,
  }
}
