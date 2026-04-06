import React, { useState, useRef, useEffect, useCallback, useImperativeHandle, useMemo, memo, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useRoomActive, useRoster, getBareJid, generateConsistentColorHexSync, getPresenceFromShow, createMessageLookup, isMessageFromIgnoredUser, isReplyToIgnoredUser, canKick, canBan, canModerate, getAvailableAffiliations, getAvailableRoles, getMyReactions, type RoomMessage, type Room, type MentionReference, type ChatStateNotification, type Contact, type FileAttachment, type RoomAffiliation, type RoomRole, type PollData } from '@fluux/sdk'
import { useConnectionStore, useIgnoreStore, useRoomStore } from '@fluux/sdk/react'
import { ignoreStore, roomStore, type IgnoredUser } from '@fluux/sdk/stores'
import { useMentionAutocomplete, useFileUpload, useLinkPreview, useTypeToFocus, useMessageCopy, useMode, useMessageSelection, useDragAndDrop, useConversationDraft, useTimeFormat, useContextMenu, isSmallScreen } from '@/hooks'
import { MessageBubble, MessageList, shouldShowAvatar, buildReplyContext, PollBanner } from './conversation'
import { FindOnPageBar } from './conversation/FindOnPageBar'
import { useFindOnPage, type FindOnPageHandle } from '@/hooks/useFindOnPage'
import { Avatar, getConsistentTextColor } from './Avatar'
import { format } from 'date-fns'
import { Shield, Crown, Upload, Loader2, LogIn, AlertCircle, Users, MessageCircle, EyeOff, User, Settings } from 'lucide-react'
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
const MAX_ROOM_SIZE_FOR_TYPING = 30

// Stable empty array for useIgnoreStore selector to prevent infinite re-render loops
const EMPTY_IGNORED_ARRAY: import('@fluux/sdk/stores').IgnoredUser[] = []

export function RoomView({ onBack, mainContentRef, composerRef, showOccupants = false, onShowOccupantsChange, onStartChat, onShowProfile, findOnPageRef, onSearchInConversation }: RoomViewProps) {
  detectRenderLoop('RoomView')
  const { t } = useTranslation()
  const { activeRoom, activeMessages, activeTypingUsers, sendMessage, sendReaction, sendPoll, votePoll, closePoll, sendCorrection, retractMessage, moderateMessage, sendChatState, setRoomNotifyAll, activeAnimation, sendEasterEgg, clearAnimation, clearFirstNewMessageId, updateLastSeenMessageId, joinRoom, setRoomAvatar, clearRoomAvatar, fetchOlderHistory, continueRoomCatchUp, activeMAMState, submitRoomConfig, setSubject, destroyRoom, setAffiliation, setRole, targetMessageId, clearTargetMessageId } = useRoomActive()
  const { contacts } = useRoster()
  // NOTE: Use focused selectors instead of useConnection() hook to avoid
  // re-renders when unrelated connection state changes (error, reconnectAttempt, etc.)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const status = useConnectionStore((s) => s.status)
  const isConnected = status === 'online'
  const { uploadFile, isUploading, progress, isSupported } = useFileUpload()
  const { processMessageForLinkPreview } = useLinkPreview()
  const { resolvedMode } = useMode()

  // Handler to open search scoped to this room
  const handleSearchInConversation = activeRoom && onSearchInConversation
    ? () => onSearchInConversation(activeRoom.jid)
    : undefined

  // Create a map of contacts by JID for quick lookup (used to show avatars for known contacts)
  const contactsByJid = (() => {
    const map = new Map<string, Contact>()
    for (const contact of contacts) {
      map.set(contact.jid, contact)
    }
    return map
  })()

  // Filter out messages from ignored users and replies quoting them (client-side ignore)
  // IMPORTANT: Use stable empty array reference to prevent infinite re-renders.
  // Zustand uses Object.is to compare selector results — a new [] each time causes re-render loops.
  const ignoredForRoom = useIgnoreStore((s) => activeRoom ? (s.ignoredUsers[activeRoom.jid] ?? EMPTY_IGNORED_ARRAY) : EMPTY_IGNORED_ARRAY)
  const displayMessages = (() => {
    if (ignoredForRoom.length === 0) return activeMessages
    const cache = activeRoom?.nickToJidCache
    return activeMessages.filter(msg =>
      !isMessageFromIgnoredUser(ignoredForRoom, msg, cache) &&
      !isReplyToIgnoredUser(ignoredForRoom, msg.replyTo, cache)
    )
  })()

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
  const handleEditLastMessage = () => {
    const msg = findLastEditableMessage(activeMessages)
    if (msg) {
      setEditingMessage(msg)
    }
  }

  // Composing state - hides message toolbars when user is typing
  const [isComposing, setIsComposing] = useState(false)

  // Track which message has reaction picker open (hides other toolbars)
  const [activeReactionPickerMessageId, setActiveReactionPickerMessageId] = useState<string | null>(null)

  // Occupant panel state setter (calls parent callback if provided)
  const setShowOccupants = (show: boolean) => {
    onShowOccupantsChange?.(show)
  }

  const handleCancelReply = () => setReplyingTo(null)
  const handleCancelEdit = () => setEditingMessage(null)
  const handleReactionPickerChange = (messageId: string, isOpen: boolean) => {
    setActiveReactionPickerMessageId(isOpen ? messageId : null)
  }
  const handleCloseOccupants = () => setShowOccupants(false)

  // Nick context menu state (right-click / long-press on nick in messages)
  const nickMenu = useContextMenu()
  const [nickMenuTarget, setNickMenuTarget] = useState<string | null>(null) // nick string
  const [nickModerationTarget, setNickModerationTarget] = useState<string | null>(null)
  // setAffiliation and setRole are now from useRoomActive() to avoid subscribing
  // to list-level selectors that cause render loops when other rooms update
  const addToast = useToastStore((s) => s.addToast)

  const handleNickContextMenu = (nick: string, e: React.MouseEvent) => {
    if (!activeRoom || nick === activeRoom.nickname) return
    setNickMenuTarget(nick)
    nickMenu.handleContextMenu(e)
  }

  const handleNickTouchStart = (nick: string, e: React.TouchEvent) => {
    if (!activeRoom || nick === activeRoom.nickname) return
    setNickMenuTarget(nick)
    nickMenu.handleTouchStart(e)
  }

  const handleNickTouchEnd = () => {
    nickMenu.handleTouchEnd()
  }

  const uploadStateObj = { isUploading, progress }

  // Scroll ref for programmatic scrolling and keyboard navigation
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(true)

  // Composer handle ref for focusing after staging attachment
  const composerHandleRef = useRef<MessageComposerHandle>(null)

  // Scroll to bottom (used after sending a message)
  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }

  // Scroll to bottom when media loads (images, videos, link previews)
  // Only scrolls if user was already at bottom to avoid disrupting scroll position
  const handleMediaLoad = () => {
    if (scrollRef.current && isAtBottomRef.current) {
      // Use instant scroll to avoid jarring animation when content expands
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }

  // Scroll to bottom when composer resizes (typing long message)
  // Only scrolls if user was already at bottom to avoid disrupting scroll position
  const handleInputResize = () => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }

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

  // Create a lookup map for messages by ID (for reply context)
  // Index by both client id and stanza-id since replies may reference either
  const messagesById = createMessageLookup(activeMessages)

  // Track pendingAttachment in a ref for cleanup (not a trigger)
  const pendingAttachmentRef = useRef(pendingAttachment)
  pendingAttachmentRef.current = pendingAttachment

  // Clear reply/edit/pending attachment state when room changes
  // Note: scroll position is managed by MessageList component
  useEffect(() => {
    setReplyingTo(null)
    setEditingMessage(null)
    // Revoke old preview URL to avoid memory leaks
    if (pendingAttachmentRef.current?.previewUrl) {
      URL.revokeObjectURL(pendingAttachmentRef.current.previewUrl)
    }
    setPendingAttachment(null)
    clearSelection()
  }, [activeRoom?.jid, clearSelection])

  // File drop handler - stages file for preview only (no upload yet - privacy protection)
  // Upload happens when user clicks Send, not on drop (prevents accidental data leaks)
  const handleFileDrop = (file: File) => {
    if (!activeRoom || !isSupported) return
    // Create preview URL for images/videos
    const previewUrl = file.type.startsWith('image/') || file.type.startsWith('video/')
      ? URL.createObjectURL(file)
      : undefined
    setPendingAttachment({ file, previewUrl })
    // Focus composer so user can add a message
    setTimeout(() => composerHandleRef.current?.focus(), 0)
  }

  // Clear pending attachment and revoke preview URL
  const handleRemovePendingAttachment = () => {
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl)
    }
    setPendingAttachment(null)
  }

  // Drag-and-drop for file upload (handles both HTML5 and Tauri native)
  const { isDragging, dragHandlers } = useDragAndDrop({
    onFileDrop: handleFileDrop,
    isUploadSupported: isSupported,
  })

  // Memoize the clearFirstNewMessageId callback to avoid render loops
  // (inline arrow functions create new references on every render)
  const roomJid = activeRoom?.jid
  const handleClearFirstNewMessageId = () => {
    if (roomJid) {
      clearFirstNewMessageId(roomJid)
    }
  }

  // Viewport observer callback: update lastSeenMessageId as user scrolls
  const handleMessageSeen = (messageId: string) => {
    if (roomJid) {
      updateLastSeenMessageId(roomJid, messageId)
    }
  }

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
          className="focus-zone flex-1 flex flex-col min-h-0 p-1 relative"
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
          <RoomMessageList
            messages={displayMessages}
            messagesById={messagesById}
            scrollerRef={scrollRef}
            isAtBottomRef={isAtBottomRef}
            room={activeRoom}
            contactsByJid={contactsByJid}
            ownAvatar={ownAvatar}
            sendReaction={sendReaction}
            votePoll={votePoll}
            closePoll={closePoll}

            onReply={setReplyingTo}
            onEdit={setEditingMessage}
            lastOutgoingMessageId={lastOutgoingMessageId}
            lastMessageId={lastMessageId}
            typingUsers={filteredTypingUsers}
            isComposing={isComposing}
            activeReactionPickerMessageId={activeReactionPickerMessageId}
            onReactionPickerChange={handleReactionPickerChange}
            retractMessage={retractMessage}
            moderateMessage={moderateMessage}
            selectedMessageId={selectedMessageId}
            hasKeyboardSelection={hasKeyboardSelection}
            showToolbarForSelection={showToolbarForSelection}
            firstNewMessageId={activeRoom.firstNewMessageId}
            targetMessageId={targetMessageId}
            clearTargetMessageId={clearTargetMessageId}
            clearFirstNewMessageId={handleClearFirstNewMessageId}
            onMessageSeen={handleMessageSeen}
            isJoined={activeRoom.joined}
            isDarkMode={resolvedMode === 'dark'}
            onMediaLoad={handleMediaLoad}
            onScrollToTop={fetchOlderHistory}
            isLoadingOlder={activeMAMState?.isLoading}
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
        </div>

        {/* Input - show composer if joined, join prompt if not */}
        {activeRoom.joined ? (
          <RoomMessageInput
            key={activeRoom.jid}
            ref={composerHandleRef}
            room={activeRoom}
            textareaRef={composerRef as React.RefObject<HTMLTextAreaElement | null>}
            sendMessage={sendMessage}
            sendCorrection={sendCorrection}
            retractMessage={retractMessage}
            sendChatState={sendChatState}
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
            onMessageIdSent={(id) => {
              if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current)
              setLastSentMessageId(id)
              lastSentTimerRef.current = setTimeout(() => setLastSentMessageId(null), 400)
            }}
          />
        ) : (
          <RoomJoinPrompt
            onJoin={() => joinRoom(activeRoom.jid, activeRoom.nickname)}
          />
        )}
      </div>

      {/* Occupant panel (inline sidebar, desktop only — mobile uses full-screen in ChatLayout) */}
      {showOccupants && !isSmallScreen() && (
        <OccupantPanel
          room={activeRoom}
          contactsByJid={contactsByJid}
          ownAvatar={ownAvatar}
          onClose={handleCloseOccupants}
          onStartChat={onStartChat}
          onShowProfile={onShowProfile}
        />
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
            className="fixed bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50 min-w-40"
            style={{ left: nickMenu.position.x, top: nickMenu.position.y }}
          >
            {bareJid && onStartChat && (
              <MenuButton
                onClick={() => { onStartChat(bareJid); nickMenu.close() }}
                icon={<MessageCircle className="w-4 h-4" />}
                label={t('rooms.sendPrivateMessage')}
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
              icon={<EyeOff className="w-4 h-4" />}
              label={isIgnored ? t('rooms.stopIgnoring') : t('rooms.ignoreUser')}
            />
            {bareJid && onShowProfile && (
              <MenuButton
                onClick={() => { onShowProfile(bareJid); nickMenu.close() }}
                icon={<User className="w-4 h-4" />}
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
                  icon={<Settings className="w-4 h-4" />}
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

const RoomMessageList = memo(function RoomMessageList({
  messages,
  messagesById,
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
  isComposing,
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
  isLoadingOlder,
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
  messagesById: Map<string, RoomMessage>
  scrollerRef: React.RefObject<HTMLElement | null>
  isAtBottomRef: React.MutableRefObject<boolean>
  room: Room
  contactsByJid: Map<string, Contact>
  ownAvatar?: string | null
  sendReaction: (roomJid: string, messageId: string, emojis: string[]) => Promise<void>
  votePoll: (roomJid: string, messageId: string, optionEmoji: string, currentMyReactions: string[], poll: PollData, isClosed?: boolean) => Promise<void>
  closePoll: (roomJid: string, messageId: string) => Promise<string | null>
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  lastOutgoingMessageId: string | null
  lastMessageId: string | null
  typingUsers: string[]
  isComposing: boolean
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
  isLoadingOlder?: boolean
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

  // Track which message is hovered for stable toolbar interaction
  // This prevents the toolbar from switching when moving mouse to it
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Handle mouse enter on a message - set it as hovered immediately
  const handleMessageHover = (messageId: string) => {
    // Clear any pending timeout to clear hover
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }
    setHoveredMessageId(messageId)
  }

  // Handle mouse leave from a message - delay clearing to allow moving to toolbar
  const handleMessageLeave = () => {
    // Clear any existing timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
    }
    // Delay clearing hover to allow mouse to reach toolbar
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredMessageId(null)
      hoverTimeoutRef.current = null
    }, 100) // Small delay to allow mouse to reach toolbar
  }

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

  // Set of original poll message IDs that have been closed (a poll-closed message references them).
  // Used to disable the "Close poll" button on already-closed polls.
  const closedPollIds = useMemo(() => {
    const ids = new Set<string>()
    for (const msg of messages) {
      if (msg.pollClosed?.pollMessageId) {
        ids.add(msg.pollClosed.pollMessageId)
      }
    }
    return ids
  }, [messages])

  // Set of known occupant nicknames for IRC-style mention highlighting
  const knownNicks = useMemo(() => {
    const nicks = new Set<string>()
    for (const nick of room.occupants.keys()) {
      nicks.add(nick)
    }
    return nicks
  }, [room.occupants])

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
  const renderMessage = (msg: RoomMessage, idx: number, groupMessages: RoomMessage[]) => (
    <RoomMessageBubbleWrapper
      message={msg}
      showAvatar={shouldShowAvatar(groupMessages, idx)}
      messagesById={messagesById}
      room={room}
      knownNicks={knownNicks}
      contactsByJid={contactsByJid}
      ownAvatar={ownAvatar}
      sendReaction={sendReaction}
      votePoll={votePoll}
      closePoll={closePoll}

      closedPollIds={closedPollIds}
      onReply={onReply}
      onEdit={onEdit}
      isLastOutgoing={msg.id === lastOutgoingMessageId}
      isLastMessage={msg.id === lastMessageId}
      hideToolbar={isComposing || (activeReactionPickerMessageId !== null && activeReactionPickerMessageId !== msg.id)}
      onReactionPickerChange={(isOpen) => onReactionPickerChange(msg.id, isOpen)}
      retractMessage={retractMessage}
      moderateMessage={moderateMessage}
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
      onNickContextMenu={onNickContextMenu}
      onNickTouchStart={onNickTouchStart}
      onNickTouchEnd={onNickTouchEnd}
      setAffiliation={setAffiliation}
      highlightTerms={highlightTerms}
      isCurrentMatch={msg.id === currentMatchId}
    />
  )

  return (
    <MessageList
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
      isLoadingOlder={isLoadingOlder}
      isHistoryComplete={isHistoryComplete}
      renderMessage={renderMessage}
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
  messagesById: Map<string, RoomMessage>
  room: Room
  knownNicks: ReadonlySet<string>
  contactsByJid: Map<string, Contact>
  ownAvatar?: string | null
  sendReaction: (roomJid: string, messageId: string, emojis: string[]) => Promise<void>
  votePoll: (roomJid: string, messageId: string, optionEmoji: string, currentMyReactions: string[], poll: PollData, isClosed?: boolean) => Promise<void>
  closePoll: (roomJid: string, messageId: string) => Promise<string | null>
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  isLastOutgoing: boolean
  isLastMessage: boolean
  hideToolbar?: boolean
  onReactionPickerChange?: (isOpen: boolean) => void
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  moderateMessage: (roomJid: string, stanzaId: string, reason?: string) => Promise<void>
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
  // Nick context menu callbacks (right-click / long-press)
  onNickContextMenu?: (nick: string, e: React.MouseEvent) => void
  onNickTouchStart?: (nick: string, e: React.TouchEvent) => void
  onNickTouchEnd?: () => void
  // Affiliation action (passed from parent to avoid useRoom() subscription)
  setAffiliation: (roomJid: string, userJid: string, affiliation: RoomAffiliation, reason?: string) => Promise<void>
  // Set of poll message IDs that have been closed (to disable close button)
  closedPollIds: Set<string>
  // Highlight terms for find-on-page
  highlightTerms?: string[]
  // Whether this message is the current find-on-page match
  isCurrentMatch?: boolean
}

const RoomMessageBubbleWrapper = memo(function RoomMessageBubbleWrapper({
  message,
  showAvatar,
  messagesById,
  room,
  knownNicks,
  contactsByJid,
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
  closedPollIds,
  highlightTerms,
  isCurrentMatch,
}: RoomMessageBubbleWrapperProps) {
  const { t } = useTranslation()

  // Moderation confirmation state
  const [showModerateConfirm, setShowModerateConfirm] = useState(false)
  const [moderateReason, setModerateReason] = useState('')
  const [banAfterModerate, setBanAfterModerate] = useState(false)

  // Delete own message confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Get occupant info if available (by nick, then by occupant-id for nick changes)
  let occupant = room.occupants.get(message.nick)
  let occupantIdMatchNick: string | undefined
  if (!occupant && message.occupantId) {
    for (const occ of room.occupants.values()) {
      if (occ.occupantId === message.occupantId) {
        occupant = occ
        occupantIdMatchNick = occ.nick
        break
      }
    }
  }
  const myNick = room.nickname

  // Compute moderation permission for non-outgoing messages
  const selfOccupant = myNick ? room.occupants.get(myNick) : undefined
  const canModerateMsg = !message.isOutgoing && selfOccupant
    ? canModerate(selfOccupant.role, selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false

  // Can we ban this user? Need their real JID and ban permission
  const senderBareJidForBan = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick)
  const canBanUser = !message.isOutgoing && selfOccupant && senderBareJidForBan
    ? canBan(selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false

  // Get avatar for message sender:
  // 1. XEP-0398 occupant avatar (fetched from MUC presence vcard-temp:x:update)
  // 2. Cached avatar from nickToAvatarCache (persists after occupant leaves)
  // 3. Contact avatar (if occupant's real JID is in our roster)
  // 4. Fall back to fallback avatar generation
  const senderBareJid = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick)
      || room.nickToJidCache?.get(occupantIdMatchNick ?? '')
  const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined
  const contactAvatar = contact?.avatar
  const cachedAvatar = room.nickToAvatarCache?.get(message.nick)
    || room.nickToAvatarCache?.get(occupantIdMatchNick ?? '')
  const senderAvatar = occupant?.avatar || cachedAvatar || contactAvatar

  // Resolve display name when message.nick doesn't match any current occupant.
  // This handles cases where the message nick differs from the current occupant nick
  // (e.g., server reflects JID local part instead of MUC nickname, or nick changed between sessions)
  // Priority: 1) direct nick match → use as-is  2) occupant-id match → current occupant nick
  //           3) roster contact name  4) raw message.nick fallback
  const resolvedSenderName = occupantIdMatchNick
    || (contact?.name && !occupant ? contact.name : null)
    || message.nick

  // Get sender color: accent for own messages, contact's pre-calculated color, or fallback to nick-based generation
  const senderColor = message.isOutgoing
    ? 'var(--fluux-text-accent)'
    : contact
      ? (isDarkMode ? contact.colorDark : contact.colorLight) || getConsistentTextColor(resolvedSenderName, isDarkMode)
      : getConsistentTextColor(resolvedSenderName, isDarkMode)

  // Get my current reactions to this message (room — uses nick)
  const myReactions = getMyReactions(message.reactions, myNick, undefined, true)

  // Handle reaction toggle — poll-option emojis are routed through vote enforcement
  const handleReaction = (emoji: string) => {
    if (!myNick) return

    // If this is a poll-option emoji, route through vote enforcement
    if (message.poll) {
      const pollEmojis = message.poll.options.map(o => o.emoji)
      if (pollEmojis.includes(emoji)) {
        void votePoll(room.jid, message.id, emoji, myReactions, message.poll)
        return
      }
    }

    // Regular reaction toggle for non-poll emojis
    const newReactions = myReactions.includes(emoji)
      ? myReactions.filter(e => e !== emoji)
      : [...myReactions, emoji]

    void sendReaction(room.jid, message.id, newReactions)
  }

  // Handle poll vote — uses SDK vote() which enforces single/multi-vote rules
  const handlePollVote = message.poll ? (emoji: string) => {
    void votePoll(room.jid, message.id, emoji, myReactions, message.poll!, !!message.pollClosedAt)
  } : undefined

  // Build reply context using shared helper
  const replyContext = buildReplyContext(
    message,
    messagesById,
    (originalMsg, fallbackId) => {
      if (originalMsg) return originalMsg.nick
      // For rooms, fallbackId is the full JID like room@server/nick - extract nick
      return fallbackId ? fallbackId.split('/').pop() || 'Unknown' : 'Unknown'
    },
    (originalMsg, fallbackId, dark) => {
      // Own messages: use accent color
      if (originalMsg?.isOutgoing) return 'var(--fluux-text-accent)'
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
      // Try to get avatar: XEP-0398 occupant avatar, cached avatar, or contact avatar
      const occupantForReply = nick ? room.occupants.get(nick) : undefined
      const senderBareJid = occupantForReply?.jid
        ? getBareJid(occupantForReply.jid)
        : (nick ? room.nickToJidCache?.get(nick) : undefined)
      const contactAvatar = senderBareJid ? contactsByJid.get(senderBareJid)?.avatar : undefined
      const cachedReplyAvatar = nick ? room.nickToAvatarCache?.get(nick) : undefined
      const replyAvatar = occupantForReply?.avatar || cachedReplyAvatar || contactAvatar
      return {
        avatarUrl: replyAvatar,
        avatarIdentifier: nick || 'unknown',
      }
    },
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
          <Crown className="w-3.5 h-3.5 text-fluux-muted" />
        </span>
      )}
      {occupant && occupant.affiliation === 'admin' && (
        <span className="self-center">
          <Shield className="w-3.5 h-3.5 text-fluux-muted" />
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
        senderName={resolvedSenderName}
        senderColor={senderColor}
        avatarUrl={message.isOutgoing ? (ownAvatar || undefined) : (senderAvatar || undefined)}
        avatarIdentifier={resolvedSenderName}
        avatarFallbackColor={senderColor}
        avatarPresence={room.joined ? (occupant ? getPresenceFromShow(occupant.show) : 'offline') : undefined}
        senderJid={senderBareJid}
        senderContact={contact}
        senderRole={occupant?.role}
        senderAffiliation={occupant?.affiliation}
        senderOccupantJid={`${room.jid}/${message.nick}`}
        nickExtras={nickExtras}
        myReactions={myReactions}
        onReaction={room.supportsReactions !== false ? handleReaction : undefined}
        getReactorName={getReactorName}
        canModerate={canModerateMsg}
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
        onNickContextMenu={!message.isOutgoing ? handleNickContextMenu : undefined}
        onNickTouchStart={!message.isOutgoing ? handleNickTouchStart : undefined}
        onNickTouchEnd={!message.isOutgoing ? onNickTouchEnd : undefined}
        onReactionPickerChange={onReactionPickerChange}
        onPollVote={handlePollVote}
        onClosePoll={message.isOutgoing && message.poll && !closedPollIds.has(message.id) && !message.pollClosedAt ? () => closePoll(room.jid, message.id) : undefined}

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
            void retractMessage(room.jid, message.id)
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* Moderation confirmation dialog */}
      {showModerateConfirm && (
        <div
          data-modal="true"
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowModerateConfirm(false)
              setModerateReason('')
              setBanAfterModerate(false)
            }
          }}
        >
          <div className="bg-fluux-sidebar rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl">
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
                    void moderateMessage(room.jid, message.stanzaId ?? message.id, reason)
                    if (banAfterModerate && senderBareJidForBan) {
                      void setAffiliation(room.jid, senderBareJidForBan, 'outcast', reason)
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
                  className="w-4 h-4 rounded border-fluux-border text-fluux-brand focus:ring-fluux-brand/50"
                />
                <span className="text-sm text-fluux-text">{t('chat.moderateAndBan')}</span>
              </label>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowModerateConfirm(false)
                  setModerateReason('')
                  setBanAfterModerate(false)
                }}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  setShowModerateConfirm(false)
                  const reason = moderateReason.trim() || undefined
                  setModerateReason('')
                  void moderateMessage(room.jid, message.stanzaId ?? message.id, reason)
                  if (banAfterModerate && senderBareJidForBan) {
                    void setAffiliation(room.jid, senderBareJidForBan, 'outcast', reason)
                  }
                  setBanAfterModerate(false)
                }}
                className="px-4 py-2 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              >
                {t('chat.moderateMessage')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
})

interface RoomMessageInputProps {
  room: Room
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  sendMessage: (roomJid: string, body: string, replyTo?: { id: string; to: string; fallback?: { author: string; body: string } }, references?: MentionReference[], attachment?: FileAttachment) => Promise<string>
  sendCorrection: (roomJid: string, messageId: string, newBody: string, attachment?: FileAttachment) => Promise<void>
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  sendChatState: (roomJid: string, state: ChatStateNotification) => Promise<void>
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
  uploadState?: { isUploading: boolean; progress: number }
  isUploadSupported?: boolean
  onFileSelect?: (file: File) => void
  uploadFile?: (file: File) => Promise<FileAttachment | null>
  pendingAttachment?: PendingAttachment | null
  onRemovePendingAttachment?: () => void
  processLinkPreview?: (messageId: string, body: string, to: string, type: 'chat' | 'groupchat') => Promise<void>
  isConnected: boolean
  onMessageIdSent?: (messageId: string) => void
}

function RoomMessageInput({
  room,
  textareaRef,
  sendMessage,
  sendCorrection,
  retractMessage,
  sendChatState,
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
  ref,
}: RoomMessageInputProps & { ref?: React.Ref<MessageComposerHandle> }) {
  const { t } = useTranslation()
  const { setDraft, getDraft, clearDraft, clearFirstNewMessageId } = useRoomActive()
  const [showPollCreator, setShowPollCreator] = useState(false)

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
    conversationId: room.jid,
    draftOperations: { getDraft, setDraft, clearDraft },
    composerRef,
    onDraftRestored: handleDraftRestored,
  })

  // Type-to-focus: auto-focus composer when user starts typing anywhere
  useTypeToFocus(composerRef)

  // Check if room is small enough to send typing notifications
  const shouldSendTypingNotifications = room.occupants.size < MAX_ROOM_SIZE_FOR_TYPING

  // Collect unique nicks from message history and affiliated members for mention suggestions
  const messageNicks = (() => {
    const nicks = new Set<string>()
    for (const msg of room.messages) {
      nicks.add(msg.nick)
    }
    // Add nicks from affiliated members (offline users with known nicks)
    if (room.affiliatedMembers) {
      for (const member of room.affiliatedMembers) {
        if (member.nick) {
          nicks.add(member.nick)
        }
      }
    }
    return nicks
  })()

  // Mention autocomplete hook
  const { state: mentionState, selectMatch, moveSelection, dismiss } = useMentionAutocomplete(
    text,
    cursorPosition,
    room.occupants,
    room.nickname,
    room.jid,
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
    const messageId = await sendMessage(room.jid, body, replyTo, references.length > 0 ? references : undefined, attachment ?? undefined)
    setReferences([])

    // Notify parent of sent message ID for animation
    onMessageIdSent?.(messageId)

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
                       ? 'bg-fluux-brand text-fluux-text-on-accent'
                       : 'hover:bg-fluux-hover text-fluux-text'}`}
        >
          {/* Avatar */}
          {match.isAll ? (
            <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-fluux-brand">
              <Users className="w-3.5 h-3.5 text-fluux-text-on-accent" />
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
    <>
    {showPollCreator && (
      <PollCreator
        onClose={() => setShowPollCreator(false)}
        onCreatePoll={async (title, options, settings, description, deadline, customEmojis) => {
          await sendPoll(room.jid, title, options, settings, description, deadline, customEmojis)
        }}
      />
    )}
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
      onCreatePoll={() => setShowPollCreator(true)}
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
    </>
  )
}

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

