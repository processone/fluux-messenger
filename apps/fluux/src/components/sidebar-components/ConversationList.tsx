import React, { useState, useRef, memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useListKeyboardNav, useRouteSync } from '@/hooks'
import { detectRenderLoop, trackSelectorChange } from '@/utils/renderLoopDetector'
import {
  useChat,
  useRoster,
  chatStore,
  roomStore,
  generateConsistentColorHexSync,
  formatMessagePreview,
  type Conversation,
  type Contact,
  type Room,
} from '@fluux/sdk'
import { useChatStore, useConnectionStore } from '@fluux/sdk/react'
import { Avatar, TypingIndicator } from '../Avatar'
import { Tooltip } from '../Tooltip'
import { useSidebarZone, ContactTooltipContent } from './types'
import { formatConversationTime } from '@/utils/dateFormat'
import { useSettingsStore } from '@/stores/settingsStore'
import { Hash, Trash2, Archive, ArchiveRestore } from 'lucide-react'
import { ConfirmDialog } from '../ConfirmDialog'
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
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    archiveConversation,
  } = useChat()
  // Direct store access — avoids subscribing to all room state (activeRoom, activeMessages,
  // allRooms, roomsWithUnreadCount, etc.) that useRoom() would pull in. During sync,
  // rapid room updates would cause 500+ renders/second through useRoom().
  const setActiveRoom = useCallback(async (roomJid: string | null) => {
    if (roomJid) {
      await roomStore.getState().loadMessagesFromCache(roomJid, { limit: 100 })
    }
    roomStore.getState().setActiveRoom(roomJid)
  }, [])
  const getRoom = useCallback(
    (roomJid: string) => roomStore.getState().rooms.get(roomJid),
    []
  )
  const { contacts } = useRoster()
  const { navigateToMessages } = useRouteSync()
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Diagnostic: track every selector-derived value per render. Dev-only.
  // Note: typingStates / drafts are NOT subscribed at the list level — each
  // ConversationItem subscribes to its own entry to avoid re-rendering the
  // full list on every typing / draft change during background sync.
  trackSelectorChange('ConversationList', 'conversations', conversations)
  trackSelectorChange('ConversationList', 'activeConversationId', activeConversationId)
  trackSelectorChange('ConversationList', 'contacts', contacts)

  // Create maps for quick lookup
  const contactMap = new Map(contacts.map(c => [c.jid, c]))

  const handleConversationClick = (convId: string) => {
    // Push if going from list to first item, replace if switching between items
    const hasActive = !!chatStore.getState().activeConversationId
    void setActiveRoom(null)
    void setActiveConversation(convId)
    navigateToMessages(convId, { replace: hasActive })
  }

  // Keyboard navigation
  // Alt+Arrow navigation is owned by the global handler in useKeyboardShortcuts
  // (goToPreviousItem / goToNextItem). The list reacts via `activeItemId` so the
  // active conversation is scrolled into view regardless of where focus lives.
  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav({
    items: conversations,
    onSelect: (conv) => handleConversationClick(conv.id),
    listRef,
    getItemId: (conv) => conv.id,
    itemAttribute: 'data-conv-id',
    zoneRef,
    enableBounce: true,
    activeItemId: activeConversationId,
  })

  if (conversations.length === 0) {
    return (
      <div className="px-3 py-4 text-fluux-muted text-sm text-center">
        {t('conversations.noConversations')}
      </div>
    )
  }

  return (
    <SidebarListMenuProvider<Conversation>>
      <div ref={listRef} className="px-2 space-y-0.5" {...getContainerProps()}>
        {conversations.map((conv, index) => (
          <ConversationItem
            key={conv.id}
            conversation={conv}
            contact={conv.type === 'chat' ? contactMap.get(conv.id) : undefined}
            room={conv.type === 'groupchat' ? getRoom(conv.id) : undefined}
            isActive={conv.id === activeConversationId}
            isSelected={index === selectedIndex}
            isKeyboardNav={isKeyboardNav}
            onClick={() => handleConversationClick(conv.id)}
            {...getItemAttribute(index)}
            {...getItemProps(index)}
          />
        ))}
      </div>
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
  const {
    archivedConversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    unarchiveConversation,
  } = useChat()
  const setActiveRoom = useCallback(async (roomJid: string | null) => {
    if (roomJid) {
      await roomStore.getState().loadMessagesFromCache(roomJid, { limit: 100 })
    }
    roomStore.getState().setActiveRoom(roomJid)
  }, [])
  const getRoom = useCallback(
    (roomJid: string) => roomStore.getState().rooms.get(roomJid),
    []
  )
  const { contacts } = useRoster()
  const { navigateToArchive } = useRouteSync()
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  const contactMap = new Map(contacts.map(c => [c.jid, c]))

  const handleConversationClick = (convId: string) => {
    const hasActive = !!chatStore.getState().activeConversationId
    void setActiveRoom(null)
    void setActiveConversation(convId)
    navigateToArchive(convId, { replace: hasActive })
  }

  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav({
    items: archivedConversations,
    onSelect: (conv) => handleConversationClick(conv.id),
    listRef,
    getItemId: (conv) => conv.id,
    itemAttribute: 'data-conv-id',
    zoneRef,
    enableBounce: true,
    activeItemId: activeConversationId,
  })

  if (archivedConversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-fluux-muted px-4 text-center">
        <Archive className="w-12 h-12 mb-3 opacity-50" />
        <p>{t('archive.noArchivedConversations')}</p>
      </div>
    )
  }

  return (
    <SidebarListMenuProvider<Conversation>>
      <div ref={listRef} className="px-2 space-y-0.5" {...getContainerProps()}>
        {archivedConversations.map((conv, index) => (
          <ConversationItem
            key={conv.id}
            conversation={conv}
            contact={conv.type === 'chat' ? contactMap.get(conv.id) : undefined}
            room={conv.type === 'groupchat' ? getRoom(conv.id) : undefined}
            isActive={conv.id === activeConversationId}
            isSelected={index === selectedIndex}
            isKeyboardNav={isKeyboardNav}
            onClick={() => handleConversationClick(conv.id)}
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
// ConversationItem (memoized, stateless)
// ============================================================================

interface ConversationItemProps {
  conversation: Conversation
  contact?: Contact
  room?: Room
  isActive: boolean
  isSelected?: boolean
  isKeyboardNav?: boolean
  onClick: () => void
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseMove?: (e: React.MouseEvent) => void
  'data-conv-id'?: string
  'data-selected'?: boolean
}

export const ConversationItem = memo(function ConversationItem({
  conversation,
  contact,
  room,
  isActive,
  isSelected,
  isKeyboardNav,
  onClick,
  onMouseEnter,
  onMouseMove,
  'data-selected': _dataSelected,
  ...rest
}: ConversationItemProps) {
  const { t, i18n } = useTranslation()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { getItemMenuProps, isOpen, longPressTriggered } = useSidebarListMenu<Conversation>()
  const currentLang = i18n.language.split('-')[0]
  const timeFormat = useSettingsStore((s) => s.timeFormat)

  // Per-item subscriptions: each item only re-renders when ITS typing/draft
  // changes, not when any conversation's state changes.
  const typingCount = useChatStore((s) => s.typingStates.get(conversation.id)?.size ?? 0)
  const isTyping = typingCount > 0
  const draft = useChatStore((s) => s.drafts.get(conversation.id))

  const isGroupChat = conversation.type === 'groupchat'
  const menuProps = getItemMenuProps(conversation)

  const handleClick = () => {
    if (isOpen || longPressTriggered.current) return
    onClick()
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
        onMouseEnter={onMouseEnter}
        onMouseMove={onMouseMove}
        className={`w-full relative px-2 py-1.5 rounded border flex items-center gap-3 text-start cursor-pointer
                    transition-colors ${isActive
                      ? "bg-fluux-sidebar-item-active text-fluux-text border-transparent before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-fluux-sidebar-item-active-accent"
                      : isSelected
                        ? 'bg-fluux-hover text-fluux-text border-fluux-brand'
                        : isKeyboardNav
                          ? 'text-fluux-muted border-transparent'
                          : 'text-fluux-muted border-transparent hover:bg-fluux-hover hover:text-fluux-text'}`}
      >
        {isGroupChat ? (
          room?.avatar ? (
            <img
              src={room.avatar}
              alt={conversation.name}
              className="w-8 h-8 rounded-full object-cover flex-shrink-0"
              draggable={false}
            />
          ) : (
            <Hash
              className="w-8 h-8 flex-shrink-0 p-1.5 rounded-full text-white"
              style={{ backgroundColor: generateConsistentColorHexSync(conversation.id, { saturation: 60, lightness: 45 }) }}
            />
          )
        ) : (
          <Avatar
            identifier={conversation.id}
            name={conversation.name}
            avatarUrl={contact?.avatar}
            size="sm"
            presence={contact?.presence ?? 'offline'}
            forceOffline={forceOffline}
            overlay={isTyping ? <TypingIndicator /> : undefined}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p dir="auto" className="truncate font-medium">{conversation.name}</p>
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
          ) : conversation.lastMessage && (
            <p dir="auto" className={`truncate text-xs opacity-75 ${conversation.lastMessage.isRetracted ? 'italic' : ''}`}>
              {conversation.lastMessage.isOutgoing ? `${t('chat.me')}: ` : ''}
              {conversation.lastMessage.isRetracted ? t('chat.messageDeleted') : formatMessagePreview(conversation.lastMessage)}
            </p>
          )}
        </div>
        {conversation.unreadCount > 0 && (
          <span className="min-w-5 h-5 px-1.5 bg-fluux-red text-white text-xs font-bold rounded-full flex-shrink-0 flex items-center justify-center">
            {conversation.unreadCount}
          </span>
        )}
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
              icon={<ArchiveRestore className="w-4 h-4" />}
              label={t('conversations.unarchive')}
            />
            <MenuButton
              onClick={handleDeleteClick}
              icon={<Trash2 className="w-4 h-4" />}
              label={t('conversations.delete')}
              variant="danger"
            />
          </>
        ) : (
          <>
            <MenuButton
              onClick={handleArchive}
              icon={<Archive className="w-4 h-4" />}
              label={t('conversations.archive')}
            />
            <MenuButton
              onClick={handleDeleteClick}
              icon={<Trash2 className="w-4 h-4" />}
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
