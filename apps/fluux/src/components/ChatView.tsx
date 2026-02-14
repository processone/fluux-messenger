import React, { useState, useRef, useEffect, useMemo, useCallback, memo, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useChatActive, useContactIdentities, usePresence, createMessageLookup, getBareJid, getLocalPart, type Message, type ContactIdentity } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { getConsistentTextColor } from './Avatar'
import { useFileUpload, useLinkPreview, useTypeToFocus, useMessageCopy, useMode, useMessageSelection, useDragAndDrop, useConversationDraft, useTimeFormat } from '@/hooks'
import { Upload, Loader2 } from 'lucide-react'
import { MessageBubble, MessageList as MessageListComponent, shouldShowAvatar, buildReplyContext } from './conversation'
import { ChristmasAnimation } from './ChristmasAnimation'
import { ChatHeader } from './ChatHeader'
import { MessageComposer, type ReplyInfo, type EditInfo, type MessageComposerHandle, type PendingAttachment } from './MessageComposer'
import { findLastEditableMessage, findLastEditableMessageId } from '@/utils/messageUtils'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'

interface ChatViewProps {
  onBack?: () => void
  onSwitchToMessages?: (conversationId: string) => void
  // Focus zone refs for Tab cycling
  mainContentRef?: RefObject<HTMLElement>
  composerRef?: RefObject<HTMLElement>
}

export function ChatView({ onBack, onSwitchToMessages, mainContentRef, composerRef }: ChatViewProps) {
  detectRenderLoop('ChatView')
  const { t } = useTranslation()
  // Use useChatActive instead of useChat to avoid subscribing to the conversation list.
  // This prevents re-renders during background MAM sync of other conversations.
  const { activeConversation, activeMessages, activeTypingUsers, sendReaction, sendCorrection, retractMessage, activeAnimation, sendEasterEgg, clearAnimation, clearFirstNewMessageId, updateLastSeenMessageId, activeMAMState, fetchOlderHistory } = useChatActive()
  // Use useContactIdentities instead of useRoster() to avoid re-renders on
  // presence changes. ChatView only needs contact names and avatars for display.
  const contactsByJid = useContactIdentities()
  // NOTE: Use focused selectors instead of useConnection() hook to avoid
  // re-renders when unrelated connection state changes (error, reconnectAttempt, etc.)
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const status = useConnectionStore((s) => s.status)
  const isConnected = status === 'online'
  const { presenceStatus: presenceShow } = usePresence()
  const { uploadFile, isUploading, progress, isSupported } = useFileUpload()
  const { processMessageForLinkPreview } = useLinkPreview()
  const { resolvedMode } = useMode()
  const myBareJid = jid?.split('/')[0]

  // Reply state - which message are we replying to
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)

  // Edit state - which message are we editing
  const [editingMessage, setEditingMessage] = useState<Message | null>(null)

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

  // Memoized callbacks to prevent render loops (new function refs cause child re-renders)
  const handleCancelReply = useCallback(() => setReplyingTo(null), [])
  const handleCancelEdit = useCallback(() => setEditingMessage(null), [])
  const handleReactionPickerChange = useCallback((messageId: string, isOpen: boolean) => {
    setActiveReactionPickerMessageId(isOpen ? messageId : null)
  }, [])

  // Memoized upload state to prevent new object reference on every render
  const uploadStateObj = useMemo(() => ({ isUploading, progress }), [isUploading, progress])

  // Composer handle ref for type-to-focus (separate from focus zone ref)
  const composerHandleRef = useRef<MessageComposerHandle>(null)

  // Type-to-focus: auto-focus composer when user starts typing anywhere
  useTypeToFocus(composerHandleRef)

  // Scroll ref for programmatic scrolling and keyboard navigation
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(true)

  // Scroll to bottom (used after sending a message)
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [])

  // Note: Media load scroll handling is now managed by useMessageListScroll hook
  // via the handleMediaLoad callback passed through renderMessage. This provides
  // batched scroll correction to avoid jitter when multiple images load.

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
    isHistoryComplete: activeMAMState?.isHistoryComplete,
    onEnterPressed: useExpandedMessagesStore.getState().toggle,
  })

  // Format copied messages with sender headers
  useMessageCopy(scrollRef)

  // Create a lookup map for messages by ID (for reply context)
  // Index by both client id and stanza-id since replies may reference either
  const messagesById = useMemo(() => createMessageLookup(activeMessages), [activeMessages])

  // Clear reply/edit/pending attachment state when conversation changes
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
  }, [activeConversation?.id, clearSelection])

  // XEP-0313: Message history is now auto-fetched by the SDK (useChat hook)
  // - Cache is loaded immediately when conversation becomes active
  // - MAM query runs in background when connected
  // - No manual orchestration needed here

  // File drop handler - stages file for preview only (no upload yet - privacy protection)
  // Upload happens when user clicks Send, not on drop (prevents accidental data leaks)
  const handleFileDrop = useCallback((file: File) => {
    if (!activeConversation || !isSupported) return
    // Create preview URL for images/videos
    const previewUrl = file.type.startsWith('image/') || file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : undefined
    setPendingAttachment({ file, previewUrl })
    // Focus composer so user can add a message
    setTimeout(() => composerHandleRef.current?.focus(), 0)
  }, [activeConversation, isSupported])

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

  // Handle reply button click - set reply state and focus composer
  const handleReply = useCallback((message: Message) => {
    setReplyingTo(message)
    // Focus composer so user can start typing immediately
    setTimeout(() => composerHandleRef.current?.focus(), 0)
  }, [])

  // Memoize the clearFirstNewMessageId callback to avoid render loops
  // (inline arrow functions create new references on every render)
  const conversationId = activeConversation?.id
  const handleClearFirstNewMessageId = useCallback(() => {
    if (conversationId) {
      clearFirstNewMessageId(conversationId)
    }
  }, [conversationId, clearFirstNewMessageId])

  // Viewport observer callback: update lastSeenMessageId as user scrolls
  const handleMessageSeen = useCallback((messageId: string) => {
    if (conversationId) {
      updateLastSeenMessageId(conversationId, messageId)
    }
  }, [conversationId, updateLastSeenMessageId])

  if (!activeConversation) return null

  // Get contact for 1:1 chats
  const contact = activeConversation.type === 'chat'
    ? contactsByJid.get(activeConversation.id)
    : undefined

  return (
    <div
      className="flex flex-col h-full min-h-0 relative"
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

      {/* Header */}
      <ChatHeader
        name={activeConversation.name}
        type={activeConversation.type}
        contact={contact}
        jid={activeConversation.id}
        onBack={onBack}
      />

      {/* Messages - focusable zone for Tab cycling */}
      <div
        ref={mainContentRef as React.RefObject<HTMLDivElement>}
        tabIndex={0}
        className="focus-zone flex-1 flex flex-col min-h-0 p-1"
        onKeyDown={handleMessageListKeyDown}
        onMouseMove={(e) => {
          // Find which message is being hovered (for keyboard nav starting point)
          const messageEl = (e.target as HTMLElement).closest('[data-message-id]')
          const messageId = messageEl?.getAttribute('data-message-id') || undefined
          handleMouseMove(e, messageId)
        }}
        onMouseLeave={handleMouseLeave}
      >
        <ChatMessageList
          messages={activeMessages}
          contactsByJid={contactsByJid}
          messagesById={messagesById}
          typingUsers={activeTypingUsers}
          scrollerRef={scrollRef}
          isAtBottomRef={isAtBottomRef}
          conversationId={activeConversation.id}
          conversationType={activeConversation.type}
          sendReaction={sendReaction}
          myBareJid={myBareJid}
          ownAvatar={ownAvatar}
          ownNickname={ownNickname}
          ownPresence={presenceShow}
          onReply={handleReply}
          onEdit={setEditingMessage}
          lastOutgoingMessageId={lastOutgoingMessageId}
          lastMessageId={lastMessageId}
          isComposing={isComposing}
          activeReactionPickerMessageId={activeReactionPickerMessageId}
          onReactionPickerChange={handleReactionPickerChange}
          retractMessage={retractMessage}
          selectedMessageId={selectedMessageId}
          hasKeyboardSelection={hasKeyboardSelection}
          showToolbarForSelection={showToolbarForSelection}
          firstNewMessageId={activeConversation.firstNewMessageId}
          clearFirstNewMessageId={handleClearFirstNewMessageId}
          onMessageSeen={handleMessageSeen}
          isDarkMode={resolvedMode === 'dark'}
          onScrollToTop={fetchOlderHistory}
          isLoadingOlder={activeMAMState?.isLoading ?? false}
          isHistoryComplete={activeMAMState?.isHistoryComplete ?? false}
          // SDK auto-fetches cache + MAM in background, no blocking spinner needed
          isInitialLoading={false}
        />
      </div>

      {/* Input */}
      <MessageInput
        composerRef={composerHandleRef}
        textareaRef={composerRef as React.RefObject<HTMLTextAreaElement>}
        conversationId={activeConversation.id}
        conversationName={activeConversation.name}
        type={activeConversation.type}
        onMessageSent={scrollToBottom}
        onInputResize={handleInputResize}
        replyingTo={replyingTo}
        onCancelReply={handleCancelReply}
        editingMessage={editingMessage}
        onCancelEdit={handleCancelEdit}
        onEditLastMessage={handleEditLastMessage}
        sendCorrection={sendCorrection}
        retractMessage={retractMessage}
        contactsByJid={contactsByJid}
        onComposingChange={setIsComposing}
        sendEasterEgg={sendEasterEgg}
        uploadState={uploadStateObj}
        isUploadSupported={isSupported}
        onFileSelect={handleFileDrop}
        uploadFile={uploadFile}
        pendingAttachment={pendingAttachment}
        onRemovePendingAttachment={handleRemovePendingAttachment}
        processLinkPreview={processMessageForLinkPreview}
        isConnected={isConnected}
        onSwitchToMessages={onSwitchToMessages}
      />

      {/* Easter egg animation */}
      {activeAnimation?.conversationId === activeConversation.id && activeAnimation.animation === 'christmas' && (
        <ChristmasAnimation onComplete={clearAnimation} />
      )}
    </div>
  )
}

const ChatMessageList = memo(function ChatMessageList({
  messages,
  contactsByJid,
  messagesById,
  typingUsers,
  scrollerRef,
  isAtBottomRef,
  conversationId,
  conversationType,
  sendReaction,
  myBareJid,
  ownAvatar,
  ownNickname,
  ownPresence,
  onReply,
  onEdit,
  lastOutgoingMessageId,
  lastMessageId,
  isComposing,
  activeReactionPickerMessageId,
  onReactionPickerChange,
  retractMessage,
  selectedMessageId,
  hasKeyboardSelection,
  showToolbarForSelection,
  firstNewMessageId,
  clearFirstNewMessageId,
  onMessageSeen,
  isDarkMode,
  onScrollToTop,
  isLoadingOlder,
  isHistoryComplete,
  isInitialLoading,
}: {
  messages: Message[]
  contactsByJid: Map<string, ContactIdentity>
  messagesById: Map<string, Message>
  typingUsers: string[]
  scrollerRef: React.RefObject<HTMLElement>
  isAtBottomRef: React.MutableRefObject<boolean>
  conversationId: string
  conversationType: 'chat' | 'groupchat'
  sendReaction: (to: string, messageId: string, emojis: string[], type: 'chat' | 'groupchat') => Promise<void>
  myBareJid?: string
  ownAvatar?: string | null
  ownNickname?: string | null
  ownPresence?: 'online' | 'away' | 'dnd' | 'offline'
  onReply: (message: Message) => void
  onEdit: (message: Message) => void
  lastOutgoingMessageId: string | null
  lastMessageId: string | null
  isComposing: boolean
  activeReactionPickerMessageId: string | null
  onReactionPickerChange: (messageId: string, isOpen: boolean) => void
  retractMessage: (conversationId: string, messageId: string) => Promise<void>
  selectedMessageId: string | null
  hasKeyboardSelection: boolean
  showToolbarForSelection: boolean
  firstNewMessageId?: string
  clearFirstNewMessageId: () => void
  onMessageSeen?: (messageId: string) => void
  isDarkMode?: boolean
  onScrollToTop?: () => void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
  isInitialLoading?: boolean
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

  // Clear hover when conversation changes
  useEffect(() => {
    setHoveredMessageId(null)
  }, [conversationId])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
      }
    }
  }, [])

  // Memoize formatTypingUser to prevent render loops
  const formatTypingUser = useCallback((jid: string) => {
    const bareJid = jid.split('/')[0]
    return contactsByJid.get(bareJid)?.name || bareJid.split('@')[0]
  }, [contactsByJid])

  // Memoize renderMessage to prevent render loops
  // Note: This callback captures many values, but they all affect how messages render
  // The onMediaLoad parameter is provided by MessageList from useMessageListScroll hook
  const renderMessage = useCallback((msg: Message, idx: number, groupMessages: Message[], _showNewMarker: boolean, onMediaLoad: () => void) => (
    <ChatMessageBubble
      message={msg}
      showAvatar={shouldShowAvatar(groupMessages, idx)}
      avatar={msg.isOutgoing ? ownAvatar ?? undefined : contactsByJid.get(msg.from)?.avatar}
      ownAvatar={ownAvatar}
      ownNickname={ownNickname}
      ownPresence={ownPresence}
      conversationId={conversationId}
      conversationType={conversationType}
      sendReaction={sendReaction}
      myBareJid={myBareJid}
      contactsByJid={contactsByJid}
      messagesById={messagesById}
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
    ownAvatar, contactsByJid, ownNickname, ownPresence, conversationId, conversationType,
    sendReaction, myBareJid, messagesById, onReply, onEdit, lastOutgoingMessageId, lastMessageId,
    isComposing, activeReactionPickerMessageId, onReactionPickerChange, retractMessage,
    selectedMessageId, hasKeyboardSelection, showToolbarForSelection, isDarkMode,
    hoveredMessageId, handleMessageHover, handleMessageLeave, formatTime, effectiveTimeFormat
  ])

  return (
    <MessageListComponent
      messages={messages}
      conversationId={conversationId}
      firstNewMessageId={firstNewMessageId}
      clearFirstNewMessageId={clearFirstNewMessageId}
      onMessageSeen={onMessageSeen}
      scrollerRef={scrollerRef}
      isAtBottomRef={isAtBottomRef}
      typingUsers={typingUsers}
      formatTypingUser={formatTypingUser}
      renderMessage={renderMessage}
      onScrollToTop={onScrollToTop}
      isLoadingOlder={isLoadingOlder}
      isHistoryComplete={isHistoryComplete}
      isLoading={isInitialLoading}
      loadingState={
        <div className="flex-1 flex items-center justify-center text-fluux-muted">
          <div className="flex items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>{t('chat.loadingMessages')}</span>
          </div>
        </div>
      }
    />
  )
})

interface ChatMessageBubbleProps {
  message: Message
  showAvatar: boolean
  avatar?: string
  ownAvatar?: string | null
  ownNickname?: string | null
  ownPresence?: 'online' | 'away' | 'dnd' | 'offline'
  conversationId: string
  conversationType: 'chat' | 'groupchat'
  sendReaction: (to: string, messageId: string, emojis: string[], type: 'chat' | 'groupchat') => Promise<void>
  myBareJid?: string
  contactsByJid: Map<string, ContactIdentity>
  messagesById: Map<string, Message>
  onReply: (message: Message) => void
  onEdit: (message: Message) => void
  isLastOutgoing: boolean
  isLastMessage: boolean
  hideToolbar?: boolean
  onReactionPickerChange?: (isOpen: boolean) => void
  retractMessage: (conversationId: string, messageId: string) => Promise<void>
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

const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  showAvatar,
  avatar,
  ownAvatar,
  ownNickname,
  ownPresence,
  conversationId,
  conversationType,
  sendReaction,
  myBareJid,
  contactsByJid,
  messagesById,
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
}: ChatMessageBubbleProps) {
  const { t } = useTranslation()

  // Use display name from roster, fall back to JID username
  // For outgoing messages, use own nickname if set
  const senderContact = contactsByJid.get(message.from.split('/')[0])
  const senderName = message.isOutgoing
    ? (ownNickname || message.from.split('@')[0])
    : (senderContact?.name || message.from.split('@')[0])

  // Get sender color: green for own messages, contact's pre-calculated color, or fallback to generation
  const senderColor = message.isOutgoing
    ? 'var(--fluux-green)'
    : senderContact
      ? (isDarkMode ? senderContact.colorDark : senderContact.colorLight) || getConsistentTextColor(message.from.split('/')[0], isDarkMode)
      : getConsistentTextColor(message.from.split('/')[0], isDarkMode)

  // Get my current reactions to this message
  const myReactions = useMemo(() => {
    if (!message.reactions || !myBareJid) return []
    return Object.entries(message.reactions)
      .filter(([, reactors]) => reactors.includes(myBareJid))
      .map(([emoji]) => emoji)
  }, [message.reactions, myBareJid])

  // Handle reaction toggle
  const handleReaction = useCallback((emoji: string) => {
    if (!myBareJid) return

    const newReactions = myReactions.includes(emoji)
      ? myReactions.filter(e => e !== emoji)
      : [...myReactions, emoji]

    void sendReaction(conversationId, message.id, newReactions, conversationType)
  }, [myBareJid, myReactions, sendReaction, conversationId, message.id, conversationType])

  // Build reply context using shared helper
  const replyContext = useMemo(() => buildReplyContext(
    message,
    messagesById,
    (originalMsg, fallbackId) => {
      // Own messages: use ownNickname or JID username
      if (originalMsg?.isOutgoing) {
        return ownNickname || originalMsg.from.split('@')[0]
      }
      if (originalMsg) {
        return contactsByJid.get(originalMsg.from.split('/')[0])?.name || originalMsg.from.split('@')[0]
      }
      return fallbackId ? fallbackId.split('@')[0] : 'Unknown'
    },
    (originalMsg, fallbackId, dark) => {
      // Own messages: use green color
      if (originalMsg?.isOutgoing) return 'var(--fluux-green)'
      const senderId = originalMsg?.from.split('/')[0] || fallbackId?.split('/')[0]
      if (!senderId) return 'var(--fluux-brand)'
      const contact = contactsByJid.get(senderId)
      if (contact) {
        return (dark ? contact.colorDark : contact.colorLight) || getConsistentTextColor(senderId, dark)
      }
      return getConsistentTextColor(senderId, dark)
    },
    (originalMsg, fallbackId) => {
      const senderId = originalMsg?.from.split('/')[0] || fallbackId?.split('/')[0]
      // If the quoted message is from the current user, use own avatar
      if (senderId === myBareJid) {
        return {
          avatarUrl: ownAvatar || undefined,
          avatarIdentifier: senderId || 'unknown',
        }
      }
      const contact = senderId ? contactsByJid.get(senderId) : undefined
      return {
        avatarUrl: contact?.avatar,
        avatarIdentifier: senderId || 'unknown',
      }
    },
    isDarkMode
  ), [message, messagesById, contactsByJid, isDarkMode, myBareJid, ownAvatar, ownNickname])

  // Get reactor display name (contact name, or username if not in roster)
  const getReactorName = useCallback((jid: string) => {
    const bareJid = getBareJid(jid)
    if (bareJid === myBareJid) return t('chat.you')
    return contactsByJid.get(bareJid)?.name || getLocalPart(jid)
  }, [myBareJid, contactsByJid, t])

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
      senderName={senderName}
      senderColor={senderColor}
      avatarUrl={avatar}
      avatarIdentifier={message.from}
      avatarFallbackColor={senderColor}
      avatarPresence={message.isOutgoing ? ownPresence : undefined}
      senderJid={message.isOutgoing ? myBareJid : message.from.split('/')[0]}
      senderContact={message.isOutgoing ? undefined : senderContact as import('@fluux/sdk').Contact | undefined}
      myReactions={myReactions}
      onReaction={handleReaction}
      getReactorName={getReactorName}
      onReply={() => onReply(message)}
      onEdit={() => onEdit(message)}
      onDelete={async () => retractMessage(conversationId, message.id)}
      onMediaLoad={onMediaLoad}
      replyContext={replyContext}
      onReactionPickerChange={onReactionPickerChange}
      formatTime={formatTime}
      timeFormat={timeFormat}
    />
  )
})

function MessageInput({
  composerRef,
  textareaRef,
  conversationId,
  conversationName,
  type,
  onMessageSent,
  onInputResize,
  replyingTo,
  onCancelReply,
  editingMessage,
  onCancelEdit,
  sendCorrection,
  retractMessage,
  contactsByJid,
  onComposingChange,
  sendEasterEgg,
  isConnected,
  onEditLastMessage,
  uploadState,
  isUploadSupported,
  onFileSelect,
  uploadFile,
  pendingAttachment,
  onRemovePendingAttachment,
  processLinkPreview,
  onSwitchToMessages,
}: {
  composerRef: React.RefObject<MessageComposerHandle>
  textareaRef?: React.RefObject<HTMLTextAreaElement>
  conversationId: string
  conversationName: string
  type: 'chat' | 'groupchat'
  onMessageSent?: () => void
  onInputResize?: () => void
  replyingTo: Message | null
  onCancelReply: () => void
  editingMessage: Message | null
  onCancelEdit: () => void
  sendCorrection: (conversationId: string, messageId: string, newBody: string, attachment?: import('@fluux/sdk').FileAttachment) => Promise<void>
  retractMessage: (conversationId: string, messageId: string) => Promise<void>
  contactsByJid: Map<string, ContactIdentity>
  onComposingChange?: (isComposing: boolean) => void
  sendEasterEgg: (to: string, type: 'chat' | 'groupchat', animation: string) => Promise<void>
  isConnected: boolean
  onEditLastMessage?: () => void
  uploadState?: { isUploading: boolean; progress: number }
  isUploadSupported?: boolean
  onFileSelect?: (file: File) => void
  uploadFile?: (file: File) => Promise<import('@fluux/sdk').FileAttachment | null>
  pendingAttachment?: PendingAttachment | null
  onRemovePendingAttachment?: () => void
  processLinkPreview?: (messageId: string, body: string, to: string, type: 'chat' | 'groupchat') => Promise<void>
  onSwitchToMessages?: (conversationId: string) => void
}) {
  const { t } = useTranslation()
  const { sendMessage, sendChatState, isArchived, unarchiveConversation, setDraft, getDraft, clearDraft, clearFirstNewMessageId } = useChatActive()

  // Draft persistence - saves on conversation change, restores on load
  const [text, setText] = useConversationDraft({
    conversationId,
    draftOperations: { getDraft, setDraft, clearDraft },
    composerRef,
  })

  // Convert Message to ReplyInfo for the composer
  // Use stanzaId (XEP-0359) if available - this is what other clients may use to look up the referenced message
  const replyInfo: ReplyInfo | null = replyingTo
    ? {
        id: replyingTo.stanzaId || replyingTo.id,
        from: replyingTo.from,
        senderName: contactsByJid.get(replyingTo.from.split('/')[0])?.name || replyingTo.from.split('@')[0],
        body: replyingTo.body,
      }
    : null

  // Convert Message to EditInfo for the composer
  const editInfo: EditInfo | null = editingMessage
    ? {
        id: editingMessage.id,
        body: editingMessage.body,
        attachment: editingMessage.attachment,
      }
    : null

  const handleCorrection = async (messageId: string, newBody: string, attachment?: import('@fluux/sdk').FileAttachment): Promise<boolean> => {
    await sendCorrection(conversationId, messageId, newBody, attachment)
    return true
  }

  const handleRetract = async (messageId: string): Promise<void> => {
    await retractMessage(conversationId, messageId)
  }

  const handleSend = async (text: string): Promise<boolean> => {
    // Unarchive conversation if archived (user is actively chatting)
    // and switch to Messages view to see it in the main list
    if (type === 'chat' && isArchived(conversationId)) {
      unarchiveConversation(conversationId)
      onSwitchToMessages?.(conversationId)
    }

    // Include reply info if replying to a message (with XEP-0428 fallback for compatibility)
    // Use stanzaId (XEP-0359) if available - this is what other clients may use to look up the referenced message
    let replyTo: { id: string; to: string; fallback?: { author: string; body: string } } | undefined
    if (replyingTo) {
      const authorName = contactsByJid.get(replyingTo.from.split('/')[0])?.name || replyingTo.from.split('@')[0]
      replyTo = {
        id: replyingTo.stanzaId || replyingTo.id,
        to: replyingTo.from,
        fallback: { author: authorName, body: replyingTo.body }
      }
    }

    // If there's a pending attachment, upload it first (privacy: only upload when user explicitly sends)
    let attachment: import('@fluux/sdk').FileAttachment | null | undefined
    if (pendingAttachment && uploadFile) {
      attachment = await uploadFile(pendingAttachment.file)
      if (!attachment) {
        // Upload failed - don't send the message
        return false
      }
    }

    // The body is the file URL if no text was entered, otherwise the user's text
    const body = text || attachment?.url || ''
    const messageId = await sendMessage(conversationId, body, type, replyTo, attachment ?? undefined)

    // Clear pending attachment after sending
    if (pendingAttachment) {
      onRemovePendingAttachment?.()
    }

    // Clear draft immediately so sidebar updates
    clearDraft(conversationId)

    // Process link preview in background (don't block on it)
    if (processLinkPreview && text) {
      processLinkPreview(messageId, text, conversationId, type).catch(console.error)
    }

    // Scroll to bottom to show the sent message
    onMessageSent?.()

    // Clear the "new messages" marker after a short delay (user is actively engaged)
    setTimeout(() => clearFirstNewMessageId(conversationId), 500)

    return true
  }

  const handleTypingState = (state: 'composing' | 'paused') => {
    void sendChatState(conversationId, state, type)
  }

  return (
    <MessageComposer
      ref={composerRef}
      textareaRef={textareaRef}
      placeholder={t('chat.messageTo', { name: conversationName })}
      replyingTo={replyInfo}
      onCancelReply={onCancelReply}
      editingMessage={editInfo}
      onCancelEdit={onCancelEdit}
      onSendCorrection={handleCorrection}
      onRetractMessage={handleRetract}
      onComposingChange={onComposingChange}
      onInputResize={onInputResize}
      onSend={handleSend}
      onSendEasterEgg={(animation) => sendEasterEgg(conversationId, type, animation)}
      onSendTypingState={handleTypingState}
      typingNotificationsEnabled={true}
      onFileSelect={onFileSelect}
      uploadState={uploadState}
      isUploadSupported={isUploadSupported}
      pendingAttachment={pendingAttachment}
      onRemovePendingAttachment={onRemovePendingAttachment}
      disabled={!isConnected}
      value={text}
      onValueChange={setText}
      onEditLastMessage={onEditLastMessage}
    />
  )
}

