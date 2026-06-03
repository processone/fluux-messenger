/**
 * Shared MessageBubble component for both 1:1 chats and MUC rooms.
 *
 * Uses composition to handle view-specific rendering while sharing
 * the common bubble structure.
 */
import { useState, useMemo, memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerUpRight, AlertCircle, RefreshCw, Lock, ShieldAlert, Ear } from 'lucide-react'
import { formatMessagePreview, formatXMPPError, type BaseMessage, type MentionReference, type Contact, type ContactIdentity, type RoomRole, type RoomAffiliation } from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { AvatarLightbox } from '../AvatarLightbox'
import { MessageToolbar } from './MessageToolbar'
import { MessageBody } from './MessageBody'
import { EncryptedPlaceholder } from './EncryptedPlaceholder'
import { MessageReactions } from './MessageReactions'
import { scrollToMessage, isActionMessage, type WhisperThreadPosition } from './messageGrouping'
import { MessageAttachments } from '../MessageAttachments'
import { LinkPreviewCard } from '../LinkPreviewCard'
import { UserInfoPopover } from './UserInfoPopover'
import { CollapsibleContent } from './CollapsibleContent'
import { PollCard } from './PollCard'
import { PollClosedCard } from './PollClosedCard'
import { Tooltip } from '../Tooltip'

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
  /** Contact or identity object for showing info in popover */
  senderContact?: Contact | ContactIdentity
  /** Room role for MUC occupants */
  senderRole?: RoomRole
  /** Room affiliation for MUC occupants */
  senderAffiliation?: RoomAffiliation
  /** Occupant JID for vCard fetch in anonymous rooms (e.g. room@conf/nick) */
  senderOccupantJid?: string

  /** Whisper counterpart nick (recipient if outgoing, sender if incoming). */
  whisperWith?: string
  /** Position within a whisper thread — drives the bounded "private with X" container. */
  whisperThread?: WhisperThreadPosition | null

  // Nick header extras (for room moderator badge, hats)
  nickExtras?: ReactNode

  // Reactions
  myReactions: string[]
  /** Handler for reaction clicks. When undefined, reaction UI is hidden (room lacks stable identity). */
  onReaction?: (emoji: string) => void
  getReactorName: (reactor: string) => string

  // Actions
  onReply: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
  onRetry?: () => void
  onMediaLoad?: () => void

  // Reply context (view-specific rendering)
  replyContext?: {
    senderName: string
    senderColor: string
    body: string
    messageId: string
    avatarUrl?: string
    avatarIdentifier: string
  }

  // Room-specific: mentions for highlighting
  mentions?: MentionReference[]

  // Room-specific: user's nickname for IRC-style mention detection fallback
  nickname?: string

  // Room-specific: known occupant nicks for IRC-style prefix mention highlighting
  knownNicks?: ReadonlySet<string>

  // XEP-0425: Whether the current user can moderate (retract) this message
  canModerate?: boolean

  // Right-click / long-press context menu on nick/avatar (for room occupant actions)
  onNickContextMenu?: (e: React.MouseEvent) => void
  onNickTouchStart?: (e: React.TouchEvent) => void
  onNickTouchEnd?: () => void

  // Poll vote action (enforces single/multi-vote rules via SDK)
  onPollVote?: (emoji: string) => void
  // Poll close action (only for poll creator)
  onClosePoll?: () => Promise<string | null>

  // Callback when reaction picker opens/closes (for hiding other toolbars)
  onReactionPickerChange?: (isOpen: boolean) => void

  // Time formatting function (respects user's 12h/24h preference)
  formatTime: (date: Date) => string

  // Effective time format for layout width calculations ('12h' needs wider column)
  timeFormat: '12h' | '24h'

  // Search term highlighting in message body
  highlightTerms?: string[]

  // Whether this message is the current find-on-page match
  isCurrentMatch?: boolean
}

/**
 * Custom comparison for memo - compares data props, ignores callback props.
 * This prevents re-renders when only callback references change.
 */
function arePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  // Message identity and content
  if (prev.message.id !== next.message.id) return false
  if (prev.message.body !== next.message.body) return false
  if (prev.whisperWith !== next.whisperWith) return false
  if (prev.whisperThread !== next.whisperThread) return false
  if (prev.message.isEdited !== next.message.isEdited) return false
  if (prev.message.isRetracted !== next.message.isRetracted) return false
  if (prev.message.isOutgoing !== next.message.isOutgoing) return false
  if (prev.message.deliveryError !== next.message.deliveryError) return false

  // Reactions - compare stringified since object reference will differ
  const prevReactions = JSON.stringify(prev.message.reactions ?? {})
  const nextReactions = JSON.stringify(next.message.reactions ?? {})
  if (prevReactions !== nextReactions) return false

  // Security context — drives the lock/trust indicator. The SDK can mutate
  // this AFTER the message first arrives (e.g. the openpgp plugin upgrades
  // a previously-untrusted message to trusted once the sender's PEP key
  // finishes fetching). Without comparing it here React skips the render
  // and the lock badge stays at its stale value forever. Stringify mirrors
  // the reactions pattern above and is fine for a tiny three-field object.
  const prevSec = JSON.stringify(prev.message.securityContext ?? null)
  const nextSec = JSON.stringify(next.message.securityContext ?? null)
  if (prevSec !== nextSec) return false

  // Unsupported-encryption tag — drives the muted lock hint. retryPendingDecrypts()
  // can set this on an already-rendered message (migration of stored OMEMO
  // messages), so it must invalidate the memo like securityContext does.
  const prevUnsup = JSON.stringify(prev.message.unsupportedEncryption ?? null)
  const nextUnsup = JSON.stringify(next.message.unsupportedEncryption ?? null)
  if (prevUnsup !== nextUnsup) return false

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
    if (prev.replyContext.avatarUrl !== next.replyContext.avatarUrl) return false
    if (prev.replyContext.avatarIdentifier !== next.replyContext.avatarIdentifier) return false
  }

  // Dark mode (affects mention colors)
  if (prev.isDarkMode !== next.isDarkMode) return false

  // Moderation permission
  if (prev.canModerate !== next.canModerate) return false

  // Mentions - compare by reference (parent should memoize)
  if (prev.mentions !== next.mentions) return false
  if (prev.nickname !== next.nickname) return false
  if (prev.knownNicks !== next.knownNicks) return false

  // nickExtras - ReactNode, compare by reference (accept some re-renders)
  if (prev.nickExtras !== next.nickExtras) return false

  // Time format affects column width
  if (prev.timeFormat !== next.timeFormat) return false

  // Find-on-page current match
  if (prev.isCurrentMatch !== next.isCurrentMatch) return false

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
  isDarkMode,
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
  senderOccupantJid,
  whisperWith,
  whisperThread,
  nickExtras,
  myReactions,
  onReaction,
  getReactorName,
  onReply,
  onEdit,
  onDelete,
  onRetry,
  onMediaLoad,
  replyContext,
  mentions,
  nickname,
  knownNicks,
  canModerate,
  onPollVote,
  onClosePoll,
  onNickContextMenu,
  onNickTouchStart,
  onNickTouchEnd,
  onReactionPickerChange,
  formatTime,
  timeFormat,
  highlightTerms,
  isCurrentMatch,
}: MessageBubbleProps) {
  const { t } = useTranslation()
  const [showReactionPicker, setShowReactionPickerState] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showAvatarLightbox, setShowAvatarLightbox] = useState(false)
  const [showErrorDetails, setShowErrorDetails] = useState(false)

  // Whether reactions are enabled for this message (room has stable occupant identity)
  const reactionsEnabled = onReaction !== undefined

  // Wrap setShowReactionPicker to notify parent
  const setShowReactionPicker = (isOpen: boolean) => {
    setShowReactionPickerState(isOpen)
    onReactionPickerChange?.(isOpen)
  }

  const handleReaction = reactionsEnabled ? (emoji: string) => {
    onReaction(emoji)
    setShowReactionPicker(false)
  } : undefined

  // Filter poll-vote emojis from the reactions display so votes don't appear as reaction pills.
  // Non-poll emojis (e.g. 👍) on poll messages still show normally.
  const pollEmojiSet = useMemo(() => {
    if (!message.poll) return null
    return new Set(message.poll.options.map((o) => o.emoji))
  }, [message.poll])

  const filteredReactions = useMemo(() => {
    const reactions = message.reactions ?? {}
    if (!pollEmojiSet) return reactions
    return Object.fromEntries(
      Object.entries(reactions).filter(([emoji]) => !pollEmojiSet.has(emoji))
    )
  }, [message.reactions, pollEmojiSet])

  const filteredMyReactions = useMemo(() => {
    if (!pollEmojiSet) return myReactions
    return myReactions.filter((emoji) => !pollEmojiSet.has(emoji))
  }, [myReactions, pollEmojiSet])

  // Determine hover state: use controlled isHovered if provided, otherwise fall back to CSS hover
  const useControlledHover = isHovered !== undefined
  const hoverClass = useControlledHover
    ? (isHovered ? 'bg-fluux-hover' : '')
    : (hasKeyboardSelection ? '' : 'hover:bg-fluux-hover')

  // Whisper thread (XEP-0045 §7.5): a same-counterpart private run renders as one
  // bounded "private with X" container; the strip on the first row carries the label.
  const inThread = !!whisperThread
  const threadStart = whisperThread === 'start' || whisperThread === 'solo'
  const threadEnd = whisperThread === 'end' || whisperThread === 'solo'
  const outerRowClass = inThread
    ? `group flex gap-4 -mx-4 px-4 transition-colors ${threadStart ? 'pt-3' : ''} ${threadEnd ? 'pb-1.5' : ''}`
    : `group flex gap-4 ${hoverClass} -mx-4 px-4 py-0.5 transition-colors ${showAvatar ? 'pt-4' : ''}`

  return (
    <div
      data-message-id={message.id}
      data-message-from={senderName}
      data-message-time={formatTime(message.timestamp)}
      data-message-body={message.body || ''}
      className={outerRowClass}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Avatar, timestamp (when selected), or spacer - width adapts to time format */}
      <div className={`${timeFormat === '12h' ? 'w-12' : 'w-10'} flex-shrink-0 flex flex-col`}>
        {/* /me action messages always show timestamp instead of avatar */}
        {isActionMessage(message.body) ? (
          <span className={`block text-center text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
            {formatTime(message.timestamp)}
          </span>
        ) : showAvatar ? (
          <div
            role="button"
            tabIndex={0}
            className="select-none cursor-pointer"
            onClick={(e) => { e.stopPropagation(); setShowAvatarLightbox(true) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAvatarLightbox(true) } }}
            onContextMenu={onNickContextMenu}
            onTouchStart={onNickTouchStart}
            onTouchEnd={onNickTouchEnd}
          >
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
        ) : (
          <span className={`block text-center text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
            {formatTime(message.timestamp)}
          </span>
        )}
      </div>

      {/* Content */}
      <div className={`relative flex-1 min-w-0 ${isSelected ? 'bg-fluux-selection -my-0.5 py-0.5 -ms-2 ps-2 -me-4 pe-4 rounded-s' : ''}${inThread ? ` bg-fluux-private-soft border-x border-fluux-private-border px-2.5 py-1 ${threadStart ? 'border-t rounded-t-lg' : ''} ${threadEnd ? 'border-b rounded-b-lg' : ''}` : ''}`}>
        {threadStart && (
          <div className="flex items-center gap-1.5 pb-1 text-xs font-medium text-fluux-private">
            <Ear className="size-3.5 shrink-0" />
            <span className="truncate">{t('rooms.whisperThread', { nick: whisperWith })}</span>
          </div>
        )}
        {/* Floating hover toolbar - hidden when user is composing or message is retracted */}
        {!message.isRetracted && (
          <MessageToolbar
            onReaction={handleReaction}
            onReply={onReply}
            onEdit={onEdit}
            onDelete={onDelete}
            myReactions={reactionsEnabled ? myReactions : []}
            canReply={!isLastMessage}
            canEdit={message.isOutgoing && isLastOutgoing}
            canDelete={message.isOutgoing || canModerate === true}
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
            <UserInfoPopover contact={senderContact} jid={senderJid} occupantJid={senderOccupantJid} role={senderRole} affiliation={senderAffiliation}>
              <span
                className="font-medium"
                style={{ color: senderColor }}
                onContextMenu={onNickContextMenu}
                onTouchStart={onNickTouchStart}
                onTouchEnd={onNickTouchEnd}
              >
                {senderName}
              </span>
            </UserInfoPopover>
            {nickExtras}
            <span className="text-xs text-fluux-muted">
              {formatTime(message.timestamp)}
            </span>
            {message.securityContext && (
              <Tooltip content={formatSecurityTooltip(t, message.securityContext)} position="top" triggerMode="click">
                <span
                  className={`flex items-center ${
                    message.securityContext.trust === 'verified'
                      ? 'text-green-500'
                      : message.securityContext.trust === 'rejected'
                      ? 'text-red-500'
                      : message.securityContext.trust === 'untrusted'
                      ? 'text-yellow-500'
                      : 'text-fluux-muted'
                  }`}
                  aria-label={`Encrypted with ${message.securityContext.protocolId}, trust ${message.securityContext.trust}`}
                >
                  {message.securityContext.trust === 'rejected'
                    ? <ShieldAlert className="size-3" />
                    : <Lock className="size-3" />}
                </span>
              </Tooltip>
            )}
            {!message.securityContext && message.unsupportedEncryption && (
              <Tooltip
                content={t('chat.encryption.unsupportedMethodTooltip', {
                  method: message.unsupportedEncryption.name,
                })}
                position="top"
                triggerMode="click"
              >
                <span
                  className="flex items-center text-fluux-muted"
                  aria-label={`Encrypted with ${message.unsupportedEncryption.name}, unsupported method`}
                >
                  <Lock className="size-3" />
                </span>
              </Tooltip>
            )}
          </div>
        )}

        {/* Reply context - show what message this is replying to (hidden for retracted messages) */}
        {!message.isRetracted && replyContext && (
          <button
            onClick={() => scrollToMessage(replyContext.messageId)}
            className="flex items-start gap-1.5 pb-1 ps-2 border-s-2 text-start min-w-0 hover:bg-fluux-hover/50 rounded-e transition-colors cursor-pointer select-none"
            style={{ borderColor: replyContext.senderColor }}
          >
            <div className="flex flex-col items-center flex-shrink-0 gap-0.5">
              <Avatar
                identifier={replyContext.avatarIdentifier}
                name={replyContext.senderName}
                avatarUrl={replyContext.avatarUrl}
                size="xs"
              />
              <CornerUpRight className="rtl-mirror size-3 text-fluux-muted" />
            </div>
            <div className="text-sm text-fluux-muted min-w-0 flex-1">
              <span
                className="font-medium"
                style={{ color: replyContext.senderColor }}
              >{replyContext.senderName}</span>
              <p className="line-clamp-2 opacity-75">{replyContext.body}</p>
            </div>
          </button>
        )}

        {/* Collapsible wrapper for long messages */}
        <CollapsibleContent messageId={message.id} isSelected={isSelected} isHovered={isHovered}>
          {/* Encrypted-payload placeholder takes precedence over body text
              so the SDK's English fallback string never reaches the UI. */}
          {message.encryptedPayload ? (
            <EncryptedPlaceholder />
          ) : (
            <MessageBody
              body={message.body}
              isEdited={message.isEdited}
              originalBody={message.originalBody}
              isRetracted={message.isRetracted}
              isModerated={message.isModerated}
              moderatedBy={message.moderatedBy}
              moderationReason={message.moderationReason}
              noStyling={message.noStyling}
              senderName={senderName}
              senderColor={senderColor}
              mentions={mentions}
              nickname={nickname}
              knownNicks={knownNicks}
              isDarkMode={isDarkMode}
              highlightTerms={highlightTerms}
              isCurrentMatch={isCurrentMatch}
            />
          )}

          {/* File attachments (image, video, audio, text preview, document card) - hidden for retracted */}
          {!message.isRetracted && <MessageAttachments attachment={message.attachment} onMediaLoad={onMediaLoad} isSelected={isSelected} isHovered={isHovered} />}

          {/* Link preview - hidden for retracted */}
          {!message.isRetracted && message.linkPreview && <LinkPreviewCard preview={message.linkPreview} onLoad={onMediaLoad} />}

          {/* Poll display - hidden for retracted */}
          {!message.isRetracted && message.poll && (
            <PollCard
              poll={message.poll}
              reactions={message.reactions ?? {}}
              myReactions={myReactions}
              onVote={onPollVote ?? handleReaction}
              onClosePoll={onClosePoll}
              isClosed={!!message.pollClosedAt}
              getReactorName={getReactorName}
            />
          )}

          {/* Poll closed result display */}
          {!message.isRetracted && message.pollClosed && (
            <PollClosedCard pollClosed={message.pollClosed} closedAt={message.timestamp} />
          )}
        </CollapsibleContent>

        {/* Reactions display — filter out poll-vote emojis so votes don't double-show as reaction pills */}
        <MessageReactions
          reactions={filteredReactions}
          myReactions={filteredMyReactions}
          onReaction={handleReaction}
          getReactorName={getReactorName}
          isRetracted={message.isRetracted}
        />

        {/* Delivery error indicator */}
        {message.deliveryError && (
          <div className="flex flex-col gap-1 pt-1">
            <div className="flex items-center gap-1.5 text-red-500">
              <AlertCircle className="size-3.5 flex-shrink-0" />
              <span className="text-xs font-medium">{t('chat.deliveryFailed')}</span>
              <span className="text-xs text-fluux-muted">—</span>
              <button
                onClick={() => setShowErrorDetails(!showErrorDetails)}
                className="text-xs text-fluux-muted hover:text-fluux-text cursor-pointer underline"
              >
                {t('chat.viewError')}
              </button>
              {onRetry && (
                <>
                  <span className="text-xs text-fluux-muted">·</span>
                  <button
                    onClick={onRetry}
                    className="text-xs text-fluux-link hover:text-fluux-link-hover cursor-pointer underline flex items-center gap-1"
                  >
                    <RefreshCw className="size-3" />
                    {t('chat.retry')}
                  </button>
                </>
              )}
            </div>
            {showErrorDetails && (
              <div className="text-xs text-fluux-muted ps-5 py-1 bg-red-500/5 rounded">
                {t('chat.errorDetails', { error: formatXMPPError(message.deliveryError) })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Avatar lightbox overlay */}
      {showAvatarLightbox && (
        <AvatarLightbox
          avatarUrl={avatarUrl}
          identifier={avatarIdentifier}
          name={senderName}
          fallbackColor={avatarFallbackColor}
          onClose={() => setShowAvatarLightbox(false)}
        />
      )}
    </div>
  )
}, arePropsEqual)

/**
 * Build the tooltip shown on hover of the per-message lock indicator.
 * Base line is protocol + trust; plugin-supplied `notes` are appended on
 * subsequent lines so the user can tell apart e.g. "signature did not
 * verify" (alarming) from "sender key not cached — signature not
 * checked" (benign, resolves after the peer is probed).
 */
function formatSecurityTooltip(
  t: (key: string, opts?: Record<string, unknown>) => string,
  ctx: NonNullable<BaseMessage['securityContext']>,
): string {
  const header = t('chat.encryption.tooltip.header')
  const protocol = t(`chat.encryption.tooltip.protocol.${ctx.protocolId}`, {
    defaultValue: ctx.protocolId,
  })
  const trust = t(`chat.encryption.tooltip.trust.${ctx.trust}`)
  const head = `${header} · ${protocol} · ${trust}`
  if (!ctx.notes || ctx.notes.length === 0) return head
  return [head, ...ctx.notes].join('\n')
}

/**
 * Helper to build reply context from a message and lookup functions.
 *
 * @param message - The message that has a replyTo
 * @param messagesById - Map to look up the original message
 * @param getSenderName - Function to get display name from sender ID
 * @param getSenderColor - Function to get color from sender ID
 * @param getAvatarInfo - Function to get avatar URL and identifier from sender
 * @returns ReplyContext or undefined if no reply
 */
export function buildReplyContext<T extends BaseMessage>(
  message: T,
  messagesById: Map<string, T>,
  getSenderName: (msg: T | undefined, fallbackId: string | undefined) => string,
  getSenderColor: (msg: T | undefined, fallbackId: string | undefined, isDarkMode?: boolean) => string,
  getAvatarInfo: (msg: T | undefined, fallbackId: string | undefined) => { avatarUrl?: string; avatarIdentifier: string },
  isDarkMode?: boolean
): MessageBubbleProps['replyContext'] {
  if (!message.replyTo) return undefined

  const originalMessage = messagesById.get(message.replyTo.id)
  const fallbackId = message.replyTo.to
  const senderName = getSenderName(originalMessage, fallbackId)
  const senderColor = getSenderColor(originalMessage, fallbackId, isDarkMode)
  // Use formatMessagePreview for consistent display (handles attachments, styling, etc.)
  const body = originalMessage
    ? formatMessagePreview(originalMessage) || 'Original message not found'
    : message.replyTo.fallbackBody || 'Original message not found'
  const { avatarUrl, avatarIdentifier } = getAvatarInfo(originalMessage, fallbackId)

  // Use the original message's actual ID for scrolling.
  // The replyTo.id may reference the stanza-id (from MAM), but the DOM uses
  // the client-generated message.id for data-message-id attributes.
  const messageId = originalMessage?.id ?? message.replyTo.id

  return {
    senderName,
    senderColor,
    body,
    messageId,
    avatarUrl,
    avatarIdentifier,
  }
}
