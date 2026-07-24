import React, { useState, useRef, useEffect, useCallback, useMemo, useImperativeHandle, memo, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import type { CopyMessageMeta } from '@/utils/buildCopyText'
import { useChatActive, useContactIdentities, useReferencedMessage, getBareJid, getLocalPart, getMyReactions, useXMPPContext, chatStore, type Message, type ContactIdentity } from '@fluux/sdk'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useToastStore } from '@/stores/toastStore'
import { useConversationPlaintextOverrideStore } from '@/stores/conversationPlaintextOverrideStore'
import { VerifyPeerDialog } from './VerifyPeerDialog'
import { useConnectionStore } from '@fluux/sdk/react'
import { useFileUpload, useLinkPreview, useTypeToFocus, useMessageCopy, useMode, useMessageSelection, useMessageHoverState, useDragAndDrop, useConversationDraft, useTimeFormat } from '@/hooks'
import { Upload, Loader2 } from 'lucide-react'
import { MessageBubble, MessageList as MessageListComponent, shouldShowAvatar, ownGroupKey as computeOwnGroupKey, buildReplyContext } from './conversation'
import { FindOnPageBar } from './conversation/FindOnPageBar'
import { useFindOnPage, type FindOnPageHandle } from '@/hooks/useFindOnPage'
import { useConversationEncryptionState, type ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { useWebUnlockDialogStore } from '@/stores/webUnlockDialogStore'
import { EasterEggAnimation } from './easter-eggs/EasterEggAnimation'
import { ChatHeader } from './ChatHeader'
import { MessageComposer, type ReplyInfo, type EditInfo, type MessageComposerHandle, type PendingAttachment } from './MessageComposer'
import { useSlashCommands } from '@/hooks/useSlashCommands'
import { visibleCommands } from '@/commands/registry'
import { CommandHelpPanel } from './composer/CommandHelpPanel'
import type { CommandContext } from '@/commands/types'
import { findLastEditableMessage, findLastEditableMessageId } from '@/utils/messageUtils'
import { isEncryptedSource } from '@/utils/replyEncryption'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'
import { ConfirmDialog } from './ConfirmDialog'
import { MediaAutoloadProvider } from '@/contexts'
import { computeMediaAutoload } from '@/utils/mediaAutoload'
import { useSettingsStore } from '@/stores/settingsStore'
import { auroraSenderColor } from '@/utils/senderColor'
import { registerViewportBottomRef } from '@/utils/viewportAtBottom'
import { ReactionMentions } from './conversation/ReactionMentions'
import { reactionMentionStore } from '@/stores/reactionMentionStore'
import { EasterEggMentions } from './conversation/EasterEggMentions'
import { easterEggMentionStore } from '@/stores/easterEggMentionStore'

interface ChatViewProps {
  onBack?: () => void
  onSwitchToMessages?: (conversationId: string) => void
  onSearchInConversation?: (conversationId: string) => void
  /** Open the contact management screen for the given JID. 1:1 chats only. */
  onShowProfile?: (jid: string) => void
  // Focus zone refs for Tab cycling
  mainContentRef?: RefObject<HTMLElement | null>
  composerRef?: RefObject<HTMLElement | null>
  /** Ref for find-on-page handle (toggle, navigate from parent shortcuts) */
  findOnPageRef?: RefObject<FindOnPageHandle | null>
}

export function ChatView({ onBack, onSwitchToMessages, onSearchInConversation, onShowProfile, mainContentRef, composerRef, findOnPageRef }: ChatViewProps) {
  detectRenderLoop('ChatView')
  const { t } = useTranslation()
  // Use useChatActive instead of useChat to avoid subscribing to the conversation list.
  // This prevents re-renders during background MAM sync of other conversations.
  const { activeConversation, firstNewMessageId, firstNewMessageIsProvisional, readPointerId, activeMessages, activeTypingUsers, sendMessage, sendReaction, sendCorrection, retractMessage, retryMessage, sendChatState, isArchived, archiveConversation, unarchiveConversation, setDraft, getDraft, clearDraft, activeAnimation, sendEasterEgg, clearAnimation, clearFirstNewMessageId, resyncDividerToReadPointer, advanceReadPointer, activeMAMState, fetchOlderHistory, loadMessagesAround, loadNewer, recenterToLatest, windowAtLiveEdge, continueChatCatchUp, targetMessageId, clearTargetMessageId } = useChatActive()
  // Use useContactIdentities instead of useRoster() to avoid re-renders on
  // presence changes. ChatView only needs contact names and avatars for display.
  const contactsByJid = useContactIdentities()
  const mediaPolicy = useSettingsStore((s) => s.mediaAutoDownload)
  // NOTE: Use focused selectors instead of useConnection() hook to avoid
  // re-renders when unrelated connection state changes (error, reconnectAttempt, etc.)
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const status = useConnectionStore((s) => s.status)
  const isConnected = status === 'online'
  const { uploadFile, isUploading, progress, isSupported, error: uploadError, clearError: clearUploadError } = useFileUpload()
  const { processMessageForLinkPreview } = useLinkPreview()
  const { resolvedMode } = useMode()
  const myBareJid = jid ? getBareJid(jid) : undefined

  // Reply state - which message are we replying to
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)

  // Edit state - which message are we editing
  const [editingMessage, setEditingMessage] = useState<Message | null>(null)

  // Pending attachment state - staged file ready to send with next message
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null)

  // Track last sent message ID for send animation
  const [lastSentMessageId, setLastSentMessageId] = useState<string | null>(null)
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)


  // Find the last outgoing message ID for edit button visibility (skip retracted)
  const lastOutgoingMessageId = findLastEditableMessageId(activeMessages)

  // Last message ID - reply button is disabled for last message (context is already clear)
  const lastMessageId = activeMessages.length > 0 ? activeMessages[activeMessages.length - 1].id : null

  // Handler to open search scoped to this conversation
  const handleSearchInConversation = activeConversation && onSearchInConversation
    ? () => onSearchInConversation(activeConversation.id)
    : undefined

  // Latest messages in a ref so the stable callbacks below don't close over
  // `activeMessages` (which changes on every incoming message). This keeps the
  // props passed to the memoized MessageInput referentially stable, so the
  // composer no longer re-renders once per message (RenderLoopDetector warning).
  const activeMessagesRef = useRef(activeMessages)
  activeMessagesRef.current = activeMessages

  // Handler to edit the last outgoing message (triggered by Up arrow in empty composer)
  const handleEditLastMessage = useCallback(() => {
    const msg = findLastEditableMessage(activeMessagesRef.current)
    if (msg) {
      setEditingMessage(msg)
    }
  }, [])

  // Composing state - hides message toolbars when user is typing
  const [isComposing, setIsComposing] = useState(false)

  // Track which message has reaction picker open (hides other toolbars)
  const [activeReactionPickerMessageId, setActiveReactionPickerMessageId] = useState<string | null>(null)

  // Callbacks for child components (stable identities for the memoized MessageInput)
  const handleCancelReply = useCallback(() => setReplyingTo(null), [])
  const handleCancelEdit = useCallback(() => setEditingMessage(null), [])
  // Stable identity so it does not break the memo bailout of every message row.
  const handleReactionPickerChange = useCallback((messageId: string, isOpen: boolean) => {
    setActiveReactionPickerMessageId(isOpen ? messageId : null)
  }, [])

  // Upload state object — memoized so it stays referentially stable between
  // renders when no upload is in progress, preventing the memoized MessageInput
  // from re-rendering on every ChatView render.
  const uploadStateObj = useMemo(
    () => ({ isUploading, progress, error: uploadError, clearError: clearUploadError }),
    [isUploading, progress, uploadError, clearUploadError],
  )

  // Composer handle ref for type-to-focus (separate from focus zone ref)
  const composerHandleRef = useRef<MessageComposerHandle>(null)

  // Type-to-focus: auto-focus composer when user starts typing anywhere
  useTypeToFocus(composerHandleRef)

  // Find on page: browser-style search within this conversation
  const find = useFindOnPage(activeMessages, activeConversation?.id)

  // Expose find-on-page handle to parent for keyboard shortcuts
  useImperativeHandle(findOnPageRef, () => ({
    open: find.open,
    close: find.close,
    isOpen: find.isOpen,
    goToNext: find.goToNext,
    goToPrev: find.goToPrev,
  }), [find.open, find.close, find.isOpen, find.goToNext, find.goToPrev])

  // Scroll ref for programmatic scrolling and keyboard navigation
  const scrollRef = useRef<HTMLElement>(null)
  const isAtBottomRef = useRef(true)

  // Publish the viewport-at-bottom truth so the global focus handler can tell a
  // genuine "user is looking at the newest message" from a view merely parked at
  // the live edge (issue #1076). Registers the ref object, so the scroll hook's
  // many writes to `.current` need no notification.
  useEffect(() => {
    const id = activeConversation?.id
    if (!id) return
    return registerViewportBottomRef('conversation', id, isAtBottomRef)
  }, [activeConversation?.id])

  // Scroll to bottom (used after sending a message)
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [])

  // Stable handler for the send-animation: clears the highlight after 400 ms.
  const handleMessageIdSent = useCallback((id: string) => {
    if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current)
    setLastSentMessageId(id)
    lastSentTimerRef.current = setTimeout(() => setLastSentMessageId(null), 400)
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
    onEnterPressed: (id: string) => useExpandedMessagesStore.getState().toggle(id),
    onKeyboardNavigate: () => { isAtBottomRef.current = false },
  })

  // Format copied messages with sender headers
  useMessageCopy(scrollRef)

  // Reply targets are resolved reactively per-row via useReferencedMessage (in
  // ChatMessageBubble), so this view no longer holds a render-time lookup map — a
  // value derived from one froze inside the memoized row when the quoted message
  // only loaded later. Store subscription = reactive, no freeze.

  // Track pendingAttachment in a ref for cleanup (not a trigger)
  const pendingAttachmentRef = useRef(pendingAttachment)
  pendingAttachmentRef.current = pendingAttachment

  // Clear reply/edit/pending attachment state when conversation changes
  // Note: scroll position is managed by MessageList component
  useEffect(() => {
    return () => {
      // Clear stale reaction mentions when leaving a conversation
      if (activeConversation?.id) {
        reactionMentionStore.getState().clearConversation(activeConversation.id)
      }
    }
  }, [activeConversation?.id])

  // Auto-play a pending easter egg once when its conversation opens. The chip
  // stays (via EasterEggMentions) as a Replay control until dismissed.
  useEffect(() => {
    const id = activeConversation?.id
    if (!id) return
    const egg = easterEggMentionStore.getState().mentions.get(id)
    if (egg && !egg.played) {
      chatStore.getState().triggerAnimation(id, egg.animation, egg.senderName)
      easterEggMentionStore.getState().markPlayed(id)
    }
  }, [activeConversation?.id])

  useEffect(() => {
    setReplyingTo(null)
    setEditingMessage(null)
    // Revoke old preview URL to avoid memory leaks
    if (pendingAttachmentRef.current?.previewUrl) {
      URL.revokeObjectURL(pendingAttachmentRef.current.previewUrl)
    }
    setPendingAttachment(null)
    clearSelection()
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

  // Handle reply button click - set reply state and focus composer.
  // Stable identity so it does not break the memo bailout of every message row.
  const handleReply = useCallback((message: Message) => {
    setReplyingTo(message)
    // Focus composer so user can start typing immediately
    setTimeout(() => composerHandleRef.current?.focus(), 0)
  }, [])

  const conversationId = activeConversation?.id
  const handleClearFirstNewMessageId = () => {
    if (conversationId) {
      clearFirstNewMessageId(conversationId)
    }
  }

  const handleResyncDivider = useCallback(
    (conversationId: string) => resyncDividerToReadPointer(conversationId),
    [resyncDividerToReadPointer],
  )

  // Viewport observer callback: update readPointerId as user scrolls
  const handleMessageSeen = (messageId: string) => {
    if (conversationId) {
      advanceReadPointer(conversationId, messageId)
    }
  }

  // E2EE: encryption status displayed as an icon in the chat header.
  // Hooks must run before the early return below.
  const encryptionState = useConversationEncryptionState(
    activeConversation?.type === 'chat' ? (activeConversation.id ?? null) : null,
    activeConversation?.type ?? 'chat',
  )
  const { client } = useXMPPContext()
  const setPeerVerified = useVerifiedPeerKeysStore((s) => s.setVerified)
  const clearPeerVerified = useVerifiedPeerKeysStore((s) => s.clearVerified)
  const addToast = useToastStore((s) => s.addToast)
  const setForcedPlaintext = useConversationPlaintextOverrideStore((s) => s.setForcedPlaintext)
  const [verifyDialogState, setVerifyDialogState] = useState<
    | { open: false }
    | { open: true; peerJid: string; peerFingerprint: string; ownFingerprint: string | null }
  >({ open: false })
  const handleOpenVerify = useCallback(() => {
    if (activeConversation?.type !== 'chat' || !activeConversation?.id) return
    // Open the verify dialog for both encrypted (verify current key) and blocked
    // (verify the new advertised key so encryption can resume).
    const peerFingerprint =
      encryptionState.kind === 'encrypted'
        ? encryptionState.fingerprint
        : encryptionState.kind === 'blocked'
          ? encryptionState.advertisedFingerprint
          : null
    if (!peerFingerprint) return
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { getOwnFingerprint?: () => string | null }
      | null
      | undefined
    setVerifyDialogState({
      open: true,
      peerJid: activeConversation.id,
      peerFingerprint,
      ownFingerprint: plugin?.getOwnFingerprint?.() ?? null,
    })
  }, [client, activeConversation, encryptionState])
  const handleVerifyConfirm = useCallback(
    (fingerprint: string) => {
      if (!verifyDialogState.open) return
      setPeerVerified(verifyDialogState.peerJid, fingerprint)
      setVerifyDialogState({ open: false })
      addToast('success', t('chat.verifyPeer.confirmSuccess'))
    },
    [verifyDialogState, setPeerVerified, addToast, t],
  )

  const handleDisableEncryption = useCallback(() => {
    if (activeConversation?.type !== 'chat' || !activeConversation?.id) return
    const jid = activeConversation.id
    setForcedPlaintext(jid, true)
    client.e2ee?.setForcedPlaintext({ kind: 'direct', peer: jid }, true)
  }, [activeConversation, setForcedPlaintext, client])

  const handleEnableEncryption = useCallback(() => {
    if (activeConversation?.type !== 'chat' || !activeConversation?.id) return
    const jid = activeConversation.id
    setForcedPlaintext(jid, false)
    client.e2ee?.setForcedPlaintext({ kind: 'direct', peer: jid }, false)
    client.e2ee?.invalidateCapability(jid)
  }, [activeConversation, setForcedPlaintext, client])

  if (!activeConversation) return null

  // Get contact for 1:1 chats
  const contact = activeConversation.type === 'chat'
    ? contactsByJid.get(activeConversation.id)
    : undefined

  // 1:1 media trust: a peer absent from the roster contacts map is a stranger
  // (matches the SDK's roster.hasContact stranger definition). Strangers never
  // auto-load, regardless of policy. ChatView only renders type==='chat'
  // conversations; were a non-1:1 peer ever to reach here it would be absent
  // from the contacts map and so fail safe to 'direct-stranger' (deferred).
  const mediaAutoLoad = computeMediaAutoload(
    mediaPolicy,
    contactsByJid.has(activeConversation.id) ? 'direct-contact' : 'direct-stranger',
  )

  return (
    <div
      className="flex flex-col h-full min-h-0 relative"
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

      {/* Header */}
      <ChatHeader
        name={activeConversation.name}
        type={activeConversation.type}
        contact={contact}
        jid={activeConversation.id}
        onBack={onBack}
        onSearchInConversation={handleSearchInConversation}
        encryptionState={encryptionState}
        onEncryptionClick={encryptionState.kind === 'encrypted' || encryptionState.kind === 'blocked' ? handleOpenVerify : undefined}
        onDisableEncryptionClick={encryptionState.kind === 'encrypted' ? handleDisableEncryption : undefined}
        onEnableEncryptionClick={encryptionState.kind === 'plaintextForced' ? handleEnableEncryption : undefined}
        onShowProfile={
          activeConversation.type === 'chat' && onShowProfile
            ? () => onShowProfile(activeConversation.id)
            : undefined
        }
        isArchived={activeConversation.type === 'chat' ? isArchived(activeConversation.id) : undefined}
        onArchive={
          activeConversation.type === 'chat'
            ? () => archiveConversation(activeConversation.id)
            : undefined
        }
        onUnarchive={
          activeConversation.type === 'chat'
            ? () => unarchiveConversation(activeConversation.id)
            : undefined
        }
      />

      {/* Key-change alert banner — UNMOUNTED in Stage 1. The single-primary
          TOFU pin and its key-change alert are retired for OpenPGP (an extra
          announced key is normal under multi-key, and `encrypt()` no longer
          gates on an alert), so a persisted alert from ≤0.17.2 would otherwise
          render a "blocked / re-verify" banner — and offer an accept action
          that re-pins off the retired model — while sending works fine. The
          component and the sealed alert store are left intact; Stage 2 remounts
          a reworded banner driven by the derived `unverified-keyset` state. */}

      {/* Verify-peer dialog — opened from the encryption icon in the header */}
      {verifyDialogState.open && jid && (
        <VerifyPeerDialog
          peerName={activeConversation.name}
          peerJid={verifyDialogState.peerJid}
          peerFingerprint={verifyDialogState.peerFingerprint}
          ownJid={jid}
          ownFingerprint={verifyDialogState.ownFingerprint}
          alreadyVerified={encryptionState.kind === 'encrypted' && encryptionState.trust === 'verified'}
          onConfirm={handleVerifyConfirm}
          onCancel={() => setVerifyDialogState({ open: false })}
          onRevoke={() => {
            if (!verifyDialogState.open) return
            clearPeerVerified(verifyDialogState.peerJid)
            setVerifyDialogState({ open: false })
            addToast('success', t('contacts.encryption.removeVerificationSuccess'))
          }}
        />
      )}

      {/* Messages - focusable zone for Tab cycling */}
      <div
        ref={mainContentRef as React.RefObject<HTMLDivElement>}
        tabIndex={0}
        // `composer-active` hides the per-message hover toolbars while typing via
        // CSS (index.css), instead of threading `isComposing` into every row's
        // `hideToolbar` prop — which re-rendered (and relayouted) the whole
        // non-virtualized list on each typing burst.
        className={`focus-zone flex-1 flex flex-col min-h-0 p-1 relative${isComposing ? ' composer-active' : ''}`}
        onKeyDown={handleMessageListKeyDown}
        onMouseMove={(e) => {
          // Find which message is being hovered (for keyboard nav starting point)
          const messageEl = (e.target as HTMLElement).closest('[data-message-id]')
          const messageId = messageEl?.getAttribute('data-message-id') || undefined
          handleMouseMove(e, messageId)
        }}
        onMouseLeave={handleMouseLeave}
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
          <ChatMessageList
            messages={activeMessages}
            contactsByJid={contactsByJid}
            typingUsers={activeTypingUsers}
            scrollerRef={scrollRef}
            isAtBottomRef={isAtBottomRef}
            conversationId={activeConversation.id}
            conversationType={activeConversation.type}
            sendReaction={sendReaction}
            myBareJid={myBareJid}
            ownAvatar={ownAvatar}
            ownNickname={ownNickname}
            onReply={handleReply}
            onEdit={setEditingMessage}
            lastOutgoingMessageId={lastOutgoingMessageId}
            lastMessageId={lastMessageId}
            activeReactionPickerMessageId={activeReactionPickerMessageId}
            onReactionPickerChange={handleReactionPickerChange}
            retractMessage={retractMessage}
            retryMessage={retryMessage}
            selectedMessageId={selectedMessageId}
            hasKeyboardSelection={hasKeyboardSelection}
            showToolbarForSelection={showToolbarForSelection}
            firstNewMessageId={firstNewMessageId}
            firstNewMessageIsProvisional={firstNewMessageIsProvisional}
            readPointerId={readPointerId}
            targetMessageId={targetMessageId}
            clearTargetMessageId={clearTargetMessageId}
            clearFirstNewMessageId={handleClearFirstNewMessageId}
            onResyncDivider={handleResyncDivider}
            onMessageSeen={handleMessageSeen}
            isDarkMode={resolvedMode === 'dark'}
          onScrollToTop={fetchOlderHistory}
          onLoadAround={loadMessagesAround}
          isLoadingOlder={activeMAMState?.isLoading ?? false}
          onLoadNewer={loadNewer}
          windowAtLiveEdge={windowAtLiveEdge}
          onJumpToLatest={recenterToLatest}
          isHistoryComplete={activeMAMState?.isHistoryComplete ?? false}
          forwardGapTimestamp={activeMAMState?.forwardGapTimestamp}
          onCatchUpHistory={continueChatCatchUp}
          isCatchingUp={activeMAMState?.isLoading ?? false}
          // SDK auto-fetches cache + MAM in background, no blocking spinner needed
          isInitialLoading={false}
          highlightTerms={find.highlightTerms}
          currentMatchId={find.currentMatchId}
          lastSentMessageId={lastSentMessageId}
          />
        </MediaAutoloadProvider>
      </div>

      {/* Reaction mention pills — pinned above the composer */}
      <ReactionMentions conversationId={activeConversation.id} onSee={(id) => chatStore.getState().setTargetMessageId(id)} />
      <EasterEggMentions conversationId={activeConversation.id} onReplay={(animation, senderName) => chatStore.getState().triggerAnimation(activeConversation.id, animation, senderName)} />

      {/* Input */}
      <MessageInput
        composerRef={composerHandleRef}
        textareaRef={composerRef as React.RefObject<HTMLTextAreaElement | null>}
        conversationId={activeConversation.id}
        conversationName={activeConversation.name}
        type={activeConversation.type}
        onMessageSent={scrollToBottom}
        onMessageIdSent={handleMessageIdSent}
        onInputResize={handleInputResize}
        replyingTo={replyingTo}
        onCancelReply={handleCancelReply}
        editingMessage={editingMessage}
        onCancelEdit={handleCancelEdit}
        onEditLastMessage={handleEditLastMessage}
        sendMessage={sendMessage}
        sendCorrection={sendCorrection}
        retractMessage={retractMessage}
        sendChatState={sendChatState}
        isArchived={isArchived}
        unarchiveConversation={unarchiveConversation}
        setDraft={setDraft}
        getDraft={getDraft}
        clearDraft={clearDraft}
        clearFirstNewMessageId={clearFirstNewMessageId}
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
        encryptionState={encryptionState}
        onEncryptionClick={
          encryptionState.kind === 'encrypted' || encryptionState.kind === 'blocked'
            ? handleOpenVerify
            : undefined
        }
        isDarkMode={resolvedMode === 'dark'}
      />

      {/* Easter egg animation */}
      {activeAnimation?.conversationId === activeConversation.id && (
        <EasterEggAnimation animation={activeAnimation.animation} onComplete={clearAnimation} senderName={activeAnimation.senderName} />
      )}
    </div>
  )
}

export const ChatMessageList = memo(function ChatMessageList({
  messages,
  contactsByJid,
  typingUsers,
  scrollerRef,
  isAtBottomRef,
  conversationId,
  conversationType,
  sendReaction,
  myBareJid,
  ownAvatar,
  ownNickname,
  onReply,
  onEdit,
  lastOutgoingMessageId,
  lastMessageId,
  activeReactionPickerMessageId,
  onReactionPickerChange,
  retractMessage,
  retryMessage,
  selectedMessageId,
  hasKeyboardSelection,
  showToolbarForSelection,
  firstNewMessageId,
  firstNewMessageIsProvisional,
  readPointerId,
  targetMessageId,
  clearTargetMessageId,
  clearFirstNewMessageId,
  onResyncDivider,
  onMessageSeen,
  isDarkMode,
  onScrollToTop,
  onLoadAround,
  isLoadingOlder,
  onLoadNewer,
  windowAtLiveEdge,
  onJumpToLatest,
  isHistoryComplete,
  isInitialLoading,
  highlightTerms,
  currentMatchId,
  lastSentMessageId,
  forwardGapTimestamp,
  onCatchUpHistory,
  isCatchingUp,
}: {
  messages: Message[]
  contactsByJid: Map<string, ContactIdentity>
  typingUsers: string[]
  scrollerRef: React.RefObject<HTMLElement | null>
  isAtBottomRef: React.MutableRefObject<boolean>
  conversationId: string
  conversationType: 'chat' | 'groupchat'
  sendReaction: (to: string, messageId: string, emojis: string[], type: 'chat' | 'groupchat') => Promise<void>
  myBareJid?: string
  ownAvatar?: string | null
  ownNickname?: string | null
  onReply: (message: Message) => void
  onEdit: (message: Message) => void
  lastOutgoingMessageId: string | null
  lastMessageId: string | null
  activeReactionPickerMessageId: string | null
  onReactionPickerChange: (messageId: string, isOpen: boolean) => void
  retractMessage: (conversationId: string, messageId: string) => Promise<void>
  retryMessage: (conversationId: string, messageId: string) => Promise<void>
  selectedMessageId: string | null
  hasKeyboardSelection: boolean
  showToolbarForSelection: boolean
  firstNewMessageId?: string
  firstNewMessageIsProvisional?: boolean
  readPointerId?: string
  targetMessageId?: string | null
  clearTargetMessageId?: () => void
  clearFirstNewMessageId: () => void
  onResyncDivider?: (conversationId: string) => void
  onMessageSeen?: (messageId: string) => void
  isDarkMode?: boolean
  onScrollToTop?: () => void
  onLoadAround?: (anchorMessageId: string) => Promise<unknown> | void
  isLoadingOlder?: boolean
  onLoadNewer?: () => void
  windowAtLiveEdge?: boolean
  onJumpToLatest?: () => Promise<unknown> | void
  isHistoryComplete?: boolean
  isInitialLoading?: boolean
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
    useMessageHoverState({ scrollRef: scrollerRef, resetKey: conversationId })

  const formatTypingUser = (jid: string) => {
    const bareJid = getBareJid(jid)
    return contactsByJid.get(bareJid)?.name || getLocalPart(bareJid)
  }

  // Clipboard metadata for a message, faithful to ChatMessageBubble's senderName so a
  // virtualized multi-message copy reconstructs identically from the array (see
  // MessageList formatMessageForCopy). Called only at copy time, so per-render cost is nil.
  const formatMessageForCopy = (msg: Message): CopyMessageMeta => ({
    id: msg.id,
    from: msg.isOutgoing
      ? (ownNickname || getLocalPart(msg.from))
      : (contactsByJid.get(getBareJid(msg.from))?.name || getLocalPart(msg.from)),
    time: formatTime(msg.timestamp),
    body: msg.body || '',
    date: format(msg.timestamp, 'yyyy-MM-dd'),
  })

  // Stable mention-color resolver: uses auroraSenderColor so 1:1 @mention pills
  // match the sender name color in the same conversation. Dep is isDarkMode only —
  // a fresh inline arrow each render would break the messageRowMemo bailout.
  const resolveMentionColor = useCallback(
    (id: string) => auroraSenderColor(id, isDarkMode ?? true),
    [isDarkMode],
  )

  // Render function for messages
  // The onMediaLoad parameter is provided by MessageList from useMessageListScroll hook
  const renderMessage = (msg: Message, idx: number, groupMessages: Message[], _showNewMarker: boolean, onMediaLoad: () => void) => (
    <ChatMessageBubble
      message={msg}
      showAvatar={shouldShowAvatar(groupMessages, idx)}
      isGroupEnd={idx === groupMessages.length - 1 || shouldShowAvatar(groupMessages, idx + 1)}
      ownGroupKey={computeOwnGroupKey(groupMessages, idx)}
      avatar={msg.isOutgoing ? ownAvatar ?? undefined : contactsByJid.get(msg.from)?.avatar}
      ownAvatar={ownAvatar}
      ownNickname={ownNickname}
      conversationId={conversationId}
      conversationType={conversationType}
      sendReaction={sendReaction}
      myBareJid={myBareJid}
      contactsByJid={contactsByJid}
      onReply={onReply}
      onEdit={onEdit}
      isLastOutgoing={msg.id === lastOutgoingMessageId}
      isLastMessage={msg.id === lastMessageId}
      hideToolbar={activeReactionPickerMessageId !== null && activeReactionPickerMessageId !== msg.id}
      onReactionPickerChange={onReactionPickerChange}
      retractMessage={retractMessage}
      retryMessage={retryMessage}
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
      highlightTerms={highlightTerms}
      isCurrentMatch={msg.id === currentMatchId}
      resolveMentionColor={resolveMentionColor}
    />
  )

  return (
    <MessageListComponent
      // Remount the message view (fresh virtualizer + scroll refs) per conversation so no
      // imperative scroll state — the @tanstack virtualizer's measurement/offset cache above
      // all — bleeds between conversations. Restoration survives via scrollStateManager (an
      // external singleton keyed by conversation id).
      key={conversationId}
      messages={messages}
      conversationId={conversationId}
      firstNewMessageId={firstNewMessageId}
      firstNewMessageIsProvisional={firstNewMessageIsProvisional}
      readPointerId={readPointerId}
      targetMessageId={targetMessageId}
      onTargetMessageConsumed={clearTargetMessageId}
      clearFirstNewMessageId={clearFirstNewMessageId}
      onResyncDivider={onResyncDivider}
      onMessageSeen={onMessageSeen}
      scrollerRef={scrollerRef}
      isAtBottomRef={isAtBottomRef}
      typingUsers={typingUsers}
      formatTypingUser={formatTypingUser}
      renderMessage={renderMessage}
      formatMessageForCopy={formatMessageForCopy}
      lastSentMessageId={lastSentMessageId}
      onScrollToTop={onScrollToTop}
      onLoadAround={onLoadAround}
      isLoadingOlder={isLoadingOlder}
      onLoadNewer={onLoadNewer}
      windowAtLiveEdge={windowAtLiveEdge}
      onJumpToLatest={onJumpToLatest}
      isHistoryComplete={isHistoryComplete}
      forwardGapTimestamp={forwardGapTimestamp}
      onCatchUpHistory={onCatchUpHistory}
      isCatchingUp={isCatchingUp}
      isLoading={isInitialLoading}
      loadingState={
        <div className="flex-1 flex items-center justify-center text-fluux-muted">
          <div className="flex items-center gap-2">
            <Loader2 className="size-5 animate-spin" />
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
  isGroupEnd: boolean
  /** Own-message run key (see ownGroupKey); undefined for incoming/solo rows. */
  ownGroupKey?: string
  avatar?: string
  ownAvatar?: string | null
  ownNickname?: string | null
  conversationId: string
  conversationType: 'chat' | 'groupchat'
  sendReaction: (to: string, messageId: string, emojis: string[], type: 'chat' | 'groupchat') => Promise<void>
  myBareJid?: string
  contactsByJid: Map<string, ContactIdentity>
  onReply: (message: Message) => void
  onEdit: (message: Message) => void
  isLastOutgoing: boolean
  isLastMessage: boolean
  hideToolbar?: boolean
  // Receives the row's own id so the row can be passed a STABLE handler (the id
  // is bound inside the row, not via a per-render closure in the parent).
  onReactionPickerChange?: (messageId: string, isOpen: boolean) => void
  retractMessage: (conversationId: string, messageId: string) => Promise<void>
  retryMessage: (conversationId: string, messageId: string) => Promise<void>
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
  // Highlight terms for find-on-page
  highlightTerms?: string[]
  // Whether this message is the current find-on-page match
  isCurrentMatch?: boolean
  // Stable color resolver for @mention pills (auroraSenderColor keyed on isDarkMode)
  resolveMentionColor?: (id: string) => string | undefined
}

const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  showAvatar,
  isGroupEnd,
  ownGroupKey,
  avatar,
  ownAvatar,
  ownNickname,
  conversationId,
  conversationType,
  sendReaction,
  myBareJid,
  contactsByJid,
  onReply,
  onEdit,
  isLastOutgoing,
  isLastMessage,
  hideToolbar,
  onReactionPickerChange,
  retractMessage,
  retryMessage,
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
  highlightTerms,
  isCurrentMatch,
  resolveMentionColor,
}: ChatMessageBubbleProps) {
  const { t } = useTranslation()

  // Resolve the replied-to message reactively from the store. Reading a
  // render-time lookup here would freeze this memoized row on the XEP-0428
  // fallback when the quoted message only paginates in later.
  const replyTarget = useReferencedMessage({ type: 'chat', conversationId, id: message.replyTo?.id })

  // Use display name from roster, fall back to JID username
  // For outgoing messages, use own nickname if set
  const senderContact = contactsByJid.get(getBareJid(message.from))
  const senderName = message.isOutgoing
    ? (ownNickname || getLocalPart(message.from))
    : (senderContact?.name || getLocalPart(message.from))

  // Get sender color: dedicated AA-safe self color for own messages, else the
  // Aurora-tuned per-person color (consistent for known + unknown senders).
  const senderColor = message.isOutgoing
    ? 'var(--fluux-text-self)'
    : auroraSenderColor(getBareJid(message.from), isDarkMode ?? true)

  // Get my current reactions to this message (1:1 chat — always uses bare JID)
  const myReactions = getMyReactions(message.reactions, undefined, myBareJid, false)

  // Handle reaction toggle
  const handleReaction = (emoji: string) => {
    if (!myBareJid) return

    const newReactions = myReactions.includes(emoji)
      ? myReactions.filter(e => e !== emoji)
      : [...myReactions, emoji]

    void sendReaction(conversationId, message.id, newReactions, conversationType)
  }

  // Build reply context using shared helper (replyTarget resolved above)
  const replyContext = buildReplyContext(
    message,
    replyTarget,
    (originalMsg, fallbackId) => {
      // Own messages: use ownNickname or JID username
      if (originalMsg?.isOutgoing) {
        return ownNickname || getLocalPart(originalMsg.from)
      }
      if (originalMsg) {
        return contactsByJid.get(getBareJid(originalMsg.from))?.name || getLocalPart(originalMsg.from)
      }
      return fallbackId ? getLocalPart(fallbackId) : 'Unknown'
    },
    (originalMsg, fallbackId, dark) => {
      // Own messages: use the dedicated AA-safe self color
      if (originalMsg?.isOutgoing) return 'var(--fluux-text-self)'
      const senderId = (originalMsg ? getBareJid(originalMsg.from) : undefined) || (fallbackId ? getBareJid(fallbackId) : undefined)
      if (!senderId) return 'var(--fluux-brand)'
      return auroraSenderColor(senderId, dark ?? true)
    },
    (originalMsg, fallbackId) => {
      const senderId = (originalMsg ? getBareJid(originalMsg.from) : undefined) || (fallbackId ? getBareJid(fallbackId) : undefined)
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
  )

  // Get reactor display name (contact name, or username if not in roster)
  const getReactorName = (jid: string) => {
    const bareJid = getBareJid(jid)
    if (bareJid === myBareJid) return t('chat.you')
    return contactsByJid.get(bareJid)?.name || getLocalPart(jid)
  }

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

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
        senderName={senderName}
        senderColor={senderColor}
        avatarUrl={avatar}
        avatarIdentifier={message.from}
        avatarFallbackColor={senderColor}
        senderJid={message.isOutgoing ? myBareJid : getBareJid(message.from)}
        senderContact={message.isOutgoing ? undefined : senderContact}
        myReactions={myReactions}
        onReaction={handleReaction}
        getReactorName={getReactorName}
        onReply={() => onReply(message)}
        onEdit={() => onEdit(message)}
        onDelete={async () => setShowDeleteConfirm(true)}
        onRetry={message.deliveryError ? () => { void retryMessage(conversationId, message.id) } : undefined}
        onMediaLoad={onMediaLoad}
        replyContext={replyContext}
        onReactionPickerChange={(isOpen) => onReactionPickerChange?.(message.id, isOpen)}
        formatTime={formatTime}
        timeFormat={timeFormat}
        highlightTerms={highlightTerms}
        isCurrentMatch={isCurrentMatch}
        resolveMentionColor={resolveMentionColor}
      />
      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('chat.deleteMessage')}
          message={t('chat.deleteMessageConfirm')}
          confirmLabel={t('chat.deleteMessage')}
          variant="danger"
          onConfirm={() => {
            setShowDeleteConfirm(false)
            void retractMessage(conversationId, message.id)
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </>
  )
})

export const MessageInput = memo(function MessageInput({
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
  sendMessage,
  sendCorrection,
  retractMessage,
  sendChatState,
  isArchived,
  unarchiveConversation,
  setDraft,
  getDraft,
  clearDraft,
  clearFirstNewMessageId,
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
  onMessageIdSent,
  encryptionState,
  onEncryptionClick,
  isDarkMode,
}: {
  composerRef: React.RefObject<MessageComposerHandle | null>
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  conversationId: string
  conversationName: string
  type: 'chat' | 'groupchat'
  onMessageSent?: () => void
  onMessageIdSent?: (messageId: string) => void
  onInputResize?: () => void
  replyingTo: Message | null
  onCancelReply: () => void
  editingMessage: Message | null
  onCancelEdit: () => void
  sendMessage: (to: string, body: string, options?: { replyTo?: { id: string; to?: string; fallback?: { author: string; body: string; fromEncrypted?: boolean } }; attachment?: import('@fluux/sdk').FileAttachment }) => Promise<string>
  sendCorrection: (conversationId: string, messageId: string, newBody: string, attachment?: import('@fluux/sdk').FileAttachment) => Promise<void>
  retractMessage: (conversationId: string, messageId: string) => Promise<void>
  sendChatState: (to: string, state: import('@fluux/sdk').ChatStateNotification, type?: 'chat' | 'groupchat') => Promise<void>
  isArchived: (id: string) => boolean
  unarchiveConversation: (id: string) => void
  setDraft: (conversationId: string, text: string) => void
  getDraft: (conversationId: string) => string
  clearDraft: (conversationId: string) => void
  clearFirstNewMessageId: (conversationId: string) => void
  contactsByJid: Map<string, ContactIdentity>
  onComposingChange?: (isComposing: boolean) => void
  sendEasterEgg: (to: string, type: 'chat' | 'groupchat', animation: string) => Promise<void>
  isConnected: boolean
  onEditLastMessage?: () => void
  uploadState?: { isUploading: boolean; progress: number; error: string | null; clearError: () => void }
  isUploadSupported?: boolean
  onFileSelect?: (file: File) => void
  uploadFile?: (file: File, options?: { encrypt?: boolean }) => Promise<import('@fluux/sdk').FileAttachment | null>
  pendingAttachment?: PendingAttachment | null
  onRemovePendingAttachment?: () => void
  processLinkPreview?: (messageId: string, body: string, to: string, type: 'chat' | 'groupchat') => Promise<void>
  onSwitchToMessages?: (conversationId: string) => void
  encryptionState: ConversationEncryptionState
  /** Open the verify/trust UI for the current peer. Passed through to MessageComposer's leading lock. */
  onEncryptionClick?: () => void
  /** Whether the app is in dark mode — used to compute the per-person reply-chip color. */
  isDarkMode?: boolean
}) {
  const { t } = useTranslation()
  const openWebUnlockDialog = useWebUnlockDialogStore((s) => s.openWebUnlockDialog)

  // Slash commands. A 1:1 chat supports /me, /say, /help, and /christmas; the
  // room-only commands are context-gated out of this 'chat' context, so their
  // sdk methods are never reached (they throw defensively if ever called).
  const [helpOpen, setHelpOpen] = useState(false)
  const chatCommandContext = useMemo<CommandContext>(() => {
    const notInRoom = async () => {
      throw new Error('command not available in a 1:1 chat')
    }
    return {
      kind: 'chat',
      entityJid: conversationId,
      sdk: {
        joinRoom: notInRoom,
        joinResult: notInRoom,
        changeNick: notInRoom,
        leaveRoom: notInRoom,
        setSubject: notInRoom,
        setRole: notInRoom,
        setAffiliation: notInRoom,
        invite: notInRoom,
      },
      ui: { openInviteModal: () => {}, openRoomConfig: () => {}, openHelp: () => setHelpOpen(true) },
      app: { sendEasterEgg: (animation) => sendEasterEgg(conversationId, type, animation) },
      resolveNick: () => undefined,
      t,
    }
  }, [conversationId, type, sendEasterEgg, t])
  const { resolveInput, classifyInput } = useSlashCommands(chatCommandContext)

  // Draft persistence - saves on conversation change, restores on load
  const [text, setText] = useConversationDraft({
    conversationId,
    draftOperations: { getDraft, setDraft, clearDraft },
    composerRef,
  })

  // Convert Message to ReplyInfo for the composer
  // XEP-0461: for chat-type messages, use the client-generated id (not stanza-id, which is only for groupchat)
  const replyInfo: ReplyInfo | null = replyingTo
    ? {
        id: replyingTo.id,
        from: replyingTo.from,
        senderName: contactsByJid.get(getBareJid(replyingTo.from))?.name || getLocalPart(replyingTo.from),
        body: replyingTo.body,
        senderColor: auroraSenderColor(getBareJid(replyingTo.from), isDarkMode ?? true),
      }
    : null

  // Show a banner notice when the reply will be sent in cleartext but the
  // quoted message arrived encrypted — the SDK strips the quote in that case.
  // Excluded kinds are those where the reply will NOT go out as cleartext:
  // `encrypted` encrypts; `keyLocked` blocks until unlock then encrypts;
  // `blocked` throws on encrypt (never sent); `checking` is an in-flight probe.
  const replyQuoteHidden =
    !!replyingTo &&
    encryptionState.kind !== 'encrypted' &&
    encryptionState.kind !== 'keyLocked' &&
    encryptionState.kind !== 'blocked' &&
    encryptionState.kind !== 'checking' &&
    isEncryptedSource(replyingTo)

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
    // Refuse to send while the local OpenPGP key is locked for an
    // encrypted conversation. Without the guard, the file upload would
    // happen plaintext-or-ciphertext-with-no-recipient (depending on
    // `encryptAttachment` below) and the send would fail at encrypt
    // time, leaving an orphaned upload on the server. Opening the
    // unlock dialog routes the user to the passphrase prompt; the
    // typed text stays in the composer (we return `false` here, which
    // skips the `setText('')` clear in MessageComposer).
    if (encryptionState.kind === 'keyLocked') {
      openWebUnlockDialog()
      return false
    }

    // Unarchive conversation if archived (user is actively chatting)
    // and switch to Messages view to see it in the main list
    if (type === 'chat' && isArchived(conversationId)) {
      unarchiveConversation(conversationId)
      onSwitchToMessages?.(conversationId)
    }

    // Include reply info if replying to a message (with XEP-0428 fallback for compatibility)
    // SDK resolves stanzaId vs id for the protocol reference (XEP-0461)
    let replyTo: { id: string; to: string; fallback?: { author: string; body: string; fromEncrypted?: boolean } } | undefined
    if (replyingTo) {
      const authorName = contactsByJid.get(getBareJid(replyingTo.from))?.name || getLocalPart(replyingTo.from)
      replyTo = {
        id: replyingTo.id,
        to: replyingTo.from,
        fallback: { author: authorName, body: replyingTo.body, fromEncrypted: isEncryptedSource(replyingTo) }
      }
    }

    // If there's a pending attachment, upload it first (privacy: only upload when user explicitly sends).
    // When the conversation is E2EE-active we encrypt the file bytes
    // client-side with a fresh AES-256-GCM key before upload; the key/IV
    // then ride inside the OpenPGP `<payload/>` via the SDK's stanza
    // assembly, so the HTTP Upload server stores only ciphertext.
    let attachment: import('@fluux/sdk').FileAttachment | null | undefined
    if (pendingAttachment && uploadFile) {
      const encryptAttachment = encryptionState.kind === 'encrypted'
      attachment = await uploadFile(pendingAttachment.file, { encrypt: encryptAttachment })
      if (!attachment) {
        // Upload failed - don't send the message
        return false
      }
    }

    // The body is the file URL if no text was entered, otherwise the user's text
    const body = text || attachment?.url || ''
    const messageId = await sendMessage(conversationId, body, { replyTo, attachment: attachment ?? undefined })

    // Notify parent of sent message ID for animation
    onMessageIdSent?.(messageId)

    // Clear pending attachment after sending
    if (pendingAttachment) {
      onRemovePendingAttachment?.()
    }

    // Clear draft immediately so sidebar updates
    clearDraft(conversationId)

    // Process link preview in background (don't block on it)
    // Skip when encrypted — the fastening would leak URL/title/image in cleartext
    if (processLinkPreview && text && encryptionState.kind !== 'encrypted') {
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
    <>
      <MessageComposer
        ref={composerRef}
        textareaRef={textareaRef}
        placeholder={t('chat.messageTo', { name: conversationName })}
        replyingTo={replyInfo}
        onCancelReply={onCancelReply}
        replyQuoteHidden={replyQuoteHidden}
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
        resolveInput={resolveInput}
        classifyInput={classifyInput}
        aboveInput={helpOpen ? <CommandHelpPanel commands={visibleCommands('chat')} onClose={() => setHelpOpen(false)} /> : undefined}
        hasExternalOverlay={helpOpen}
        onEditLastMessage={onEditLastMessage}
        encryptionState={encryptionState}
        onEncryptionClick={onEncryptionClick}
      />
    </>
  )
})
