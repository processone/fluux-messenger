import React, { useState, useRef, useLayoutEffect, memo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useListKeyboardNav, useRouteSync } from '@/hooks'
import { detectRenderLoop, trackSelectorChange } from '@/utils/renderLoopDetector'
import {
  chatStore,
  subscribeDecryptionActivity,
  isMessageDecrypting,
  roomStore,
  isPreviewableMessage,
  type Conversation,
} from '@fluux/sdk'
import { useWebKeyLocked } from '@/hooks/useWebKeyLocked'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { conversationDecryptionKey, formatLocalizedPreview } from '@/utils/messagePreviewText'
import { shouldReplaceOnSelect } from '@/utils/navigationHistory'
import { useChatStore, useConnectionStore, useRosterStore, useRoomStore } from '@fluux/sdk/react'
import { Avatar, TypingIndicator } from '../Avatar'
import { RoomAvatar } from '../RoomAvatar'
import { Tooltip } from '../Tooltip'
import { useSidebarZone, ContactTooltipContent } from './types'
import { formatConversationTime } from '@/utils/dateFormat'
import { useDayChange } from '@/hooks/useDayChange'
import { AvatarUnreadBadge } from './AvatarUnreadBadge'
import { useSettingsStore } from '@/stores/settingsStore'
import { useConversationFileDrop } from '@/hooks/useConversationFileDrop'
import { Trash2, Archive, ArchiveRestore, MessageCircle, Loader2 } from 'lucide-react'
import { ListEmpty } from '../ui/ListEmpty'
import { ConfirmDialog } from '../ConfirmDialog'
import { MessageRequestsBanner } from './MessageRequestsBanner'
import {
  SidebarListMenuProvider,
  SidebarListMenuPortal,
  useSidebarListMenu,
  MenuButton,
} from './SidebarListMenu'

// ============================================================================
// ConversationList & ArchiveList
// ============================================================================
// These two components share similar structure (keyboard nav, render loop,
// context menu) but are kept separate intentionally. Each is ~80 lines and
// self-contained; a parametrized base would save lines but add indirection
// for little readability gain. Revisit if they grow more shared behaviour.

export function ConversationList() {
  detectRenderLoop('ConversationList')
  const { t } = useTranslation()
  // Subscribe ONLY to the sidebar-ordered conversation ids. This re-renders the
  // list on reorder / membership change, NOT on per-conversation metadata churn
  // (unread, last message) or presence churn — each ConversationItem subscribes to
  // its OWN conversation / contact / room by id. (Mirrors RoomsList.)
  const conversationIds = useChatStore(useShallow((s) => s.conversationSidebarIds()))
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const archiveConversation = useChatStore((s) => s.archiveConversation)
  const { navigateToMessages } = useRouteSync()
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  trackSelectorChange('ConversationList', 'conversationIds', conversationIds)
  trackSelectorChange('ConversationList', 'activeConversationId', activeConversationId)

  // Mount-scoped handlers keep row props stable. Publish the latest actions
  // after commit, so an abandoned render cannot change a visible row's actions.
  const latestNavRef = useRef({ navigateToMessages })
  useLayoutEffect(() => { latestNavRef.current = { navigateToMessages } })
  const [handleConversationClick] = useState(() => (convId: string) => {
    const L = latestNavRef.current
    // Standard back stack: switching to a different conversation pushes a
    // history entry; re-selecting the active one dedups (replace).
    const current = chatStore.getState().activeConversationId
    void roomStore.getState().activateRoom(null)
    void chatStore.getState().activateConversation(convId)
    L.navigateToMessages(convId, { replace: shouldReplaceOnSelect(convId, current) })
  })
  const handleFileDrop = useConversationFileDrop(handleConversationClick)

  // Keyboard navigation
  // Alt+Arrow navigation is owned by the global handler in useKeyboardShortcuts
  // (goToPreviousItem / goToNextItem). The list reacts via `activeItemId` so the
  // active conversation is scrolled into view regardless of where focus lives.
  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav<string>({
    items: conversationIds,
    onSelect: (id) => handleConversationClick(id),
    listRef,
    getItemId: (id) => id,
    itemAttribute: 'data-conv-id',
    zoneRef,
    enableBounce: true,
    activeItemId: activeConversationId,
  })

  return (
    <SidebarListMenuProvider<Conversation>>
      <MessageRequestsBanner />
      {conversationIds.length === 0 ? (
        <ListEmpty icon={MessageCircle} title={t('conversations.noConversations')} />
      ) : (
        <div ref={listRef} className="px-2 space-y-0.5" {...getContainerProps()}>
          {conversationIds.map((id, index) => (
            <ConversationItem
              key={id}
              conversationId={id}
              isActive={id === activeConversationId}
              isSelected={index === selectedIndex}
              isKeyboardNav={isKeyboardNav}
              onClick={handleConversationClick}
              onFileDrop={handleFileDrop}
              {...getItemAttribute(index)}
              {...getItemProps(index)}
            />
          ))}
        </div>
      )}
      <ConversationContextMenu
        isArchived={false}
        onArchive={archiveConversation}
        onUnarchive={() => {}}
        onDelete={deleteConversation}
      />
    </SidebarListMenuProvider>
  )
}

// ArchiveList — see rationale above for why this isn't merged with ConversationList

export function ArchiveList() {
  const { t } = useTranslation()
  const archivedIds = useChatStore(useShallow((s) => s.archivedConversationSidebarIds()))
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const unarchiveConversation = useChatStore((s) => s.unarchiveConversation)
  const { navigateToMessages } = useRouteSync()
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Identity-stable click handler (see ConversationList for rationale).
  const latestNavRef = useRef({ navigateToMessages })
  latestNavRef.current = { navigateToMessages }
  const clickRef = useRef<((convId: string) => void) | null>(null)
  if (!clickRef.current) {
    clickRef.current = (convId: string) => {
      const L = latestNavRef.current
      // Standard back stack: switching to a different conversation pushes a
      // history entry; re-selecting the active one dedups (replace).
      const current = chatStore.getState().activeConversationId
      void roomStore.getState().activateRoom(null)
      void chatStore.getState().activateConversation(convId)
      L.navigateToMessages(convId, { replace: shouldReplaceOnSelect(convId, current) })
    }
  }
  const handleConversationClick = clickRef.current
  const handleFileDrop = useConversationFileDrop(handleConversationClick)

  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav<string>({
    items: archivedIds,
    onSelect: (id) => handleConversationClick(id),
    listRef,
    getItemId: (id) => id,
    itemAttribute: 'data-conv-id',
    zoneRef,
    enableBounce: true,
    activeItemId: activeConversationId,
  })

  if (archivedIds.length === 0) {
    return <ListEmpty className="h-full" icon={Archive} title={t('archive.noArchivedConversations')} />
  }

  return (
    <SidebarListMenuProvider<Conversation>>
      <div ref={listRef} className="px-2 space-y-0.5" {...getContainerProps()}>
        {archivedIds.map((id, index) => (
          <ConversationItem
            key={id}
            conversationId={id}
            isActive={id === activeConversationId}
            isSelected={index === selectedIndex}
            isKeyboardNav={isKeyboardNav}
            onClick={handleConversationClick}
            onFileDrop={handleFileDrop}
            {...getItemAttribute(index)}
            {...getItemProps(index)}
          />
        ))}
      </div>
      <ConversationContextMenu
        isArchived={true}
        onArchive={() => {}}
        onUnarchive={unarchiveConversation}
        onDelete={deleteConversation}
      />
    </SidebarListMenuProvider>
  )
}

// ============================================================================
// ConversationItem (memoized; keeps only its file-drag highlight)
// ============================================================================

interface ConversationItemProps {
  conversationId: string
  isActive: boolean
  isSelected?: boolean
  isKeyboardNav?: boolean
  onClick: (conversationId: string) => void
  /** A file dropped on the row: opens the conversation and stages the file in its composer. */
  onFileDrop?: (conversationId: string, file: File) => void
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseMove?: (e: React.MouseEvent) => void
  'data-conv-id'?: string
  'data-selected'?: boolean
}

export const ConversationItem = memo(function ConversationItem({
  conversationId,
  isActive,
  isSelected,
  isKeyboardNav,
  onClick,
  onFileDrop,
  onMouseEnter,
  onMouseMove,
  'data-selected': _dataSelected,
  ...rest
}: ConversationItemProps) {
  const { t, i18n } = useTranslation()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { getItemMenuProps, isOpen, longPressTriggered, targetItem } = useSidebarListMenu<Conversation>()
  const currentLang = i18n.language.split('-')[0]
  const timeFormat = useSettingsStore((s) => s.timeFormat)
  const densityMode = useSettingsStore((s) => s.densityMode)

  // Per-item subscriptions: each row re-renders only when ITS conversation /
  // contact / room / typing / draft changes — not when any OTHER conversation
  // updates or any contact's presence changes. The combined `conversations` map is
  // updated incrementally, so get(id) is a stable reference until THIS conversation
  // changes; contacts.get / getRoom are likewise stable per entry. (For a 1:1 the
  // room lookup is undefined; for a group chat the contact lookup is undefined.)
  const conversation = useChatStore((s) => s.conversations.get(conversationId))
  const contact = useRosterStore((s) => s.contacts.get(conversationId))
  const room = useRoomStore((s) => s.getRoom(conversationId))
  const typingCount = useChatStore((s) => s.typingStates.get(conversationId)?.size ?? 0)
  const isTyping = typingCount > 0
  const draft = useChatStore((s) => s.drafts.get(conversationId))
  const locked = useWebKeyLocked()
  const enabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  const decrypting = useSyncExternalStore(subscribeDecryptionActivity,
    () => isMessageDecrypting(conversationId, conversation?.lastMessage), () => false)
  const encryption = { decrypting, locked, enabled }
  const previewStatus = conversation?.lastMessage && conversationDecryptionKey(conversation.lastMessage, encryption)
  const activeDecrypt = previewStatus === 'chat.encryption.previewDecrypting'

  // Re-render when the local day rolls over: this row's timestamp label is relative
  // ("Yesterday" / a time-of-day for today), and the row is memoized, so nothing
  // else would re-evaluate it after midnight.
  useDayChange()

  // Highlight while a file is dragged over the row; the depth counts nested enter/leave pairs.
  const [isDropTarget, setIsDropTarget] = useState(false)
  const dragDepth = useRef(0)

  if (!conversation) return null
  const isGroupChat = conversation.type === 'groupchat'
  const avatarSize = densityMode === 'compact' ? 'sm' : 'md'
  const menuProps = getItemMenuProps(conversation)
  // While the long-press / context menu is open, highlight the targeted cell so
  // the user can clearly see which conversation the action will apply to.
  const isMenuTarget = isOpen && targetItem?.id === conversationId

  const handleClick = () => {
    if (isOpen || longPressTriggered.current) return
    onClick(conversationId)
  }

  // Only files dragged in from outside the app; images dragged out of a
  // message carry html or a link and are not offered to the conversation.
  const isFileDrag = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types)
    return !!onFileDrop && types.includes('Files') && !types.includes('text/html') && !types.includes('text/uri-list')
  }
  const handleDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current++
    setIsDropTarget(true)
  }
  const handleDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDropTarget(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setIsDropTarget(false)
    const file = e.dataTransfer.files[0]
    if (file) onFileDrop?.(conversationId, file)
  }

  return (
    <Tooltip
      content={contact ? <ContactTooltipContent contact={contact} t={t} forceOffline={forceOffline} /> : null}
      position="right"
      delay={600}
      maxWidth={280}
      disabled={isGroupChat || !contact}
      className="w-full"
    >
      <div
        {...rest}
        {...menuProps}
        onClick={handleClick}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onMouseEnter={onMouseEnter}
        onMouseMove={onMouseMove}
        className={`w-full relative px-2 sidebar-row touch-menu-row ${isSelected && isKeyboardNav ? 'keyboard-focus-row' : ''} rounded border flex items-center text-start cursor-pointer
                    transition-colors ${isDropTarget ? 'ring-2 ring-fluux-brand ring-inset z-10' : ''} ${isMenuTarget ? 'ring-2 ring-fluux-brand ring-inset z-10' : ''} ${isActive
                      ? "bg-fluux-sidebar-item-active text-fluux-text border-transparent before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-fluux-sidebar-item-active-accent"
                      : isMenuTarget
                        ? 'bg-fluux-hover text-fluux-text border-transparent'
                        : isSelected
                          ? 'bg-fluux-hover text-fluux-text border-transparent'
                          : isKeyboardNav
                            ? 'text-fluux-muted border-transparent'
                            : 'text-fluux-muted border-transparent hover:bg-fluux-hover hover:text-fluux-text'}`}
      >
        {/* Avatar wrapper — the unread badge overlays the avatar (UX_REVIEW §3.1)
            instead of taking its own flex column, so the name/preview column
            keeps its full width and stops truncating short names. */}
        <div className="relative flex-shrink-0">
          {isGroupChat ? (
            <RoomAvatar
              identifier={conversation.id}
              name={conversation.name}
              avatarUrl={room?.avatar}
              size={avatarSize}
              overlay={isTyping && !isActive ? <TypingIndicator /> : undefined}
            />
          ) : (
            <Avatar
              identifier={conversation.id}
              name={conversation.name}
              avatarUrl={contact?.avatar}
              size={avatarSize}
              presence={contact?.presence ?? 'offline'}
              forceOffline={forceOffline}
              overlay={isTyping && !isActive ? <TypingIndicator /> : undefined}
            />
          )}
          <AvatarUnreadBadge count={conversation.unreadCount} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p dir="auto" className={`truncate ${conversation.unreadCount > 0 ? 'font-semibold text-fluux-text' : 'font-medium'}`}>{conversation.name}</p>
            {conversation.lastMessage && (
              <span className="text-xs text-fluux-muted flex-shrink-0">
                {formatConversationTime(conversation.lastMessage.timestamp, t, currentLang, timeFormat)}
              </span>
            )}
          </div>
          {draft ? (
            <p className="truncate text-xs opacity-75 italic">
              {t('conversations.draft')}: {draft}
            </p>
          ) : conversation.lastMessage && isPreviewableMessage(conversation.lastMessage) && (
            // Guard against a non-previewable placeholder (e.g. a stuck bodiless
            // encrypted reaction) rendering as a blank "Me:" line. It still
            // carries a timestamp for ordering; it just shows no preview text
            // until a real message supersedes it.
            <p dir="auto" className={`truncate text-xs opacity-75 ${conversation.lastMessage.isRetracted ? 'italic' : ''}`}>
              {activeDecrypt && <Loader2 className="inline size-3 me-1 align-text-bottom motion-safe:animate-spin" aria-hidden="true" />}
              {conversation.lastMessage.isOutgoing ? `${t('chat.me')}: ` : ''}
              <span>{formatLocalizedPreview(conversation.lastMessage, t, encryption)}</span>
            </p>
          )}
        </div>
      </div>
    </Tooltip>
  )
})

// ============================================================================
// ConversationContextMenu
// ============================================================================

interface ConversationContextMenuProps {
  isArchived: boolean
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
}

function ConversationContextMenu({
  isArchived,
  onArchive,
  onUnarchive,
  onDelete,
}: ConversationContextMenuProps) {
  const { t } = useTranslation()
  const { targetItem, close } = useSidebarListMenu<Conversation>()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)

  const handleArchive = () => {
    if (targetItem) {
      close()
      onArchive(targetItem.id)
    }
  }

  const handleUnarchive = () => {
    if (targetItem) {
      close()
      onUnarchive(targetItem.id)
    }
  }

  const handleDeleteClick = () => {
    if (targetItem) {
      setDeleteTargetId(targetItem.id)
      close()
      setShowDeleteConfirm(true)
    }
  }

  const handleDeleteConfirm = () => {
    if (deleteTargetId) {
      setShowDeleteConfirm(false)
      onDelete(deleteTargetId)
      setDeleteTargetId(null)
    }
  }

  return (
    <>
      <SidebarListMenuPortal>
        {isArchived ? (
          <>
            <MenuButton
              onClick={handleUnarchive}
              icon={<ArchiveRestore className="size-4" />}
              label={t('conversations.unarchive')}
            />
            <MenuButton
              onClick={handleDeleteClick}
              icon={<Trash2 className="size-4" />}
              label={t('conversations.delete')}
              variant="danger"
            />
          </>
        ) : (
          <>
            <MenuButton
              onClick={handleArchive}
              icon={<Archive className="size-4" />}
              label={t('conversations.archive')}
            />
            <MenuButton
              onClick={handleDeleteClick}
              icon={<Trash2 className="size-4" />}
              label={t('conversations.delete')}
              variant="danger"
            />
          </>
        )}
      </SidebarListMenuPortal>

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('conversations.delete')}
          message={t('conversations.deleteConfirmMessage')}
          confirmLabel={t('conversations.delete')}
          onConfirm={handleDeleteConfirm}
          onCancel={() => {
            setShowDeleteConfirm(false)
            setDeleteTargetId(null)
          }}
        />
      )}
    </>
  )
}
