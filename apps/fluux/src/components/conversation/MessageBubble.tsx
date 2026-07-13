/**
 * Shared MessageBubble component for both 1:1 chats and MUC rooms.
 *
 * Uses composition to handle view-specific rendering while sharing
 * the common bubble structure.
 */
import { useState, useMemo, useRef, useEffect, memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerUpRight, AlertCircle, RefreshCw, Shield, ShieldCheck, ShieldX, ShieldAlert, Ear, UserX } from 'lucide-react'
import { formatMessagePreview, formatXMPPError, getBareJid, type BaseMessage, type MentionReference, type Contact, type ContactIdentity, type RoomRole, type RoomAffiliation } from '@fluux/sdk'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { Avatar } from '../Avatar'
import { NickText, NickSentence } from '../NickText'
import { AvatarLightbox } from '../AvatarLightbox'
import { MessageToolbar } from './MessageToolbar'
import { MessageBody } from './MessageBody'
import { renderQuotePreview } from '@/utils/messageStyles'
import { EncryptedPlaceholder } from './EncryptedPlaceholder'
import { UnsupportedEncryptionNotice } from './UnsupportedEncryptionNotice'
import { MessageReactions } from './MessageReactions'
import { scrollToMessage, isActionMessage, type WhisperThreadPosition } from './messageGrouping'
import { useOwnGroupWidth } from './messageGroupWidth'
import { resolveDisplayTrust } from './messageTrust'
import { trustVisual } from '@/e2ee/trustVisual'
import { MessageAttachments } from '../MessageAttachments'
import { LinkPreviewCard } from '../LinkPreviewCard'
import { UserInfoPopover } from './UserInfoPopover'
import { CollapsibleContent } from './CollapsibleContent'
import { PollCard } from './PollCard'
import { PollClosedCard } from './PollClosedCard'
import { Tooltip } from '../Tooltip'
import { MessageActionSheet } from './MessageActionSheet'
import { computeMessageActions } from './messageActionCapabilities'

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
  /**
   * Whether this row is the LAST in its avatar-group (the next message starts a
   * new group, or this is the last message). Combined with `showAvatar` (group
   * start), it lets the own-message tint render a run of outgoing messages as one
   * continuous surface — rounded at the top of the first and bottom of the last —
   * so the group's lock/trust indicator visually covers every message under it.
   * Defaults to true so a standalone bubble renders a fully-rounded solo surface.
   */
  isGroupEnd?: boolean
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
  /**
   * Whether the whisper counterpart is currently in the room. When false, the
   * thread's last row shows a "no longer in the room" note and reply is disabled.
   * Undefined = treated as present (e.g. non-whisper messages).
   */
  counterpartPresent?: boolean

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

  // Room-specific: stable resolver giving a mention pill the same color as the
  // mentioned person's name (roster contact's XEP-0392 color, else nick hash).
  resolveMentionColor?: (nick: string) => string | undefined

  // XEP-0425: Whether the current user can moderate (retract) this message
  canModerate?: boolean

  // Room-specific: true for IRC gateway channels (Biboumi). IRC has no concept of
  // retractions/corrections, so the edit + delete affordances are hidden. See #228.
  isIrcGateway?: boolean

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

  /**
   * Key of the consecutive own-message run this row belongs to (from
   * {@link ownGroupKey}); undefined for incoming or solo own messages. When set,
   * the row's tint box shares the run's widest width so the own-message tint
   * reads as one clean rectangle instead of a ragged, per-row hug.
   */
  ownGroupKey?: string
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
  if (prev.counterpartPresent !== next.counterpartPresent) return false
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
  if (prev.isGroupEnd !== next.isGroupEnd) return false
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
    if (prev.replyContext.senderColor !== next.replyContext.senderColor) return false
    if (prev.replyContext.avatarUrl !== next.replyContext.avatarUrl) return false
    if (prev.replyContext.avatarIdentifier !== next.replyContext.avatarIdentifier) return false
  }

  // Dark mode (affects mention colors)
  if (prev.isDarkMode !== next.isDarkMode) return false

  // Moderation permission
  if (prev.canModerate !== next.canModerate) return false

  // IRC-gateway flag gates edit/delete affordances
  if (prev.isIrcGateway !== next.isIrcGateway) return false

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

  // Own-message run identity — changes when grouping shifts, so the row can
  // (de)register from the shared-width coordinator.
  if (prev.ownGroupKey !== next.ownGroupKey) return false

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
  isGroupEnd = true,
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
  counterpartPresent,
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
  resolveMentionColor,
  canModerate,
  isIrcGateway,
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
  ownGroupKey,
}: MessageBubbleProps) {
  const { t } = useTranslation()
  const [showReactionPicker, setShowReactionPickerState] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showAvatarLightbox, setShowAvatarLightbox] = useState(false)
  const [showErrorDetails, setShowErrorDetails] = useState(false)

  // Touch: long-press the message content opens the action sheet — the touch
  // counterpart of the hover-only MessageToolbar. Handlers are attached
  // unconditionally (a mouse never fires touch events); native text selection is
  // suppressed on touch via `touch:select-none` so the hold opens the sheet cleanly.
  const [showActionSheet, setShowActionSheet] = useState(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)

  // Clear a pending long-press timer if the row unmounts mid-press.
  useEffect(() => () => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }, [])

  // Trust color must track verification LIVE, not freeze at decrypt time.
  // The plugin bakes `verified`/`tofu` onto the message when it's decrypted; if
  // the user verifies the peer later, that baked value never updates. So derive
  // the displayed trust from the live verification store — but confirm the
  // verified fingerprint against THIS message's signing key (resolveDisplayTrust),
  // so a rotated or server-substituted key can't inherit a stale verified lock.
  // The store only changes on explicit verify/un-verify (never during
  // sync/typing), so this per-peer subscription is cheap.
  const verifiedFingerprint = useVerifiedPeerKeysStore(
    (s) => s.verifiedFingerprintByJid[getBareJid(message.from)],
  )
  const displayTrust = resolveDisplayTrust(message.securityContext, verifiedFingerprint, message.isOutgoing)

  // Density-aware avatar: reads only `densityMode` (narrow selector) so this row
  // only re-renders on a density change, NOT on message append or composing toggle.
  // Do NOT add densityMode to arePropsEqual or thread it as a prop.
  const densityMode = useSettingsStore((s) => s.densityMode)
  const avatarSize = densityMode === 'compact' ? 'sm' : 'md'
  const avatarColWidth = densityMode === 'compact'
    ? (timeFormat === '12h' ? 'w-10' : 'w-8')
    : (timeFormat === '12h' ? 'w-12' : 'w-10')

  const inThread = !!whisperThread
  const counterpartGone = inThread && counterpartPresent === false

  // Whether reactions are enabled for this message (room has stable occupant identity)
  const reactionsEnabled = onReaction !== undefined

  const actions = computeMessageActions({
    isOutgoing: message.isOutgoing,
    isPrivate: inThread,
    isLastOutgoing,
    isLastMessage,
    inThread,
    counterpartGone,
    isIrcGateway: isIrcGateway ?? false,
    canModerate: canModerate === true,
    reactionsEnabled,
  })

  // Wrap setShowReactionPicker to notify parent
  const setShowReactionPicker = (isOpen: boolean) => {
    setShowReactionPickerState(isOpen)
    onReactionPickerChange?.(isOpen)
  }

  // actions.canReact implies reactionsEnabled (i.e. onReaction !== undefined).
  const handleReaction = actions.canReact ? (emoji: string) => {
    onReaction!(emoji)
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
    ? (isHovered ? 'bg-fluux-message-hover' : '')
    : (hasKeyboardSelection ? '' : 'hover:bg-fluux-message-hover')

  // Whisper thread (XEP-0045 §7.5): a same-counterpart private run renders as one
  // bounded "private with X" container; the strip on the first row carries the label.
  const threadStart = whisperThread === 'start' || whisperThread === 'solo'
  const threadEnd = whisperThread === 'end' || whisperThread === 'solo'
  const outerRowClass = inThread
    ? `group flex gap-4 -mx-4 px-4 transition-colors ${threadStart ? 'pt-3' : ''} ${threadEnd ? 'pb-1.5' : ''}`
    : `group flex gap-4 ${hoverClass} -mx-4 px-4 py-0.5 transition-colors ${showAvatar ? 'message-group-start' : ''}${isGroupEnd ? ' message-group-end' : ''}`

  // Action capabilities — shared by the hover toolbar (MessageToolbar) and the
  // touch action sheet (MessageActionSheet) so the two surfaces stay in lock-step.
  // Own-message tint as a continuous surface across an avatar-group: `showAvatar`
  // marks the group start (round the top), `isGroupEnd` the last row (round the
  // bottom); interior rows stay square and the tint bridges the inter-row gap so
  // the run reads as one panel under the group's lock indicator. Suppressed in a
  // whisper thread (the bounded "private with X" card owns the fill there).
  const ownTint = message.isOutgoing && !inThread
  const ownTintClass = ownTint
    ? `message-own-tint${showAvatar ? ' message-own-tint-start' : ''}${isGroupEnd ? ' message-own-tint-end' : ''}`
    : ''
  // Tighten the interior junctions of an own-message group so the merged surface
  // reads as one block rather than messages separated by a blank line: a
  // continuation row (no avatar) pulls up toward the message above; a row that a
  // continuation follows (not the group end) pulls down toward the one below.
  const ownRowClass = ownTint
    ? `${!showAvatar ? ' message-own-cont-top' : ''}${!isGroupEnd ? ' message-own-cont-bottom' : ''}`
    : ''
  // Own-message tint hugs its content instead of spanning the row: `w-fit` sizes
  // the filled surface to the widest line (body or the name+time header) and
  // `max-w-full` still wraps long messages at the available width. The tint box
  // sits inside a full-width positioning column (see below), so incoming rows and
  // whisper cards fill that column with `w-full`; their layout is unchanged.
  const contentWidthClass = ownTint ? 'w-fit max-w-full' : 'w-full'
  // A run of consecutive own messages shares its widest line's width so the tint
  // reads as one clean rectangle rather than a ragged per-row hug. `ownGroupKey`
  // is already undefined unless this is a MULTI-row own run; gate on `ownTint`
  // too so a whisper-thread own message (a `flex-1` card) never gets pinned. The
  // signature captures every field that changes the row's natural width so the
  // group re-fits on content edits but not on hover/selection churn.
  const ownGroupWidthSignature = `${message.body ?? ''}|${showAvatar ? 1 : 0}|${timeFormat}|${message.isRetracted ? 1 : 0}|${message.isEdited ? 1 : 0}|${JSON.stringify(message.reactions ?? {})}|${replyContext?.messageId ?? ''}|${message.attachment ? 1 : 0}|${message.linkPreview ? 1 : 0}|${message.poll ? 1 : 0}|${message.encryptedPayload ? 1 : 0}|${message.unsupportedEncryption?.name ?? ''}`
  const ownGroupRef = useOwnGroupWidth(ownTint ? ownGroupKey : undefined, message.id, ownGroupWidthSignature)

  const { canReply, canEdit, canDelete } = actions
  const canCopyBody = !!message.body && !message.isRetracted && !message.encryptedPayload && !message.unsupportedEncryption
  const hasMessageActions = !message.isRetracted && (actions.canReact || canReply || canEdit || canDelete || canCopyBody)

  // Long-press (touch) → open the action sheet; scrolling (touchmove) or lifting
  // before the threshold cancels it. longPressFired suppresses the click that a
  // tap-and-hold would otherwise dispatch to an inner control on release.
  const handleContentTouchStart = () => {
    if (!hasMessageActions) return
    longPressFired.current = false
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true
      setShowActionSheet(true)
    }, 500)
  }
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }
  const swallowPostLongPressClick = (e: React.MouseEvent) => {
    if (longPressFired.current) {
      e.preventDefault()
      e.stopPropagation()
      longPressFired.current = false
    }
  }

  return (
    <div
      data-message-id={message.id}
      data-message-from={senderName}
      data-message-time={formatTime(message.timestamp)}
      data-message-body={message.body || ''}
      className={`${outerRowClass}${ownRowClass}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Avatar, timestamp (when selected), or spacer - width adapts to time format and density */}
      <div className={`${avatarColWidth} flex-shrink-0 flex flex-col`}>
        {/* /me action messages always show timestamp instead of avatar */}
        {isActionMessage(message.body) ? (
          <span className={`block text-center text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 touch:opacity-100'} transition-opacity`}>
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
              size={avatarSize}
              presence={avatarPresence}
              presenceBorderColor="border-fluux-chat"
            />
          </div>
        ) : (
          <span className={`block text-center text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 touch:opacity-100'} transition-opacity`}>
            {formatTime(message.timestamp)}
          </span>
        )}
      </div>

      {/* Content. The own-message tint is suppressed inside a whisper thread
          (`!inThread`): it sets its own `background` (overriding the bounded
          card's purple fill) and widens the row via margin-inline, which would
          mismatch the fill and knock the side borders 8px out of alignment with
          the incoming rows — shattering the single "private with X" card. The
          name header already carries the own-vs-counterpart distinction. */}
      {/* Full-width positioning column. The hover toolbar is anchored here (not
          inside the tint box) so it pins to the row's right edge and keeps a
          stable position regardless of how narrow the own-message tint hugs its
          content. Incoming rows already spanned the full width, so their toolbar
          position is unchanged. */}
      <div className="relative flex-1 min-w-0">
        {/* Floating hover toolbar - hidden when user is composing or message is retracted */}
        {!message.isRetracted && (
          <MessageToolbar
            onReaction={handleReaction}
            onReply={onReply}
            onEdit={onEdit}
            onDelete={onDelete}
            myReactions={reactionsEnabled ? myReactions : []}
            canReply={canReply}
            canEdit={canEdit}
            canDelete={canDelete}
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
      <div
        ref={ownGroupRef}
        className={`relative ${contentWidthClass} min-w-0 touch:select-none touch:[-webkit-touch-callout:none] ${isSelected || showActionSheet ? 'bg-fluux-selection -my-0.5 py-0.5 -ms-2 ps-2 -me-4 pe-4 rounded-s' : ''}${inThread ? ` bg-fluux-private-soft border-x border-fluux-private-border px-2.5 py-1 ${threadStart ? 'border-t rounded-t-lg' : ''} ${threadEnd ? 'border-b rounded-b-lg' : ''}` : ''} ${ownTintClass}`}
        data-msg-chrome={showAvatar ? 'header' : 'cont'}
        // Marks hug-width (w-fit) own bubbles so useRowMetrics never samples their text box
        // as the conversation's content width (it is only as wide as the text itself).
        data-msg-own={ownTint ? '' : undefined}
        onTouchStart={handleContentTouchStart}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        onClickCapture={swallowPostLongPressClick}
      >
        {threadStart && (counterpartGone ? (
          <div className="flex items-center gap-1.5 pb-1 text-xs font-medium text-fluux-private">
            <Ear className="size-3.5 shrink-0" />
            <span className="truncate"><NickSentence i18nKey="rooms.whisperThread" nick={whisperWith} /></span>
          </div>
        ) : (
          // Clicking the header re-enters whisper mode (same flow as the
          // toolbar reply button); read-only threads keep the plain label.
          <button
            type="button"
            onClick={onReply}
            title={t('rooms.sendPrivateMessage')}
            className="flex max-w-full cursor-pointer items-center gap-1.5 -ms-1 mb-0.5 rounded px-1 py-0.5 text-xs font-medium text-fluux-private transition-colors hover:bg-fluux-private-hover"
          >
            <Ear className="size-3.5 shrink-0" />
            <span className="truncate"><NickSentence i18nKey="rooms.whisperThread" nick={whisperWith} /></span>
          </button>
        ))}
        {/* Nick header - hidden for /me action messages (nick is shown inline) */}
        {showAvatar && !isActionMessage(message.body) && (
          <div className="flex items-baseline gap-2 pb-1 flex-wrap">
            <UserInfoPopover contact={senderContact} jid={senderJid} occupantJid={senderOccupantJid} role={senderRole} affiliation={senderAffiliation}>
              <span
                className="font-medium"
                style={{ color: senderColor }}
                onContextMenu={onNickContextMenu}
                // Stop the long-press from bubbling to the content wrapper so a
                // hold on the nick opens the occupant menu, not the message sheet.
                onTouchStart={(e) => { e.stopPropagation(); onNickTouchStart?.(e) }}
                onTouchEnd={onNickTouchEnd}
              >
                <NickText nick={senderName} />
              </span>
            </UserInfoPopover>
            {nickExtras}
            <span className="text-xs text-fluux-muted">
              {formatTime(message.timestamp)}
            </span>
            {message.securityContext && (
              <Tooltip content={formatSecurityTooltip(t, { ...message.securityContext, trust: displayTrust ?? message.securityContext.trust })} position="top" triggerMode="click">
                <span
                  className={`flex items-center ${trustVisual(
                    displayTrust === 'verified'
                      ? 'verified'
                      : displayTrust === 'rejected'
                      ? 'rejected'
                      : displayTrust === 'untrusted'
                      ? 'decryptFailed'
                      : 'trusted'
                  ).colorClass}`}
                  aria-label={`Encrypted with ${message.securityContext.protocolId}, trust ${displayTrust}`}
                >
                  {displayTrust === 'verified'
                    ? <ShieldCheck className="size-3" />
                    : displayTrust === 'rejected'
                    ? <ShieldX className="size-3" />
                    : displayTrust === 'untrusted'
                    ? <ShieldAlert className="size-3" />
                    : <Shield className="size-3" />}
                </span>
              </Tooltip>
            )}
          </div>
        )}

        {/* Reply context - show what message this is replying to (hidden for retracted messages) */}
        {!message.isRetracted && replyContext && (
          <button
            onClick={() => scrollToMessage(replyContext.messageId)}
            className="flex items-start gap-1.5 py-1 pe-2 ps-2 mb-1.5 border-s-2 text-start min-w-0 bg-fluux-bg-secondary hover:bg-fluux-hover/50 rounded-e transition-colors cursor-pointer select-none"
            style={{ borderColor: replyContext.senderColor }}
          >
            <CornerUpRight
              className="rtl-mirror size-3.5 flex-shrink-0 mt-0.5"
              style={{ color: replyContext.senderColor }}
            />
            <div className="text-sm text-fluux-muted min-w-0 flex-1">
              <span
                className="font-medium"
                style={{ color: replyContext.senderColor }}
              ><NickText nick={replyContext.senderName} /></span>
              <div className="reply-quote-preview opacity-75 max-h-16 overflow-hidden">{renderQuotePreview(replyContext.body)}</div>
            </div>
          </button>
        )}

        {/* Collapsible wrapper for long messages */}
        <CollapsibleContent messageId={message.id} isSelected={isSelected} isHovered={isHovered} hasMedia={!!(message.attachment || message.linkPreview)}>
          {/* Encryption placeholders take precedence over body text so the
              sender's plaintext fallback never reaches the UI. encryptedPayload:
              an E2EE stanza we couldn't decrypt. unsupportedEncryption: a
              protocol no registered plugin handles (e.g. OMEMO). */}
          {message.encryptedPayload ? (
            <EncryptedPlaceholder />
          ) : message.unsupportedEncryption ? (
            <UnsupportedEncryptionNotice method={message.unsupportedEncryption.name} />
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
              resolveMentionColor={resolveMentionColor}
              isDarkMode={isDarkMode}
              highlightTerms={highlightTerms}
              isCurrentMatch={isCurrentMatch}
            />
          )}

          {/* File attachments (image, video, audio, text preview, document card) - hidden for retracted */}
          {!message.isRetracted && <MessageAttachments attachment={message.attachment} onMediaLoad={onMediaLoad} isSelected={isSelected} isHovered={isHovered} isOwnMessage={message.isOutgoing} />}

          {/* Link preview - hidden for retracted */}
          {!message.isRetracted && message.linkPreview && <LinkPreviewCard preview={message.linkPreview} onLoad={onMediaLoad} isOwnMessage={message.isOutgoing} />}

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
            <div className="flex items-center gap-1.5 text-fluux-error">
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

        {/* Whisper thread footer: counterpart is no longer in the room — reply disabled */}
        {threadEnd && counterpartGone && (
          <div className="flex items-center gap-1.5 pt-1.5 text-xs text-fluux-muted">
            <UserX className="size-3.5 shrink-0" />
            <span className="truncate"><NickSentence i18nKey="rooms.whisperCounterpartGone" nick={whisperWith} /></span>
          </div>
        )}
      </div>
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

      {/* Touch action sheet — opened by long-pressing the message content.
          Mounted only while open so the list never carries one sheet per row. */}
      {showActionSheet && (
        <MessageActionSheet
          open
          onClose={() => setShowActionSheet(false)}
          onReaction={handleReaction}
          myReactions={reactionsEnabled ? myReactions : []}
          body={message.body}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          canReply={canReply}
          canEdit={canEdit}
          canDelete={canDelete}
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
 * Build the reply-context view model for a message's quoted reply.
 *
 * The referenced ("original") message is resolved by the caller — reactively,
 * via `useReferencedMessage` — and passed in directly. buildReplyContext does
 * NOT look it up itself: a render-time lookup inside a memoized row freezes on
 * the XEP-0428 fallback when the target only loads later. When `originalMessage`
 * is undefined the reply's `fallbackBody` is shown instead.
 *
 * @param message - The message that has a replyTo
 * @param originalMessage - The resolved referenced message, or undefined if not (yet) available
 * @param getSenderName - Function to get display name from sender ID
 * @param getSenderColor - Function to get color from sender ID
 * @param getAvatarInfo - Function to get avatar URL and identifier from sender
 * @returns ReplyContext or undefined if no reply
 */
export function buildReplyContext<T extends BaseMessage>(
  message: T,
  originalMessage: T | undefined,
  getSenderName: (msg: T | undefined, fallbackId: string | undefined) => string,
  getSenderColor: (msg: T | undefined, fallbackId: string | undefined, isDarkMode?: boolean) => string,
  getAvatarInfo: (msg: T | undefined, fallbackId: string | undefined) => { avatarUrl?: string; avatarIdentifier: string },
  isDarkMode?: boolean
): MessageBubbleProps['replyContext'] {
  if (!message.replyTo) return undefined

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
