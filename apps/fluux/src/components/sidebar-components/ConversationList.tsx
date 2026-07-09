import React, { useState, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useListKeyboardNav, useRouteSync } from '@/hooks'
import { detectRenderLoop, trackSelectorChange } from '@/utils/renderLoopDetector'
import {
  chatStore,
  roomStore,
  isPreviewableMessage,
  type Conversation,
} from '@fluux/sdk'
import { formatLocalizedPreview } from '@/utils/messagePreviewText'
import { shouldReplaceOnSelect } from '@/utils/navigationHistory'
import { useChatStore, useConnectionStore, useRosterStore, useRoomStore } from '@fluux/sdk/react'
import { Avatar, TypingIndicator } from '../Avatar'
import { RoomAvatar } from '../RoomAvatar'
import { Tooltip } from '../Tooltip'
import { useSidebarZone, ContactTooltipContent } from './types'
import { formatConversationTime } from '@/utils/dateFormat'
import { useSettingsStore } from '@/stores/settingsStore'
import { Trash2, Archive, ArchiveRestore, MessageCircle } from 'lucide-react'
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

  // Identity-stable click handler. useCallback is unreliable here: the React
  // Compiler leaves JSX-only callbacks as fresh closures, which breaks
  // ConversationItem's React.memo and re-renders the whole list on every update.
  // A lazy-init ref + "latest" ref keeps the handler stable for the list's life.
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
  conversationId: string
  isActive: boolean
  isSelected?: boolean
  isKeyboardNav?: boolean
  onClick: (conversationId: string) => void
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
        className={`w-full relative px-2 sidebar-row rounded border flex items-center text-start cursor-pointer
                    transition-colors ${isMenuTarget ? 'ring-2 ring-fluux-brand ring-inset z-10' : ''} ${isActive
                      ? "bg-fluux-sidebar-item-active text-fluux-text border-transparent before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-fluux-sidebar-item-active-accent"
                      : isMenuTarget
                        ? 'bg-fluux-hover text-fluux-text border-transparent'
                        : isSelected
                          ? 'bg-fluux-hover text-fluux-text border-fluux-brand'
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
          {conversation.unreadCount > 0 && (
            <span className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge-strong text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {conversation.unreadCount}
            </span>
          )}
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
              {conversation.lastMessage.isOutgoing ? `${t('chat.me')}: ` : ''}
              {conversation.lastMessage.isRetracted ? t('chat.messageDeleted') : formatLocalizedPreview(conversation.lastMessage, t)}
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
