import { useState, useRef, useEffect, useCallback, useMemo, useImperativeHandle, type RefObject } from 'react'
import type { Message, MessageRowRef, RoomMessage, ViewportEvidenceKey } from '@fluux/sdk'
import { currentViewportGeneration, getStorageScopeJid, reportViewport } from '@fluux/sdk'
import { useFileUpload, useLinkPreview, useTypeToFocus, useMode, useMessageSelection, useDragAndDrop } from '@/hooks'
import { useConnectionStore } from '@fluux/sdk/react'
import { useFindOnPage, type FindOnPageHandle } from '@/hooks/useFindOnPage'
import { usePendingAttachment } from '@/hooks/usePendingAttachment'
import { useMessageListHandle } from '@/hooks/useMessageListHandle'
import { messageRowId, messageRowRefFromRowId, readMessageRowId } from '@/components/conversation/messageRowIdentity'
import type { MessageComposerHandle } from '@/components/MessageComposer'
import { findLastEditableMessage } from '@/utils/messageUtils'
import { useExpandedMessagesStore } from '@/stores/expandedMessagesStore'
import { reactionMentionStore } from '@/stores/reactionMentionStore'
import { easterEggMentionStore } from '@/stores/easterEggMentionStore'

type ThreadMessage = Message | RoomMessage

/** What a view tells the thread about the conversation it shows. */
export interface ConversationThreadSource<M extends ThreadMessage> {
  /** Which store side the conversation lives on: a 1:1 or group chat, or a room. */
  kind: 'chat' | 'room'
  /** The conversation id (the room's address for a room); undefined while none is open. */
  id: string | undefined
  /** The rows the list, find on page, keyboard selection and the last row show. */
  displayMessages: M[]
  /** Every loaded message, including rows a view hides: the last editable message comes from here. */
  allMessages: M[]
  /** Reads the loaded messages when the composer asks to edit the last one, without closing over them. */
  readAllMessages: () => M[]
  fetchOlderHistory?: () => void
  isLoadingOlder?: boolean
  isHistoryComplete?: boolean
  clearFirstNewMessageId: (id: string) => void
  advanceReadPointer: (id: string, row: MessageRowRef) => void
  /** Jumps the list to a message. Must keep one identity across renders. */
  setTargetMessageId: (messageId: string) => void
  /** Starts an easter egg animation in a conversation. Must keep one identity across renders. */
  triggerAnimation: (id: string, animation: string, senderName: string) => void
  /** The animation now playing in this conversation, or null. */
  activeAnimation: { animation: string; senderName?: string } | null
  clearAnimation: () => void
  /** Parent handlers; the thread binds the conversation id. */
  onSearchInConversation?: (id: string) => void
  onShowSavedInConversation?: (id: string) => void
  /** Where the parent's keyboard shortcuts reach find on page. */
  findOnPageRef?: RefObject<FindOnPageHandle | null>
}

const VIEWPORT_LIST_KIND = { chat: 'conversation', room: 'room' } as const

/**
 * The thread both conversation views share: staged reply, edit and attachment, the send
 * highlight, keyboard selection, find on page, file drop, the read pointer, the live edge,
 * and the mentions pinned above the composer. A view calls it first, then its own hooks, and
 * hands the result to ConversationThread together with what is specific to its kind.
 */
export function useConversationThread<M extends ThreadMessage>(source: ConversationThreadSource<M>) {
  const {
    kind, id, displayMessages, allMessages, readAllMessages, fetchOlderHistory, isLoadingOlder, isHistoryComplete,
    clearFirstNewMessageId, advanceReadPointer, setTargetMessageId, triggerAnimation, activeAnimation, clearAnimation,
    onSearchInConversation, onShowSavedInConversation, findOnPageRef,
  } = source

  const isConnected = useConnectionStore((s) => s.status) === 'online'
  const { uploadFile, isUploading, progress, isSupported, error: uploadError, clearError: clearUploadError, maxFileSize } = useFileUpload()
  const { processMessageForLinkPreview } = useLinkPreview()
  const { resolvedMode } = useMode()

  const [replyingTo, setReplyingTo] = useState<M | null>(null)
  const [editingMessage, setEditingMessage] = useState<M | null>(null)
  // Staged file ready to send with the next message
  const { pendingAttachment, stage: stageAttachment, clear: clearPendingAttachment, choosePhoto } = usePendingAttachment(maxFileSize)
  const [lastSentMessageId, setLastSentMessageId] = useState<string | null>(null)
  const lastSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Typing hides the row toolbars; an open reaction picker hides every other row's toolbar
  const [isComposing, setIsComposing] = useState(false)
  const [activeReactionPickerMessageId, setActiveReactionPickerMessageId] = useState<string | null>(null)

  const lastEditableMessage = findLastEditableMessage(allMessages)
  const lastOutgoingMessageId = lastEditableMessage ? messageRowId(lastEditableMessage) ?? null : null
  // The reply button is disabled for the last row: its context is already clear
  const lastMessage = displayMessages[displayMessages.length - 1]
  const lastMessageId = lastMessage ? messageRowId(lastMessage) ?? null : null

  const handleSearchInConversation = id && onSearchInConversation ? () => onSearchInConversation(id) : undefined
  const handleShowSaved = id && onShowSavedInConversation ? () => onShowSavedInConversation(id) : undefined

  // Stable identities below: they reach memoized rows and the memoized composer
  const handleEditLastMessage = useCallback(() => {
    const message = findLastEditableMessage(readAllMessages())
    if (message) setEditingMessage(message)
  }, [readAllMessages])
  const handleCancelReply = useCallback(() => setReplyingTo(null), [])
  const handleCancelEdit = useCallback(() => setEditingMessage(null), [])
  const handleReactionPickerChange = useCallback((messageId: string, isOpen: boolean) => {
    setActiveReactionPickerMessageId(isOpen ? messageId : null)
  }, [])

  const uploadState = useMemo(
    () => ({ isUploading, progress, error: uploadError, clearError: clearUploadError }),
    [isUploading, progress, uploadError, clearUploadError],
  )

  // Composer handle, separate from the focus-zone ref
  const composerHandleRef = useRef<MessageComposerHandle>(null)
  const focusComposer = useCallback(() => { setTimeout(() => composerHandleRef.current?.focus(), 0) }, [])
  // Typing anywhere outside a field focuses the composer
  useTypeToFocus(composerHandleRef)

  const find = useFindOnPage(displayMessages, id, messageRowId)
  useImperativeHandle(findOnPageRef, () => ({
    open: find.open,
    close: find.close,
    isOpen: find.isOpen,
    goToNext: find.goToNext,
    goToPrev: find.goToPrev,
  }), [find.open, find.close, find.isOpen, find.goToNext, find.goToPrev])

  // The list's command handle (keyboard navigation, hover scoping). The hook also publishes
  // whether the viewport shows the newest message, so the global focus handler can tell a
  // reader looking at it from a view merely parked at the live edge.
  const listHandleRef = useMessageListHandle(VIEWPORT_LIST_KIND[kind], id)

  // Clears the send highlight 400 ms after a send
  const handleMessageIdSent = useCallback((messageId: string) => {
    if (lastSentTimerRef.current) clearTimeout(lastSentTimerRef.current)
    setLastSentMessageId(messageId)
    lastSentTimerRef.current = setTimeout(() => setLastSentMessageId(null), 400)
  }, [])
  // The highlight timer is the only one here that sets state: left armed it fires into a torn-down tree
  useEffect(() => () => {
    if (lastSentTimerRef.current) {
      clearTimeout(lastSentTimerRef.current)
      lastSentTimerRef.current = null
    }
  }, [])

  const {
    selectedMessageId,
    hasKeyboardSelection,
    showToolbarForSelection,
    handleKeyDown,
    clearSelection,
    handleMouseMove,
    handleMouseLeave,
  } = useMessageSelection(displayMessages, listHandleRef, {
    getRowId: messageRowId,
    onReachedFirstMessage: fetchOlderHistory,
    isLoadingOlder,
    isHistoryComplete,
    onEnterPressed: (rowId: string) => useExpandedMessagesStore.getState().toggle(rowId),
  })

  // Clear stale reaction mentions when leaving a conversation
  useEffect(() => {
    return () => {
      if (id) reactionMentionStore.getState().clearConversation(id)
    }
  }, [id])

  // Auto-play a pending easter egg once when its conversation opens. The chip stays
  // (via EasterEggMentions) as a Replay control until dismissed.
  useEffect(() => {
    if (!id) return
    const egg = easterEggMentionStore.getState().mentions.get(id)
    if (egg && !egg.played) {
      triggerAnimation(id, egg.animation, egg.senderName)
      easterEggMentionStore.getState().markPlayed(id)
    }
  }, [id, triggerAnimation])

  // A new conversation starts clean. Declared before the view's own effects so a switch and
  // anything it stages (a file dropped on a sidebar row) settle in order.
  useEffect(() => {
    setReplyingTo(null)
    setEditingMessage(null)
    // Releases the preview URL and any photo preparation of the previous conversation
    clearPendingAttachment()
    clearSelection()
  }, [id, clearSelection, clearPendingAttachment])

  // A dropped file is staged for preview only: nothing uploads before Send (privacy protection)
  const hasConversation = Boolean(id)
  const handleFileDrop = useCallback((file: File) => {
    if (!hasConversation || !isSupported) return
    // Previews images and videos; on iOS a large photo is reduced locally first
    stageAttachment(file)
    focusComposer()
  }, [hasConversation, isSupported, stageAttachment, focusComposer])
  const { isDragging, dragHandlers } = useDragAndDrop({ onFileDrop: handleFileDrop, isUploadSupported: isSupported })

  const handleClearFirstNewMessageId = useCallback(() => {
    if (id) clearFirstNewMessageId(id)
  }, [id, clearFirstNewMessageId])

  // The read pointer follows the viewport. The observer reports a ROW HANDLE; decoding it keeps
  // the occupant attached across the SDK boundary instead of collapsing to a client id.
  const handleMessageSeen = useCallback((rowId: string) => {
    if (id) advanceReadPointer(id, messageRowRefFromRowId(rowId))
  }, [id, advanceReadPointer])

  // The on-arrival read-pointer advance waits for a real viewport-at-live-edge signal. The SDK's
  // activation is the sole caller of beginViewportGeneration: this view only reads the current
  // generation and reports measured geometry. The key has no time-varying data, so it keeps one
  // identity per conversation; the generation is an activation value, read on EVERY render so a
  // same-conversation reactivation is picked up instead of echoing a stale token forever.
  const viewportEvidenceKey: ViewportEvidenceKey | null = useMemo(
    () => (id ? { kind, entityId: id, accountScope: getStorageScopeJid() ?? '' } : null),
    [kind, id],
  )
  const viewportGeneration = viewportEvidenceKey ? currentViewportGeneration(viewportEvidenceKey) : 0
  // Never read the generation INSIDE this callback: closing over this render's token is what
  // makes a delayed callback from a previous activation carry the old, correctly rejected one.
  const reportLiveEdge = useCallback(
    (atEdge: boolean) => {
      if (!viewportEvidenceKey) return
      reportViewport(viewportEvidenceKey, viewportGeneration, atEdge ? 'at-edge' : 'away')
    },
    [viewportEvidenceKey, viewportGeneration],
  )

  const handleSeeReaction = useCallback((messageId: string) => setTargetMessageId(messageId), [setTargetMessageId])
  const handleReplayEasterEgg = useCallback(
    (animation: string, senderName: string) => { if (id) triggerAnimation(id, animation, senderName) },
    [id, triggerAnimation],
  )

  return {
    id,
    isConnected,
    isDarkMode: resolvedMode === 'dark',
    // A view's own reply, whisper and edit policies reach the thread's state through these
    setReplyingTo,
    setEditingMessage,
    stageAttachment,
    clearPendingAttachment,
    composerHandleRef,
    focusComposer,
    /** The header's search and saved handlers. */
    handleSearchInConversation,
    handleShowSaved,
    /** Props shared by the view's message list: spread them into it. */
    listProps: {
      listHandleRef,
      onLiveEdgeMeasured: reportLiveEdge,
      onEdit: setEditingMessage,
      lastOutgoingMessageId,
      lastMessageId,
      activeReactionPickerMessageId,
      onReactionPickerChange: handleReactionPickerChange,
      selectedMessageId,
      hasKeyboardSelection,
      showToolbarForSelection,
      clearFirstNewMessageId: handleClearFirstNewMessageId,
      onMessageSeen: handleMessageSeen,
      highlightTerms: find.highlightTerms,
      currentMatchId: find.currentMatchId,
      lastSentMessageId,
    },
    /** Props shared by the view's composer: spread them into it. */
    composerProps: {
      replyingTo,
      onCancelReply: handleCancelReply,
      editingMessage,
      onCancelEdit: handleCancelEdit,
      onEditLastMessage: handleEditLastMessage,
      onComposingChange: setIsComposing,
      uploadState,
      isUploadSupported: isSupported,
      onFileSelect: handleFileDrop,
      uploadFile,
      pendingAttachment,
      onRemovePendingAttachment: clearPendingAttachment,
      onChoosePhoto: choosePhoto,
      processLinkPreview: processMessageForLinkPreview,
      isConnected,
      onMessageIdSent: handleMessageIdSent,
      isDarkMode: resolvedMode === 'dark',
    },
    /** What the layout draws around the slots. */
    layout: {
      id,
      isDragging,
      dragHandlers,
      isComposing,
      find,
      onKeyDown: handleKeyDown,
      onMouseMove: (e: React.MouseEvent) => {
        // The row under the pointer is where keyboard navigation starts
        const target = e.target as HTMLElement
        const rowElement = target.closest<HTMLElement>('[data-message-row-id]') ?? target.closest<HTMLElement>('[data-message-id]')
        handleMouseMove(e, rowElement ? readMessageRowId(rowElement) : undefined)
      },
      onMouseLeave: handleMouseLeave,
      onSeeReaction: handleSeeReaction,
      onReplayEasterEgg: handleReplayEasterEgg,
      activeAnimation,
      clearAnimation,
    },
  }
}

export type ConversationThreadLayout = ReturnType<typeof useConversationThread>['layout']
