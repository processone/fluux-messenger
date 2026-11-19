import { iosHaptic } from '@/platform/ios/haptics'
/**
 * Shared MessageBubble component for both 1:1 chats and MUC rooms.
 *
 * Uses composition to handle view-specific rendering while sharing
 * the common bubble structure.
 */
import { useState, useMemo, useRef, useEffect, useContext, memo, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerUpRight, AlertCircle, RefreshCw, Shield, ShieldCheck, ShieldX, ShieldAlert, Ear, UserX } from 'lucide-react'
import { formatMessagePreview, formatXMPPError, getBareJid, type BaseMessage, type MentionReference, type Contact, type ContactIdentity, type RoomRole, type RoomAffiliation } from '@fluux/sdk'
import { useKeyDecisions } from '@/e2ee/openpgpTrustView'
import { useSettingsStore } from '@/stores/settingsStore'
import { Avatar } from '../Avatar'
import { NickText, NickSentence } from '../NickText'
import { AvatarLightbox } from '../AvatarLightbox'
import { MessageToolbar } from './MessageToolbar'
import { useForwardMessage } from './forwardMessageContext'
import { RoomMessageLinkPreview } from './RoomMessageLinkPreview'
import { forwardFallbackRange, forwardableText, forwardedCopyFallbackRange, withoutForwardFallback } from '@/utils/forwardMessage'
import { MessageBody } from './MessageBody'
import { renderQuotePreview } from '@/utils/messageStyles'
import { deriveCopyBody } from '@/utils/copyMessageBody'
import { isSpamModerated } from '@/utils/spamModeration'
import { EncryptedPlaceholder } from './EncryptedPlaceholder'
import { UnsupportedEncryptionNotice } from './UnsupportedEncryptionNotice'
import { MessageReactions } from './MessageReactions'
import { MessageReactorsSheet, type ReactorDetails } from './MessageReactorsSheet'
import { isActionMessage, type WhisperThreadPosition } from './messageGrouping'
import { messageRowId, messageWrapIdentity } from './messageRowIdentity'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'
import { messageRowRef, type MessageRowRef } from '@fluux/sdk'
import { useRequestMessageTarget } from './messageTargetContext'
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
import { MessageInteractionContext, useMessageInteractionHeld } from './useMessageInteractionHold'
import { downloadAttachment } from '@/utils/download'
import { roomMessageLinkFor } from '@/utils/roomMessageLink'
import { copyToClipboard } from '@/utils/clipboard'

type ReplyQuoteCardStyle = CSSProperties & {
  '--fluux-quote-frame-color': string
}

function replyQuoteCardStyle(senderColor: string): ReplyQuoteCardStyle {
  return {
    borderColor: senderColor,
    '--fluux-quote-frame-color': senderColor,
  }
}

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

  // Toolbar hover intent (row highlighting is owned by CSS)
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
  /** Occupant JID for profile-details fetch in anonymous rooms (e.g. room@conf/nick) */
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
  /** Handler for reaction clicks. When undefined, existing reactions remain viewable but cannot be toggled. */
  onReaction?: (emoji: string) => void
  getReactorName: (reactor: string) => string
  getReactorDetails?: (reactor: string) => ReactorDetails

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
    messageId: string | MessageRowRef
    avatarUrl?: string
    avatarIdentifier: string
  }

  // Room-specific: mentions for highlighting
  mentions?: MentionReference[]

  // Room-specific: user's nickname for IRC-style mention detection fallback
  nickname?: string

  // Mention lookup and color contracts: see MessageBodyProps.
  knownNicks?: ReadonlySet<string>
  resolveMentionColor?: (nick: string) => string | undefined
  mentionColors?: ReadonlyMap<string, string>

  // XEP-0425: Whether the current user can moderate (retract) this message
  canModerate?: boolean

  // Room-specific: true for IRC gateway channels (Biboumi). IRC has no concept of
  // retractions/corrections, so the edit + delete affordances are hidden. See #228.
  isIrcGateway?: boolean
  /** Whether the containing room archives its public messages. */
  supportsMAM?: boolean

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
   * Security context of the row that opened this row's avatar group. Set on
   * continuation rows: when this row's displayed trust differs from the
   * header's, the row shows its own trust badge in the avatar gutter.
   */
  groupSecurityContext?: BaseMessage['securityContext']
}

/**
 * Custom comparison for memo - compares data props, ignores callback props.
 * This prevents re-renders when only callback references change.
 */
function arePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  // Message identity and content
  if (prev.message.id !== next.message.id) return false
  if (messageRowId(prev.message) !== messageRowId(next.message)) return false
  if (prev.message.body !== next.message.body) return false
  if (JSON.stringify(prev.message.references) !== JSON.stringify(next.message.references)) return false
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
  for (const reactors of Object.values(next.message.reactions ?? {})) {
    for (const reactor of reactors) {
      if (prev.getReactorName(reactor) !== next.getReactorName(reactor)) return false
      const before = prev.getReactorDetails?.(reactor)
      const after = next.getReactorDetails?.(reactor)
      if (before?.name !== after?.name || before?.avatarIdentifier !== after?.avatarIdentifier || before?.avatarUrl !== after?.avatarUrl) return false
    }
  }

  // Security context — drives the lock/trust indicator. The SDK can mutate
  // this AFTER the message first arrives (e.g. the openpgp plugin upgrades
  // a previously-untrusted message to trusted once the sender's PEP key
  // finishes fetching). Without comparing it here React skips the render
  // and the lock badge stays at its stale value forever. Stringify mirrors
  // the reactions pattern above and is fine for a tiny three-field object.
  const prevSec = JSON.stringify(prev.message.securityContext ?? null)
  const nextSec = JSON.stringify(next.message.securityContext ?? null)
  if (prevSec !== nextSec) return false
  if (JSON.stringify(prev.groupSecurityContext ?? null) !== JSON.stringify(next.groupSecurityContext ?? null)) return false

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
  if (prev.message.poll !== next.message.poll) return false
  if (prev.message.pollClosed !== next.message.pollClosed) return false

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
  if ((prev.onReaction === undefined) !== (next.onReaction === undefined)) return false

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
  if (prev.supportsMAM !== next.supportsMAM) return false

  // Mentions - compare by reference (parent should memoize)
  if (prev.mentions !== next.mentions) return false
  if (prev.nickname !== next.nickname) return false
  if (prev.knownNicks !== next.knownNicks) return false
  if (prev.mentionColors !== next.mentionColors) return false

  // nickExtras - ReactNode, compare by reference (accept some re-renders)
  if (prev.nickExtras !== next.nickExtras) return false

  // Time format affects column width
  if (prev.timeFormat !== next.timeFormat) return false

  // Find-on-page current match
  if (prev.isCurrentMatch !== next.isCurrentMatch) return false

  // Own-message run identity — changes when grouping shifts, so the row can
  // (de)register from the shared-width coordinator.

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
  getReactorDetails,
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
  mentionColors,
  canModerate,
  isIrcGateway,
  supportsMAM = false,
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
  groupSecurityContext,
}: MessageBubbleProps) {
  const { t } = useTranslation()
  // Route jumps to the list this row is rendered in, so a click inside a search/activity preview
  // positions that preview instead of no-opping or scrolling the live conversation.
  const requestMessageTarget = useRequestMessageTarget()
  const [showReactionPicker, setShowReactionPickerState] = useState(false)
  const [showMoreMenu, setShowMoreMenuState] = useState(false)
  const interaction = useContext(MessageInteractionContext)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const rowId = messageRowId(message)
  // Stable between renders so the memoized body does not re-render; the late fields
  // (archive/origin/occupant ids) only change when backfill supplies them.
  const { id: msgId, type: msgType, from: msgFrom, originId, stanzaId, timestamp } = message
  const { conversationId, roomJid, occupantId, receivedAt } = message as { conversationId?: string; roomJid?: string; occupantId?: string; receivedAt?: Date }
  const wrapIdentity = useMemo(
    () => messageWrapIdentity({ id: msgId, type: msgType, conversationId, roomJid, from: msgFrom, originId, occupantId, stanzaId, timestamp, receivedAt }),
    [msgId, msgType, conversationId, roomJid, msgFrom, originId, occupantId, stanzaId, timestamp, receivedAt],
  )
  // This row's own backfill (same mounted occurrence gaining archive/origin ids) carries its stored
  // wrap choice along; an unmounted row or a look-alike twin never inherits one.
  const previousWrapIdentity = useRef(wrapIdentity)
  useEffect(() => {
    const previous = previousWrapIdentity.current
    previousWrapIdentity.current = wrapIdentity
    if (previous && wrapIdentity) useWrappedCodeBlocksStore.getState().promote(previous, wrapIdentity)
  }, [wrapIdentity])
  const interactionHeld = useMessageInteractionHeld(bubbleRef)
  const openMenusRef = useRef({ more: false, reaction: false })
  const [showAvatarLightbox, setShowAvatarLightbox] = useState(false)
  const [showErrorDetails, setShowErrorDetails] = useState(false)

  // Touch: long-press the message content opens the action menu — the touch
  // counterpart of the hover-only MessageToolbar. Handlers are attached
  // unconditionally (a mouse never fires touch events); native text selection is
  // suppressed on touch via `touch:select-none` so the hold opens the sheet cleanly.
  const [showActionSheet, setShowActionSheet] = useState(false)
  const forwardMessage = useForwardMessage()
  // A forward's quote and link stay until its source is on screen; then the preview replaces them.
  const [sourceShown, setSourceShown] = useState(false)
  const hasForwardFallback = !!forwardFallbackRange(message.references)
  const hideForwardFallback = hasForwardFallback && sourceShown
  // A copy that is shown replaces the quote it came with; a copy that is missing, retracted or
  // still encrypted leaves the quote visible.
  const copyShown = !!message.forwarded && !message.isRetracted && !message.encryptedPayload && !message.unsupportedEncryption
  const hideCopyQuote = copyShown && !!forwardedCopyFallbackRange(message)
  const shown = hideForwardFallback || hideCopyQuote ? withoutForwardFallback(message, mentions, hideCopyQuote) : { body: message.body, mentions }
  const [reactorEmoji, setReactorEmoji] = useState<string | null>(null)
  const actionAnchor = useRef<HTMLElement | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)
  const hasMessageActionsRef = useRef(false)

  // Clear a pending long-press timer if the row unmounts mid-press.
  useEffect(() => () => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }, [])

  // Trust color must track the user's key decisions LIVE, not freeze at decrypt
  // time. The plugin bakes `verified`/`tofu` onto the message when it's
  // decrypted; if the user verifies or refuses a key later, that baked value
  // never updates. So derive the displayed trust from the plugin's live
  // decisions about THIS message's signing key (resolveDisplayTrust), so a new
  // or server-substituted key can't inherit another key's verified lock.
  // A contact's decisions change only on an explicit decision (never during
  // sync/typing), and the view keeps the same object until then, so this
  // per-peer subscription is cheap.
  const keyDecisions = useKeyDecisions(message.isOutgoing ? null : getBareJid(message.from))
  const displayTrust = resolveDisplayTrust(message.securityContext, keyDecisions, message.isOutgoing)
  // A continuation row joins its group across trust changes within one protocol
  // (shouldShowAvatar), so it shows its own trust whenever that differs from
  // the header's. Both sides resolve through the same live key decisions: two
  // rows with the same stored trust can still differ once one signing key is
  // verified.
  const headerDisplayTrust = resolveDisplayTrust(groupSecurityContext, keyDecisions, message.isOutgoing)
  const showTrustCue = !showAvatar && !isActionMessage(message.body) && !!message.securityContext
    && !!groupSecurityContext
    && (groupSecurityContext.protocolId !== message.securityContext.protocolId || headerDisplayTrust !== displayTrust)

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

  const closeInteractionMenus = () => {
    openMenusRef.current = { more: false, reaction: false }
    setShowMoreMenuState(false)
    setShowReactionPickerState(false)
    onReactionPickerChange?.(false)
  }
  const reportMenus = () => {
    if (rowId) interaction?.setMenuOpen(rowId,
      openMenusRef.current.more || openMenusRef.current.reaction, closeInteractionMenus,
      bubbleRef.current?.closest<HTMLElement>('[data-message-row-id]') ?? undefined)
  }
  const setShowMoreMenu = (isOpen: boolean) => {
    openMenusRef.current.more = isOpen
    reportMenus()
    setShowMoreMenuState(isOpen)
  }
  // The picker remains a list interaction even when its pointer/focus leaves the row's box.
  const setShowReactionPicker = (isOpen: boolean) => {
    openMenusRef.current.reaction = isOpen
    reportMenus()
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
    return Object.fromEntries(
      Object.entries(reactions).filter(([emoji, reactors]) => reactors.length > 0 && !pollEmojiSet?.has(emoji))
    )
  }, [message.reactions, pollEmojiSet])

  const filteredMyReactions = useMemo(() => {
    if (!pollEmojiSet) return myReactions
    return myReactions.filter((emoji) => !pollEmojiSet.has(emoji))
  }, [myReactions, pollEmojiSet])

  // Whisper thread (XEP-0045 §7.5): a same-counterpart private run renders as one
  // bounded "private with X" container; the strip on the first row carries the label.
  const threadStart = whisperThread === 'start' || whisperThread === 'solo'
  const threadEnd = whisperThread === 'end' || whisperThread === 'solo'
  const outerRowClass = inThread
    ? `group flex gap-4 -mx-4 px-4 transition-colors ${threadStart ? 'pt-3' : ''} ${threadEnd ? 'pb-1.5' : ''}`
    : `group flex gap-4 -mx-4 px-4 py-0.5 ${showAvatar ? 'message-group-start' : ''}${isGroupEnd ? ' message-group-end' : ''}`

  // Action capabilities — shared by the hover toolbar (MessageToolbar) and the
  // touch action menu (MessageActionSheet) so the two surfaces stay in lock-step.

  // Forwards the parent's scroll re-pin when media reaches its final size, so the
  // timeline stays glued to the bottom.
  const handleMediaLoad = () => {
    onMediaLoad?.()
  }

  const { canReply, canEdit, canDelete } = actions
  const messageLink = roomMessageLinkFor(message, supportsMAM)
  const onCopyMessageLink = messageLink ? () => { void copyToClipboard(messageLink) } : undefined
  // A source that cannot be read, such as an undecryptable one, is forwarded as a link only.
  const readable = !message.isRetracted && !message.encryptedPayload && !message.unsupportedEncryption
  // A message holding a copy forwards its displayed comment and the copied text as one readable quote.
  const forwardText = readable ? (copyShown ? forwardableText(shown.body, message.forwarded) : message.body) : ''
  const quotable = !!forwardText.trim()
  // A room message forwards with its link; a one-to-one message has none, so it forwards its readable
  // content. A message read from an encrypted chat is marked so it can only go into an encrypted chat.
  const directForward = message.type === 'chat' && quotable && !message.deliveryError
  const onForward = forwardMessage && (messageLink || directForward) ? () => forwardMessage({
    ...(messageLink && { link: messageLink }),
    ...(quotable && { quote: {
      author: senderName,
      text: forwardText,
      ...(message.type === 'groupchat' && { from: message.from }),
      ...(directForward && { from: getBareJid(message.from) }),
      type: message.type,
      timestamp: message.timestamp.getTime(),
      ...(directForward && message.securityContext && { fromEncrypted: true }),
    } }),
  }) : undefined
  const canCopyBody = !!message.body && !message.isRetracted && !message.encryptedPayload && !message.unsupportedEncryption
  const saveableAttachment = !message.isRetracted && !message.encryptedPayload ? message.attachment : undefined
  const hasViewableReactions = !message.isRetracted && Object.keys(filteredReactions).length > 0
  useEffect(() => {
    if (!hasViewableReactions) setReactorEmoji(null)
  }, [hasViewableReactions])
  const hasMessageActions = !message.isRetracted && (actions.canReact || canReply || canEdit || canDelete || canCopyBody || !!saveableAttachment || hasViewableReactions || !!messageLink || !!onForward)

  // Long-press (touch) → open the action menu; scrolling (touchmove) or lifting
  // before the threshold cancels it. longPressFired suppresses the click that a
  // tap-and-hold would otherwise dispatch to an inner control on release.
  hasMessageActionsRef.current = hasMessageActions
  const handleContentTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    cancelLongPress()
    if (!hasMessageActions || event.touches.length > 1) return
    actionAnchor.current = event.currentTarget
    longPressFired.current = false
    longPressTimer.current = setTimeout(() => {
      if (!hasMessageActionsRef.current) return
      longPressFired.current = true
      setShowActionSheet(true)
      iosHaptic('contextMenu')
    }, 500)
  }
  const cancelLongPress = (event?: React.TouchEvent) => {
    // Consume release before its click can target an action portaled under the finger.
    if (event?.type === 'touchend' && longPressFired.current) event.preventDefault()
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

  const showSenderHeader = showAvatar && !isActionMessage(message.body)
  return (
    <div
      ref={bubbleRef}
      data-message-id={message.id}
      data-message-from={senderName}
      data-message-time={formatTime(message.timestamp)}
      data-message-body={deriveCopyBody(message, t)}
      data-hover-disabled={hasKeyboardSelection || isSelected || inThread ? '' : undefined}
      className={`relative message-hover-surface ${outerRowClass}`}
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
            onTouchMove={onNickTouchEnd}
            onTouchCancel={onNickTouchEnd}
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
        ) : showTrustCue ? (
          // The trust badge holds the gutter at rest; hovering swaps it for the
          // timestamp every continuation row reveals there. Touch has no hover,
          // so there the badge stays and the gutter timestamp is not shown.
          <div className="relative">
            <span data-msg-trust-cue="" className={`flex justify-center pt-1 leading-none ${isSelected ? 'opacity-0' : hasKeyboardSelection ? 'opacity-100' : 'opacity-100 group-hover:opacity-0 touch:opacity-100'} transition-opacity`}>
              <TrustBadge securityContext={message.securityContext!} displayTrust={displayTrust} />
            </span>
            <span className={`absolute inset-x-0 top-0 block text-center text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 touch:opacity-0'} transition-opacity`}>
              {formatTime(message.timestamp)}
            </span>
          </div>
        ) : (
          <span className={`block text-center text-[10px] text-fluux-muted font-mono pt-0.5 ${isSelected ? 'opacity-100' : hasKeyboardSelection ? 'opacity-0' : 'opacity-0 group-hover:opacity-100 touch:opacity-100'} transition-opacity`}>
            {formatTime(message.timestamp)}
          </span>
        )}
      </div>

      {/* Floating hover toolbar - hidden when user is composing or message is retracted */}
      {!message.isRetracted && (
        <MessageToolbar
          onReaction={handleReaction}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onCopyMessageLink={onCopyMessageLink}
          onForward={onForward}
          myReactions={reactionsEnabled ? myReactions : []}
          canReply={canReply}
          canEdit={canEdit}
          canDelete={canDelete}
          interactionHeld={interactionHeld}
          isHidden={hideToolbar || false}
          isSelected={isSelected || false}
          hasKeyboardSelection={hasKeyboardSelection || false}
          showToolbarForSelection={showToolbarForSelection || false}
          showReactionPicker={showReactionPicker}
          setShowReactionPicker={setShowReactionPicker}
          showMoreMenu={showMoreMenu}
          setShowMoreMenu={setShowMoreMenu}
          isHovered={isHovered}
          onToolbarMouseEnter={onMouseEnter}
        />
      )}

      {/* The content column spans the conversation's real content width whatever the
          row holds; useRowMetrics reads it to estimate row heights. */}
      <div className="relative flex-1 min-w-0" data-msg-column="">
      <div
        // Opacity keeps the previous focus target available while the overlay captures and restores focus.
        className={`relative ${showActionSheet ? 'opacity-0' : ''} w-full min-w-0 touch:select-none touch:[-webkit-touch-callout:none] ${inThread ? ` bg-fluux-private-soft border-x border-fluux-private-border px-2.5 py-1 ${threadStart ? 'border-t rounded-t-lg' : ''} ${threadEnd ? 'border-b rounded-b-lg' : ''}` : ''}`}
        data-msg-chrome={showAvatar ? 'header' : 'cont'}
        data-msg-outgoing={message.isOutgoing ? '' : undefined}
        // Whisper borders/padding are not the ordinary row's width or chrome.
        data-msg-whisper={inThread ? '' : undefined}
        // Paint selection on the outer row without changing this content box.
        data-msg-selected={isSelected ? '' : undefined}
        onTouchStart={handleContentTouchStart}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
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
        {showSenderHeader && (
          // Row-chrome sampling needs the sender header to tell header rows apart (useRowMetrics).
          <div data-msg-sender className="flex items-center gap-1 pb-1">
            <div className="flex flex-1 min-w-0 items-baseline gap-2 flex-wrap">
              <UserInfoPopover contact={senderContact} jid={senderJid} occupantJid={senderOccupantJid} role={senderRole} affiliation={senderAffiliation}>
                <span
                  className="font-medium"
                  style={{ color: senderColor }}
                  onContextMenu={onNickContextMenu}
                  // Stop the long-press from bubbling to the content wrapper so a
                  // hold on the nick opens the occupant menu, not the message sheet.
                  onTouchStart={(e) => { e.stopPropagation(); onNickTouchStart?.(e) }}
                  onTouchEnd={onNickTouchEnd}
                  onTouchMove={onNickTouchEnd}
                  onTouchCancel={onNickTouchEnd}
                >
                  <NickText nick={senderName} />
                </span>
              </UserInfoPopover>
              {nickExtras}
              <span className="text-xs text-fluux-muted">
                {formatTime(message.timestamp)}
              </span>
              {message.securityContext && (
                <TrustBadge securityContext={message.securityContext} displayTrust={displayTrust} />
              )}
            </div>
          </div>
        )}

        {/* Reply context - show what message this is replying to (hidden for retracted messages) */}
        {!message.isRetracted && replyContext && (
          <button
            type="button"
            onClick={() => requestMessageTarget(replyContext.messageId)}
            className="reply-quote-card flex items-start gap-1.5 py-1 pe-2 ps-2 mb-1.5 border-s-2 text-start min-w-0 max-w-full bg-fluux-bg-secondary hover:bg-fluux-hover/50 rounded-e transition-colors cursor-pointer select-none"
            // Bulk-copy selection frames the reply card with its sender hue.
            style={replyQuoteCardStyle(replyContext.senderColor)}
          >
            <CornerUpRight
              className="rtl-mirror size-3.5 flex-shrink-0 mt-0.5"
              style={{ color: replyContext.senderColor }}
            />
            <div className="text-sm text-fluux-muted min-w-0 max-w-full flex-1">
              <span
                className="font-medium"
                style={{ color: replyContext.senderColor }}
              ><NickText nick={replyContext.senderName} /></span>
              <div className="reply-quote-preview min-w-0 max-w-full [overflow-wrap:anywhere] opacity-75 max-h-16 overflow-hidden">{renderQuotePreview(replyContext.body)}</div>
            </div>
          </button>
        )}

        {/* Collapsible wrapper for long messages */}
        <CollapsibleContent messageId={messageRowId(message) ?? message.id} wrapIdentity={wrapIdentity} hasMedia={!!(message.attachment || message.linkPreview)}>
          {/* Encryption placeholders take precedence over body text so the
              sender's plaintext fallback never reaches the UI. encryptedPayload:
              an E2EE stanza we couldn't decrypt. unsupportedEncryption: a
              protocol no registered plugin handles (e.g. OMEMO). */}
          {message.encryptedPayload ? (
            <EncryptedPlaceholder reason={message.securityContext?.failureReason} />
          ) : message.unsupportedEncryption ? (
            <UnsupportedEncryptionNotice method={message.unsupportedEncryption.name} />
          ) : (hideForwardFallback && !shown.body) ? null : (
            <>
            {hasForwardFallback && !hideForwardFallback && (
              <div data-forward-quoted-copy className="text-xs text-fluux-muted mb-0.5">{t('chat.forwardQuotedCopy')}</div>
            )}
            <MessageBody
              wrapIdentity={wrapIdentity}
              body={shown.body}
              isEdited={message.isEdited}
              originalBody={message.originalBody}
              isRetracted={message.isRetracted}
              isModerated={message.isModerated}
              moderatedBy={message.moderatedBy}
              moderationReason={message.moderationReason}
              noStyling={message.noStyling}
              senderName={senderName}
              senderColor={senderColor}
              mentions={shown.mentions}
              nickname={nickname}
              knownNicks={knownNicks}
              resolveMentionColor={resolveMentionColor}
              mentionColors={mentionColors}
              isDarkMode={isDarkMode}
              highlightTerms={highlightTerms}
              isCurrentMatch={isCurrentMatch}
            />
            </>
          )}

          {message.forwarded && !message.isRetracted && !message.encryptedPayload && !message.unsupportedEncryption && (
            <div data-forwarded-copy className="mt-1 pl-2 border-l-2 border-fluux-hover">
              <div className="text-xs text-fluux-muted">
                {t('chat.forwardedCopyLabel', { author: message.forwarded.author || t('chat.forwardedCopyUnknownAuthor') })}
                {message.forwarded.timestamp !== undefined && ` · ${formatTime(new Date(message.forwarded.timestamp))}`}
              </div>
              <div className="text-sm text-fluux-text whitespace-pre-wrap break-words">{message.forwarded.text}</div>
            </div>
          )}

          {/* A structured copy already shows the source, so no second preview of the same link. */}
          {!(message.forwarded && !message.isRetracted) && <RoomMessageLinkPreview message={message} formatTime={formatTime} isDarkMode={isDarkMode} onSourceShown={hasForwardFallback ? setSourceShown : undefined} />}

          {/* File attachments (image, video, audio, text preview, document card) - hidden for retracted */}
          {!message.isRetracted && <MessageAttachments attachment={message.attachment} onMediaLoad={handleMediaLoad} isOwnMessage={message.isOutgoing} />}

          {/* Link preview - hidden for retracted */}
          {!message.isRetracted && message.linkPreview && <LinkPreviewCard preview={message.linkPreview} onLoad={handleMediaLoad} isOwnMessage={message.isOutgoing} />}

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
          onShowReactors={setReactorEmoji}
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
                type="button"
                onClick={() => setShowErrorDetails(!showErrorDetails)}
                className="text-xs text-fluux-muted hover:text-fluux-text cursor-pointer underline"
              >
                {t('chat.viewError')}
              </button>
              {onRetry && (
                <>
                  <span className="text-xs text-fluux-muted">·</span>
                  <button
                    type="button"
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

      {reactorEmoji !== null && hasViewableReactions && (
        <MessageReactorsSheet
          reactions={filteredReactions}
          initialEmoji={reactorEmoji}
          getReactorName={getReactorName}
          getReactorDetails={getReactorDetails}
          onClose={() => setReactorEmoji(null)}
        />
      )}

      {/* Touch action menu — opened by a long press.
          Mounted only while open so the list never carries one menu per row. */}
      {showActionSheet && (
        <MessageActionSheet
          open
          anchor={actionAnchor.current}
          onClose={() => {
            longPressFired.current = false
            setShowActionSheet(false)
          }}
          onReaction={handleReaction}
          myReactions={reactionsEnabled ? myReactions : []}
          onShowReactors={hasViewableReactions ? () => setReactorEmoji(Object.keys(filteredReactions)[0]) : undefined}
          body={message.body}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onCopyMessageLink={onCopyMessageLink}
          onForward={onForward}
          onSaveAttachment={saveableAttachment
            ? () => downloadAttachment(saveableAttachment, { errorMessage: t('common.downloadFailed') })
            : undefined}
          canReply={canReply}
          canEdit={canEdit}
          canDelete={canDelete}
        />
      )}
    </div>
  )
}, arePropsEqual)

/** Lock badge for an encrypted message, coloured and shaped by its displayed trust. */
function TrustBadge({ securityContext, displayTrust }: {
  securityContext: NonNullable<BaseMessage['securityContext']>
  displayTrust: NonNullable<BaseMessage['securityContext']>['trust'] | undefined
}) {
  const { t } = useTranslation()
  return (
    <Tooltip content={formatSecurityTooltip(t, { ...securityContext, trust: displayTrust ?? securityContext.trust })} position="top" triggerMode="click">
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
        aria-label={`Encrypted with ${securityContext.protocolId}, trust ${displayTrust}`}
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
  )
}

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
  originalMessage: T | null | undefined,
  getSenderName: (msg: T | undefined, fallbackId: string | undefined) => string,
  getSenderColor: (msg: T | undefined, fallbackId: string | undefined, isDarkMode?: boolean) => string,
  getAvatarInfo: (msg: T | undefined, fallbackId: string | undefined) => { avatarUrl?: string; avatarIdentifier: string },
  isDarkMode?: boolean
): MessageBubbleProps['replyContext'] {
  if (!message.replyTo || originalMessage === null || (originalMessage && isSpamModerated(originalMessage))) return undefined

  const fallbackId = message.replyTo.to
  const senderName = getSenderName(originalMessage, fallbackId)
  const senderColor = getSenderColor(originalMessage, fallbackId, isDarkMode)
  // Use formatMessagePreview for consistent display (handles attachments, styling, etc.)
  const body = (originalMessage?.isRetracted && message.replyTo.fallbackBody)
    || (originalMessage ? formatMessagePreview(originalMessage) : message.replyTo.fallbackBody)
    || 'Original message not found'
  const { avatarUrl, avatarIdentifier } = getAvatarInfo(originalMessage, fallbackId)

  const messageId = (originalMessage?.type === 'groupchat' ? messageRowRef(originalMessage) : originalMessage?.id)
    ?? message.replyTo.id

  return {
    senderName,
    senderColor,
    body,
    messageId,
    avatarUrl,
    avatarIdentifier,
  }
}
