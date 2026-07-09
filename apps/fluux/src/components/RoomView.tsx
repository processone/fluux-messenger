import React, { useState, useRef, useEffect, useCallback, useImperativeHandle, useMemo, memo, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useRoomActive, usePolls, useRoomModeration, useRoomManagement, useRoomEntity, useContactIdentities, getBareJid, generateConsistentColorHexSync, useReferencedMessage, isMessageFromIgnoredUser, isReplyToIgnoredUser, filterIgnoredReactions, canKick, canBan, getAvailableAffiliations, getAvailableRoles, getMyReactions, WhisperCounterpartGoneError, type RoomMessage, type Room, type RoomOccupant, type MentionReference, type ChatStateNotification, type ContactIdentity, type FileAttachment, type RoomAffiliation, type RoomRole, type PollData } from '@fluux/sdk'
import { useConnectionStore, useIgnoreStore, useRoomStore } from '@fluux/sdk/react'
import { ignoreStore, roomStore, type IgnoredUser } from '@fluux/sdk/stores'
import { useMentionAutocomplete, useFileUpload, useLinkPreview, useTypeToFocus, useMessageCopy, useMode, useMessageSelection, useMessageHoverState, useDragAndDrop, useConversationDraft, useTimeFormat, useContextMenu, useWhisperCounterpartPresent, useRoomOccupantCountBelow, isSmallScreen } from '@/hooks'
import { MessageBubble, MessageList, RoomSystemLine, shouldShowAvatar, ownGroupKey as computeOwnGroupKey, whisperThreadPosition, whisperCounterpartPresent, resolveWhisperTarget, decideWhisperSend, decideChatStateRoute, buildReplyContext, canClosePoll, PollBanner, type WhisperThreadPosition, type WhisperTarget } from './conversation'
import { FindOnPageBar } from './conversation/FindOnPageBar'
import { useFindOnPage, type FindOnPageHandle } from '@/hooks/useFindOnPage'
import { Avatar } from './Avatar'
import { selectSelfOccupant, stableNickSet, resolveRoomSender, resolveReplyAvatar, resolveSenderColor, resolveNickColor } from './conversation/roomSenderResolution'
import { selectRoomInitialLoading } from './conversation/roomLoadingState'
import { format } from 'date-fns'
import type { CopyMessageMeta } from '@/utils/buildCopyText'
import { Shield, Crown, Upload, Loader2, LogIn, AlertCircle, Users, MessageCircle, EyeOff, User, Settings, Ear, X, Hash } from 'lucide-react'
import { ChristmasAnimation } from './ChristmasAnimation'
import { TextInput, TextArea } from './ui/TextInput'
import { MessageComposer, type ReplyInfo, type EditInfo, type MessageComposerHandle, type PendingAttachment, MESSAGE_INPUT_BASE_CLASSES, MESSAGE_INPUT_OVERLAY_CLASSES } from './MessageComposer'
import { RoomHeader } from './RoomHeader'
import { OccupantPanel } from './OccupantPanel'
import { OccupantModerationModal } from './OccupantModerationModal'
import { PollCreator } from './PollCreator'
import { MenuButton, MenuDivider } from './sidebar-components/SidebarListMenu'
import { Tooltip } from './Tooltip'
import { useToastStore } from '@/stores/toastStore'
import { findLastEditableMessage, findLastEditableMessageId } from '@/utils/messageUtils'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'
import { ConfirmDialog } from './ConfirmDialog'
import { ModalOverlay } from './ModalOverlay'
import { useRoomCommandContext } from '@/hooks/useRoomCommandContext'
import { useSlashCommands } from '@/hooks/useSlashCommands'
import { useCommandMenu } from '@/hooks/useCommandMenu'
import { CommandMenu } from './composer/CommandMenu'
import { CommandHelpPanel } from './composer/CommandHelpPanel'
import { visibleCommands } from '@/commands/registry'
import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'
import { MediaAutoloadProvider } from '@/contexts'
import { computeMediaAutoload } from '@/utils/mediaAutoload'
import { useSettingsStore } from '@/stores/settingsStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
import { auroraSenderColor, nickColorSeed } from '@/utils/senderColor'
import { ReactionMentions } from './conversation/ReactionMentions'
import { reactionMentionStore } from '@/stores/reactionMentionStore'

// Generate hat colors from URI using XEP-0392 consistent color
function getHatColors(hat: { uri: string; hue?: number }) {
  if (hat.hue !== undefined) {
    // Use server-provided hue: light background, dark text
    return {
      backgroundColor: `hsl(${hat.hue}, 50%, 85%)`,
      color: `hsl(${hat.hue}, 70%, 25%)`,
    }
  }
  // Generate consistent colors from hat URI: light background, dark text
  const bgColor = generateConsistentColorHexSync(hat.uri, { saturation: 50, lightness: 85 })
  const textColor = generateConsistentColorHexSync(hat.uri, { saturation: 70, lightness: 25 })
  return {
    backgroundColor: bgColor,
    color: textColor,
  }
}

interface RoomViewProps {
  onBack?: () => void
  // Focus zone refs for Tab cycling
  mainContentRef?: RefObject<HTMLElement | null>
  composerRef?: RefObject<HTMLElement | null>
  // Occupant panel state (lifted to parent for persistence across view switches)
  showOccupants?: boolean
  onShowOccupantsChange?: (show: boolean) => void
  // Callback to start a direct chat with a JID (from occupant panel)
  onStartChat?: (jid: string) => void
  // Callback to show user profile (from occupant panel)
  onShowProfile?: (jid: string) => void
  /** Ref for find-on-page handle (toggle, navigate from parent shortcuts) */
  findOnPageRef?: RefObject<FindOnPageHandle | null>
  /** Callback to open search scoped to a room */
  onSearchInConversation?: (conversationId: string) => void
}

// Max room size for sending typing indicators (to avoid noise in large rooms)
const MAX_ROOM_SIZE_FOR_TYPING = 300

// Stable empty array for useIgnoreStore selector to prevent infinite re-render loops
const EMPTY_IGNORED_ARRAY: import('@fluux/sdk/stores').IgnoredUser[] = []
// Stable empty fallback for the composer's NON-reactive occupants read.
const EMPTY_OCCUPANTS: Map<string, RoomOccupant> = new Map()

export function RoomView({ onBack, mainContentRef, composerRef, showOccupants = false, onShowOccupantsChange, onStartChat, onShowProfile, findOnPageRef, onSearchInConversation }: RoomViewProps) {
  detectRenderLoop('RoomView')
  const { t } = useTranslation()
  // Active-room state + messaging/scroll actions. Poll / moderation /
  // management actions come from the focused hooks below (they subscribe to no
  // store, so they add no re-render triggers).
  const { activeRoom, activeMessages, activeTypingUsers, sendMessage, sendWhisper, sendReaction, sendCorrection, retractMessage, sendChatState, sendWhisperChatState, activeAnimation, sendEasterEgg, clearAnimation, clearFirstNewMessageId, updateLastSeenMessageId, joinRoom, joinResult, fetchOlderHistory, loadMessagesAround, loadNewer, recenterToLatest, windowAtLiveEdge, continueRoomCatchUp, activeMAMState, targetMessageId, clearTargetMessageId, firstNewMessageId } = useRoomActive()
  const { sendPoll, votePoll, closePoll } = usePolls()
  const { moderateMessage, setAffiliation, setRole } = useRoomModeration()
  const { setRoomNotifyAll, setRoomAvatar, clearRoomAvatar, submitRoomConfig, setSubject, destroyRoom } = useRoomManagement()
  const mediaPolicy = useSettingsStore((s) => s.mediaAutoDownload)

  // NOTE: Use focused selectors instead of useConnection() hook to avoid
  // re-renders when unrelated connection state changes (error, reconnectAttempt, etc.)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const status = useConnectionStore((s) => s.status)
  const isConnected = status === 'online'
  const { uploadFile, isUploading, progress, isSupported, error: uploadError, clearError: clearUploadError } = useFileUpload()
  const { processMessageForLinkPreview } = useLinkPreview()
  const { resolvedMode } = useMode()
  const { confirmJoin, warningDialog } = useRoomJoinWarning()

  // Handler to open search scoped to this room
  const handleSearchInConversation = activeRoom && onSearchInConversation
    ? () => onSearchInConversation(activeRoom.jid)
    : undefined

  // Contact identity (name/avatar) lookup for occupant + message-row avatars. Sourced from
  // useContactIdentities (NOT useRoster) so it stays referentially stable across presence
  // churn — a fresh map every render breaks the memo bailout of every RoomMessageBubbleWrapper
  // and OccupantRow, and presence-only updates don't change a contact's identity.
  const contactsByJid = useContactIdentities()

  // Filter out messages from ignored users and replies quoting them (client-side ignore)
  // IMPORTANT: Use stable empty array reference to prevent infinite re-renders.
  // Zustand uses Object.is to compare selector results — a new [] each time causes re-render loops.
  const ignoredForRoom = useIgnoreStore((s) => activeRoom ? (s.ignoredUsers[activeRoom.jid] ?? EMPTY_IGNORED_ARRAY) : EMPTY_IGNORED_ARRAY)
  const displayMessages = useMemo(() => {
    if (ignoredForRoom.length === 0) return activeMessages
    const cache = activeRoom?.nickToJidCache
    return activeMessages
      .filter(msg =>
        !isMessageFromIgnoredUser(ignoredForRoom, msg, cache) &&
        !isReplyToIgnoredUser(ignoredForRoom, msg.replyTo, cache)
      )
      // Also strip reactions left by ignored users on surviving messages. The
      // helper returns the same reference when nothing is removed, so we only
      // clone the rare message that actually carried an ignored reaction —
      // keeping the memo bailout intact for everything else.
      .map(msg => {
        const reactions = filterIgnoredReactions(msg.reactions, ignoredForRoom, cache)
        return reactions === msg.reactions ? msg : { ...msg, reactions }
      })
  }, [activeMessages, ignoredForRoom, activeRoom?.nickToJidCache])

  // Filter typing indicators from ignored users
  const filteredTypingUsers = useMemo(() => {
    if (ignoredForRoom.length === 0) return activeTypingUsers
    const cache = activeRoom?.nickToJidCache
    return activeTypingUsers.filter(
      nick => !isMessageFromIgnoredUser(ignoredForRoom, { nick }, cache)
    )
  }, [activeTypingUsers, ignoredForRoom, activeRoom?.nickToJidCache])

  // Reply state
  const [replyingTo, setReplyingTo] = useState<RoomMessage | null>(null)

  // Edit state
  const [editingMessage, setEditingMessage] = useState<RoomMessage | null>(null)

  // Pending attachment state - staged file ready to send with next message
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null)

  // Track last sent message ID for send animation
  const [lastSentMessageId, setLastSentMessageId] = useState<string | null>(null)
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Poll state — persisted to localStorage via roomStore
  const activeRoomJid = activeRoom?.jid ?? ''
  const votedPollIds = useRoomStore((s) => s.getVotedPollIds(activeRoomJid))
  const dismissedPollIds = useRoomStore((s) => s.getDismissedPollIds(activeRoomJid))
  const handleDismissPoll = useCallback((messageId: string) => {
    if (activeRoomJid) roomStore.getState().dismissPoll(activeRoomJid, messageId)
  }, [activeRoomJid])


  // Find the last outgoing message ID for edit button visibility (skip retracted)
  const lastOutgoingMessageId = findLastEditableMessageId(activeMessages)

  // Last message ID - reply button is disabled for last message (context is already clear)
  const lastMessageId = activeMessages.length > 0 ? activeMessages[activeMessages.length - 1].id : null

  // Handler to edit the last outgoing message (triggered by Up arrow in empty composer)
  // Reads messages from the store at call time to avoid closing over the changing activeMessages array
  const handleEditLastMessage = useCallback(() => {
    const msg = findLastEditableMessage(roomStore.getState().activeMessages())
    if (msg) {
      setEditingMessage(msg)
    }
  }, [])

  // Composing state - hides message toolbars when user is typing
  const [isComposing, setIsComposing] = useState(false)

  // Track which message has reaction picker open (hides other toolbars)
  const [activeReactionPickerMessageId, setActiveReactionPickerMessageId] = useState<string | null>(null)

  // Occupant panel state setter (calls parent callback if provided)
  const setShowOccupants = (show: boolean) => {
    onShowOccupantsChange?.(show)
  }

  const handleCancelReply = useCallback(() => setReplyingTo(null), [])
  const handleCancelEdit = useCallback(() => setEditingMessage(null), [])
  // Stable identity so it does not break the memo bailout of every message row.
  const handleReactionPickerChange = useCallback((messageId: string, isOpen: boolean) => {
    setActiveReactionPickerMessageId(isOpen ? messageId : null)
  }, [])
  const handleCloseOccupants = () => setShowOccupants(false)

  // Nick context menu state (right-click / long-press on nick in messages)
  const nickMenu = useContextMenu()
  const [nickMenuTarget, setNickMenuTarget] = useState<string | null>(null) // nick string
  const [nickModerationTarget, setNickModerationTarget] = useState<string | null>(null)

  // Whisper mode: when set, the composer targets a specific occupant privately.
  // Carries the counterpart's occupant-id (captured at entry) so presence checks
  // bind to the person, not just the nick (XEP-0045 §7.5, XEP-0421).
  const [whisperTarget, setWhisperTarget] = useState<WhisperTarget | null>(null)

  // setAffiliation and setRole are now from useRoomActive() to avoid subscribing
  // to list-level selectors that cause render loops when other rooms update
  const addToast = useToastStore((s) => s.addToast)

  // Stable identities (read the room from the store at call time instead of closing
  // over the recombined `activeRoom`) so they do not break the memo bailout of every
  // message row. The nickMenu.* handlers are stabilized inside useContextMenu, so
  // destructuring them gives exhaustive-deps stable references to depend on.
  const { handleContextMenu: openNickMenu, handleTouchStart: startNickLongPress, handleTouchEnd: cancelNickLongPress } = nickMenu
  const handleNickContextMenu = useCallback((nick: string, e: React.MouseEvent) => {
    const room = roomStore.getState().activeRoom()
    if (!room || nick === room.nickname) return
    setNickMenuTarget(nick)
    openNickMenu(e)
  }, [openNickMenu])

  const handleNickTouchStart = useCallback((nick: string, e: React.TouchEvent) => {
    const room = roomStore.getState().activeRoom()
    if (!room || nick === room.nickname) return
    setNickMenuTarget(nick)
    startNickLongPress(e)
  }, [startNickLongPress])

  const handleNickTouchEnd = useCallback(() => {
    cancelNickLongPress()
  }, [cancelNickLongPress])

  const uploadStateObj = useMemo(
    () => ({ isUploading, progress, error: uploadError, clearError: clearUploadError }),
    [isUploading, progress, uploadError, clearUploadError]
  )

  // Scroll ref for programmatic scrolling and keyboard navigation
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(true)

  // Composer handle ref for focusing after staging attachment
  const composerHandleRef = useRef<MessageComposerHandle>(null)

  // Scroll to bottom (used after sending a message)
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [])

  // Scroll to bottom when media loads (images, videos, link previews)
  // Only scrolls if user was already at bottom to avoid disrupting scroll position
  const handleMediaLoad = useCallback(() => {
    if (scrollRef.current && isAtBottomRef.current) {
      // Use instant scroll to avoid jarring animation when content expands
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  // Scroll to bottom when composer resizes (typing long message)
  // Only scrolls if user was already at bottom to avoid disrupting scroll position
  const handleInputResize = useCallback(() => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  // Keyboard navigation for message selection
  const {
    selectedMessageId,
    hasKeyboardSelection,
    showToolbarForSelection,
    handleKeyDown: handleMessageListKeyDown,
    clearSelection,
    handleMouseMove,
    handleMouseLeave,
  } = useMessageSelection(activeMessages, scrollRef, isAtBottomRef, {
    onReachedFirstMessage: fetchOlderHistory,
    isLoadingOlder: activeMAMState?.isLoading,
    isHistoryComplete: activeRoom?.supportsMAM === false || activeMAMState?.isHistoryComplete,
    onEnterPressed: (id: string) => useExpandedMessagesStore.getState().toggle(id),
    onKeyboardNavigate: () => { isAtBottomRef.current = false },
  })

  // Format copied messages with sender headers
  useMessageCopy(scrollRef)

  // Reply targets are resolved reactively per-row via useReferencedMessage (in
  // RoomMessageBubbleWrapper), so the list no longer holds a render-time lookup
  // map here — a value derived from such a map froze inside the memoized row when
  // the target only loaded later. Store subscription = reactive, no freeze.

  // Track pendingAttachment in a ref for cleanup (not a trigger)
  const pendingAttachmentRef = useRef(pendingAttachment)
  pendingAttachmentRef.current = pendingAttachment

  // Track the active room in a ref so enterWhisperMode can resolve the
  // counterpart's occupant-id at call time without depending on activeRoom
  // (which changes on every occupant update and would destabilize the callback).
  const activeRoomRef = useRef(activeRoom)
  activeRoomRef.current = activeRoom

  // Referentially-stable room for the message rows. `activeRoom` is recombined
  // (entity/meta/runtime) on every render, so passing it directly re-renders every
  // RoomMessageBubbleWrapper on each new message. The rows only read these fields,
  // none of which change on a plain message append — so keep the previous reference
  // until one of them actually changes (occupant/cache/nick churn). Implemented with
  // a ref + field comparison rather than useMemo-with-partial-deps so it stays clean
  // for both react-hooks/exhaustive-deps and the React Compiler.
  const stableRoomRef = useRef(activeRoom)
  {
    const prev = stableRoomRef.current
    if (!activeRoom) {
      stableRoomRef.current = undefined
    } else if (
      !prev ||
      prev.jid !== activeRoom.jid ||
      prev.nickname !== activeRoom.nickname ||
      prev.joined !== activeRoom.joined ||
      prev.supportsReactions !== activeRoom.supportsReactions ||
      prev.isIrcGateway !== activeRoom.isIrcGateway ||
      prev.occupants !== activeRoom.occupants ||
      prev.nickToJidCache !== activeRoom.nickToJidCache ||
      prev.nickToAvatarCache !== activeRoom.nickToAvatarCache
    ) {
      stableRoomRef.current = activeRoom
    }
  }
  const stableRoom = stableRoomRef.current

  // Stable callback that clears any staged compose state before entering whisper
  // mode. Whispers are text-only so a staged reply, edit, or pending attachment
  // must be discarded to avoid showing conflicting UI (banner + attachment preview).
  const enterWhisperMode = useCallback((nick: string) => {
    setReplyingTo(null)
    setEditingMessage(null)
    if (pendingAttachmentRef.current?.previewUrl) {
      URL.revokeObjectURL(pendingAttachmentRef.current.previewUrl)
    }
    setPendingAttachment(null)
    // Capture the counterpart's occupant-id now so the send/disable gates can
    // bind to this exact person even if they later change nick or leave.
    setWhisperTarget(resolveWhisperTarget(nick, activeRoomRef.current?.occupants ?? new Map()))
  }, [])

  // Replying to a whisper stays private: re-enter whisper mode with that counterpart
  // instead of staging a public reply (which would leak the private text into the room).
  const handleReplyToMessage = useCallback((message: RoomMessage) => {
    if (message.isPrivate && message.whisperWith) {
      // Only continue a private thread if the counterpart is still in the room —
      // replying to a recycled or absent nick would leak the private text.
      // Read the room from a ref (not the recombined activeRoom) so this callback
      // keeps a stable identity and does not break the message-row memo bailout.
      const room = activeRoomRef.current
      if (room && whisperCounterpartPresent(message, room.occupants)) {
        enterWhisperMode(message.whisperWith)
      } else {
        addToast('info', t('rooms.whisperCounterpartGone', { nick: message.whisperWith }))
      }
    } else {
      setReplyingTo(message)
    }
  }, [enterWhisperMode, addToast, t])

  // Clear stale reaction mentions when leaving a room
  useEffect(() => {
    return () => {
      if (activeRoom?.jid) {
        reactionMentionStore.getState().clearConversation(activeRoom.jid)
      }
    }
  }, [activeRoom?.jid])

  // Clear reply/edit/whisper/pending attachment state when room changes
  // Note: scroll position is managed by MessageList component
  useEffect(() => {
    setReplyingTo(null)
    setEditingMessage(null)
    setWhisperTarget(null)
    // Revoke old preview URL to avoid memory leaks
    if (pendingAttachmentRef.current?.previewUrl) {
      URL.revokeObjectURL(pendingAttachmentRef.current.previewUrl)
    }
    setPendingAttachment(null)
    clearSelection()
  }, [activeRoom?.jid, clearSelection])

  // File drop handler - stages file for preview only (no upload yet - privacy protection)
  // Upload happens when user clicks Send, not on drop (prevents accidental data leaks)
  // Uses activeRoomRef to avoid closing over the churning activeRoom object.
  const handleFileDrop = useCallback((file: File) => {
    if (!activeRoomRef.current || !isSupported) return
    // Create preview URL for images/videos
    const previewUrl = file.type.startsWith('image/') || file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : undefined
    setPendingAttachment({ file, previewUrl })
    // Focus composer so user can add a message
    setTimeout(() => composerHandleRef.current?.focus(), 0)
  }, [isSupported])

  // Clear pending attachment and revoke preview URL
  // Uses pendingAttachmentRef to read current value without closing over state
  const handleRemovePendingAttachment = useCallback(() => {
    if (pendingAttachmentRef.current?.previewUrl) {
      URL.revokeObjectURL(pendingAttachmentRef.current.previewUrl)
    }
    setPendingAttachment(null)
  }, [])

  // Drag-and-drop for file upload (handles both HTML5 and Tauri native)
  const { isDragging, dragHandlers } = useDragAndDrop({
    onFileDrop: handleFileDrop,
    isUploadSupported: isSupported,
  })

  // Stable callbacks passed to memoized RoomMessageList — useCallback prevents
  // the child from re-rendering when only unrelated RoomView state changes.
  const roomJid = activeRoom?.jid
  const handleClearFirstNewMessageId = useCallback(() => {
    if (roomJid) {
      clearFirstNewMessageId(roomJid)
    }
  }, [roomJid, clearFirstNewMessageId])

  // Viewport observer callback: update lastSeenMessageId as user scrolls
  const handleMessageSeen = useCallback((messageId: string) => {
    if (roomJid) {
      updateLastSeenMessageId(roomJid, messageId)
    }
  }, [roomJid, updateLastSeenMessageId])

  // Find on page: browser-style search within this room
  const find = useFindOnPage(activeMessages, activeRoom?.jid)

  // Expose find-on-page handle to parent for keyboard shortcuts
  useImperativeHandle(findOnPageRef, () => ({
    open: find.open,
    close: find.close,
    isOpen: find.isOpen,
    goToNext: find.goToNext,
    goToPrev: find.goToPrev,
  }), [find.open, find.close, find.isOpen, find.goToNext, find.goToPrev])

  // Stable handler for the send-animation: clears the highlight after 400 ms.
  // Uses a ref for the timer to avoid any closure over state.
  const handleMessageIdSent = useCallback((id: string) => {
    if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current)
    setLastSentMessageId(id)
    lastSentTimerRef.current = setTimeout(() => setLastSentMessageId(null), 400)
  }, [])

  // Stable callback to clear whisper target (name avoids clash with the
  // composer-internal handleClearWhisper defined inside RoomMessageInput).
  const handleClearWhisperTarget = useCallback(() => setWhisperTarget(null), [])

  if (!activeRoom) return null

  // Room media trust: open rooms are public; members-only/hidden are private.
  // A room whose disco hasn't resolved has isPrivate falsy → treated as public
  // (fail-safe). Strangers do not apply to rooms.
  const mediaAutoLoad = computeMediaAutoload(mediaPolicy, activeRoom.isPrivate ? 'room-private' : 'room-public')

  return (
    <div
      className="flex flex-1 min-h-0 relative"
      {...dragHandlers}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-fluux-bg/95 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-fluux-brand rounded-xl bg-fluux-bg/50">
            <Upload className="size-12 text-fluux-brand" />
            <p className="text-lg font-medium text-fluux-text">{t('upload.dropToUpload')}</p>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <RoomHeader
          room={activeRoom}
          onBack={onBack}
          showOccupants={showOccupants}
          onToggleOccupants={() => setShowOccupants(!showOccupants)}
          setRoomNotifyAll={setRoomNotifyAll}
          setRoomAvatar={setRoomAvatar}
          clearRoomAvatar={clearRoomAvatar}
          submitRoomConfig={submitRoomConfig}
          setSubject={setSubject}
          destroyRoom={destroyRoom}
          onSearchInConversation={handleSearchInConversation}
        />

        {/* Unanswered poll banner */}
        <PollBanner
          messages={displayMessages}
          myNick={activeRoom.nickname}
          votedPollIds={votedPollIds}
          dismissedPollIds={dismissedPollIds}
          onDismiss={handleDismissPoll}
        />

        {/* Messages - focusable zone for Tab cycling */}
        <div
          ref={mainContentRef as React.RefObject<HTMLDivElement>}
          tabIndex={0}
          onKeyDown={handleMessageListKeyDown}
          onMouseMove={(e) => {
            // Find which message is being hovered (for keyboard nav starting point)
            const messageEl = (e.target as HTMLElement).closest('[data-message-id]')
            const messageId = messageEl?.getAttribute('data-message-id') || undefined
            handleMouseMove(e, messageId)
          }}
          onMouseLeave={handleMouseLeave}
          // `composer-active` hides the per-message hover toolbars while typing via
          // CSS (index.css), instead of threading `isComposing` into every row's
          // `hideToolbar` prop — which re-rendered (and relayouted) the whole
          // non-virtualized room list on each typing burst (parity with ChatView).
          className={`focus-zone flex-1 flex flex-col min-h-0 p-1 relative${isComposing ? ' composer-active' : ''}`}
        >
          {find.isOpen && (
            <FindOnPageBar
              searchText={find.searchText}
              onSearchTextChange={find.setSearchText}
              currentMatchIndex={find.currentMatchIndex}
              totalMatches={find.matchIds.length}
              onNext={find.goToNext}
              onPrev={find.goToPrev}
              onClose={find.close}
            />
          )}
          <MediaAutoloadProvider autoLoad={mediaAutoLoad}>
            <RoomMessageList
              messages={displayMessages}
              scrollerRef={scrollRef}
              isAtBottomRef={isAtBottomRef}
              room={stableRoom ?? activeRoom}
            contactsByJid={contactsByJid}
            ownAvatar={ownAvatar}
            sendReaction={sendReaction}
            votePoll={votePoll}
            closePoll={closePoll}

            onReply={handleReplyToMessage}
            onEdit={setEditingMessage}
            lastOutgoingMessageId={lastOutgoingMessageId}
            lastMessageId={lastMessageId}
            typingUsers={filteredTypingUsers}
            activeReactionPickerMessageId={activeReactionPickerMessageId}
            onReactionPickerChange={handleReactionPickerChange}
            retractMessage={retractMessage}
            moderateMessage={moderateMessage}
            selectedMessageId={selectedMessageId}
            hasKeyboardSelection={hasKeyboardSelection}
            showToolbarForSelection={showToolbarForSelection}
            firstNewMessageId={firstNewMessageId}
            targetMessageId={targetMessageId}
            clearTargetMessageId={clearTargetMessageId}
            clearFirstNewMessageId={handleClearFirstNewMessageId}
            onMessageSeen={handleMessageSeen}
            isJoined={activeRoom.joined}
            isDarkMode={resolvedMode === 'dark'}
            onMediaLoad={handleMediaLoad}
            onScrollToTop={fetchOlderHistory}
            onLoadAround={loadMessagesAround}
            isLoadingOlder={activeMAMState?.isLoading}
            onLoadNewer={loadNewer}
            windowAtLiveEdge={windowAtLiveEdge}
            onJumpToLatest={recenterToLatest}
            isHistoryComplete={activeRoom.supportsMAM === false || activeMAMState?.isHistoryComplete}
            onNickContextMenu={handleNickContextMenu}
            onNickTouchStart={handleNickTouchStart}
            onNickTouchEnd={handleNickTouchEnd}
            setAffiliation={setAffiliation}
            highlightTerms={find.highlightTerms}
            currentMatchId={find.currentMatchId}
            lastSentMessageId={lastSentMessageId}
            forwardGapTimestamp={activeMAMState?.forwardGapTimestamp}
            onCatchUpHistory={continueRoomCatchUp}
            isCatchingUp={activeMAMState?.isLoading}
            />
          </MediaAutoloadProvider>
        </div>

        {/* Reaction mention pills — pinned above the composer */}
        <ReactionMentions conversationId={activeRoom.jid} />

        {/* Input - show composer if joined, join prompt if not */}
        {activeRoom.joined ? (
          <RoomMessageInput
            key={activeRoom.jid}
            ref={composerHandleRef}
            roomJid={activeRoom.jid}
            textareaRef={composerRef as React.RefObject<HTMLTextAreaElement | null>}
            sendMessage={sendMessage}
            sendCorrection={sendCorrection}
            retractMessage={retractMessage}
            sendChatState={sendChatState}
            sendWhisperChatState={sendWhisperChatState}
            sendEasterEgg={sendEasterEgg}
            sendPoll={sendPoll}
            onMessageSent={scrollToBottom}
            onInputResize={handleInputResize}
            replyingTo={replyingTo}
            onCancelReply={handleCancelReply}
            editingMessage={editingMessage}
            onCancelEdit={handleCancelEdit}
            onEditLastMessage={handleEditLastMessage}
            onComposingChange={setIsComposing}
            uploadState={uploadStateObj}
            isUploadSupported={isSupported}
            onFileSelect={handleFileDrop}
            uploadFile={uploadFile}
            pendingAttachment={pendingAttachment}
            onRemovePendingAttachment={handleRemovePendingAttachment}
            processLinkPreview={processMessageForLinkPreview}
            isConnected={isConnected}
            onMessageIdSent={handleMessageIdSent}
            whisperTarget={whisperTarget}
            onClearWhisper={handleClearWhisperTarget}
            sendWhisper={sendWhisper}
            isDarkMode={resolvedMode === 'dark'}
          />
        ) : (
          <RoomJoinPrompt
            onJoin={async () => {
              // Issue #37: warn before joining a room that would expose the user's real JID.
              if (await confirmJoin(activeRoom.jid)) {
                try {
                  await joinRoom(activeRoom.jid, activeRoom.nickname)
                  await joinResult(activeRoom.jid)
                } catch (err) {
                  addToast('error', getRoomJoinErrorMessage(t, err))
                }
              }
            }}
          />
        )}
        {warningDialog}
      </div>

      {/* Occupant panel (>=768px; <768 uses the full-screen panel in ChatLayout).
          Below lg it's a right-edge drawer over a dimmed backdrop so it doesn't
          squeeze the chat into a narrow column on tablets; at lg+ there's room
          for it as an in-flow side column. */}
      {showOccupants && !isSmallScreen() && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={handleCloseOccupants}
            className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          />
          <div className="fixed inset-y-0 end-0 z-40 flex shadow-xl animate-drawer-in lg:static lg:z-auto lg:shadow-none">
            <OccupantPanel
              room={activeRoom}
              contactsByJid={contactsByJid}
              ownAvatar={ownAvatar}
              onClose={handleCloseOccupants}
              onStartChat={onStartChat}
              onWhisper={enterWhisperMode}
              onShowProfile={onShowProfile}
            />
          </div>
        </>
      )}

      {/* Christmas easter egg animation */}
      {activeAnimation?.roomJid === activeRoom.jid && activeAnimation.animation === 'christmas' && (
        <ChristmasAnimation onComplete={clearAnimation} />
      )}

      {/* Nick context menu (right-click / long-press on nick in messages) */}
      {nickMenu.isOpen && nickMenuTarget && activeRoom && (() => {
        const occupant = activeRoom.occupants.get(nickMenuTarget)
        const bareJid = occupant?.jid
          ? getBareJid(occupant.jid)
          : activeRoom.nickToJidCache?.get(nickMenuTarget)
        const selfOccupant = activeRoom.nickname ? activeRoom.occupants.get(activeRoom.nickname) : undefined
        const selfAff: RoomAffiliation = selfOccupant?.affiliation ?? 'none'
        const selfRol: RoomRole = selfOccupant?.role ?? 'none'
        const targetAff = occupant?.affiliation ?? 'none'
        const targetRole = occupant?.role ?? 'none'

        // Determine ignore state
        const ignoredUsers = ignoreStore.getState().ignoredUsers[activeRoom.jid] || []
        const occupantId = occupant?.occupantId
        const identifier = occupantId || bareJid || nickMenuTarget
        const isIgnored = ignoredUsers.some(u => u.identifier === identifier)

        // Moderation permissions
        const availableRoles = getAvailableRoles(selfRol, selfAff, targetRole, targetAff)
        const availableAffs = bareJid ? getAvailableAffiliations(selfAff, targetAff) : []
        const showKick = canKick(selfRol, selfAff, targetAff)
        const showBan = bareJid ? canBan(selfAff, targetAff) : false
        const hasModActions = showKick || showBan || availableRoles.length > 0 || availableAffs.length > 0

        return (
          <div
            ref={nickMenu.menuRef}
            className="fixed fluux-popover rounded-lg py-1 z-50 min-w-40"
            style={{ left: nickMenu.position.x, top: nickMenu.position.y }}
          >
            {bareJid && onStartChat && (
              <MenuButton
                onClick={() => { onStartChat(bareJid); nickMenu.close() }}
                icon={<MessageCircle className="size-4" />}
                label={t('rooms.sendPrivateMessage')}
              />
            )}
            {nickMenuTarget !== activeRoom.nickname && (
              <MenuButton
                onClick={() => { enterWhisperMode(nickMenuTarget!); nickMenu.close() }}
                icon={<Ear className="size-4" />}
                label={t('rooms.whisper')}
              />
            )}
            <MenuButton
              onClick={() => {
                if (isIgnored) {
                  ignoreStore.getState().removeIgnored(activeRoom.jid, identifier)
                } else {
                  const user: IgnoredUser = {
                    identifier,
                    displayName: nickMenuTarget,
                    jid: bareJid,
                  }
                  ignoreStore.getState().addIgnored(activeRoom.jid, user)
                }
                nickMenu.close()
              }}
              icon={<EyeOff className="size-4" />}
              label={isIgnored ? t('rooms.stopIgnoring') : t('rooms.ignoreUser')}
            />
            {bareJid && onShowProfile && (
              <MenuButton
                onClick={() => { onShowProfile(bareJid); nickMenu.close() }}
                icon={<User className="size-4" />}
                label={t('rooms.userInfo')}
              />
            )}
            {hasModActions && (
              <>
                <MenuDivider />
                <MenuButton
                  onClick={() => {
                    setNickModerationTarget(nickMenuTarget)
                    nickMenu.close()
                  }}
                  icon={<Settings className="size-4" />}
                  label={t('rooms.manageOccupant')}
                />
              </>
            )}
          </div>
        )
      })()}

      {/* Nick moderation modal (from context menu) */}
      {nickModerationTarget && activeRoom && (() => {
        const occupant = activeRoom.occupants.get(nickModerationTarget)
        if (!occupant) return null
        const bareJid = occupant.jid ? getBareJid(occupant.jid) : activeRoom.nickToJidCache?.get(nickModerationTarget)
        const contact = bareJid ? contactsByJid.get(bareJid) : undefined
        const selfOccupant = activeRoom.nickname ? activeRoom.occupants.get(activeRoom.nickname) : undefined
        return (
          <OccupantModerationModal
            occupant={{
              nick: nickModerationTarget,
              bareJid,
              role: occupant.role,
              affiliation: occupant.affiliation,
              avatar: occupant.avatar || contact?.avatar,
            }}
            selfRole={selfOccupant?.role ?? 'none'}
            selfAffiliation={selfOccupant?.affiliation ?? 'none'}
            onSetRole={async (nick, role) => {
              try {
                await setRole(activeRoom.jid, nick, role)
                addToast('success', t('rooms.roleChanged'))
              } catch {
                addToast('error', t('rooms.roleError'))
              }
            }}
            onSetAffiliation={async (jid, aff) => {
              try {
                await setAffiliation(activeRoom.jid, jid, aff)
                addToast('success', t('rooms.affiliationChanged'))
              } catch {
                addToast('error', t('rooms.affiliationError'))
              }
            }}
            onKick={async (nick, reason) => {
              try {
                await setRole(activeRoom.jid, nick, 'none', reason)
                addToast('success', t('rooms.roleChanged'))
              } catch {
                addToast('error', t('rooms.kickError'))
              }
            }}
            onBan={async (jid, reason) => {
              try {
                await setAffiliation(activeRoom.jid, jid, 'outcast', reason)
                addToast('success', t('rooms.affiliationChanged'))
              } catch {
                addToast('error', t('rooms.banError'))
              }
            }}
            onClose={() => setNickModerationTarget(null)}
          />
        )
      })()}
    </div>
  )
}

export const RoomMessageList = memo(function RoomMessageList({
  messages,
  scrollerRef,
  isAtBottomRef,
  room,
  contactsByJid,
  ownAvatar,
  sendReaction,
  votePoll,
  closePoll,
  onReply,
  onEdit,
  lastOutgoingMessageId,
  lastMessageId,
  typingUsers,
  activeReactionPickerMessageId,
  onReactionPickerChange,
  retractMessage,
  moderateMessage,
  selectedMessageId,
  hasKeyboardSelection,
  showToolbarForSelection,
  firstNewMessageId,
  targetMessageId,
  clearTargetMessageId,
  clearFirstNewMessageId,
  onMessageSeen,
  isJoined,
  isDarkMode,
  onMediaLoad,
  onScrollToTop,
  onLoadAround,
  isLoadingOlder,
  onLoadNewer,
  windowAtLiveEdge,
  onJumpToLatest,
  isHistoryComplete,
  onNickContextMenu,
  onNickTouchStart,
  onNickTouchEnd,
  setAffiliation,
  highlightTerms,
  currentMatchId,
  lastSentMessageId,
  forwardGapTimestamp,
  onCatchUpHistory,
  isCatchingUp,
}: {
  messages: RoomMessage[]
  scrollerRef: React.RefObject<HTMLElement | null>
  isAtBottomRef: React.MutableRefObject<boolean>
  room: Room
  contactsByJid: Map<string, ContactIdentity>
  ownAvatar?: string | null
  sendReaction: (roomJid: string, messageId: string, emojis: string[]) => Promise<void>
  votePoll: (roomJid: string, messageId: string, optionEmoji: string, currentMyReactions: string[], poll: PollData, isClosed?: boolean) => Promise<void>
  closePoll: (roomJid: string, messageId: string) => Promise<string | null>
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  lastOutgoingMessageId: string | null
  lastMessageId: string | null
  typingUsers: string[]
  activeReactionPickerMessageId: string | null
  onReactionPickerChange: (messageId: string, isOpen: boolean) => void
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  moderateMessage: (roomJid: string, stanzaId: string, reason?: string) => Promise<void>
  selectedMessageId: string | null
  hasKeyboardSelection: boolean
  showToolbarForSelection: boolean
  firstNewMessageId?: string
  targetMessageId?: string | null
  clearTargetMessageId?: () => void
  clearFirstNewMessageId: () => void
  onMessageSeen?: (messageId: string) => void
  isJoined?: boolean
  isDarkMode?: boolean
  onMediaLoad?: () => void
  onScrollToTop?: () => void
  onLoadAround?: (anchorMessageId: string) => Promise<unknown> | void
  isLoadingOlder?: boolean
  onLoadNewer?: () => void
  windowAtLiveEdge?: boolean
  onJumpToLatest?: () => Promise<unknown> | void
  isHistoryComplete?: boolean
  onNickContextMenu?: (nick: string, e: React.MouseEvent) => void
  onNickTouchStart?: (nick: string, e: React.TouchEvent) => void
  onNickTouchEnd?: () => void
  setAffiliation: (roomJid: string, userJid: string, affiliation: RoomAffiliation, reason?: string) => Promise<void>
  highlightTerms?: string[]
  currentMatchId?: string
  lastSentMessageId?: string | null
  forwardGapTimestamp?: number
  onCatchUpHistory?: () => void
  isCatchingUp?: boolean
}) {
  const { t } = useTranslation()
  const { formatTime, effectiveTimeFormat } = useTimeFormat()

  // Selection-aware, hover-intent toolbar hover state (stable handler identities)
  const { hoveredMessageId, handleMessageHover, handleMessageLeave } =
    useMessageHoverState({ scrollRef: scrollerRef, resetKey: room.jid })

  // Set of original poll message IDs that have been closed (a poll-closed message references them).
  // Used to disable the "Close poll" button on already-closed polls. Each row receives a
  // per-message boolean derived from this set (see renderMessage), NOT the Set itself nor a
  // stable getter: a fresh Set or a stable-ref getter read during render would either break the
  // memo bailout of every row on each append, or freeze the closed-state inside the memoized row
  // (a row only re-renders when its own props change). A per-message boolean flips only for the
  // poll that closed, so it stays reactive without re-rendering unrelated rows.
  const closedPollIds = useMemo(() => {
    const ids = new Set<string>()
    for (const msg of messages) {
      if (msg.pollClosed?.pollMessageId) {
        ids.add(msg.pollClosed.pollMessageId)
      }
    }
    return ids
  }, [messages])

  // Set of known occupant nicknames for IRC-style mention highlighting.
  // Ref-stable across presence (show/status) churn — only changes when the nick
  // SET changes — so it does not bust every memoized row on each presence stanza.
  const knownNicksRef = useRef<ReadonlySet<string>>(new Set())
  knownNicksRef.current = stableNickSet(room.occupants, knownNicksRef.current)
  const knownNicks = knownNicksRef.current

  // Stable nick→color resolver for inline @mention pills. Mirrors the sender-name
  // color (resolveSenderColor, incl. a roster contact's XEP-0392 color) so a mention
  // matches the mentioned person's displayed color instead of a bare nick hash.
  // Backed by a ref so its identity stays stable across presence churn — passing a
  // fresh closure would bust every memoized row. Reads the latest room/contacts/theme
  // at call time, which is render time of each body (kept current by the rows that
  // re-render). See [project_reply_scroll_freeze] for the derived-value class.
  const mentionColorCtxRef = useRef({ room, contactsByJid, isDarkMode })
  mentionColorCtxRef.current = { room, contactsByJid, isDarkMode }
  const resolveMentionColor = useCallback((nick: string) => {
    const ctx = mentionColorCtxRef.current
    return resolveNickColor(nick, ctx.room, ctx.contactsByJid, ctx.isDarkMode ?? true)
  }, [])

  // The current user's own occupant record (stable ref across presence churn unless
  // our own role/affiliation changes). Used per-row to compute moderation permission.
  const selfOccupant = useMemo(
    () => selectSelfOccupant(room.occupants, room.nickname),
    [room.occupants, room.nickname],
  )

  // Loading state covers two phases: joining (waiting for self-presence) and the
  // first MAM catch-up after join when nothing is cached yet. Without the second
  // phase the spinner vanished on join and the view showed "No messages" while
  // history was still loading (see selectRoomInitialLoading).
  const isInitialLoading = selectRoomInitialLoading({
    isJoining: room.isJoining ?? false,
    joined: room.joined ?? false,
    isCatchingUp: isCatchingUp ?? false,
    messageCount: messages.length,
  })
  // Label matches the phase: still joining vs. joined and loading history.
  const isJoiningPhase = (room.isJoining ?? false) && !(room.joined ?? false)
  const loadingState = isInitialLoading ? (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-fluux-muted">
      <Loader2 className="size-8 animate-spin text-fluux-brand" />
      <p>{isJoiningPhase ? t('rooms.joining') : t('chat.loadingMessages')}</p>
    </div>
  ) : null

  // Empty state: different for joined vs not joined
  const emptyState = (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted gap-3">
      {!isJoined && (
        <div className="flex items-center gap-2 text-fluux-yellow mb-1">
          <AlertCircle className="size-4" />
          <span className="text-sm">{t('rooms.notJoinedNoHistory')}</span>
        </div>
      )}
      <div className="size-16 rounded-full bg-fluux-brand/10 border border-fluux-brand/25 flex items-center justify-center">
        <Hash className="size-7 text-fluux-brand" />
      </div>
      <p className="text-sm">{isJoined ? t('chat.noMessages') : t('rooms.joinToLoadHistory')}</p>
    </div>
  )

  // Extra content: cached history warning banner when not joined
  const extraContent = !isJoined && messages.length > 0 ? (
    <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-700 dark:text-amber-400">
      <AlertCircle className="size-4 flex-shrink-0" />
      <span className="text-sm">
        {t('rooms.cachedHistoryWarning', {
          date: format(messages[messages.length - 1].timestamp, 'PPp'),
        })}
      </span>
    </div>
  ) : null

  // Resolve each message's sender (and reply-target avatar) HERE, in the list layer,
  // from cheap Map lookups — then pass only reference-stable objects (the live
  // `occupant`, which roomStore.addOccupant preserves for unchanged occupants) and
  // primitives down to the memoized row. A presence change for occupant X thus changes
  // props only for X's rows; every other row's shallow memo bails. The row no longer
  // sees `room` (a fresh Map ref every presence stanza), so it stops re-rendering on
  // unrelated presence churn.
  // Clipboard metadata for a message, faithful to the row's resolvedSenderName so a
  // virtualized multi-message copy reconstructs identically from the array (see
  // MessageList formatMessageForCopy). Called only at copy time, so per-render cost is nil.
  const formatMessageForCopy = (msg: RoomMessage): CopyMessageMeta => ({
    id: msg.id,
    from: resolveRoomSender(msg, room, contactsByJid, selfOccupant).resolvedSenderName,
    time: formatTime(msg.timestamp),
    body: msg.body || '',
    date: format(msg.timestamp, 'yyyy-MM-dd'),
  })

  const renderMessage = (msg: RoomMessage, idx: number, groupMessages: RoomMessage[]) => {
    // System notices (e.g. nick changes) render as a centered line, not a bubble.
    if (msg.systemEvent) {
      return <RoomSystemLine event={msg.systemEvent} />
    }

    const sender = resolveRoomSender(msg, room, contactsByJid, selfOccupant)

    // Resolve the reply-preview avatar to PRIMITIVES (the wrapper builds the
    // replyContext object internally from these — see RoomMessageBubbleWrapper — so
    // nothing object-shaped is passed that could bust the row memo on presence churn).
    let replyAvatarUrl: string | undefined
    let replyAvatarIdentifier: string | undefined
    let replyBareJid: string | undefined
    if (msg.replyTo) {
      // Reply-target nick from the XEP-0461 `to` JID (room@server/nick). The reply BODY
      // is resolved reactively in the row via useReferencedMessage; only the preview
      // avatar is resolved here so it can be passed down as a memo-safe primitive.
      // replyNick may be undefined (no `to`); resolveReplyAvatar handles that safely.
      const replyNick = msg.replyTo.to ? msg.replyTo.to.split('/').pop() : undefined
      const ra = resolveReplyAvatar(replyNick, room, contactsByJid, room.nickname, ownAvatar)
      replyAvatarUrl = ra.avatarUrl
      replyAvatarIdentifier = ra.avatarIdentifier
      replyBareJid = ra.senderBareJid
    }

    return (
      <RoomMessageBubbleWrapper
        message={msg}
        showAvatar={shouldShowAvatar(groupMessages, idx)}
        isGroupEnd={idx === groupMessages.length - 1 || shouldShowAvatar(groupMessages, idx + 1)}
        ownGroupKey={computeOwnGroupKey(groupMessages, idx)}
        whisperThread={whisperThreadPosition(groupMessages, idx)}
        roomJid={room.jid}
        myNick={room.nickname}
        supportsReactions={room.supportsReactions !== false}
        isIrcGateway={room.isIrcGateway === true}
        occupant={sender.occupant}
        avatarPresence={sender.avatarPresence}
        senderAvatar={sender.senderAvatar}
        resolvedSenderName={sender.resolvedSenderName}
        senderRole={sender.senderRole}
        senderAffiliation={sender.senderAffiliation}
        senderBareJid={sender.senderBareJid}
        senderBareJidForBan={sender.senderBareJidForBan}
        canModerate={sender.canModerate}
        canBan={sender.canBan}
        counterpartPresent={sender.counterpartPresent}
        replyAvatarUrl={replyAvatarUrl}
        replyAvatarIdentifier={replyAvatarIdentifier}
        replyBareJid={replyBareJid}
        knownNicks={knownNicks}
        contactsByJid={contactsByJid}
        resolveMentionColor={resolveMentionColor}
        ownAvatar={ownAvatar}
        sendReaction={sendReaction}
        votePoll={votePoll}
        closePoll={closePoll}
        isPollClosed={closedPollIds.has(msg.id)}
        onReply={onReply}
        onEdit={onEdit}
        isLastOutgoing={msg.id === lastOutgoingMessageId}
        isLastMessage={msg.id === lastMessageId}
        hideToolbar={activeReactionPickerMessageId !== null && activeReactionPickerMessageId !== msg.id}
        onReactionPickerChange={onReactionPickerChange}
        retractMessage={retractMessage}
        moderateMessage={moderateMessage}
        isSelected={msg.id === selectedMessageId}
        hasKeyboardSelection={hasKeyboardSelection}
        showToolbarForSelection={showToolbarForSelection}
        isDarkMode={isDarkMode}
        onMediaLoad={onMediaLoad}
        isHovered={hoveredMessageId === msg.id}
        onMouseEnter={handleMessageHover}
        onMouseLeave={handleMessageLeave}
        formatTime={formatTime}
        timeFormat={effectiveTimeFormat}
        onNickContextMenu={onNickContextMenu}
        onNickTouchStart={onNickTouchStart}
        onNickTouchEnd={onNickTouchEnd}
        setAffiliation={setAffiliation}
        highlightTerms={highlightTerms}
        isCurrentMatch={msg.id === currentMatchId}
      />
    )
  }

  return (
    <MessageList
      // Remount the message view (fresh virtualizer + scroll refs) per room so no imperative
      // scroll state — the @tanstack virtualizer's measurement/offset cache above all — bleeds
      // between rooms. Restoration survives via scrollStateManager (keyed by room jid).
      key={room.jid}
      messages={messages}
      conversationId={room.jid}
      firstNewMessageId={firstNewMessageId}
      targetMessageId={targetMessageId}
      onTargetMessageConsumed={clearTargetMessageId}
      clearFirstNewMessageId={clearFirstNewMessageId}
      onMessageSeen={onMessageSeen}
      scrollerRef={scrollerRef}
      isAtBottomRef={isAtBottomRef}
      typingUsers={typingUsers}
      isLoading={isInitialLoading}
      loadingState={loadingState}
      emptyState={emptyState}
      extraContent={extraContent}
      onScrollToTop={onScrollToTop}
      onLoadAround={onLoadAround}
      isLoadingOlder={isLoadingOlder}
      onLoadNewer={onLoadNewer}
      windowAtLiveEdge={windowAtLiveEdge}
      onJumpToLatest={onJumpToLatest}
      isHistoryComplete={isHistoryComplete}
      renderMessage={renderMessage}
      formatMessageForCopy={formatMessageForCopy}
      lastSentMessageId={lastSentMessageId}
      forwardGapTimestamp={forwardGapTimestamp}
      onCatchUpHistory={onCatchUpHistory}
      isCatchingUp={isCatchingUp}
    />
  )
})

interface RoomMessageBubbleWrapperProps {
  message: RoomMessage
  showAvatar: boolean
  isGroupEnd: boolean
  /** Own-message run key (see ownGroupKey); undefined for incoming/solo rows. */
  ownGroupKey?: string
  whisperThread: WhisperThreadPosition | null
  // Per-row resolved sender data (resolved in the list layer from cheap Map lookups).
  // `occupant` is the live, reference-stable occupant record (roomStore.addOccupant
  // preserves unchanged refs); the rest are primitives. Passing these instead of `room`
  // is what lets the row memo bail on presence churn for unaffected occupants.
  roomJid: string
  myNick: string | undefined
  supportsReactions: boolean
  isIrcGateway: boolean
  occupant: RoomOccupant | undefined
  avatarPresence: 'online' | 'away' | 'dnd' | 'offline' | undefined
  senderAvatar: string | undefined
  resolvedSenderName: string
  senderRole: RoomRole | undefined
  senderAffiliation: RoomAffiliation | undefined
  // Superset JID, for senderColor's contact lookup (occupant-id fallback included).
  senderBareJid: string | undefined
  senderBareJidForBan: string | undefined
  canModerate: boolean
  canBan: boolean
  counterpartPresent: boolean
  // Reply-preview avatar as primitives; the wrapper builds replyContext from these.
  replyAvatarUrl: string | undefined
  replyAvatarIdentifier: string | undefined
  // Reply sender's bare JID, for the contact-color lookup (keeps the quote's
  // color identical to the sender's main-message color).
  replyBareJid: string | undefined
  knownNicks: ReadonlySet<string>
  contactsByJid: Map<string, ContactIdentity>
  // Stable nick→color resolver for inline @mention pills (built in the list layer
  // where `room` is available; this row intentionally never sees `room`).
  resolveMentionColor: (nick: string) => string | undefined
  ownAvatar?: string | null
  sendReaction: (roomJid: string, messageId: string, emojis: string[]) => Promise<void>
  votePoll: (roomJid: string, messageId: string, optionEmoji: string, currentMyReactions: string[], poll: PollData, isClosed?: boolean) => Promise<void>
  closePoll: (roomJid: string, messageId: string) => Promise<string | null>
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  isLastOutgoing: boolean
  isLastMessage: boolean
  hideToolbar?: boolean
  // Receives the row's own id so the parent can pass a STABLE handler (id bound here).
  onReactionPickerChange?: (messageId: string, isOpen: boolean) => void
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  moderateMessage: (roomJid: string, stanzaId: string, reason?: string) => Promise<void>
  isSelected?: boolean
  hasKeyboardSelection?: boolean
  showToolbarForSelection?: boolean
  isDarkMode?: boolean
  onMediaLoad?: () => void
  // Hover state for stable toolbar interaction.
  // onMouseEnter receives the row's own id so the parent can pass a stable handler.
  isHovered?: boolean
  onMouseEnter?: (messageId: string) => void
  onMouseLeave?: () => void
  // Time formatting function (respects user's 12h/24h preference)
  formatTime: (date: Date) => string
  // Effective time format for layout width calculations
  timeFormat: '12h' | '24h'
  // Nick context menu callbacks (right-click / long-press)
  onNickContextMenu?: (nick: string, e: React.MouseEvent) => void
  onNickTouchStart?: (nick: string, e: React.TouchEvent) => void
  onNickTouchEnd?: () => void
  // Affiliation action (passed from parent to avoid useRoom() subscription)
  setAffiliation: (roomJid: string, userJid: string, affiliation: RoomAffiliation, reason?: string) => Promise<void>
  // Per-message boolean: is this poll already closed? (to hide the close action).
  // A reactive prop, NOT a stable getter — so the memoized row updates when its own
  // poll closes instead of freezing a render-time lookup.
  isPollClosed: boolean
  // Highlight terms for find-on-page
  highlightTerms?: string[]
  // Whether this message is the current find-on-page match
  isCurrentMatch?: boolean
}

const RoomMessageBubbleWrapper = memo(function RoomMessageBubbleWrapper({
  message,
  showAvatar,
  isGroupEnd,
  ownGroupKey,
  whisperThread,
  roomJid,
  myNick,
  supportsReactions,
  isIrcGateway,
  occupant,
  avatarPresence,
  senderAvatar,
  resolvedSenderName,
  senderRole,
  senderAffiliation,
  senderBareJid,
  senderBareJidForBan,
  canModerate: canModerateMsg,
  canBan: canBanUser,
  counterpartPresent,
  replyAvatarUrl,
  replyAvatarIdentifier,
  replyBareJid,
  knownNicks,
  contactsByJid,
  resolveMentionColor,
  ownAvatar,
  sendReaction,
  votePoll,
  closePoll,
  onReply,
  onEdit,
  isLastOutgoing,
  isLastMessage,
  hideToolbar,
  onReactionPickerChange,
  retractMessage,
  moderateMessage,
  isSelected,
  hasKeyboardSelection,
  showToolbarForSelection,
  isDarkMode,
  onMediaLoad,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  formatTime,
  timeFormat,
  onNickContextMenu,
  onNickTouchStart,
  onNickTouchEnd,
  setAffiliation,
  isPollClosed,
  highlightTerms,
  isCurrentMatch,
}: RoomMessageBubbleWrapperProps) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)

  // Moderation confirmation state
  const [showModerateConfirm, setShowModerateConfirm] = useState(false)
  const [moderateReason, setModerateReason] = useState('')
  const [banAfterModerate, setBanAfterModerate] = useState(false)

  // Delete own message confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Sender data (occupant, senderAvatar, resolvedSenderName, presence, permissions,
  // JIDs) is resolved once per row in the list layer (resolveRoomSender) and passed in
  // as reference-stable / primitive props — see RoomMessageList.renderMessage. The row
  // therefore never touches `room` (a fresh Map ref every presence stanza), so its memo
  // bails on presence churn for unaffected occupants.
  //
  // Roster contact for senderColor: looked up from the superset senderBareJid prop
  // (occupant-id fallback included), matching the pre-refactor lookup.

  // Resolve the replied-to message reactively from the store. Reading a render-time
  // lookup here would freeze this memoized row on the XEP-0428 fallback when the quoted
  // message only paginates in later. Uses the roomJid prop (the row no longer sees `room`).
  const replyTarget = useReferencedMessage({ type: 'groupchat', roomJid, id: message.replyTo?.id })

  const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined

  // Get sender color: dedicated AA-safe self color for own messages, contact's pre-calculated color, or fallback to nick-based generation
  const senderColor = message.isOutgoing
    ? 'var(--fluux-text-self)'
    // Seed on stable identity (occupant-id, then real JID), not the display name,
    // so an impersonator's look-alike nick renders in a different color.
    : resolveSenderColor(
        nickColorSeed({ occupantId: message.occupantId, bareJid: senderBareJid, nick: message.nick }),
        contact,
        isDarkMode ?? true,
      )

  // Get my current reactions to this message (room — uses nick)
  const myReactions = getMyReactions(message.reactions, myNick, undefined, true)

  // Handle reaction toggle — poll-option emojis are routed through vote enforcement
  const handleReaction = (emoji: string) => {
    if (!myNick) return

    // If this is a poll-option emoji, route through vote enforcement
    if (message.poll) {
      const pollEmojis = message.poll.options.map(o => o.emoji)
      if (pollEmojis.includes(emoji)) {
        void votePoll(roomJid, message.id, emoji, myReactions, message.poll)
        return
      }
    }

    // Regular reaction toggle for non-poll emojis
    const newReactions = myReactions.includes(emoji)
      ? myReactions.filter(e => e !== emoji)
      : [...myReactions, emoji]

    sendReaction(roomJid, message.id, newReactions).catch((e) => {
      if (e instanceof WhisperCounterpartGoneError) {
        addToast('info', t('rooms.whisperCounterpartGone', { nick: e.nick }))
        return
      }
      throw e
    })
  }

  // Handle poll vote — uses SDK vote() which enforces single/multi-vote rules
  const handlePollVote = message.poll ? (emoji: string) => {
    void votePoll(roomJid, message.id, emoji, myReactions, message.poll!, !!message.pollClosedAt)
  } : undefined

  // Build reply context using shared helper (replyTarget resolved above)
  const replyContext = buildReplyContext(
    message,
    replyTarget,
    (originalMsg, fallbackId) => {
      if (originalMsg) return originalMsg.nick
      // For rooms, fallbackId is the full JID like room@server/nick - extract nick
      return fallbackId ? fallbackId.split('/').pop() || 'Unknown' : 'Unknown'
    },
    (originalMsg, fallbackId, dark) => {
      // Own messages: use the dedicated AA-safe self color
      if (originalMsg?.isOutgoing) return 'var(--fluux-text-self)'
      const nick = originalMsg?.nick || (fallbackId ? fallbackId.split('/').pop() : undefined)
      if (!nick) return 'var(--fluux-brand)'
      // Same contact-color preference as the main senderColor above, so the
      // quote never disagrees with the sender's main-message color.
      const replyContact = replyBareJid ? contactsByJid.get(replyBareJid) : undefined
      return resolveSenderColor(
        nickColorSeed({ occupantId: originalMsg?.occupantId, bareJid: replyBareJid, nick }),
        replyContact,
        dark ?? true,
      )
    },
    // Reply-target avatar resolved to primitives in the list layer (resolveReplyAvatar)
    // and passed in — so this callback reads no `room` and the row memo stays bail-able.
    () => ({ avatarUrl: replyAvatarUrl, avatarIdentifier: replyAvatarIdentifier ?? 'unknown' }),
    isDarkMode
  )

  // Get reactor display name (for rooms, nicks are shown as-is)
  // Note: MAM-loaded reactions may use full MUC JID (room@server/nick), so extract nick
  const getReactorName = (reactorId: string) => {
    // Extract nick from full MUC JID (room@server/nick) or use as-is if already a nick
    const nick = reactorId.includes('/') ? reactorId.split('/').pop() || reactorId : reactorId
    if (nick === myNick) return t('chat.you')
    return nick
  }

  // Build nick extras (affiliation badge and XEP-0317 hats)
  // Note: individual tooltips removed - all info is now in the unified avatar/name tooltip
  // Show affiliation (owner/admin) rather than role, consistent with the member list
  const nickExtras = (
    <>
      {occupant && occupant.affiliation === 'owner' && (
        <span className="self-center">
          <Crown className="size-3.5 text-fluux-muted" />
        </span>
      )}
      {occupant && occupant.affiliation === 'admin' && (
        <span className="self-center">
          <Shield className="size-3.5 text-fluux-muted" />
        </span>
      )}
      {(() => {
        const hats = occupant?.hats ?? []
        const MAX_INLINE = 3
        const visible = hats.slice(0, MAX_INLINE)
        const overflow = hats.slice(MAX_INLINE, MAX_INLINE + 9)
        return (
          <>
            {visible.map((hat) => (
              <span
                key={hat.uri}
                className="px-1.5 py-0.5 text-[10px] font-medium rounded self-center"
                style={getHatColors(hat)}
              >
                {hat.title}
              </span>
            ))}
            {overflow.length > 0 && (
              <Tooltip
                content={
                  <div className="flex flex-col gap-1">
                    {overflow.map((hat) => (
                      <span
                        key={hat.uri}
                        className="px-1.5 py-0.5 text-[10px] font-medium rounded inline-block"
                        style={getHatColors(hat)}
                      >
                        {hat.title}
                      </span>
                    ))}
                  </div>
                }
                position="top"
                delay={300}
              >
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded self-center bg-fluux-muted/20 text-fluux-muted cursor-default">
                  +{overflow.length}
                </span>
              </Tooltip>
            )}
          </>
        )
      })()}
    </>
  )

  // Bind nick to context menu callbacks for this message
  const handleNickContextMenu = (e: React.MouseEvent) => {
    onNickContextMenu?.(message.nick, e)
  }

  const handleNickTouchStart = (e: React.TouchEvent) => {
    onNickTouchStart?.(message.nick, e)
  }

  return (
    <>
      <MessageBubble
        message={message}
        showAvatar={showAvatar}
        isGroupEnd={isGroupEnd}
        ownGroupKey={ownGroupKey}
        isSelected={isSelected}
        hasKeyboardSelection={hasKeyboardSelection}
        showToolbarForSelection={showToolbarForSelection}
        hideToolbar={hideToolbar}
        isLastOutgoing={isLastOutgoing}
        isLastMessage={isLastMessage}
        isDarkMode={isDarkMode}
        isHovered={isHovered}
        onMouseEnter={() => onMouseEnter?.(message.id)}
        onMouseLeave={onMouseLeave}
        senderName={resolvedSenderName}
        senderColor={senderColor}
        avatarUrl={message.isOutgoing ? (ownAvatar || undefined) : (senderAvatar || undefined)}
        avatarIdentifier={resolvedSenderName}
        avatarFallbackColor={senderColor}
        avatarPresence={avatarPresence}
        senderJid={senderBareJid}
        senderContact={contact}
        senderRole={senderRole}
        senderAffiliation={senderAffiliation}
        senderOccupantJid={`${roomJid}/${message.nick}`}
        nickExtras={nickExtras}
        myReactions={myReactions}
        onReaction={supportsReactions ? handleReaction : undefined}
        getReactorName={getReactorName}
        canModerate={canModerateMsg}
        isIrcGateway={isIrcGateway}
        onReply={() => onReply(message)}
        onEdit={() => onEdit(message)}
        onDelete={async () => {
          if (message.isOutgoing) {
            setShowDeleteConfirm(true)
          } else {
            setShowModerateConfirm(true)
          }
        }}
        onMediaLoad={onMediaLoad}
        replyContext={replyContext}
        mentions={message.mentions}
        nickname={myNick}
        knownNicks={knownNicks}
        resolveMentionColor={resolveMentionColor}
        whisperWith={message.whisperWith}
        whisperThread={whisperThread}
        counterpartPresent={counterpartPresent}
        onNickContextMenu={!message.isOutgoing ? handleNickContextMenu : undefined}
        onNickTouchStart={!message.isOutgoing ? handleNickTouchStart : undefined}
        onNickTouchEnd={!message.isOutgoing ? onNickTouchEnd : undefined}
        onReactionPickerChange={(isOpen) => onReactionPickerChange?.(message.id, isOpen)}
        onPollVote={handlePollVote}
        onClosePoll={canClosePoll(message, isPollClosed) ? () => closePoll(roomJid, message.id) : undefined}

        formatTime={formatTime}
        timeFormat={timeFormat}
        highlightTerms={highlightTerms}
        isCurrentMatch={isCurrentMatch}
      />

      {/* Delete own message confirmation dialog */}
      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('chat.deleteMessage')}
          message={t('chat.deleteMessageConfirm')}
          confirmLabel={t('chat.deleteMessage')}
          variant="danger"
          onConfirm={() => {
            setShowDeleteConfirm(false)
            void retractMessage(roomJid, message.id)
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* Moderation confirmation dialog */}
      {showModerateConfirm && (
        <ModalOverlay
          onClose={() => {
            setShowModerateConfirm(false)
            setModerateReason('')
            setBanAfterModerate(false)
          }}
          panelClassName="p-4"
        >
          {({ close }) => (
            <>
            <h3 className="text-lg font-semibold text-fluux-text mb-2">{t('chat.moderateMessage')}</h3>
            <p className="text-sm text-fluux-muted mb-3">{t('chat.moderateMessageConfirm')}</p>
            <div className="mb-3">
              <label className="block text-xs text-fluux-muted mb-1">{t('chat.moderateReason')}</label>
              <TextInput
                type="text"
                value={moderateReason}
                onChange={(e) => setModerateReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setShowModerateConfirm(false)
                    const reason = moderateReason.trim() || undefined
                    setModerateReason('')
                    void moderateMessage(roomJid, message.stanzaId ?? message.id, reason)
                    if (banAfterModerate && senderBareJidForBan) {
                      void setAffiliation(roomJid, senderBareJidForBan, 'outcast', reason)
                    }
                    setBanAfterModerate(false)
                  }
                }}
                placeholder={t('chat.moderateReasonPlaceholder')}
                className="w-full px-3 py-1.5 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder-fluux-muted focus:outline-none focus:ring-2 focus:ring-fluux-brand/50"
                autoFocus
              />
            </div>
            {canBanUser && senderBareJidForBan && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={banAfterModerate}
                  onChange={(e) => setBanAfterModerate(e.target.checked)}
                  className="size-4 rounded border-fluux-border text-fluux-brand focus:ring-fluux-brand/50"
                />
                <span className="text-sm text-fluux-text">{t('chat.moderateAndBan')}</span>
              </label>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={close}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  setShowModerateConfirm(false)
                  const reason = moderateReason.trim() || undefined
                  setModerateReason('')
                  void moderateMessage(roomJid, message.stanzaId ?? message.id, reason)
                  if (banAfterModerate && senderBareJidForBan) {
                    void setAffiliation(roomJid, senderBareJidForBan, 'outcast', reason)
                  }
                  setBanAfterModerate(false)
                }}
                className="px-4 py-2 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              >
                {t('chat.moderateMessage')}
              </button>
            </div>
            </>
          )}
        </ModalOverlay>
      )}
    </>
  )
})

interface RoomMessageInputProps {
  roomJid: string
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  sendMessage: (roomJid: string, body: string, options?: { replyTo?: { id: string; to: string; fallback?: { author: string; body: string } }; references?: MentionReference[]; attachment?: FileAttachment }) => Promise<string>
  sendCorrection: (roomJid: string, messageId: string, newBody: string, attachment?: FileAttachment) => Promise<void>
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  sendChatState: (roomJid: string, state: ChatStateNotification) => Promise<void>
  sendWhisperChatState: (roomJid: string, nick: string, state: ChatStateNotification) => Promise<void>
  sendEasterEgg: (roomJid: string, animation: string) => Promise<void>
  sendPoll: (roomJid: string, title: string, options: string[], settings?: Partial<import('@fluux/sdk').PollSettings>, description?: string, deadline?: string, customEmojis?: string[]) => Promise<string>
  onMessageSent?: () => void
  onInputResize?: () => void
  replyingTo: RoomMessage | null
  onCancelReply: () => void
  editingMessage: RoomMessage | null
  onCancelEdit: () => void
  onEditLastMessage?: () => void
  onComposingChange?: (isComposing: boolean) => void
  uploadState?: { isUploading: boolean; progress: number; error: string | null; clearError: () => void }
  isUploadSupported?: boolean
  onFileSelect?: (file: File) => void
  uploadFile?: (file: File) => Promise<FileAttachment | null>
  pendingAttachment?: PendingAttachment | null
  onRemovePendingAttachment?: () => void
  processLinkPreview?: (messageId: string, body: string, to: string, type: 'chat' | 'groupchat') => Promise<void>
  isConnected: boolean
  onMessageIdSent?: (messageId: string) => void
  whisperTarget?: WhisperTarget | null
  onClearWhisper?: () => void
  sendWhisper: (roomJid: string, nick: string, body: string) => Promise<string>
  /** Whether the app is in dark mode -- used to compute the per-person reply-chip color. */
  isDarkMode?: boolean
}

export const RoomMessageInput = memo(function RoomMessageInput({
  roomJid,
  textareaRef,
  sendMessage,
  sendCorrection,
  retractMessage,
  sendChatState,
  sendWhisperChatState,
  sendEasterEgg,
  sendPoll,
  onMessageSent,
  onInputResize,
  replyingTo,
  onCancelReply,
  editingMessage,
  onCancelEdit,
  onEditLastMessage,
  onComposingChange,
  uploadState,
  isUploadSupported,
  onFileSelect,
  uploadFile,
  pendingAttachment,
  onRemovePendingAttachment,
  processLinkPreview,
  isConnected,
  onMessageIdSent,
  whisperTarget,
  onClearWhisper,
  sendWhisper,
  isDarkMode,
  ref,
}: RoomMessageInputProps & { ref?: React.Ref<MessageComposerHandle> }) {
  detectRenderLoop('RoomMessageInput')
  const { t } = useTranslation()
  // Narrow, reference-stable subscriptions: the composer re-renders on entity
  // changes (name/nickname) and occupant COUNT changes (join/leave), but NOT on
  // message churn nor on occupant metadata churn (show/avatar/presence flapping).
  const entity = useRoomEntity(roomJid)
  const roomName = entity?.name ?? roomJid
  const roomNickname = entity?.nickname ?? ''
  // Subscribe ONLY to the derived "small enough to send typing notifications?"
  // boolean, NOT the raw occupant count. The occupants Map ref is replaced on every
  // occupant event (join/leave/show/avatar update); even the count changes on every
  // join/leave, so a count subscription re-rendered the composer ~1:1 with membership
  // churn (netsplit rejoin, busy room). The only thing we derive from the count is a
  // threshold decision, which flips only when the room crosses MAX_ROOM_SIZE_FOR_TYPING
  // — so subscribe to that boolean and a stably-large (or stably-small) room costs no
  // composer renders on join/leave. Whisper-counterpart presence is handled separately
  // by its own narrow subscription (useWhisperCounterpartPresent).
  //
  // The occupant DATA — mention candidates — is read NON-reactively from the store on
  // each render (like messageNicks below): the composer already re-renders on every
  // keystroke while composing a mention, so the candidate list stays fresh without a
  // subscription (the mention popup is only visible while typing).
  const shouldSendTypingNotifications = useRoomOccupantCountBelow(roomJid, MAX_ROOM_SIZE_FOR_TYPING)
  const occupants = roomStore.getState().getRoom(roomJid)?.occupants ?? EMPTY_OCCUPANTS
  // Draft actions are stable function refs — read non-reactively from the store.
  const { setDraft, getDraft, clearDraft, clearFirstNewMessageId } = roomStore.getState()
  const addToast = useToastStore((s) => s.addToast)
  const [showPollCreator, setShowPollCreator] = useState(false)

  // Reactive whisper-counterpart presence. The hook re-evaluates on every occupant
  // change — driving the "gone" banner and the disabled Send button while preserving
  // the typed draft. Called unconditionally (returns false when target is null).
  const counterpartPresent = useWhisperCounterpartPresent(roomJid, whisperTarget)
  const whisperCounterpartGone = !!whisperTarget && !counterpartPresent

  // Mention state
  const [cursorPosition, setCursorPosition] = useState(0)
  const [references, setReferences] = useState<MentionReference[]>([])
  const composerRef = useRef<MessageComposerHandle>(null)

  // Forward ref to parent for focus after staging attachment
  React.useImperativeHandle(ref, () => ({
    focus: () => composerRef.current?.focus(),
    getText: () => composerRef.current?.getText() || '',
    setText: (t: string) => composerRef.current?.setText(t),
  }), [])

  // Stable callback for draft restoration (resets mention references)
  const handleDraftRestored = useCallback(() => setReferences([]), [])

  // Draft persistence - saves on room change, restores on load, clears references
  const [text, setText] = useConversationDraft({
    conversationId: roomJid,
    draftOperations: { getDraft, setDraft, clearDraft },
    composerRef,
    onDraftRestored: handleDraftRestored,
  })

  // Exit whisper mode AND discard the typed text. The composer draft is keyed only
  // by room JID, so a private whisper draft would otherwise survive into the public
  // composer and could be sent to the whole room. Discarding upholds the invariant:
  // private text is never converted into a public message (XEP-0045 §7.5).
  const handleClearWhisper = () => {
    setText('')
    clearDraft(roomJid)
    onClearWhisper?.()
  }

  // Slash commands (XEP-0045 moderation/subject/invite shortcuts, plus app-level
  // easter eggs). The context composes the room action hooks and the roomUiStore
  // bridge so commands can open modals rendered in RoomHeader.
  const [helpOpen, setHelpOpen] = useState(false)
  const selfOccupant = occupants.get(roomNickname)
  const commandSelf = {
    role: selfOccupant?.role ?? 'none' as RoomRole,
    affiliation: selfOccupant?.affiliation ?? 'none' as RoomAffiliation,
  }
  const commandContext = useRoomCommandContext({
    roomJid,
    self: commandSelf,
    occupants,
    currentSubject: entity?.subject,
    onOpenHelp: () => setHelpOpen(true),
    sendEasterEgg: (jid, _kind, animation) => { void sendEasterEgg(jid, animation) },
  })
  const { resolveInput, classifyInput } = useSlashCommands(commandContext)
  const commandMenu = useCommandMenu(text, cursorPosition, 'room', commandSelf)

  // Type-to-focus: auto-focus composer when user starts typing anywhere
  useTypeToFocus(composerRef)

  // Collect mention-candidate nicks (occupants + history authors + affiliated
  // members). Read NON-reactively from the store on each render: this must NOT
  // subscribe to room.messages (that would re-render the composer on every
  // message). Recomputed each render so it stays fresh while typing, without a
  // subscription. (Do not memoize on [roomJid] — that would freeze the set at
  // room-entry and miss later authors.)
  const messageNicks = (() => {
    const nicks = new Set<string>()
    const liveRoom = roomStore.getState().getRoom(roomJid)
    for (const msg of liveRoom?.messages ?? []) nicks.add(msg.nick)
    for (const member of liveRoom?.affiliatedMembers ?? []) {
      if (member.nick) nicks.add(member.nick)
    }
    return nicks
  })()

  // Mention autocomplete hook
  const { state: mentionState, selectMatch, moveSelection, dismiss } = useMentionAutocomplete(
    text,
    cursorPosition,
    occupants,
    roomNickname,
    roomJid,
    messageNicks
  )

  // Handle mention selection
  const handleMentionSelect = (index: number) => {
    const { newText, newCursorPosition, reference } = selectMatch(index)
    setText(newText)
    setReferences(prev => [...prev, reference])
    // Focus and set cursor position after state update
    setTimeout(() => {
      composerRef.current?.focus()
    }, 0)
    setCursorPosition(newCursorPosition)
  }

  // Auto-focus composer when starting a reply
  useEffect(() => {
    if (replyingTo) {
      setTimeout(() => composerRef.current?.focus(), 0)
    }
  }, [replyingTo])

  // Convert RoomMessage to ReplyInfo for the composer
  // Use stanzaId (XEP-0359) for MUC messages - this is what other clients use to look up the referenced message
  const replyInfo: ReplyInfo | null = replyingTo
    ? {
        id: replyingTo.stanzaId || replyingTo.id,
        from: replyingTo.from,
        senderName: replyingTo.nick,
        body: replyingTo.body,
        senderColor: auroraSenderColor(nickColorSeed({ occupantId: replyingTo.occupantId, nick: replyingTo.nick }), isDarkMode ?? true),
      }
    : null

  // Convert RoomMessage to EditInfo for the composer
  const editInfo: EditInfo | null = editingMessage
    ? {
        id: editingMessage.id,
        body: editingMessage.body,
        attachment: editingMessage.attachment,
      }
    : null

  // Handle correction
  const handleCorrection = async (messageId: string, newBody: string, attachment?: import('@fluux/sdk').FileAttachment): Promise<boolean> => {
    try {
      await sendCorrection(roomJid, messageId, newBody, attachment)
      return true
    } catch (e) {
      if (e instanceof WhisperCounterpartGoneError) {
        addToast('info', t('rooms.whisperCounterpartGone', { nick: e.nick }))
        return false
      }
      throw e
    }
  }

  // Handle retraction (when edit removes all content)
  const handleRetract = async (messageId: string): Promise<void> => {
    try {
      await retractMessage(roomJid, messageId)
    } catch (e) {
      if (e instanceof WhisperCounterpartGoneError) {
        addToast('info', t('rooms.whisperCounterpartGone', { nick: e.nick }))
        return
      }
      throw e
    }
  }

  // Handle send
  const handleSend = async (sendText: string): Promise<boolean> => {
    // Whisper mode (XEP-0045 §7.5): text-only, ephemeral, no reply/attachment.
    if (whisperTarget) {
      // Hard backstop: re-check presence against the LIVE occupant list (not the
      // closed-over prop) so we cover the gap between the counterpart leaving and
      // React re-rendering the disabled Send button. Never deliver private text
      // once they've left or the nick has been recycled by someone else.
      const liveOccupants = roomStore.getState().getRoom(roomJid)?.occupants ?? occupants
      const decision = decideWhisperSend(whisperTarget, sendText, liveOccupants)
      if (!decision.ok) {
        if (decision.reason === 'counterpart-gone') {
          addToast('info', t('rooms.whisperCounterpartGone', { nick: decision.nick }))
        }
        return false
      }
      const messageId = await sendWhisper(roomJid, decision.nick, decision.body)
      onMessageIdSent?.(messageId)
      clearDraft(roomJid)
      onMessageSent?.()
      setTimeout(() => clearFirstNewMessageId(roomJid), 500)
      return true
    }

    // Include reply info if replying to a message
    // SDK resolves stanzaId vs id for the protocol reference (XEP-0461)
    let replyTo: { id: string; to: string; fallback?: { author: string; body: string } } | undefined
    if (replyingTo) {
      replyTo = {
        id: replyingTo.id,
        to: replyingTo.from,
        fallback: { author: replyingTo.nick, body: replyingTo.body }
      }
    }

    // If there's a pending attachment, upload it first (privacy: only upload when user explicitly sends)
    let attachment: FileAttachment | null | undefined
    if (pendingAttachment && uploadFile) {
      attachment = await uploadFile(pendingAttachment.file)
      if (!attachment) {
        // Upload failed - don't send the message
        return false
      }
    }

    // The body is the file URL if no text was entered, otherwise the user's text
    const body = sendText || attachment?.url || ''
    const messageId = await sendMessage(roomJid, body, { replyTo, references: references.length > 0 ? references : undefined, attachment: attachment ?? undefined })
    setReferences([])

    // Notify parent of sent message ID for animation
    onMessageIdSent?.(messageId)

    // Clear pending attachment after sending
    if (pendingAttachment) {
      onRemovePendingAttachment?.()
    }

    // Clear draft immediately so sidebar updates
    clearDraft(roomJid)

    // Whisper sends return early above, so a private URL never reaches link-preview generation (no room broadcast).
    // Process link preview in background (don't block on it)
    if (processLinkPreview && sendText) {
      processLinkPreview(messageId, sendText, roomJid, 'groupchat').catch(console.error)
    }

    // Send active state after message (for small rooms)
    if (shouldSendTypingNotifications) {
      void sendChatState(roomJid, 'active')
    }

    // Scroll to bottom to show the sent message
    onMessageSent?.()

    // Clear the "new messages" marker after a short delay (user is actively engaged)
    setTimeout(() => clearFirstNewMessageId(roomJid), 500)

    return true
  }

  // Handle typing state
  const handleTypingState = (state: 'composing' | 'paused') => {
    const route = decideChatStateRoute(whisperTarget ?? null, shouldSendTypingNotifications)
    if (route.target === 'whisper') void sendWhisperChatState(roomJid, route.nick, state)
    else if (route.target === 'room') void sendChatState(roomJid, state)
  }

  // Clear references when text is cleared
  useEffect(() => {
    if (text === '') {
      setReferences([])
    }
  }, [text])

  // Mention autocomplete dropdown
  const mentionDropdown = mentionState.isActive && mentionState.matches.length > 0 ? (
    <div
      className="absolute bottom-full inset-x-0 mb-1 max-h-48 overflow-y-auto
                 fluux-popover rounded-lg z-30"
    >
      {mentionState.matches.map((match, idx) => (
        <button
          key={match.nick}
          type="button"
          onClick={() => handleMentionSelect(idx)}
          className={`w-full px-3 py-2 text-start text-sm flex items-center gap-2 transition-colors
                     ${idx === mentionState.selectedIndex
                       ? 'bg-fluux-brand text-fluux-text-on-accent'
                       : 'hover:bg-fluux-hover text-fluux-text'}`}
        >
          {/* Avatar */}
          {match.isAll ? (
            <div className="size-6 rounded-full flex items-center justify-center flex-shrink-0 bg-fluux-brand">
              <Users className="size-3.5 text-fluux-text-on-accent" />
            </div>
          ) : (
            <Avatar
              identifier={match.nick}
              name={match.nick}
              size="xs"
            />
          )}
          <span className="font-medium">@{match.nick}</span>
          {match.isAll && (
            <span className={`text-xs ${idx === mentionState.selectedIndex ? 'text-fluux-text-on-accent/70' : 'text-fluux-muted'}`}>
              {t('rooms.notifyEveryone')}
            </span>
          )}
          {match.role === 'moderator' && !match.isAll && (
            <span className={`text-xs ${idx === mentionState.selectedIndex ? 'text-fluux-text-on-accent/70' : 'text-fluux-muted'}`}>
              {t('rooms.mod')}
            </span>
          )}
        </button>
      ))}
    </div>
  ) : null

  // Popovers rendered above the composer, in priority order: help panel, then
  // command completion menu, then the mention dropdown.
  const aboveInputNode = helpOpen ? (
    <CommandHelpPanel commands={visibleCommands('room', commandSelf)} onClose={() => setHelpOpen(false)} />
  ) : commandMenu.state.isActive ? (
    <CommandMenu
      matches={commandMenu.state.matches}
      selectedIndex={commandMenu.state.selectedIndex}
      onSelect={(idx) => {
        const cmd = commandMenu.state.matches[idx]
        if (cmd) {
          setText(`/${cmd.name} `)
          commandMenu.dismiss()
        }
      }}
      onDismiss={commandMenu.dismiss}
    />
  ) : (
    mentionDropdown
  )

  // Custom input renderer with mention highlighting
  const renderMentionInput = ({ inputRef, mergedRef, value, onChange, onKeyDown: baseKeyDown, onSelect, onPaste, placeholder }: {
    inputRef: React.RefObject<HTMLTextAreaElement | null>
    mergedRef: (node: HTMLTextAreaElement | null) => void
    value: string
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
    onSelect?: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
    onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
    placeholder: string
  }) => {
    // Enhanced keydown handler for mentions
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Handle backspace/delete within a mention - delete the whole mention at once
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const textarea = e.currentTarget
        const selStart = textarea.selectionStart
        const selEnd = textarea.selectionEnd

        // Find if cursor/selection overlaps with any mention
        for (let i = 0; i < references.length; i++) {
          const ref = references[i]
          // Check if cursor is inside or at the boundary of this mention
          const cursorInMention = (e.key === 'Backspace')
            ? (selStart > ref.begin && selStart <= ref.end) // Backspace: cursor after start, up to end
            : (selStart >= ref.begin && selStart < ref.end) // Delete: cursor from start, before end
          const selectionOverlapsMention = selStart < ref.end && selEnd > ref.begin

          if (cursorInMention || selectionOverlapsMention) {
            e.preventDefault()

            // Remove the entire mention from text
            const newText = text.slice(0, ref.begin) + text.slice(ref.end)
            const mentionLength = ref.end - ref.begin

            // Update references: remove this one and adjust positions of later ones
            const newReferences = references
              .filter((_, idx) => idx !== i)
              .map(r => {
                if (r.begin > ref.begin) {
                  return { ...r, begin: r.begin - mentionLength, end: r.end - mentionLength }
                }
                return r
              })

            setText(newText)
            setReferences(newReferences)

            // Set cursor to where the mention started
            setTimeout(() => {
              if (inputRef.current) {
                inputRef.current.setSelectionRange(ref.begin, ref.begin)
                setCursorPosition(ref.begin)
              }
            }, 0)
            return
          }
        }
      }

      // Handle command-menu keyboard navigation. Takes precedence over the mention
      // menu -- in practice they are mutually exclusive (command menu only triggers
      // on a bare "/" at position 0, mentions trigger on "@" mid-text) but this makes
      // the precedence explicit.
      if (commandMenu.state.isActive) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          commandMenu.moveSelection('up')
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          commandMenu.moveSelection('down')
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const cmd = commandMenu.state.matches[commandMenu.state.selectedIndex]
          if (cmd) {
            setText(`/${cmd.name} `)
            commandMenu.dismiss()
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          commandMenu.dismiss()
          return
        }
      }

      // Handle mention autocomplete keyboard navigation
      if (mentionState.isActive) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          moveSelection('up')
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          moveSelection('down')
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          if (mentionState.matches.length > 0) {
            e.preventDefault()
            handleMentionSelect(mentionState.selectedIndex)
            return
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismiss()
          return
        }
      }

      // Pass to base handler for enter to send
      baseKeyDown(e)
    }

    return (
      <>
        {/* Background layer with styled mentions - positioned absolutely within parent wrapper */}
        <div
          className="message-input absolute inset-0 px-2 py-3 pointer-events-none whitespace-pre-wrap
                     overflow-hidden"
          aria-hidden="true"
          ref={(el) => {
            // Sync scroll position with textarea
            if (el && inputRef.current) {
              el.scrollTop = inputRef.current.scrollTop
            }
          }}
        >
          {renderInputWithMentions(value, references)}
        </div>
        {/* Transparent textarea on top - uses shared base classes for consistency */}
        <TextArea
          ref={mergedRef}
          value={value}
          onChange={onChange}
          onSelect={onSelect}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          onScroll={(e) => {
            // Sync overlay scroll when textarea scrolls
            const overlay = e.currentTarget.previousElementSibling as HTMLElement
            if (overlay) {
              overlay.scrollTop = e.currentTarget.scrollTop
            }
          }}
          placeholder={placeholder}
          rows={1}
          spellCheck={true}
          autoCorrect="on"
          autoCapitalize="sentences"
          className={`${MESSAGE_INPUT_BASE_CLASSES} ${MESSAGE_INPUT_OVERLAY_CLASSES}`}
          style={{ caretColor: 'var(--fluux-text, #e4e4e7)' }}
        />
      </>
    )
  }

  return (
    <div
      onKeyDownCapture={(e) => {
        if (whisperTarget && e.key === 'Escape') {
          e.stopPropagation()
          handleClearWhisper()
        }
      }}
    >
      {showPollCreator && (
        <PollCreator
          onClose={() => setShowPollCreator(false)}
          onCreatePoll={async (title, options, settings, description, deadline, customEmojis) => {
            await sendPoll(roomJid, title, options, settings, description, deadline, customEmojis)
          }}
        />
      )}
      {whisperTarget && (
        <div className={`flex items-center justify-between gap-2 px-4 py-1.5 mb-1 rounded text-sm border-s-2 ${
          whisperCounterpartGone
            ? 'bg-fluux-muted/10 text-fluux-muted border-fluux-muted/40'
            : 'bg-fluux-private-soft text-fluux-private border-fluux-private'
        }`}>
          <span className="inline-flex items-center gap-1.5 min-w-0">
            {whisperCounterpartGone
              ? <AlertCircle className="size-4 shrink-0" />
              : <Ear className="size-4 shrink-0" />}
            <span className="truncate">
              {whisperCounterpartGone
                ? t('rooms.whisperCounterpartGone', { nick: whisperTarget.nick })
                : t('rooms.whisperingTo', { nick: whisperTarget.nick })}
            </span>
          </span>
          <button
            type="button"
            onClick={handleClearWhisper}
            aria-label={t('common.cancel')}
            className={`shrink-0 rounded p-0.5 ${whisperCounterpartGone ? 'hover:bg-fluux-muted/20' : 'hover:bg-fluux-private-hover'}`}
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <MessageComposer
        ref={composerRef}
        textareaRef={textareaRef}
        placeholder={whisperTarget ? t('rooms.whisperPlaceholder', { nick: whisperTarget.nick }) : t('chat.messageRoom', { name: roomName })}
        replyingTo={replyInfo}
        onCancelReply={onCancelReply}
        editingMessage={editInfo}
        onCancelEdit={onCancelEdit}
        onSendCorrection={handleCorrection}
        onRetractMessage={handleRetract}
        onComposingChange={onComposingChange}
        onInputResize={onInputResize}
        onSend={handleSend}
        onSendEasterEgg={(animation) => sendEasterEgg(roomJid, animation)}
        onCreatePoll={() => setShowPollCreator(true)}
        onSendTypingState={handleTypingState}
        typingNotificationsEnabled={shouldSendTypingNotifications}
        renderInput={renderMentionInput}
        aboveInput={aboveInputNode}
        resolveInput={resolveInput}
        classifyInput={classifyInput}
        commandsEnabled={!whisperTarget}
        value={text}
        onValueChange={setText}
        onSelectionChange={setCursorPosition}
        onFileSelect={onFileSelect}
        uploadState={uploadState}
        isUploadSupported={isUploadSupported}
        pendingAttachment={pendingAttachment}
        onRemovePendingAttachment={onRemovePendingAttachment}
        disabled={!isConnected}
        sendDisabled={whisperCounterpartGone}
        sendBadge={whisperTarget
          ? <Ear className={`absolute bottom-2 end-2 size-2.5 ${whisperCounterpartGone ? 'text-fluux-muted' : 'text-fluux-private'}`} />
          : undefined}
        onEditLastMessage={onEditLastMessage}
      />
    </div>
  )
})

/**
 * Join prompt shown when viewing a bookmarked room that is not joined.
 * Replaces the composer area with a button to join the room.
 */
function RoomJoinPrompt({
  onJoin,
}: {
  onJoin: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [isJoining, setIsJoining] = useState(false)

  const handleJoin = async () => {
    setIsJoining(true)
    try {
      await onJoin()
    } finally {
      setIsJoining(false)
    }
  }

  return (
    <div className="p-4 border-t border-fluux-hover">
      <button
        onClick={handleJoin}
        disabled={isJoining}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-fluux-brand hover:bg-fluux-brand/90
                   disabled:opacity-50 disabled:cursor-not-allowed text-fluux-text-on-accent rounded-lg font-medium transition-colors"
      >
        {isJoining ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {t('rooms.joining')}
          </>
        ) : (
          <>
            <LogIn className="size-4" />
            {t('rooms.joinToParticipate')}
          </>
        )}
      </button>
    </div>
  )
}

// Helper functions

/**
 * Render text with @mentions highlighted for the input overlay
 * Only highlights completed mentions (those in the references array)
 */
function renderInputWithMentions(text: string, references: MentionReference[]): React.ReactNode {
  if (!text) return null

  // If no references, render plain text
  if (references.length === 0) {
    return <span className="text-fluux-text">{text}</span>
  }

  // Sort references by begin position
  const sortedRefs = [...references].sort((a, b) => a.begin - b.begin)

  const parts: React.ReactNode[] = []
  let lastIndex = 0

  for (let i = 0; i < sortedRefs.length; i++) {
    const ref = sortedRefs[i]

    // Add text before this mention
    if (ref.begin > lastIndex) {
      parts.push(
        <span key={`text-${i}`} className="text-fluux-text">
          {text.slice(lastIndex, ref.begin)}
        </span>
      )
    }

    // Add the highlighted mention
    parts.push(
      <span key={`mention-${i}`} className="text-fluux-brand">
        {text.slice(ref.begin, ref.end)}
      </span>
    )

    lastIndex = ref.end
  }

  // Add any remaining text after the last mention
  if (lastIndex < text.length) {
    parts.push(
      <span key="text-end" className="text-fluux-text">
        {text.slice(lastIndex)}
      </span>
    )
  }

  return <>{parts}</>
}

