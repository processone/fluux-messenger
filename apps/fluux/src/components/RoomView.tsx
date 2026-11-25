import { iosHaptic } from '@/platform/ios/haptics'
import { editableForward } from '../utils/forwardMessage'
import { isSpamModerated } from '@/utils/spamModeration'
import { SpamModerationOption } from './SpamModerationOption'
import { RoomReadBadge } from './RoomReadMarkers'
import type { GapInterval, MessageRowRef, RoomReadMarkers } from '@fluux/sdk'
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useId, useMemo, useSyncExternalStore, memo, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { shallow } from 'zustand/shallow'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { getRoomModerationId, archiveReference, senderReference, useRoomActive, usePolls, useRoomModeration, useRoomManagement, useRoomEntity, useContactIdentities, getBareJid, generateConsistentColorHexSync, createMessageLookup, useReferencedMessage, useRoomMessageSnapshots, resolveRoomMessageSnapshot, isMessageFromIgnoredUser, isReplyToIgnoredUser, filterIgnoredReactions, canKick, canBan, getAvailableAffiliations, getAvailableRoles, getMyReactions, WhisperCounterpartGoneError, getStorageScopeJid, type RoomMessage, type Room, type RoomOccupant, type MentionReference, type ChatStateNotification, type ContactIdentity, type FileAttachment, type RoomAffiliation, type RoomRole, type PollData } from '@fluux/sdk'
import { useConnectionStore, useIgnoreStore, useRoomStore } from '@fluux/sdk/react'
import { ignoreStore, roomStore, type IgnoredUser } from '@fluux/sdk/stores'
import { useMentionAutocomplete, useMessageHoverState, useConversationDraft, useTimeFormat, useContextMenu, useWhisperCounterpartPresent, useRoomOccupantCountBelow, isSmallScreen } from '@/hooks'
import { MessageBubble, MessageList, RoomSystemLine, shouldShowAvatar, groupHeaderIndex, whisperThreadPosition, whisperCounterpartPresent, resolveWhisperTarget, decideWhisperSend, decideChatStateRoute, buildReplyContext, canClosePoll, PollBanner, type WhisperThreadPosition, type WhisperTarget } from './conversation'
import type { FindOnPageHandle } from '@/hooks/useFindOnPage'
import { selectSelfOccupant, stableNickSet, resolveRoomSender, resolveReplyAvatar, resolveRoomAvatar, resolveSenderColor, rememberRoomNickIdentities, resolveRoomMentionColors, type RoomNickIdentity } from './conversation/roomSenderResolution'
import { selectRoomInitialLoading, selectRoomMembershipPhase } from './conversation/roomLoadingState'
import type { ReactorDetails } from './conversation/MessageReactorsSheet'
import { format } from 'date-fns'
import type { CopyMessageMeta } from '@/utils/buildCopyText'
import { deriveCopyBody } from '@/utils/copyMessageBody'
import { Shield, Crown, Loader2, LogIn, AlertCircle, MessageCircle, EyeOff, User, Settings, Ear, X, Hash } from 'lucide-react'
import { TextInput } from './ui/TextInput'
import { MessageComposer, type ReplyInfo, type EditInfo, type MessageComposerHandle, type PendingAttachment, type ComposerAutocompleteAriaProps, type ComposerInputElement, type ComposerChangeEvent, type ComposerSelectEvent } from './MessageComposer'
import { MentionAutocompleteMenu } from './composer/MentionAutocompleteMenu'
import { RoomComposerEditor } from './composer/RoomComposerEditor'
import { useMentionReferences } from './composer/useMentionReferences'
import { composerAutocompleteAriaProps } from './composer/autocompleteAria'
import { usesMobileEnterKey } from './composer/mobileEnter'
import { ConversationThread } from './conversation/ConversationThread'
import { useConversationThread } from '@/hooks/useConversationThread'
import { useDraftResumeTarget, type RegisterDraftResume } from '@/hooks/useDraftResumeTarget'
import { RoomHeader } from './RoomHeader'
import { RoomVoiceControls } from './RoomVoiceControls'
import { OccupantPanel } from './OccupantPanel'
import { RegionErrorBoundary } from './RegionErrorBoundary'
import { OccupantModerationModal } from './OccupantModerationModal'
import { RoomBulkModerationModal } from './RoomBulkModerationModal'
import { canBulkModerate } from './roomBulkModeration'
import { PollCreator } from './PollCreator'
import { MenuButton, MenuDivider } from './sidebar-components/SidebarListMenu'
import { Tooltip } from './Tooltip'
import { useToastStore } from '@/stores/toastStore'
import { ConfirmDialog } from './ConfirmDialog'
import { ModalOverlay } from './ModalOverlay'
import { useRoomCommandContext } from '@/hooks/useRoomCommandContext'
import { useSlashCommands } from '@/hooks/useSlashCommands'
import { useCommandMenu } from '@/hooks/useCommandMenu'
import { CommandMenu } from './composer/CommandMenu'
import { CommandHelpPanel } from './composer/CommandHelpPanel'
import { visibleCommands } from '@/commands/registry'
import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'
import { useRoomPasswordPrompt } from '@/hooks/useRoomPasswordPrompt'
import { computeMediaAutoload } from '@/utils/mediaAutoload'
import { useSettingsStore } from '@/stores/settingsStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
import { auroraSenderColor, nickColorSeed } from '@/utils/senderColor'
import type { MessageListHandle } from './conversation/messageListBoundary'
import { messageRowId } from './conversation/messageRowIdentity'
import { donateIOSConversation } from '@/platform/ios/shareSuggestions'
import { trackSend } from '@/utils/pendingSends'

const roomMentionIdentities = new Map<string, Map<string, RoomNickIdentity>>()

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

const noPeerMarkerSubscription = () => () => {}

interface RoomViewProps {
  onRegisterDraftResume?: RegisterDraftResume
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
  onShowSavedInConversation?: (conversationId: string) => void
  /** Covered by another pane (the mobile member list), so out of reach of focus and assistive technology. */
  covered?: boolean
  /** Wrap the mobile member panel in the layout-owned navigation pane. */
  renderMobileOccupants?: (panel: React.ReactNode) => React.ReactNode
  /** Animated back navigation for the mobile member panel. */
  onCloseMobileOccupants?: () => void
}

// Max room size for sending typing indicators (to avoid noise in large rooms)
const MAX_ROOM_SIZE_FOR_TYPING = 300

// Stable empty array for useIgnoreStore selector to prevent infinite re-render loops
const EMPTY_IGNORED_ARRAY: import('@fluux/sdk/stores').IgnoredUser[] = []
// Stable empty fallback for the composer's NON-reactive occupants read.
const EMPTY_OCCUPANTS: Map<string, RoomOccupant> = new Map()

// Stable identities: the thread reads them in effects keyed on the room
const readActiveRoomMessages = () => roomStore.getState().activeMessages()
const setRoomTargetMessageId = (target: string | MessageRowRef) => roomStore.getState().setTargetMessageId(target)
const triggerRoomAnimation = (id: string, animation: string, senderName: string) => roomStore.getState().triggerAnimation(id, animation, senderName)

export function RoomView({ onBack, mainContentRef, composerRef, showOccupants = false, onShowOccupantsChange, onStartChat, onShowProfile, findOnPageRef, onSearchInConversation, onShowSavedInConversation, covered = false, renderMobileOccupants, onCloseMobileOccupants, onRegisterDraftResume }: RoomViewProps) {
  const { t } = useTranslation()
  // Active-room state + messaging/scroll actions. Poll / moderation /
  // management actions come from the focused hooks below (they subscribe to no
  // store, so they add no re-render triggers).
  const { activeRoom, activeMessages, activeMessageIngressVersion, activeTypingUsers, sendMessage, sendWhisper, sendReaction, sendCorrection, retractMessage, sendChatState, sendWhisperChatState, activeAnimation, sendEasterEgg, clearAnimation, clearFirstNewMessageId, advanceReadPointer, fetchOlderHistory, loadMessagesAround, loadNewer, recenterToLatest, windowAtLiveEdge, continueRoomCatchUp, activeHistoryState, targetMessageId, clearTargetMessageId, firstNewMessageRow, firstNewMessageIsProvisional, firstNewMessageCount, readPointerRow, peerReadMarkers } = useRoomActive()
  detectRenderLoop('RoomView', activeMessageIngressVersion)
  const interiorPlacementVersion = useRoomStore((state) => {
    const jid = state.activeRoomJid
    return jid ? state.interiorPlacementVersions.get(jid) ?? 0 : 0
  })
  const { sendPoll, votePoll, closePoll } = usePolls()
  const { moderateMessage, setAffiliation, setRole } = useRoomModeration()
  const { setRoomNotifyLevel, setRoomAvatar, clearRoomAvatar, submitRoomConfig, setSubject, destroyRoom } = useRoomManagement()
  const mediaPolicy = useSettingsStore((s) => s.mediaAutoDownload)


  // NOTE: Use focused selectors instead of useConnection() hook to avoid
  // re-renders when unrelated connection state changes (error, reconnectAttempt, etc.)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const { confirmJoin, warningDialog } = useRoomJoinWarning()
  const { joinRoomWithPassword, passwordDialog } = useRoomPasswordPrompt()

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
    const visibleMessages = activeMessages.some(isSpamModerated)
      ? activeMessages.filter(message => !isSpamModerated(message)) : activeMessages
    if (ignoredForRoom.length === 0) return visibleMessages
    const cache = activeRoom?.nickToJidCache
    return visibleMessages
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



  const [bulkModerationRoomJid, setBulkModerationRoomJid] = useState<string | null>(null)
  const [bulkModerationSender, setBulkModerationSender] = useState<RoomMessage | undefined>()
  const [bulkModerationReason, setBulkModerationReason] = useState<string | undefined>()
  const handleModerateSender = useCallback((message: RoomMessage, reason?: string) => {
    setBulkModerationSender(message)
    setBulkModerationReason(reason)
    setBulkModerationRoomJid(message.roomJid)
  }, [])

  // Poll state — persisted to localStorage via roomStore
  const activeRoomJid = activeRoom?.jid ?? ''
  const votedPollIds = useRoomStore((s) => s.getVotedPollIds(activeRoomJid))
  const dismissedPollIds = useRoomStore((s) => s.getDismissedPollIds(activeRoomJid))
  const handleDismissPoll = useCallback((messageId: string) => {
    if (activeRoomJid) roomStore.getState().dismissPoll(activeRoomJid, messageId)
  }, [activeRoomJid])


  const thread = useConversationThread<RoomMessage>({
    kind: 'room',
    id: activeRoom?.jid,
    // The list, find, selection and last row skip ignored and spam rows; the last editable message does not
    displayMessages,
    allMessages: activeMessages,
    readAllMessages: readActiveRoomMessages,
    fetchOlderHistory,
    isLoadingOlder: activeHistoryState?.isLoading,
    historyGaps: activeHistoryState?.gaps,
    archiveAvailable: activeRoom?.supportsMAM,
    windowAtLiveEdge,
    recenterToLatest,
    isHistoryComplete: activeRoom?.supportsMAM === false || activeHistoryState?.isHistoryComplete,
    clearFirstNewMessageId,
    advanceReadPointer,
    setTargetMessageId: setRoomTargetMessageId,
    triggerAnimation: triggerRoomAnimation,
    activeAnimation: activeAnimation && activeAnimation.roomJid === activeRoom?.jid ? activeAnimation : null,
    clearAnimation,
    onSearchInConversation,
    onShowSavedInConversation,
    findOnPageRef,
  })
  const { setReplyingTo, setEditingMessage, clearPendingAttachment, composerHandleRef } = thread

  // Occupant panel state setter (calls parent callback if provided)
  const setShowOccupants = (show: boolean) => {
    onShowOccupantsChange?.(show)
  }

  const handleCloseOccupants = () => setShowOccupants(false)

  // Nick context menu state (right-click / long-press on nick in messages)
  const nickMenu = useContextMenu()
  const [nickMenuTarget, setNickMenuTarget] = useState<string | null>(null) // nick string
  const [nickModerationTarget, setNickModerationTarget] = useState<string | null>(null)

  // Whisper mode: when set, the composer targets a specific occupant privately.
  // Carries the counterpart's occupant-id (captured at entry) so presence checks
  // bind to the person, not just the nick (XEP-0045 §7.5, XEP-0421).
  const [whisperTarget, setWhisperTarget] = useState<WhisperTarget | null>(null)
  const focusAfterWhisperCancel = useRef<string | null>(null)
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

  // Track the active room in a ref so enterWhisperMode can resolve the
  // counterpart's occupant-id at call time without depending on activeRoom
  // (which changes on every occupant update and would destabilize the callback).
  const activeRoomRef = useRef(activeRoom)
  useLayoutEffect(() => { activeRoomRef.current = activeRoom }, [activeRoom])

  // Keep the row snapshot until a field consumed by rows changes. State,
  // unlike a render-time ref write, is safe when React abandons a render.
  const [stableRoom, setStableRoom] = useState(activeRoom)
  if (stableRoom !== activeRoom && (
    !stableRoom || !activeRoom ||
    stableRoom.jid !== activeRoom.jid ||
    stableRoom.nickname !== activeRoom.nickname ||
    stableRoom.joined !== activeRoom.joined ||
    stableRoom.isJoining !== activeRoom.isJoining ||
    stableRoom.supportsReactions !== activeRoom.supportsReactions ||
    stableRoom.supportsMAM !== activeRoom.supportsMAM ||
    stableRoom.isIrcGateway !== activeRoom.isIrcGateway ||
    stableRoom.occupants !== activeRoom.occupants ||
    stableRoom.nickToJidCache !== activeRoom.nickToJidCache ||
    stableRoom.nickToAvatarCache !== activeRoom.nickToAvatarCache
  )) setStableRoom(activeRoom)

  // Stable callback that clears any staged compose state before entering whisper
  // mode. Whispers are text-only so a staged reply, edit, or pending attachment
  // must be discarded to avoid showing conflicting UI (banner + attachment preview).
  const enterWhisperMode = useCallback((nick: string) => {
    setReplyingTo(null)
    setEditingMessage(null)
    clearPendingAttachment()
    // Capture the counterpart's occupant-id now so the send/disable gates can
    // bind to this exact person even if they later change nick or leave.
    setWhisperTarget(resolveWhisperTarget(nick, activeRoomRef.current?.occupants ?? new Map()))
  }, [setReplyingTo, setEditingMessage, clearPendingAttachment])

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
  }, [enterWhisperMode, setReplyingTo, addToast, t])

  // Clear bulk moderation and whisper state when the room changes. The thread clears the
  // staged reply, edit, attachment and selection in its own effect.
  useEffect(() => {
    setBulkModerationRoomJid(null)
    setBulkModerationSender(undefined)
    setWhisperTarget(null)
  }, [activeRoom?.jid])

  // Stable callback to clear whisper target (name avoids clash with the
  // composer-internal handleClearWhisper defined inside RoomMessageInput).
  const handleClearWhisperTarget = useCallback(() => {
    focusAfterWhisperCancel.current = activeRoomRef.current?.jid ?? null
    setWhisperTarget(null)
  }, [])

  useLayoutEffect(() => {
    if (whisperTarget || !focusAfterWhisperCancel.current) return
    const roomJid = focusAfterWhisperCancel.current
    focusAfterWhisperCancel.current = null
    if (activeRoom?.jid === roomJid) composerHandleRef.current?.focus()
  }, [whisperTarget, activeRoom?.jid, composerHandleRef])

  if (!activeRoom) return null

  const membershipPhase = selectRoomMembershipPhase(activeRoom)

  // Room media trust: open rooms are public; members-only/hidden are private.
  // A room whose disco hasn't resolved has isPrivate falsy → treated as public
  // (fail-safe). Strangers do not apply to rooms.
  const mediaAutoLoad = computeMediaAutoload(mediaPolicy, activeRoom.isPrivate ? 'room-private' : 'room-public')

  return (
    <>
      <ConversationThread
        thread={thread.layout}
        mainContentRef={mainContentRef}
        mediaAutoLoad={mediaAutoLoad}
        rootClassName="flex flex-1 min-h-0 relative"
        covered={covered}
        columnClassName="flex flex-col flex-1 min-w-0"
        header={
          <RoomHeader
            peerReadMarkers={peerReadMarkers}
            room={activeRoom}
            covered={covered}
            onBack={onBack}
            showOccupants={showOccupants}
            onToggleOccupants={() => setShowOccupants(!showOccupants)}
            setRoomNotifyLevel={setRoomNotifyLevel}
            setRoomAvatar={setRoomAvatar}
            clearRoomAvatar={clearRoomAvatar}
            submitRoomConfig={submitRoomConfig}
            setSubject={setSubject}
            destroyRoom={destroyRoom}
            onSearchInConversation={thread.handleSearchInConversation}
            onJumpToDate={thread.handleJumpToDate}
            onShowSavedInConversation={thread.handleShowSaved}
            onBulkModeration={canBulkModerate(activeRoom) ? () => {
              setBulkModerationSender(undefined)
              setBulkModerationReason(undefined)
              setBulkModerationRoomJid(activeRoom.jid)
            } : undefined}
          />
        }
        aboveList={
          <>
          {bulkModerationRoomJid === activeRoom.jid && (
            <RoomBulkModerationModal
              key={`bulk-moderation:${activeRoom.jid}`}
              room={activeRoom}
              messages={activeMessages}
              isConnected={thread.isConnected}
              initialSender={bulkModerationSender}
              initialReason={bulkModerationReason}
              moderateMessage={moderateMessage}
              onClose={() => setBulkModerationRoomJid(null)}
            />
          )}

          {/* Unanswered poll banner */}
          <PollBanner
            messages={displayMessages}
            myNick={activeRoom.nickname}
            votedPollIds={votedPollIds}
            dismissedPollIds={dismissedPollIds}
            onDismiss={handleDismissPoll}
          />
          </>
        }
        list={
              <RoomMessageList
                {...thread.listProps}
                peerReadMarkers={peerReadMarkers}
                messages={displayMessages}
                identityMessages={activeMessages}
                loadedMessageCount={activeMessages.length}
                messageIngressVersion={activeMessageIngressVersion}
                interiorPlacementVersion={interiorPlacementVersion}
                room={stableRoom ?? activeRoom}
              unreadCount={activeRoom.unreadCount}
              contactsByJid={contactsByJid}
              ownAvatar={ownAvatar}
              sendReaction={sendReaction}
              votePoll={votePoll}
              closePoll={closePoll}

              onReply={handleReplyToMessage}
              typingUsers={filteredTypingUsers}
              retractMessage={retractMessage}
              moderateMessage={moderateMessage}
              onModerateSender={handleModerateSender}
              firstNewMessageRow={firstNewMessageRow}
              firstNewMessageIsProvisional={firstNewMessageIsProvisional}
              firstNewMessageCount={firstNewMessageCount}
              readPointerRow={readPointerRow}
              targetMessageId={targetMessageId}
              clearTargetMessageId={clearTargetMessageId}
              membershipPhase={membershipPhase}
              isDarkMode={thread.isDarkMode}
              onScrollToTop={fetchOlderHistory}
              onLoadAround={loadMessagesAround}
              isLoadingOlder={activeHistoryState?.isLoading}
              onLoadNewer={loadNewer}
              windowAtLiveEdge={windowAtLiveEdge}
              onJumpToLatest={recenterToLatest}
              isHistoryComplete={activeRoom.supportsMAM === false || activeHistoryState?.isHistoryComplete}
              historyUnavailable={Boolean(activeHistoryState?.error)}
              onNickContextMenu={handleNickContextMenu}
              onNickTouchStart={handleNickTouchStart}
              onNickTouchEnd={handleNickTouchEnd}
              setAffiliation={setAffiliation}
              gaps={activeHistoryState?.gaps}
              onCatchUpHistory={continueRoomCatchUp}
              isCatchingUp={activeHistoryState?.isLoading}
              />
        }
        composer={
          <>
            {/* Membership owns the footer; joining never replaces the reading area. */}
            {membershipPhase === 'joined' ? (
              <RoomVoiceControls room={activeRoom} isConnected={thread.isConnected} allowWhisper={!!whisperTarget}>
                <RoomMessageInput
                  {...thread.composerProps}
                  key={activeRoom.jid}
                  onRegisterDraftResume={onRegisterDraftResume}
                  ref={composerHandleRef}
                  roomJid={activeRoom.jid}
                  textareaRef={composerRef as React.RefObject<ComposerInputElement | null>}
                  sendMessage={sendMessage}
                  sendCorrection={sendCorrection}
                  retractMessage={retractMessage}
                  sendChatState={sendChatState}
                  sendWhisperChatState={sendWhisperChatState}
                  sendEasterEgg={sendEasterEgg}
                  sendPoll={sendPoll}
                  whisperTarget={whisperTarget}
                  onClearWhisper={handleClearWhisperTarget}
                  sendWhisper={sendWhisper}
                />
              </RoomVoiceControls>
            ) : membershipPhase === 'joining' ? (
              <RoomJoiningPanel />
            ) : (
              <RoomJoinPrompt
                onJoin={async () => {
                  // Issue #37: warn before joining a room that would expose the user's real JID.
                  if (await confirmJoin(activeRoom.jid)) {
                    try {
                      // Prompts for the room password when the server asks for one.
                      await joinRoomWithPassword(activeRoom.jid, activeRoom.nickname)
                    } catch (err) {
                      addToast('error', getRoomJoinErrorMessage(t, err))
                    }
                  }
                }}
              />
            )}
          </>
        }
        columnEnd={<>{warningDialog}{passwordDialog}</>}
        aside={
          <>
      {/* Occupant panel (>=768px; mobile uses the layout-owned pane below).
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
            className="fixed-below-titlebar z-30 bg-black/50 lg:hidden"
          />
          <div className="fixed bottom-0 top-[var(--fluux-window-titlebar-height)] end-0 z-40 flex shadow-xl animate-drawer-in lg:static lg:z-auto lg:shadow-none">
            <RegionErrorBoundary region="occupants" variant="panel" resetKey={activeRoom.jid}>
              <OccupantPanel
                room={activeRoom}
                contactsByJid={contactsByJid}
                ownAvatar={ownAvatar}
                onClose={handleCloseOccupants}
                onStartChat={onStartChat}
                onWhisper={enterWhisperMode}
                onShowProfile={onShowProfile}
              />
            </RegionErrorBoundary>
          </div>
        </>
      )}
          </>
        }
        overlays={
          <>
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
          </>
        }
      />
      {renderMobileOccupants?.(
        <RegionErrorBoundary region="occupants" variant="panel" resetKey={activeRoom.jid} onBack={onCloseMobileOccupants ?? handleCloseOccupants}>
        <OccupantPanel
          room={activeRoom}
          contactsByJid={contactsByJid}
          ownAvatar={ownAvatar}
          onClose={onCloseMobileOccupants ?? handleCloseOccupants}
          onStartChat={onStartChat}
          onShowProfile={onShowProfile}
          onWhisper={(nick) => {
            // iOS focus must stay in the click gesture, after the room is no longer inert.
            flushSync(() => {
              enterWhisperMode(nick)
              setShowOccupants(false)
            })
            composerHandleRef.current?.focus()
          }}
          fullScreen
        />
        </RegionErrorBoundary>,
      )}
    </>
  )
}

export const RoomMessageList = memo(function RoomMessageList({
  messages,
  identityMessages = messages,
  loadedMessageCount: suppliedLoadedMessageCount,
  messageIngressVersion,
  interiorPlacementVersion = 0,
  listHandleRef,
  onLiveEdgeMeasured,
  peerReadMarkers,
  room,
  unreadCount,
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
  onModerateSender,
  selectedMessageId,
  hasKeyboardSelection,
  showToolbarForSelection,
  firstNewMessageRow,
  firstNewMessageIsProvisional,
  firstNewMessageCount,
  readPointerRow,
  targetMessageId,
  clearTargetMessageId,
  clearFirstNewMessageId,
  onMessageSeen,
  membershipPhase,
  isDarkMode,
  onScrollToTop,
  onLoadAround,
  isLoadingOlder,
  onLoadNewer,
  windowAtLiveEdge,
  onJumpToLatest,
  isHistoryComplete,
  historyUnavailable,
  onNickContextMenu,
  onNickTouchStart,
  onNickTouchEnd,
  setAffiliation,
  highlightTerms,
  currentMatchId,
  lastSentMessageId,
  onJumpToDate,
  gaps,
  onCatchUpHistory,
  isCatchingUp,
}: {
  messages: RoomMessage[]
  identityMessages?: readonly RoomMessage[]
  loadedMessageCount?: number
  messageIngressVersion?: number
  interiorPlacementVersion?: number
  /** Holds the list's command handle; filled in while the list is mounted. */
  listHandleRef: RefObject<MessageListHandle | null>
  onLiveEdgeMeasured?: (atEdge: boolean) => void
  room: Room
  peerReadMarkers?: RoomReadMarkers
  // Read fresh off `activeRoom` (NOT `room`/`stableRoom`): the stable room memo
  // deliberately freezes on jid/nickname/joined/occupants/etc and does NOT refresh
  // on unreadCount, so addMessage's count bump would never reach the in-list
  // divider/pill/FAB badge if this were read from `room` instead. See RoomView
  // Optional (mirrors MessageList's own `unreadCount?: number`)
  // so unrelated presence/memo tests that don't care about the badge need no changes.
  unreadCount?: number
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
  onModerateSender?: (message: RoomMessage, reason?: string) => void
  selectedMessageId: string | null
  hasKeyboardSelection: boolean
  showToolbarForSelection: boolean
  firstNewMessageRow?: MessageRowRef
  firstNewMessageIsProvisional?: boolean
  firstNewMessageCount?: number
  readPointerRow?: MessageRowRef
  targetMessageId?: string | MessageRowRef | null
  clearTargetMessageId?: () => void
  clearFirstNewMessageId: () => void
  onMessageSeen?: (messageId: string) => void
  membershipPhase: ReturnType<typeof selectRoomMembershipPhase>
  isDarkMode?: boolean
  onScrollToTop?: () => void
  onLoadAround?: (anchorRow: MessageRowRef, signal?: AbortSignal) => Promise<unknown> | void
  isLoadingOlder?: boolean
  onLoadNewer?: () => void
  windowAtLiveEdge?: boolean
  onJumpToLatest?: () => Promise<unknown> | void
  isHistoryComplete?: boolean
  historyUnavailable?: boolean
  onNickContextMenu?: (nick: string, e: React.MouseEvent) => void
  onNickTouchStart?: (nick: string, e: React.TouchEvent) => void
  onNickTouchEnd?: () => void
  setAffiliation: (roomJid: string, userJid: string, affiliation: RoomAffiliation, reason?: string) => Promise<void>
  highlightTerms?: string[]
  currentMatchId?: string
  lastSentMessageId?: string | null
  onJumpToDate?: (date: string) => void
  gaps?: readonly GapInterval[]
  onCatchUpHistory?: (gapStart: number) => void
  isCatchingUp?: boolean
}) {
  const loadedMessageCount = suppliedLoadedMessageCount === undefined ? messages.length : suppliedLoadedMessageCount
  const sharingSnapshot = useCallback(() => peerReadMarkers?.isEnabledFor(room.jid) ?? false, [peerReadMarkers, room.jid])
  const collectViews = useSyncExternalStore(peerReadMarkers?.subscribe ?? noPeerMarkerSubscription, sharingSnapshot)
  const { t } = useTranslation()
  const { formatTime, effectiveTimeFormat } = useTimeFormat()

  // Selection-aware, hover-intent toolbar hover state (stable handler identities)
  const { hoveredMessageId, handleMessageHover, handleMessageLeave } =
    useMessageHoverState({ list: listHandleRef, resetKey: room.jid })

  // Set of original poll message IDs that have been closed (a poll-closed message references them).
  // Used to disable the "Close poll" button on already-closed polls. Each row receives a
  // per-message boolean derived from this set (see renderMessage), NOT the Set itself nor a
  // stable getter: a fresh Set or a stable-ref getter read during render would either break the
  // memo bailout of every row on each append, or freeze the closed-state inside the memoized row
  // (a row only re-renders when its own props change). A per-message boolean flips only for the
  // poll that closed, so it stays reactive without re-rendering unrelated rows.
  const closedPollIds = useMemo(() => {
    const ids = new Set<string>()
    const polls = messages.filter(message => message.poll)
    for (const msg of messages) {
      if (msg.pollClosed?.pollMessageId) {
        const authorPolls = polls.filter(poll => poll.occupantId && msg.occupantId
          ? poll.occupantId === msg.occupantId : poll.from === msg.from)
        const poll = createMessageLookup(authorPolls).get(msg.pollClosed.pollMessageId)
        const rowId = poll && messageRowId(poll)
        if (rowId) ids.add(rowId)
      }
    }
    return ids
  }, [messages])

  // Resolve reply identities once per resident message window. The lookup
  // includes stanza/origin aliases, matching reply resolution elsewhere.
  const messagesById = useMemo(() => createMessageLookup(messages), [messages])

  const [previousMentionColors, setPreviousMentionColors] = useState<ReadonlyMap<string, string>>()
  const identityKey = JSON.stringify([getStorageScopeJid(), room.jid])
  const mentionColors = useMemo(() => {
    let identities = roomMentionIdentities.get(identityKey)
    if (!identities) {
      identities = new Map()
      roomMentionIdentities.set(identityKey, identities)
    }
    rememberRoomNickIdentities(room, identityMessages, identities)
    const colors = resolveRoomMentionColors(room, contactsByJid, isDarkMode ?? true, identities, previousMentionColors)
    return colors
  }, [identityKey, room, identityMessages, contactsByJid, isDarkMode, previousMentionColors])
  if (mentionColors !== previousMentionColors) setPreviousMentionColors(mentionColors)
  const [previousKnownNicks, setPreviousKnownNicks] = useState<ReadonlySet<string>>(new Set())
  const knownNicks = stableNickSet(mentionColors, previousKnownNicks)
  if (knownNicks !== previousKnownNicks) setPreviousKnownNicks(knownNicks)

  // The current user's own occupant record (stable ref across presence churn unless
  // our own role/affiliation changes). Used per-row to compute moderation permission.
  const selfOccupant = useMemo(
    () => selectSelfOccupant(room.occupants, room.nickname),
    [room.occupants, room.nickname],
  )

  // Only an uncached first history fetch replaces the reading area.
  const isInitialLoading = selectRoomInitialLoading({
    joined: membershipPhase === 'joined',
    isCatchingUp: isCatchingUp ?? false,
    messageCount: loadedMessageCount,
  })
  const loadingState = isInitialLoading ? (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-fluux-muted">
      <Loader2 className="size-8 animate-spin text-fluux-brand" />
      <p>{t('chat.loadingMessages')}</p>
    </div>
  ) : null

  // Empty state: different for joined vs not joined
  const emptyState = (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted gap-3">
      {membershipPhase === 'not-joined' && (
        <div className="flex items-center gap-2 text-fluux-yellow mb-1">
          <AlertCircle className="size-4" />
          <span className="text-sm">{t('rooms.notJoinedNoHistory')}</span>
        </div>
      )}
      <div className="size-16 rounded-full bg-fluux-brand/10 border border-fluux-brand/25 flex items-center justify-center">
        <Hash className="size-7 text-fluux-brand" />
      </div>
      <p className="text-sm">{membershipPhase === 'joined' ? t('chat.noMessages') : membershipPhase === 'joining' ? t('rooms.noHistoryYet') : t('rooms.joinToLoadHistory')}</p>
      {membershipPhase === 'joined' && !isHistoryComplete && onScrollToTop && (
        <button
          type="button"
          onClick={() => onScrollToTop()}
          disabled={isLoadingOlder}
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg hover:text-fluux-text hover:bg-fluux-hover disabled:cursor-wait disabled:opacity-50"
        >
          {t('chat.loadEarlierMessages')}
        </button>
      )}
    </div>
  )

  // Extra content: cached history warning banner when not joined
  const extraContent = membershipPhase === 'not-joined' && messages.length > 0 ? (
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
  // props only for X's rows; every other row's shallow memo bails. The row never
  // sees `room` (a fresh Map ref every presence stanza), so unrelated presence
  // churn does not re-render it.
  // Clipboard metadata for a message, faithful to the row's resolvedSenderName so a
  // virtualized multi-message copy reconstructs identically from the array (see
  // MessageList formatMessageForCopy). Called only at copy time, so per-render cost is nil.
  const formatMessageForCopy = (msg: RoomMessage): CopyMessageMeta => ({
    id: msg.id,
    from: resolveRoomSender(msg, room, contactsByJid, selfOccupant).resolvedSenderName,
    time: formatTime(msg.timestamp),
    body: deriveCopyBody(msg, t),
    date: format(msg.timestamp, 'yyyy-MM-dd'),
  })

  // Use the media callback supplied by MessageList. It owns the controller-backed choice between
  // live-edge re-pin and fixed-anchor preservation; the former RoomView callback bypassed that
  // arbitration with a raw scrollTop write.
  const renderMessage = (
    msg: RoomMessage,
    idx: number,
    groupMessages: RoomMessage[],
    _showNewMarker: boolean,
    onMediaLoad: () => void,
  ) => {
    // System notices (e.g. nick changes) render as a centered line, not a bubble.
    if (msg.systemEvent) {
      return <RoomSystemLine event={msg.systemEvent} />
    }

    const sender = resolveRoomSender(msg, room, contactsByJid, selfOccupant)
    const rowId = messageRowId(msg) ?? msg.id
    const reactorDetails = Object.fromEntries(Object.values(msg.reactions ?? {}).flat().map((nick) => {
      const avatar = resolveRoomAvatar({ nick, isOwn: nick === room.nickname }, room, contactsByJid, ownAvatar)
      return [nick, { name: nick, avatarIdentifier: avatar.avatarIdentifier, avatarUrl: avatar.avatarUrl }]
    }))

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
      const replyOccupantId = messagesById.get(msg.replyTo.id)?.occupantId
      const ra = resolveReplyAvatar(
        replyNick,
        room,
        contactsByJid,
        room.nickname,
        ownAvatar,
        replyOccupantId,
      )
      replyAvatarUrl = ra.avatarUrl
      replyAvatarIdentifier = ra.avatarIdentifier
      replyBareJid = ra.senderBareJid
    }

    return (
      <RoomMessageBubbleWrapper
        peerReadMarkers={collectViews ? peerReadMarkers : undefined}
        message={msg}
        rowId={rowId}
        showAvatar={shouldShowAvatar(groupMessages, idx)}
        isGroupEnd={idx === groupMessages.length - 1 || shouldShowAvatar(groupMessages, idx + 1)}
        groupSecurityContext={groupMessages[groupHeaderIndex(groupMessages, idx)].securityContext}
        whisperThread={whisperThreadPosition(groupMessages, idx)}
        roomJid={room.jid}
        myNick={room.nickname}
        supportsReactions={room.supportsReactions !== false}
        supportsMAM={room.supportsMAM === true}
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
        reactorDetails={reactorDetails}
        knownNicks={knownNicks}
        contactsByJid={contactsByJid}
        mentionColors={mentionColors}
        ownAvatar={ownAvatar}
        sendReaction={sendReaction}
        votePoll={votePoll}
        closePoll={closePoll}
        isPollClosed={closedPollIds.has(rowId)}
        onReply={onReply}
        onEdit={onEdit}
        isLastOutgoing={rowId === lastOutgoingMessageId}
        isLastMessage={rowId === lastMessageId}
        hideToolbar={activeReactionPickerMessageId !== null && activeReactionPickerMessageId !== rowId}
        onReactionPickerChange={onReactionPickerChange}
        retractMessage={retractMessage}
        moderateMessage={moderateMessage}
        onModerateSender={onModerateSender}
        isSelected={rowId === selectedMessageId}
        hasKeyboardSelection={hasKeyboardSelection}
        showToolbarForSelection={showToolbarForSelection}
        isDarkMode={isDarkMode}
        onMediaLoad={onMediaLoad}
        isHovered={hoveredMessageId === rowId}
        onMouseEnter={handleMessageHover}
        onMouseLeave={handleMessageLeave}
        formatTime={formatTime}
        timeFormat={effectiveTimeFormat}
        onNickContextMenu={onNickContextMenu}
        onNickTouchStart={onNickTouchStart}
        onNickTouchEnd={onNickTouchEnd}
        setAffiliation={setAffiliation}
        highlightTerms={highlightTerms}
        isCurrentMatch={rowId === currentMatchId}
      />
    )
  }

  return (
    <MessageList
      // Remount the message view (fresh virtualizer + scroll refs) per room so no imperative
      // scroll state — the @tanstack virtualizer's measurement/offset cache above all — bleeds
      // between rooms. Restoration survives via scrollStateManager (keyed by room jid).
      key={room.jid}
      conversationId={room.jid}
      timeline={{
        messages,
        ingressVersion: messageIngressVersion,
        interiorPlacementVersion,
        history: {
          onLoadOlder: onScrollToTop,
          isLoadingOlder,
          isComplete: isHistoryComplete,
          unavailable: historyUnavailable,
          onLoadAround,
        },
        window: { atLiveEdge: windowAtLiveEdge, onLoadNewer, onJumpToLatest, onJumpToDate },
        gaps: { intervals: gaps, onCatchUp: onCatchUpHistory, isCatchingUp },
      }}
      readMarkers={{
        onFocusedVisibleRows: peerReadMarkers && collectViews ? rows => {
          // The shared observer orders these by their measured bottom edge.
          // Local read/MDS events and hydration never create viewing evidence.
          const incoming = rows.filter(row => !row.isOutgoing && !row.isPrivate && !row.systemEvent
            && !row.securityContext && !row.encryptedPayload && !row.unsupportedEncryption && !row.contentAvailability)
          const last = incoming.at(-1)
          if (last) void peerReadMarkers.viewed(room.jid, last).catch(() => {})
        } : undefined,
        firstNewRow: firstNewMessageRow,
        firstNewIsProvisional: firstNewMessageIsProvisional,
        firstNewCount: firstNewMessageCount,
        readPointerRow,
        unreadCount,
        onSeen: onMessageSeen,
        onClear: clearFirstNewMessageId,
        onLiveEdgeMeasured,
      }}
      target={{ id: targetMessageId, onConsumed: clearTargetMessageId }}
      handleRef={listHandleRef}
      typing={{ users: typingUsers }}
      renderMessage={renderMessage}
      formatMessageForCopy={formatMessageForCopy}
      lastSentMessageId={lastSentMessageId}
      loading={loadingState}
      emptyState={emptyState}
      extraContent={extraContent}
    />
  )
})

interface RoomMessageBubbleWrapperProps {
  peerReadMarkers?: RoomReadMarkers
  message: RoomMessage
  rowId: string
  showAvatar: boolean
  isGroupEnd: boolean
  /** Security context of this row's group header (see MessageBubble's groupSecurityContext). */
  groupSecurityContext?: RoomMessage['securityContext']
  whisperThread: WhisperThreadPosition | null
  // Per-row resolved sender data (resolved in the list layer from cheap Map lookups).
  // `occupant` is the live, reference-stable occupant record (roomStore.addOccupant
  // preserves unchanged refs); the rest are primitives. Passing these instead of `room`
  // is what lets the row memo bail on presence churn for unaffected occupants.
  roomJid: string
  myNick: string | undefined
  supportsReactions: boolean
  supportsMAM: boolean
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
  reactorDetails: Readonly<Record<string, ReactorDetails>>
  knownNicks: ReadonlySet<string>
  contactsByJid: Map<string, ContactIdentity>
  mentionColors: ReadonlyMap<string, string>
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
  onModerateSender?: (message: RoomMessage, reason?: string) => void
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
  peerReadMarkers,
  message,
  rowId,
  showAvatar,
  isGroupEnd,
  groupSecurityContext,
  whisperThread,
  roomJid,
  myNick,
  supportsReactions,
  supportsMAM,
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
  reactorDetails,
  knownNicks,
  contactsByJid,
  mentionColors,
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
  onModerateSender,
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

  const confirmModeration = () => {
    const stanzaId = getRoomModerationId(message)
    if (!canModerateMsg || message.roomJid !== roomJid || !stanzaId || message.isRetracted) return
    setShowModerateConfirm(false)
    const reason = moderateReason.trim() || undefined
    setModerateReason('')
    void moderateMessage(roomJid, stanzaId, reason)
    if (banAfterModerate && senderBareJidForBan) {
      void setAffiliation(roomJid, senderBareJidForBan, 'outcast', reason)
    }
    setBanAfterModerate(false)
  }

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
  // message only paginates in later. Uses the roomJid prop (the row never sees `room`).
  const replyTarget = useReferencedMessage({ type: 'groupchat', roomJid, id: message.replyTo?.id, from: message.replyTo?.to, cache: true })

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
        void votePoll(roomJid, archiveReference(message), emoji, myReactions, message.poll)
        return
      }
    }

    // Regular reaction toggle for non-poll emojis
    const newReactions = myReactions.includes(emoji)
      ? myReactions.filter(e => e !== emoji)
      : [...myReactions, emoji]

    sendReaction(roomJid, archiveReference(message), newReactions).then(() => iosHaptic('selection')).catch((e) => {
      if (e instanceof WhisperCounterpartGoneError) {
        addToast('info', t('rooms.whisperCounterpartGone', { nick: e.nick }))
        return
      }
      throw e
    })
  }

  // Handle poll vote — uses SDK vote() which enforces single/multi-vote rules
  const handlePollVote = message.poll ? (emoji: string) => {
    void votePoll(roomJid, archiveReference(message), emoji, myReactions, message.poll!, !!message.pollClosedAt)
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

  const getReactorName = (reactorId: string) => {
    const nick = reactorDetails[reactorId].name
    if (nick === myNick) return t('chat.you')
    return nick
  }

  // Build nick extras (affiliation badge and XEP-0317 hats)
  // Note: individual tooltips removed - all info is now in the unified avatar/name tooltip
  // Show affiliation (owner/admin) rather than role, consistent with the member list
  const readMarkerBadge = useMemo(() => peerReadMarkers && !message.isPrivate
    ? <RoomReadBadge markers={peerReadMarkers} roomJid={roomJid} row={{ id: message.id, occupantId: message.occupantId, stanzaId: message.stanzaId }} /> : undefined,
  [peerReadMarkers, roomJid, message.id, message.occupantId, message.stanzaId, message.isPrivate])

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
        groupSecurityContext={groupSecurityContext}
        isSelected={isSelected}
        hasKeyboardSelection={hasKeyboardSelection}
        showToolbarForSelection={showToolbarForSelection}
        hideToolbar={hideToolbar}
        isLastOutgoing={isLastOutgoing}
        isLastMessage={isLastMessage}
        isDarkMode={isDarkMode}
        isHovered={isHovered}
        onMouseEnter={() => onMouseEnter?.(rowId)}
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
        readMarkerBadge={readMarkerBadge}
        myReactions={myReactions}
        onReaction={supportsReactions ? handleReaction : undefined}
        getReactorName={getReactorName}
        getReactorDetails={(reactorId) => reactorDetails[reactorId]}
        canModerate={canModerateMsg}
        supportsMAM={supportsMAM}
        isIrcGateway={isIrcGateway}
        onReply={() => onReply(message)}
        onEdit={() => onEdit(message)}
        onDelete={async () => {
          if (message.isOutgoing) {
            setShowDeleteConfirm(true)
          } else if (canModerateMsg && getRoomModerationId(message)) {
            setShowModerateConfirm(true)
          }
        }}
        onMediaLoad={onMediaLoad}
        replyContext={replyContext}
        mentions={message.mentions}
        nickname={myNick}
        knownNicks={knownNicks}
        mentionColors={mentionColors}
        whisperWith={message.whisperWith}
        whisperThread={whisperThread}
        counterpartPresent={counterpartPresent}
        onNickContextMenu={!message.isOutgoing ? handleNickContextMenu : undefined}
        onNickTouchStart={!message.isOutgoing ? handleNickTouchStart : undefined}
        onNickTouchEnd={!message.isOutgoing ? onNickTouchEnd : undefined}
        onReactionPickerChange={(isOpen) => onReactionPickerChange?.(rowId, isOpen)}
        onPollVote={handlePollVote}
        onClosePoll={canClosePoll(message, isPollClosed) ? () => closePoll(roomJid, archiveReference(message)) : undefined}

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
            void retractMessage(roomJid, archiveReference(message))
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
            {onModerateSender && message.occupantId && getRoomModerationId(message) && (
              <button
                type="button"
                className="w-full px-3 py-2 mb-3 rounded-lg border border-fluux-brand text-fluux-brand text-sm text-start [overflow-wrap:anywhere] hover:bg-fluux-selection transition-colors"
                onClick={() => {
                  setShowModerateConfirm(false)
                  setModerateReason('')
                  setBanAfterModerate(false)
                  onModerateSender(message, moderateReason.trim() || undefined)
                }}
              >
                {t('rooms.bulkModerationSender', { nick: message.nick })}
              </button>
            )}
            <div className="mb-3 space-y-2">
              <SpamModerationOption reason={moderateReason} onChange={setModerateReason} />
              <div className="space-y-1">
                <label className="block text-sm font-medium text-fluux-text">{t('chat.moderateReason')}</label>
                <TextInput
                  type="text"
                  value={moderateReason}
                  onChange={(e) => setModerateReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmModeration()
                  }}
                  placeholder={t('chat.moderateReasonPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-fluux-bg border border-fluux-border rounded-lg text-fluux-text placeholder:text-fluux-muted"
                  autoFocus
                />
              </div>
            </div>
            {canBanUser && senderBareJidForBan && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={banAfterModerate}
                  onChange={(e) => setBanAfterModerate(e.target.checked)}
                  className="size-4 rounded border-fluux-border text-fluux-brand"
                />
                <span className="text-sm text-fluux-text">{t('chat.moderateAndBan')}</span>
              </label>
            )}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={close}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={confirmModeration}
                disabled={!canModerateMsg || !getRoomModerationId(message) || message.isRetracted}
                className="px-4 py-2 text-sm text-white bg-fluux-red hover:bg-[color-mix(in_srgb,var(--fluux-status-error),black_10%)] rounded-lg transition-colors"
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
}, (prev, next) => {
  const { reactorDetails: prevDetails, ...prevProps } = prev
  const { reactorDetails: nextDetails, ...nextProps } = next
  return shallow(prevProps, nextProps) && JSON.stringify(prevDetails) === JSON.stringify(nextDetails)
})

interface RoomMessageInputProps {
  onRegisterDraftResume?: RegisterDraftResume
  roomJid: string
  textareaRef?: React.RefObject<ComposerInputElement | null>
  sendMessage: (roomJid: string, body: string, options?: { replyTo?: { id: string; to: string; fallback?: { author: string; body: string } }; references?: MentionReference[]; attachment?: FileAttachment }) => Promise<string>
  sendCorrection: (roomJid: string, messageId: string, newBody: string, attachment?: FileAttachment) => Promise<void>
  retractMessage: (roomJid: string, messageId: string) => Promise<void>
  sendChatState: (roomJid: string, state: ChatStateNotification) => Promise<void>
  sendWhisperChatState: (roomJid: string, nick: string, state: ChatStateNotification) => Promise<void>
  sendEasterEgg: (roomJid: string, animation: string) => Promise<void>
  sendPoll: (roomJid: string, title: string, options: string[], settings?: Partial<import('@fluux/sdk').PollSettings>, description?: string, deadline?: string, customEmojis?: string[]) => Promise<string>
  replyingTo: RoomMessage | null
  onCancelReply: () => void
  editingMessage: RoomMessage | null
  onCancelEdit: () => void
  onEditLastMessage?: () => void
  onComposingChange?: (isComposing: boolean) => void
  uploadState?: { isUploading: boolean; progress: number; error: string | null; clearError: () => void }
  isUploadSupported?: boolean
  onFileSelect?: (file: File) => void
  uploadFile?: (file: File, options?: import('@/hooks/useFileUpload').FileUploadOptions) => Promise<FileAttachment | null>
  pendingAttachment?: PendingAttachment | null
  onRemovePendingAttachment?: () => void
  onChoosePhoto?: (mode: 'reduced' | 'original') => void
  processLinkPreview?: (messageId: string, body: string, to: string, type: 'chat' | 'groupchat') => Promise<void>
  isConnected: boolean
  onMessageIdSent?: (messageId: string) => void
  whisperTarget?: WhisperTarget | null
  onClearWhisper?: () => void
  sendWhisper: (roomJid: string, nick: string, body: string, options?: { attachment?: FileAttachment }) => Promise<string>
  /** Whether the app is in dark mode -- used to compute the per-person reply-chip color. */
  isDarkMode?: boolean
}

export const RoomMessageInput = memo(function RoomMessageInput(props: RoomMessageInputProps & { ref?: React.Ref<MessageComposerHandle> }) {
  // Public and private editors cannot share a buffer or a late failed-send recovery owner.
  const recipient = props.whisperTarget
  const identity = JSON.stringify([props.roomJid, recipient
    ? recipient.occupantId ? ['occupant-id', recipient.occupantId] : ['nickname', recipient.nick]
    : ['public']])
  return <RoomMessageInputContent key={identity} {...props} />
})

const RoomMessageInputContent = memo(function RoomMessageInputContent({
  onRegisterDraftResume,
  roomJid,
  textareaRef,
  sendMessage,
  sendCorrection,
  retractMessage,
  sendChatState,
  sendWhisperChatState,
  sendEasterEgg,
  sendPoll,
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
  onChoosePhoto,
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
  const { t, i18n } = useTranslation()
  // Narrow, reference-stable subscriptions: the composer re-renders on entity
  // changes (name/nickname) and occupant COUNT changes (join/leave), but NOT on
  // message churn nor on occupant metadata churn (show/avatar/presence flapping).
  const replySnapshots = useMemo(() => replyingTo ? [replyingTo] : [], [replyingTo])
  const [currentReplyTarget] = useRoomMessageSnapshots(roomJid, replySnapshots)
  const replyIsSpam = !!currentReplyTarget && isSpamModerated(currentReplyTarget)
  const activeReply = !replyIsSpam ? replyingTo : null
  useEffect(() => {
    if (replyIsSpam) onCancelReply()
  }, [replyIsSpam, onCancelReply])

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
  const ordinaryDraftOrigin = useRef({ account: getStorageScopeJid(), text: getDraft(roomJid), confirmed: !!roomStore.getState().ordinaryDrafts?.has(roomJid) })
  const getOrdinaryDraft = useCallback((jid: string, text: string) => {
    const origin = ordinaryDraftOrigin.current
    if (origin.account === getStorageScopeJid() && origin.text === text) return origin.confirmed
    const state = roomStore.getState()
    return state.getDraft(jid) === text && state.ordinaryDrafts?.has(jid) === true
  }, [])
  const markPublicEdit = (text: string) => {
    if (!whisperTarget && editingMessage?.roomJid !== roomJid) {
      ordinaryDraftOrigin.current = { account: getStorageScopeJid(), text, confirmed: true }
    }
  }
  const addToast = useToastStore((s) => s.addToast)
  const [showPollCreator, setShowPollCreator] = useState(false)

  // Reactive whisper-counterpart presence. The hook re-evaluates on every occupant
  // change — driving the "gone" banner and the disabled Send button while preserving
  // the typed draft. Called unconditionally (returns false when target is null).
  const counterpartPresent = useWhisperCounterpartPresent(roomJid, whisperTarget)
  const whisperCounterpartGone = !!whisperTarget && !counterpartPresent
  const [attachmentWarning, setAttachmentWarning] = useState(false)
  const warningResolve = useRef<((confirmed: boolean) => void) | null>(null)
  const whisperSendGeneration = useRef(0)
  // Private draft recovery expires on route exit, not attachment changes.
  const whisperDraftGeneration = useRef(0)
  useEffect(() => () => { whisperDraftGeneration.current += 1 }, [roomJid, whisperTarget])
  const currentWhisper = useRef(whisperTarget)
  currentWhisper.current = whisperTarget
  const currentAttachment = useRef(pendingAttachment)
  currentAttachment.current = pendingAttachment
  const currentRoomJid = useRef(roomJid)
  currentRoomJid.current = roomJid
  const supportsRetention = useConnectionStore(s => s.httpUploadService?.supportsRetention === true)
  useEffect(() => {
    setAttachmentWarning(false)
    return () => {
      whisperSendGeneration.current += 1
      warningResolve.current?.(false)
      warningResolve.current = null
    }
  }, [roomJid, whisperTarget, pendingAttachment])

  // Mention state
  const [cursorPosition, setCursorPosition] = useState(0)
  // Only an editor edit opens mentions. Bind its caret to that exact text so a
  // restored/prefilled draft or a later selection report cannot become a query.
  const [mentionInput, setMentionInput] = useState<{ text: string; position: number } | null>(null)
  const composerRef = useRef<MessageComposerHandle>(null)

  // Forward ref to parent for focus after staging attachment
  React.useImperativeHandle(ref, () => ({
    focus: () => composerRef.current?.focus(),
    getText: () => composerRef.current?.getText() || '',
    setText: (t: string) => composerRef.current?.setText(t),
    placeCaret: (t: string, position: number) => composerRef.current?.placeCaret(t, position),
  }), [])

  // Stable callback for draft restoration (resets mention references)
  // (The references hook needs the draft's setter, which needs this callback.)
  const clearReferencesRef = useRef<() => void>(() => {})
  const handleDraftRestored = useCallback(() => clearReferencesRef.current(), [])

  const mentionRecovery = useRef<{
    references: MentionReference[]
    restore: (text: string, references: MentionReference[]) => void
  }>({ references: [], restore: () => {} })

  // A reopened room has no private recipient; its private buffer has no durable draft operations.
  const whisperDraftOperations = useMemo(() => ({
    owner: {},
    getDraft: (_roomJid: string) => '',
    setDraft: (_roomJid: string, _text: string) => {},
    clearDraft: (_roomJid: string) => {},
  }), [])

  // The current mounted room owns both recovered text and its mention metadata.
  const [text, setText, consumeDraft, discardDraft, restoreMessageDraft] = useConversationDraft({
    conversationId: roomJid,
    draftOperations: whisperTarget ? whisperDraftOperations : { owner: roomStore, getDraft, setDraft, clearDraft, getOrdinary: getOrdinaryDraft },
    composerRef,
    onDraftRestored: handleDraftRestored,
    editingConversationId: editingMessage?.roomJid,
    getReferences: () => mentionRecovery.current.references,
    onDraftRecovered: (text, references, ordinary) => {
      ordinaryDraftOrigin.current = { account: getStorageScopeJid(), text, confirmed: ordinary === true }
      mentionRecovery.current.restore(text, references)
    },
  })

  // External writes (including Send clearing the box) end the typing session.
  // Merely hiding a mismatched snapshot would revive it if recovery or editing
  // later restored the same text.
  if (mentionInput && mentionInput.text !== text) setMentionInput(null)

  const { references, setReferences, handleEditorEdit, handleValueChange, insertMention, restoreReferences } = useMentionReferences(setText)
  mentionRecovery.current = { references, restore: restoreReferences }
  clearReferencesRef.current = () => setReferences([])

  // Discard the private buffer before restoring the room's independent ordinary draft.
  // Private text is never converted into a public message (XEP-0045 §7.5).
  const handleClearWhisper = () => {
    whisperDraftGeneration.current += 1
    discardDraft()
    onClearWhisper?.()
  }

  useDraftResumeTarget(onRegisterDraftResume, 'room', roomJid,
    whisperTarget ? 'whisper' : editingMessage?.roomJid === roomJid ? 'edit' : null,
    whisperTarget ?? (editingMessage?.roomJid === roomJid ? editingMessage : null),
    () => {
      if (whisperTarget) {
        const state = roomStore.getState()
        if (!state.ordinaryDrafts?.has(roomJid) || !state.getDraft(roomJid).trim()) return false
        handleClearWhisper()
        onCancelEdit()
        return true
      }
      if (!restoreMessageDraft()) return false
      onCancelEdit()
      return true
    })

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

  // Collect mention-candidate nicks (occupants + history authors + affiliated
  // members). Read NON-reactively from the store on each render: subscribing to
  // the room's message window would re-render the composer on every message.
  // Recomputed each render so it stays fresh while typing, without a
  // subscription. (Do not memoize on [roomJid] — that would freeze the set at
  // room-entry and miss later authors.)
  const messageNicks = (() => {
    const nicks = new Set<string>()
    const rs = roomStore.getState()
    for (const msg of rs.messages.get(roomJid) ?? []) nicks.add(msg.nick)
    for (const member of rs.getRoom(roomJid)?.affiliatedMembers ?? []) {
      if (member.nick) nicks.add(member.nick)
    }
    return nicks
  })()

  // Mention autocomplete hook
  const { state: mentionState, selectMatch, moveSelection, dismiss } = useMentionAutocomplete(
    text,
    mentionInput?.text === text ? mentionInput.position : null,
    occupants,
    roomNickname,
    roomJid,
    messageNicks,
    references
  )
  const mentionListboxId = `${useId()}-mention-autocomplete`

  // Handle mention selection
  const handleMentionSelect = (index: number) => {
    const { newText, newCursorPosition, reference } = selectMatch(index)
    markPublicEdit(newText)
    insertMention(newText, reference)
    // Restores focus, drops the caret after the mention rather than at the end
    // of the message, and reports the new position back for the next lookup.
    composerRef.current?.placeCaret(newText, newCursorPosition)
  }

  // Auto-focus composer when starting a reply
  useEffect(() => {
    if (replyingTo) {
      setTimeout(() => composerRef.current?.focus(), 0)
    }
  }, [replyingTo])

  // Convert RoomMessage to ReplyInfo for the composer
  const replyInfo: ReplyInfo | null = activeReply
    ? {
        id: archiveReference(activeReply),
        from: activeReply.from,
        senderName: activeReply.nick,
        body: activeReply.body,
        senderColor: auroraSenderColor(nickColorSeed({ occupantId: activeReply.occupantId, nick: activeReply.nick }), isDarkMode ?? true),
      }
    : null

  // Convert RoomMessage to EditInfo for the composer
  const editInfo: EditInfo | null = editingMessage?.roomJid === roomJid
    ? {
        id: editingMessage.id,
        ...editableForward(editingMessage),
        attachment: editingMessage.attachment,
      }
    : null

  // Handle correction
  const handleCorrection = async (messageId: string, newBody: string, attachment?: import('@fluux/sdk').FileAttachment): Promise<boolean> => {
    try {
      await sendCorrection(roomJid, editingMessage ? senderReference(editingMessage) : messageId, newBody, attachment)
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
      await retractMessage(roomJid, editingMessage ? archiveReference(editingMessage) : messageId)
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
    const sendingAccount = getStorageScopeJid()
    const sendingGeneration = whisperSendGeneration.current
    // Private sends preserve the room/nick route and skip public link previews.
    if (whisperTarget) {
      // Hard backstop: re-check presence against the LIVE occupant list (not the
      // closed-over prop) so we cover the gap between the counterpart leaving and
      // React re-rendering the disabled Send button. Resolve the captured person
      // to their current nick so recycling the old nick cannot redirect the send.
      const liveOccupants = roomStore.getState().getRoom(roomJid)?.occupants ?? occupants
      const decision = decideWhisperSend(whisperTarget, sendText, liveOccupants, !!pendingAttachment)
      if (!decision.ok) {
        if (decision.reason === 'counterpart-gone') {
          addToast('info', t('rooms.whisperCounterpartGone', { nick: decision.nick }))
        }
        return false
      }
      let attachment: FileAttachment | null | undefined
      let appliedRetentionSeconds: number | undefined
      const stillCurrent = () => whisperSendGeneration.current === sendingGeneration
        && getStorageScopeJid() === sendingAccount
        && currentRoomJid.current === roomJid && currentWhisper.current === whisperTarget
        && currentAttachment.current === pendingAttachment
      if (pendingAttachment) {
        if (!uploadFile) return false
        const confirmed = await new Promise<boolean>(resolve => {
          warningResolve.current = resolve
          setAttachmentWarning(true)
        })
        warningResolve.current = null
        setAttachmentWarning(false)
        if (!confirmed || !stillCurrent()) {
          if (stillCurrent()) setTimeout(() => composerRef.current?.focus(), 0)
          return false
        }
        const beforeUpload = decideWhisperSend(whisperTarget, decision.body,
          roomStore.getState().getRoom(roomJid)?.occupants ?? EMPTY_OCCUPANTS, true)
        if (!beforeUpload.ok) return false
        attachment = await uploadFile(pendingAttachment.file, {
          suggestedRetentionSeconds: 86400,
          onRetentionApplied: seconds => { appliedRetentionSeconds = seconds },
        })
        if (!attachment || !stillCurrent()) return false
      }
      if (!stillCurrent()) return false
      const finalDecision = decideWhisperSend(whisperTarget, decision.body,
        roomStore.getState().getRoom(roomJid)?.occupants ?? EMPTY_OCCUPANTS, !!attachment)
      if (!finalDecision.ok) {
        if (finalDecision.reason === 'counterpart-gone') {
          addToast('info', t('rooms.whisperCounterpartGone', { nick: finalDecision.nick }))
        }
        return false
      }
      const body = sendText.trim() || attachment?.url || decision.body
      const messageId = attachment
        ? await sendWhisper(roomJid, finalDecision.nick, body, { attachment })
        : await sendWhisper(roomJid, finalDecision.nick, body)
      if (attachment) {
        const hours = appliedRetentionSeconds !== undefined && appliedRetentionSeconds % 3600 === 0
        const duration = appliedRetentionSeconds === undefined ? undefined
          : new Intl.NumberFormat(i18n.resolvedLanguage, { style: 'unit', unit: hours ? 'hour' : 'second', unitDisplay: 'short' })
            .format(hours ? appliedRetentionSeconds / 3600 : appliedRetentionSeconds)
        addToast('info', supportsRetention && duration
          ? t('rooms.whisperAttachmentRetention', { duration })
          : t('rooms.whisperAttachmentWarning'))
        onRemovePendingAttachment?.()
      }
      onMessageIdSent?.(messageId)
      setTimeout(() => clearFirstNewMessageId(roomJid), 500)
      return true
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

    if (getStorageScopeJid() !== sendingAccount) return false
    const sendReply = replyingTo ? await resolveRoomMessageSnapshot(replyingTo) : undefined
    const sendReplyIsSpam = !!sendReply && isSpamModerated(sendReply)
    // Include reply info if replying to a message
    // SDK resolves stanzaId vs id for the protocol reference (XEP-0461)
    let replyTo: { id: string; stanzaId?: string; to: string; fallback?: { author: string; body: string } } | undefined
    if (sendReply && !sendReplyIsSpam) {
      replyTo = {
        id: sendReply.id,
        stanzaId: sendReply.stanzaId,
        to: sendReply.from,
        fallback: { author: sendReply.nick, body: replyingTo!.body }
      }
    }

    // The body is the file URL if no text was entered, otherwise the user's text
    const body = sendText || attachment?.url || ''
    const messageId = await sendMessage(roomJid, body, { replyTo, references: references.length > 0 ? references : undefined, attachment: attachment ?? undefined })
    void donateIOSConversation(sendingAccount, roomJid, 'groupchat')
    // The composer cleared the submitted references with the text.

    // Notify parent of sent message ID for animation
    onMessageIdSent?.(messageId)

    // Clear pending attachment after sending
    if (pendingAttachment) {
      onRemovePendingAttachment?.()
    }

    // The composer consumed this draft before sending; do not clear a newer draft.

    // Whisper sends return early above, so a private URL never reaches link-preview generation (no room broadcast).
    // Process link preview in background (don't block on it)
    if (processLinkPreview && sendText) {
      processLinkPreview(messageId, sendText, roomJid, 'groupchat').catch(console.error)
    }

    // Send active state after message (for small rooms)
    if (shouldSendTypingNotifications) {
      void sendChatState(roomJid, 'active')
    }

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

  // handleValueChange and draft recovery update text and references together.
  // An empty-text effect here would erase metadata restored during mounting.

  // Mention autocomplete dropdown
  const isMentionListboxOpen = mentionState.isActive && mentionState.matches.length > 0
  const mentionDropdown = isMentionListboxOpen ? (
    <MentionAutocompleteMenu
      id={mentionListboxId}
      matches={mentionState.matches}
      totalMatches={mentionState.totalMatches}
      selectedIndex={mentionState.selectedIndex}
      navSerial={mentionState.navSerial}
      onSelect={handleMentionSelect}
    />
  ) : null

  const handleCommandSelect = (index: number) => {
    const command = commandMenu.state.matches[index]
    if (!command) return
    const value = `/${command.name} `
    markPublicEdit(value)
    setText(value)
    commandMenu.dismiss()
  }

  // Popovers rendered above the composer, in priority order: help panel, then
  // command completion menu, then the mention dropdown.
  const aboveInputNode = helpOpen ? (
    <CommandHelpPanel commands={visibleCommands('room', commandSelf)} onClose={() => setHelpOpen(false)} />
  ) : commandMenu.state.isActive ? (
    <CommandMenu
      matches={commandMenu.state.matches}
      selectedIndex={commandMenu.state.selectedIndex}
      navSerial={commandMenu.state.navSerial}
      onSelect={handleCommandSelect}
      onDismiss={commandMenu.dismiss}
    />
  ) : (
    mentionDropdown
  )

  // Custom input renderer: the single-layer editor, which colours mentions in
  // the same element that holds the caret.
  const renderMentionInput = ({ mergedRef, value, onChange, onKeyDown: baseKeyDown, onSelect, onPaste, placeholder, ariaProps }: {
    mergedRef: (node: ComposerInputElement | null) => void
    value: string
    onChange: (e: ComposerChangeEvent) => void
    onKeyDown: (e: React.KeyboardEvent<ComposerInputElement>) => void
    onSelect?: (e: ComposerSelectEvent) => void
    onPaste?: (e: React.ClipboardEvent<HTMLElement>) => void
    placeholder: string
    ariaProps: ComposerAutocompleteAriaProps
  }) => {
    // While the mention list owns the overlay slot the composer's own emoji
    // completion is suppressed, so its aria props describe a closed popup.
    // Announce the list the user can actually see instead.
    const inputAriaProps = isMentionListboxOpen
      ? composerAutocompleteAriaProps({
          label: placeholder,
          listboxId: mentionListboxId,
          isOpen: true,
          activeOptionKey: mentionState.matches[mentionState.selectedIndex]?.nick,
        })
      : ariaProps

    // Keyboard handling for the completion menus. Backspace/Delete need nothing
    // here: a mention is one unit of the editor, so it goes in one keystroke.
    const handleKeyDown = (e: KeyboardEvent) => {
      const enterSelectsSuggestion = e.key === 'Enter' && !usesMobileEnterKey()

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
        if (enterSelectsSuggestion || e.key === 'Tab') {
          e.preventDefault()
          handleCommandSelect(commandMenu.state.selectedIndex)
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
        if (enterSelectsSuggestion || e.key === 'Tab') {
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
      baseKeyDown(e as unknown as React.KeyboardEvent<ComposerInputElement>)
    }

    return (
      <RoomComposerEditor
        value={value}
        references={references}
        placeholder={placeholder}
        ariaProps={inputAriaProps}
        mergedRef={mergedRef}
        onEdit={(text, references) => {
          markPublicEdit(text)
          handleEditorEdit(text, references)
        }}
        onChange={(e) => {
          setMentionInput({ text: e.target.value, position: e.target.selectionStart })
          onChange(e)
        }}
        onSelect={(e) => {
          const { value: selectedText, selectionStart: position, selectionEnd } = e.currentTarget
          // A duplicate report for the edit's own collapsed caret is not a new move.
          setMentionInput(previous =>
            previous?.text === selectedText && previous.position === position && position === selectionEnd
              ? previous
              : null
          )
          onSelect?.(e)
        }}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
      />
    )
  }

  return (
    <div
      onKeyDownCapture={(e) => {
        if (whisperTarget && e.key === 'Escape' && !attachmentWarning) {
          e.preventDefault()
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
      {attachmentWarning && (
        <ConfirmDialog
          title={t('rooms.whisperAttachmentTitle')}
          message={t('rooms.whisperAttachmentWarning')}
          confirmLabel={t('rooms.sendPrivateMessage')}
          variant="warning"
          onConfirm={() => warningResolve.current?.(true)}
          onCancel={() => warningResolve.current?.(false)}
        />
      )}
      <MessageComposer
        onExplicitTextEdit={markPublicEdit}
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
        onConsumeDraft={() => {
          const privateGeneration = whisperDraftGeneration.current
          // Validate again when a held failure is applied after an edit/remount.
          return consumeDraft(() => !whisperTarget || whisperDraftGeneration.current === privateGeneration)
        }}
        onSend={(sendText) => trackSend(handleSend(sendText))}
        onSendEasterEgg={(animation) => sendEasterEgg(roomJid, animation)}
        onCreatePoll={() => setShowPollCreator(true)}
        onSendTypingState={handleTypingState}
        typingNotificationsEnabled={shouldSendTypingNotifications}
        renderInput={renderMentionInput}
        aboveInput={aboveInputNode}
        hasExternalOverlay={aboveInputNode !== null}
        resolveInput={resolveInput}
        classifyInput={classifyInput}
        commandsEnabled={!whisperTarget}
        value={text}
        onValueChange={handleValueChange}
        onSelectionChange={setCursorPosition}
        onFileSelect={onFileSelect}
        uploadState={uploadState}
        isUploadSupported={isUploadSupported}
        pendingAttachment={pendingAttachment}
        onRemovePendingAttachment={onRemovePendingAttachment}
        onChoosePhoto={onChoosePhoto}
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

/** Noninteractive replacement for the composer until membership is confirmed. */
function RoomJoiningPanel() {
  const { t } = useTranslation()
  return (
    <div className="p-4 pb-safe border-t border-fluux-hover">
      <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-fluux-bg/50 border border-fluux-hover text-fluux-muted text-sm">
        <Loader2 aria-hidden="true" className="size-4 text-fluux-brand animate-spin motion-reduce:animate-none" />
        <span>{t('rooms.joining')}</span>
      </div>
    </div>
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
        type="button"
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
