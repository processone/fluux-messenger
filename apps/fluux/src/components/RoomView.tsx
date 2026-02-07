import React, { useState, useRef, useEffect, useMemo, useCallback, memo, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoom, useRoster, getBareJid, generateConsistentColorHexSync, getPresenceFromShow, createMessageLookup, type RoomMessage, type Room, type MentionReference, type ChatStateNotification, type Contact, type FileAttachment } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { useMentionAutocomplete, useFileUpload, useLinkPreview, useTypeToFocus, useMessageCopy, useMode, useMessageSelection, useDragAndDrop, useConversationDraft, useTimeFormat } from '@/hooks'
import { MessageBubble, MessageList, shouldShowAvatar, buildReplyContext } from './conversation'
import { Avatar, getConsistentTextColor } from './Avatar'
import { format } from 'date-fns'
import { Shield, Upload, Loader2, LogIn, AlertCircle, Users } from 'lucide-react'
import { ChristmasAnimation } from './ChristmasAnimation'
import { MessageComposer, type ReplyInfo, type EditInfo, type MessageComposerHandle, type PendingAttachment, MESSAGE_INPUT_BASE_CLASSES, MESSAGE_INPUT_OVERLAY_CLASSES } from './MessageComposer'
import { RoomHeader } from './RoomHeader'
import { OccupantPanel } from './OccupantPanel'
import { findLastEditableMessage, findLastEditableMessageId } from '@/utils/messageUtils'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'

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
  mainContentRef?: RefObject<HTMLElement>
  composerRef?: RefObject<HTMLElement>
}

// Max room size for sending typing indicators (to avoid noise in large rooms)
const MAX_ROOM_SIZE_FOR_TYPING = 30

export function RoomView({ onBack, mainContentRef, composerRef }: RoomViewProps) {
  const { t } = useTranslation()
  const { activeRoom, activeMessages, activeTypingUsers, sendMessage, sendReaction, sendCorrection, retractMessage, sendChatState, setRoomNotifyAll, activeAnimation, sendEasterEgg, clearAnimation, clearFirstNewMessageId, joinRoom, setRoomAvatar, clearRoomAvatar, fetchOlderHistory, activeMAMState } = useRoom()
  const { contacts } = useRoster()
  // NOTE: Use focused selectors instead of useConnection() hook to avoid
  // re-renders when unrelated connection state changes (error, reconnectAttempt, etc.)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const status = useConnectionStore((s) => s.status)
  const isConnected = status === 'online'
  const { uploadFile, isUploading, progress, isSupported } = useFileUpload()
  const { processMessageForLinkPreview } = useLinkPreview()
  const { resolvedMode } = useMode()

  // Create a map of contacts by JID for quick lookup (used to show avatars for known contacts)
  const contactsByJid = useMemo(() => {
    const map = new Map<string, Contact>()
    for (const contact of contacts) {
      map.set(contact.jid, contact)
    }
    return map
  }, [contacts])

  // Reply state
  const [replyingTo, setReplyingTo] = useState<RoomMessage | null>(null)

  // Edit state
  const [editingMessage, setEditingMessage] = useState<RoomMessage | null>(null)

  // Pending attachment state - staged file ready to send with next message
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null)


  // Find the last outgoing message ID for edit button visibility (skip retracted)
  const lastOutgoingMessageId = useMemo(
    () => findLastEditableMessageId(activeMessages),
    [activeMessages]
  )

  // Last message ID - reply button is disabled for last message (context is already clear)
  const lastMessageId = activeMessages.length > 0 ? activeMessages[activeMessages.length - 1].id : null

  // Handler to edit the last outgoing message (triggered by Up arrow in empty composer)
  const handleEditLastMessage = useCallback(() => {
    const msg = findLastEditableMessage(activeMessages)
    if (msg) {
      setEditingMessage(msg)
    }
  }, [activeMessages])

  // Composing state - hides message toolbars when user is typing
  const [isComposing, setIsComposing] = useState(false)

  // Track which message has reaction picker open (hides other toolbars)
  const [activeReactionPickerMessageId, setActiveReactionPickerMessageId] = useState<string | null>(null)

  // Occupant panel state
  const [showOccupants, setShowOccupants] = useState(false)

  // Memoized callbacks to prevent render loops (new function refs cause child re-renders)
  const handleCancelReply = useCallback(() => setReplyingTo(null), [])
  const handleCancelEdit = useCallback(() => setEditingMessage(null), [])
  const handleReactionPickerChange = useCallback((messageId: string, isOpen: boolean) => {
    setActiveReactionPickerMessageId(isOpen ? messageId : null)
  }, [])
  const handleCloseOccupants = useCallback(() => setShowOccupants(false), [])

  // Memoized upload state to prevent new object reference on every render
  const uploadStateObj = useMemo(() => ({ isUploading, progress }), [isUploading, progress])

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
    isHistoryComplete: !activeRoom?.supportsMAM || activeMAMState?.isHistoryComplete,
    onEnterPressed: useExpandedMessagesStore.getState().toggle,
  })

  // Format copied messages with sender headers
  useMessageCopy(scrollRef)

  // Create a lookup map for messages by ID (for reply context)
  // Index by both client id and stanza-id since replies may reference either
  const messagesById = useMemo(() => createMessageLookup(activeMessages), [activeMessages])

  // Clear reply/edit/pending attachment state when room changes
  // Note: scroll position is managed by MessageList component
  useEffect(() => {
    setReplyingTo(null)
    setEditingMessage(null)
    // Revoke old preview URL to avoid memory leaks
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl)
    }
    setPendingAttachment(null)
    clearSelection()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- pendingAttachment cleanup is intentional, not a trigger
  }, [activeRoom?.jid, clearSelection])

  // File drop handler - stages file for preview only (no upload yet - privacy protection)
  // Upload happens when user clicks Send, not on drop (prevents accidental data leaks)
  const handleFileDrop = useCallback((file: File) => {
    if (!activeRoom || !isSupported) return
    // Create preview URL for images/videos
    const previewUrl = file.type.startsWith('image/') || file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : undefined
    setPendingAttachment({ file, previewUrl })
    // Focus composer so user can add a message
    setTimeout(() => composerHandleRef.current?.focus(), 0)
  }, [activeRoom, isSupported])

  // Clear pending attachment and revoke preview URL
  const handleRemovePendingAttachment = useCallback(() => {
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl)
    }
    setPendingAttachment(null)
  }, [pendingAttachment])

  // Drag-and-drop for file upload (handles both HTML5 and Tauri native)
  const { isDragging, dragHandlers } = useDragAndDrop({
    onFileDrop: handleFileDrop,
    isUploadSupported: isSupported,
  })

  // Memoize the clearFirstNewMessageId callback to avoid render loops
  // (inline arrow functions create new references on every render)
  const roomJid = activeRoom?.jid
  const handleClearFirstNewMessageId = useCallback(() => {
    if (roomJid) {
      clearFirstNewMessageId(roomJid)
    }
  }, [roomJid, clearFirstNewMessageId])

  if (!activeRoom) return null

  return (
    <div
      className="flex flex-1 min-h-0 relative"
      {...dragHandlers}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-fluux-bg/95 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-fluux-brand rounded-xl bg-fluux-bg/50">
            <Upload className="w-12 h-12 text-fluux-brand" />
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
          className="focus-zone flex-1 flex flex-col min-h-0 p-1"
        >
          <RoomMessageList
            messages={activeMessages}
            messagesById={messagesById}
            scrollerRef={scrollRef}
            isAtBottomRef={isAtBottomRef}
            room={activeRoom}
            contactsByJid={contactsByJid}
            ownAvatar={ownAvatar}
            sendReaction={sendReaction}
            onReply={setReplyingTo}
            onEdit={setEditingMessage}
            lastOutgoingMessageId={lastOutgoingMessageId}
            lastMessageId={lastMessageId}
            typingUsers={activeTypingUsers}
            isComposing={isComposing}
            activeReactionPickerMessageId={activeReactionPickerMessageId}
            onReactionPickerChange={handleReactionPickerChange}
            retractMessage={retractMessage}
            selectedMessageId={selectedMessageId}
            hasKeyboardSelection={hasKeyboardSelection}
            showToolbarForSelection={showToolbarForSelection}
            firstNewMessageId={activeRoom.firstNewMessageId}
            clearFirstNewMessageId={handleClearFirstNewMessageId}
            isJoined={activeRoom.joined}
            isDarkMode={resolvedMode === 'dark'}
            onMediaLoad={handleMediaLoad}
            onScrollToTop={fetchOlderHistory}
            isLoadingOlder={activeMAMState?.isLoading}
            isHistoryComplete={!activeRoom.supportsMAM || activeMAMState?.isHistoryComplete}
          />
        </div>

        {/* Input - show composer if joined, join prompt if not */}
        {activeRoom.joined ? (
          <RoomMessageInput
            ref={composerHandleRef}
            room={activeRoom}
            textareaRef={composerRef as React.RefObject<HTMLTextAreaElement>}
            sendMessage={sendMessage}
            sendCorrection={sendCorrection}
            retractMessage={retractMessage}
            sendChatState={sendChatState}
            sendEasterEgg={sendEasterEgg}
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
          />
        ) : (
          <RoomJoinPrompt
            onJoin={() => joinRoom(activeRoom.jid, activeRoom.nickname)}
          />
        )}
      </div>

      {/* Occupant panel */}
      {showOccupants && (
        <OccupantPanel
          room={activeRoom}
          contactsByJid={contactsByJid}
          ownAvatar={ownAvatar}
          onClose={handleCloseOccupants}
        />
      )}

      {/* Christmas easter egg animation */}
      {activeAnimation?.roomJid === activeRoom.jid && activeAnimation.animation === 'christmas' && (
        <ChristmasAnimation onComplete={clearAnimation} />
      )}
    </div>
  )
}

const RoomMessageList = memo(function RoomMessageList({
  messages,
  messagesById,
  scrollerRef,
  isAtBottomRef,
  room,
  contactsByJid,
  ownAvatar,
  sendReaction,
  onReply,
  onEdit,
  lastOutgoingMessageId,
  lastMessageId,
  typingUsers,
  isComposing,
  activeReactionPickerMessageId,
  onReactionPickerChange,
  retractMessage,
  selectedMessageId,
  hasKeyboardSelection,
  showToolbarForSelection,
  firstNewMessageId,
  clearFirstNewMessageId,
  isJoined,
  isDarkMode,
  onMediaLoad,
  onScrollToTop,
  isLoadingOlder,
  isHistoryComplete,
}: {
  messages: RoomMessage[]
  messagesById: Map<string, RoomMessage>
  scrollerRef: React.RefObject<HTMLElement>
  isAtBottomRef: React.MutableRefObject<boolean>
  room: Room
  contactsByJid: Map<string, Contact>
  ownAvatar?: string | null
  sendReaction: (roomJid: string, messageId: string, emojis: string[]) => Promise<void>
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  lastOutgoingMessageId: string | null
  lastMessageId: string | null
  typingUsers: string[]
  isComposing: boolean
  activeReactionPickerMessageId: string | null
  onReactionPickerChange: (messageId: string, isOpen: boolean) => void
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  selectedMessageId: string | null
  hasKeyboardSelection: boolean
  showToolbarForSelection: boolean
  firstNewMessageId?: string
  clearFirstNewMessageId: () => void
  isJoined?: boolean
  isDarkMode?: boolean
  onMediaLoad?: () => void
  onScrollToTop?: () => void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
}) {
  const { t } = useTranslation()
  const { formatTime, effectiveTimeFormat } = useTimeFormat()

  // Track which message is hovered for stable toolbar interaction
  // This prevents the toolbar from switching when moving mouse to it
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Handle mouse enter on a message - set it as hovered immediately
  const handleMessageHover = useCallback((messageId: string) => {
    // Clear any pending timeout to clear hover
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }
    setHoveredMessageId(messageId)
  }, [])

  // Handle mouse leave from a message - delay clearing to allow moving to toolbar
  const handleMessageLeave = useCallback(() => {
    // Clear any existing timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
    }
    // Delay clearing hover to allow mouse to reach toolbar
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredMessageId(null)
      hoverTimeoutRef.current = null
    }, 100) // Small delay to allow mouse to reach toolbar
  }, [])

  // Clear hover when room changes
  useEffect(() => {
    setHoveredMessageId(null)
  }, [room.jid])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
      }
    }
  }, [])

  // Loading state: only show when joining room (SDK auto-loads cache in background)
  // No "loading messages" spinner - cache loads instantly, messages appear immediately
  const isInitialLoading = room.isJoining && !room.joined
  const loadingState = isInitialLoading ? (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-fluux-muted">
      <Loader2 className="w-8 h-8 animate-spin text-fluux-brand" />
      <p>{t('rooms.joining')}</p>
    </div>
  ) : null

  // Empty state: different for joined vs not joined
  const emptyState = (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted gap-2">
      {!isJoined && (
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 mb-2">
          <AlertCircle className="w-4 h-4" />
          <span className="text-sm">{t('rooms.notJoinedNoHistory')}</span>
        </div>
      )}
      <p>{isJoined ? t('chat.noMessages') : t('rooms.joinToLoadHistory')}</p>
    </div>
  )

  // Extra content: cached history warning banner when not joined
  const extraContent = !isJoined && messages.length > 0 ? (
    <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-700 dark:text-amber-400">
      <AlertCircle className="w-4 h-4 flex-shrink-0" />
      <span className="text-sm">
        {t('rooms.cachedHistoryWarning', {
          date: format(messages[messages.length - 1].timestamp, 'PPp'),
        })}
      </span>
    </div>
  ) : null

  // Memoize renderMessage to prevent render loops
  // Note: This callback captures many values, but they all affect how messages render
  const renderMessage = useCallback((msg: RoomMessage, idx: number, groupMessages: RoomMessage[]) => (
    <RoomMessageBubbleWrapper
      message={msg}
      showAvatar={shouldShowAvatar(groupMessages, idx)}
      messagesById={messagesById}
      room={room}
      contactsByJid={contactsByJid}
      ownAvatar={ownAvatar}
      sendReaction={sendReaction}
      onReply={onReply}
      onEdit={onEdit}
      isLastOutgoing={msg.id === lastOutgoingMessageId}
      isLastMessage={msg.id === lastMessageId}
      hideToolbar={isComposing || (activeReactionPickerMessageId !== null && activeReactionPickerMessageId !== msg.id)}
      onReactionPickerChange={(isOpen) => onReactionPickerChange(msg.id, isOpen)}
      retractMessage={retractMessage}
      isSelected={msg.id === selectedMessageId}
      hasKeyboardSelection={hasKeyboardSelection}
      showToolbarForSelection={showToolbarForSelection}
      isDarkMode={isDarkMode}
      onMediaLoad={onMediaLoad}
      isHovered={hoveredMessageId === msg.id}
      onMouseEnter={() => handleMessageHover(msg.id)}
      onMouseLeave={handleMessageLeave}
      formatTime={formatTime}
      timeFormat={effectiveTimeFormat}
    />
  ), [
    messagesById, room, contactsByJid, ownAvatar, sendReaction, onReply, onEdit,
    lastOutgoingMessageId, lastMessageId, isComposing, activeReactionPickerMessageId,
    onReactionPickerChange, retractMessage, selectedMessageId, hasKeyboardSelection,
    showToolbarForSelection, isDarkMode, onMediaLoad, hoveredMessageId, handleMessageHover, handleMessageLeave,
    formatTime, effectiveTimeFormat
  ])

  return (
    <MessageList
      messages={messages}
      conversationId={room.jid}
      firstNewMessageId={firstNewMessageId}
      clearFirstNewMessageId={clearFirstNewMessageId}
      scrollerRef={scrollerRef}
      isAtBottomRef={isAtBottomRef}
      typingUsers={typingUsers}
      isLoading={isInitialLoading}
      loadingState={loadingState}
      emptyState={emptyState}
      extraContent={extraContent}
      onScrollToTop={onScrollToTop}
      isLoadingOlder={isLoadingOlder}
      isHistoryComplete={isHistoryComplete}
      renderMessage={renderMessage}
    />
  )
})

interface RoomMessageBubbleWrapperProps {
  message: RoomMessage
  showAvatar: boolean
  messagesById: Map<string, RoomMessage>
  room: Room
  contactsByJid: Map<string, Contact>
  ownAvatar?: string | null
  sendReaction: (roomJid: string, messageId: string, emojis: string[]) => Promise<void>
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  isLastOutgoing: boolean
  isLastMessage: boolean
  hideToolbar?: boolean
  onReactionPickerChange?: (isOpen: boolean) => void
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  isSelected?: boolean
  hasKeyboardSelection?: boolean
  showToolbarForSelection?: boolean
  isDarkMode?: boolean
  onMediaLoad?: () => void
  // Hover state for stable toolbar interaction
  isHovered?: boolean
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  // Time formatting function (respects user's 12h/24h preference)
  formatTime: (date: Date) => string
  // Effective time format for layout width calculations
  timeFormat: '12h' | '24h'
}

const RoomMessageBubbleWrapper = memo(function RoomMessageBubbleWrapper({
  message,
  showAvatar,
  messagesById,
  room,
  contactsByJid,
  ownAvatar,
  sendReaction,
  onReply,
  onEdit,
  isLastOutgoing,
  isLastMessage,
  hideToolbar,
  onReactionPickerChange,
  retractMessage,
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
}: RoomMessageBubbleWrapperProps) {
  const { t } = useTranslation()

  // Get occupant info if available
  const occupant = room.occupants.get(message.nick)
  const myNick = room.nickname

  // Get avatar for message sender:
  // 1. XEP-0398 occupant avatar (fetched from MUC presence vcard-temp:x:update)
  // 2. Contact avatar (if occupant's real JID is in our roster)
  // 3. Fall back to fallback avatar generation
  const senderBareJid = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick)
  const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined
  const contactAvatar = contact?.avatar
  // Prefer occupant's direct avatar (XEP-0398) over contact avatar
  const senderAvatar = occupant?.avatar || contactAvatar

  // Get sender color: green for own messages, contact's pre-calculated color, or fallback to nick-based generation
  const senderColor = message.isOutgoing
    ? 'var(--fluux-green)'
    : contact
      ? (isDarkMode ? contact.colorDark : contact.colorLight) || getConsistentTextColor(message.nick, isDarkMode)
      : getConsistentTextColor(message.nick, isDarkMode)

  // Get my current reactions to this message
  const myReactions = useMemo(() => {
    if (!message.reactions || !myNick) return []
    return Object.entries(message.reactions)
      .filter(([, reactors]) => reactors.includes(myNick))
      .map(([emoji]) => emoji)
  }, [message.reactions, myNick])

  // Handle reaction toggle
  const handleReaction = useCallback((emoji: string) => {
    if (!myNick) return

    const newReactions = myReactions.includes(emoji)
      ? myReactions.filter(e => e !== emoji)
      : [...myReactions, emoji]

    void sendReaction(room.jid, message.id, newReactions)
  }, [myNick, myReactions, sendReaction, room.jid, message.id])

  // Build reply context using shared helper
  const replyContext = useMemo(() => buildReplyContext(
    message,
    messagesById,
    (originalMsg, fallbackId) => {
      if (originalMsg) return originalMsg.nick
      // For rooms, fallbackId is the full JID like room@server/nick - extract nick
      return fallbackId ? fallbackId.split('/').pop() || 'Unknown' : 'Unknown'
    },
    (originalMsg, fallbackId, dark) => {
      // Own messages: use green color
      if (originalMsg?.isOutgoing) return 'var(--fluux-green)'
      const nick = originalMsg?.nick || (fallbackId ? fallbackId.split('/').pop() : undefined)
      return nick ? getConsistentTextColor(nick, dark) : 'var(--fluux-brand)'
    },
    (originalMsg, fallbackId) => {
      const nick = originalMsg?.nick || (fallbackId ? fallbackId.split('/').pop() : undefined)
      // If the quoted message is from the current user, use own avatar
      if (nick === myNick) {
        return {
          avatarUrl: ownAvatar || undefined,
          avatarIdentifier: nick || 'unknown',
        }
      }
      // Try to get avatar: XEP-0398 occupant avatar or contact avatar
      const occupantForReply = nick ? room.occupants.get(nick) : undefined
      const senderBareJid = occupantForReply?.jid
        ? getBareJid(occupantForReply.jid)
        : (nick ? room.nickToJidCache?.get(nick) : undefined)
      const contactAvatar = senderBareJid ? contactsByJid.get(senderBareJid)?.avatar : undefined
      // Prefer occupant's direct avatar (XEP-0398) over contact avatar
      const replyAvatar = occupantForReply?.avatar || contactAvatar
      return {
        avatarUrl: replyAvatar,
        avatarIdentifier: nick || 'unknown',
      }
    },
    isDarkMode
  ), [message, messagesById, isDarkMode, room.occupants, room.nickToJidCache, contactsByJid, myNick, ownAvatar])

  // Get reactor display name (for rooms, nicks are shown as-is)
  // Note: MAM-loaded reactions may use full MUC JID (room@server/nick), so extract nick
  const getReactorName = useCallback((reactorId: string) => {
    // Extract nick from full MUC JID (room@server/nick) or use as-is if already a nick
    const nick = reactorId.includes('/') ? reactorId.split('/').pop() || reactorId : reactorId
    if (nick === myNick) return t('chat.you')
    return nick
  }, [myNick, t])

  // Build nick extras (moderator badge and XEP-0317 hats)
  // Note: individual tooltips removed - all info is now in the unified avatar/name tooltip
  const nickExtras = useMemo(() => (
    <>
      {occupant && occupant.role === 'moderator' && (
        <span className="self-center">
          <Shield className="w-3.5 h-3.5 text-fluux-muted" />
        </span>
      )}
      {occupant?.hats?.map((hat) => (
        <span
          key={hat.uri}
          className="px-1.5 py-0.5 text-[10px] font-medium rounded self-center"
          style={getHatColors(hat)}
        >
          {hat.title}
        </span>
      ))}
    </>
  ), [occupant])

  return (
    <MessageBubble
      message={message}
      showAvatar={showAvatar}
      isSelected={isSelected}
      hasKeyboardSelection={hasKeyboardSelection}
      showToolbarForSelection={showToolbarForSelection}
      hideToolbar={hideToolbar}
      isLastOutgoing={isLastOutgoing}
      isLastMessage={isLastMessage}
      isDarkMode={isDarkMode}
      isHovered={isHovered}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      senderName={message.nick}
      senderColor={senderColor}
      avatarUrl={message.isOutgoing ? (ownAvatar || undefined) : (senderAvatar || undefined)}
      avatarIdentifier={message.nick}
      avatarFallbackColor={senderColor}
      avatarPresence={room.joined ? (occupant ? getPresenceFromShow(occupant.show) : 'offline') : undefined}
      senderJid={senderBareJid}
      senderContact={contact}
      senderRole={occupant?.role}
      senderAffiliation={occupant?.affiliation}
      nickExtras={nickExtras}
      myReactions={myReactions}
      onReaction={handleReaction}
      getReactorName={getReactorName}
      onReply={() => onReply(message)}
      onEdit={() => onEdit(message)}
      onDelete={async () => retractMessage(room.jid, message.id)}
      onMediaLoad={onMediaLoad}
      replyContext={replyContext}
      mentions={message.mentions}
      onReactionPickerChange={onReactionPickerChange}
      formatTime={formatTime}
      timeFormat={timeFormat}
    />
  )
})

interface RoomMessageInputProps {
  room: Room
  textareaRef?: React.RefObject<HTMLTextAreaElement>
  sendMessage: (roomJid: string, body: string, replyTo?: { id: string; to: string; fallback?: { author: string; body: string } }, references?: MentionReference[], attachment?: FileAttachment) => Promise<string>
  sendCorrection: (roomJid: string, messageId: string, newBody: string, attachment?: FileAttachment) => Promise<void>
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  sendChatState: (roomJid: string, state: ChatStateNotification) => Promise<void>
  sendEasterEgg: (roomJid: string, animation: string) => Promise<void>
  onMessageSent?: () => void
  onInputResize?: () => void
  replyingTo: RoomMessage | null
  onCancelReply: () => void
  editingMessage: RoomMessage | null
  onCancelEdit: () => void
  onEditLastMessage?: () => void
  onComposingChange?: (isComposing: boolean) => void
  uploadState?: { isUploading: boolean; progress: number }
  isUploadSupported?: boolean
  onFileSelect?: (file: File) => void
  uploadFile?: (file: File) => Promise<FileAttachment | null>
  pendingAttachment?: PendingAttachment | null
  onRemovePendingAttachment?: () => void
  processLinkPreview?: (messageId: string, body: string, to: string, type: 'chat' | 'groupchat') => Promise<void>
  isConnected: boolean
}

const RoomMessageInput = React.forwardRef<MessageComposerHandle, RoomMessageInputProps>(function RoomMessageInput({
  room,
  textareaRef,
  sendMessage,
  sendCorrection,
  retractMessage,
  sendChatState,
  sendEasterEgg,
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
}, ref) {
  const { t } = useTranslation()
  const { setDraft, getDraft, clearDraft, clearFirstNewMessageId } = useRoom()

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

  // Draft persistence - saves on room change, restores on load, clears references
  const [text, setText] = useConversationDraft({
    conversationId: room.jid,
    draftOperations: { getDraft, setDraft, clearDraft },
    composerRef,
    onDraftRestored: useCallback(() => setReferences([]), []),
  })

  // Type-to-focus: auto-focus composer when user starts typing anywhere
  useTypeToFocus(composerRef)

  // Check if room is small enough to send typing notifications
  const shouldSendTypingNotifications = room.occupants.size < MAX_ROOM_SIZE_FOR_TYPING

  // Mention autocomplete hook
  const { state: mentionState, selectMatch, moveSelection, dismiss } = useMentionAutocomplete(
    text,
    cursorPosition,
    room.occupants,
    room.nickname,
    room.jid
  )

  // Handle mention selection
  const handleMentionSelect = useCallback((index: number) => {
    const { newText, newCursorPosition, reference } = selectMatch(index)
    setText(newText)
    setReferences(prev => [...prev, reference])
    // Focus and set cursor position after state update
    setTimeout(() => {
      composerRef.current?.focus()
    }, 0)
    setCursorPosition(newCursorPosition)
  }, [selectMatch, setText])

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
    await sendCorrection(room.jid, messageId, newBody, attachment)
    return true
  }

  // Handle retraction (when edit removes all content)
  const handleRetract = async (messageId: string): Promise<void> => {
    await retractMessage(room.jid, messageId)
  }

  // Handle send
  const handleSend = async (sendText: string): Promise<boolean> => {
    // Include reply info if replying to a message
    // Use stanzaId (XEP-0359) for MUC messages - this is what other clients use to look up the referenced message
    let replyTo: { id: string; to: string; fallback?: { author: string; body: string } } | undefined
    if (replyingTo) {
      replyTo = {
        id: replyingTo.stanzaId || replyingTo.id,
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
    const messageId = await sendMessage(room.jid, body, replyTo, references.length > 0 ? references : undefined, attachment ?? undefined)
    setReferences([])

    // Clear pending attachment after sending
    if (pendingAttachment) {
      onRemovePendingAttachment?.()
    }

    // Clear draft immediately so sidebar updates
    clearDraft(room.jid)

    // Process link preview in background (don't block on it)
    if (processLinkPreview && sendText) {
      processLinkPreview(messageId, sendText, room.jid, 'groupchat').catch(console.error)
    }

    // Send active state after message (for small rooms)
    if (shouldSendTypingNotifications) {
      void sendChatState(room.jid, 'active')
    }

    // Scroll to bottom to show the sent message
    onMessageSent?.()

    // Clear the "new messages" marker after a short delay (user is actively engaged)
    setTimeout(() => clearFirstNewMessageId(room.jid), 500)

    return true
  }

  // Handle typing state
  const handleTypingState = (state: 'composing' | 'paused') => {
    if (shouldSendTypingNotifications) {
      void sendChatState(room.jid, state)
    }
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
      className="absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto
                 bg-fluux-bg border border-fluux-hover rounded-lg shadow-lg z-30"
    >
      {mentionState.matches.map((match, idx) => (
        <button
          key={match.nick}
          type="button"
          onClick={() => handleMentionSelect(idx)}
          className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors
                     ${idx === mentionState.selectedIndex
                       ? 'bg-fluux-brand text-white'
                       : 'hover:bg-fluux-hover text-fluux-text'}`}
        >
          {/* Avatar */}
          {match.isAll ? (
            <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-fluux-brand">
              <Users className="w-3.5 h-3.5 text-white" />
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
            <span className={`text-xs ${idx === mentionState.selectedIndex ? 'text-white/70' : 'text-fluux-muted'}`}>
              {t('rooms.notifyEveryone')}
            </span>
          )}
          {match.role === 'moderator' && !match.isAll && (
            <span className={`text-xs ${idx === mentionState.selectedIndex ? 'text-white/70' : 'text-fluux-muted'}`}>
              {t('rooms.mod')}
            </span>
          )}
        </button>
      ))}
    </div>
  ) : null

  // Custom input renderer with mention highlighting
  const renderMentionInput = useCallback(({ inputRef, mergedRef, value, onChange, onKeyDown: baseKeyDown, onSelect, placeholder }: {
    inputRef: React.RefObject<HTMLTextAreaElement>
    mergedRef: (node: HTMLTextAreaElement | null) => void
    value: string
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
    onSelect?: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
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
          className="absolute inset-0 px-2 py-3 pointer-events-none whitespace-pre-wrap break-words
                     overflow-hidden leading-6"
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
        <textarea
          ref={mergedRef}
          value={value}
          onChange={onChange}
          onSelect={onSelect}
          onKeyDown={handleKeyDown}
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
  }, [references, text, mentionState, moveSelection, dismiss, handleMentionSelect, setText])

  return (
    <MessageComposer
      ref={composerRef}
      textareaRef={textareaRef}
      placeholder={t('chat.messageRoom', { name: room.name })}
      replyingTo={replyInfo}
      onCancelReply={onCancelReply}
      editingMessage={editInfo}
      onCancelEdit={onCancelEdit}
      onSendCorrection={handleCorrection}
      onRetractMessage={handleRetract}
      onComposingChange={onComposingChange}
      onInputResize={onInputResize}
      onSend={handleSend}
      onSendEasterEgg={(animation) => sendEasterEgg(room.jid, animation)}
      onSendTypingState={handleTypingState}
      typingNotificationsEnabled={shouldSendTypingNotifications}
      renderInput={renderMentionInput}
      aboveInput={mentionDropdown}
      value={text}
      onValueChange={setText}
      onSelectionChange={setCursorPosition}
      onFileSelect={onFileSelect}
      uploadState={uploadState}
      isUploadSupported={isUploadSupported}
      pendingAttachment={pendingAttachment}
      onRemovePendingAttachment={onRemovePendingAttachment}
      disabled={!isConnected}
      onEditLastMessage={onEditLastMessage}
    />
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
                   disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
      >
        {isJoining ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('rooms.joining')}
          </>
        ) : (
          <>
            <LogIn className="w-4 h-4" />
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

