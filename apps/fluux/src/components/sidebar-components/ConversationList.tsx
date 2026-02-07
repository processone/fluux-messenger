import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useListKeyboardNav } from '@/hooks'
import {
  useChat,
  useRoster,
  useRoom,
  generateConsistentColorHexSync,
  formatMessagePreview,
  type Conversation,
  type Contact,
  type Room,
} from '@fluux/sdk'
import { Avatar, TypingIndicator } from '../Avatar'
import { Tooltip } from '../Tooltip'
import { useSidebarZone, ContactDevicesTooltip } from './types'
import { formatConversationTime } from '@/utils/dateFormat'
import { useSettingsStore } from '@/stores/settingsStore'
import { Hash, Trash2, Archive, ArchiveRestore } from 'lucide-react'
import {
  SidebarListMenuProvider,
  SidebarListMenuPortal,
  useSidebarListMenu,
  MenuButton,
} from './SidebarListMenu'

// ============================================================================
// ConversationList
// ============================================================================

export function ConversationList() {
  const { t } = useTranslation()
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    archiveConversation,
    typingStates,
    drafts,
  } = useChat()
  const { setActiveRoom, getRoom } = useRoom()
  const { contacts, restoreContactAvatarFromCache } = useRoster()
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Create maps for quick lookup
  const contactMap = new Map(contacts.map(c => [c.jid, c]))

  // Restore contact avatars from cache for contacts that have avatarHash but no avatar blob URL
  useEffect(() => {
    for (const contact of contacts) {
      if (contact.avatarHash && !contact.avatar) {
        restoreContactAvatarFromCache(contact.jid, contact.avatarHash)
      }
    }
  }, [contacts, restoreContactAvatarFromCache])

  const handleConversationClick = useCallback((convId: string) => {
    setActiveRoom(null)
    setActiveConversation(convId)
  }, [setActiveRoom, setActiveConversation])

  // Keyboard navigation
  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav({
    items: conversations,
    onSelect: (conv) => handleConversationClick(conv.id),
    listRef,
    getItemId: (conv) => conv.id,
    itemAttribute: 'data-conv-id',
    zoneRef,
    enableBounce: true,
    activateOnAltNav: true,
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
        {conversations.map((conv, index) => {
          const typingSet = typingStates.get(conv.id)
          const isTyping = typingSet && typingSet.size > 0
          const draft = drafts.get(conv.id)
          return (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              contact={conv.type === 'chat' ? contactMap.get(conv.id) : undefined}
              room={conv.type === 'groupchat' ? getRoom(conv.id) : undefined}
              isActive={conv.id === activeConversationId}
              isSelected={index === selectedIndex}
              isKeyboardNav={isKeyboardNav}
              isTyping={isTyping}
              draft={draft}
              onClick={() => handleConversationClick(conv.id)}
              {...getItemAttribute(index)}
              {...getItemProps(index)}
            />
          )
        })}
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

// ============================================================================
// ArchiveList
// ============================================================================

export function ArchiveList() {
  const { t } = useTranslation()
  const {
    archivedConversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    unarchiveConversation,
    typingStates,
    drafts,
  } = useChat()
  const { setActiveRoom, getRoom } = useRoom()
  const { contacts } = useRoster()
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  const contactMap = new Map(contacts.map(c => [c.jid, c]))

  const handleConversationClick = useCallback((convId: string) => {
    setActiveRoom(null)
    setActiveConversation(convId)
  }, [setActiveRoom, setActiveConversation])

  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav({
    items: archivedConversations,
    onSelect: (conv) => handleConversationClick(conv.id),
    listRef,
    getItemId: (conv) => conv.id,
    itemAttribute: 'data-conv-id',
    zoneRef,
    enableBounce: true,
    activateOnAltNav: true,
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
        {archivedConversations.map((conv, index) => {
          const typingSet = typingStates.get(conv.id)
          const isTyping = typingSet && typingSet.size > 0
          const draft = drafts.get(conv.id)
          return (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              contact={conv.type === 'chat' ? contactMap.get(conv.id) : undefined}
              room={conv.type === 'groupchat' ? getRoom(conv.id) : undefined}
              isActive={conv.id === activeConversationId}
              isSelected={index === selectedIndex}
              isKeyboardNav={isKeyboardNav}
              isTyping={isTyping}
              draft={draft}
              onClick={() => handleConversationClick(conv.id)}
              {...getItemAttribute(index)}
              {...getItemProps(index)}
            />
          )
        })}
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
  isTyping?: boolean
  draft?: string
  onClick: () => void
  onMouseEnter?: () => void
  onMouseMove?: () => void
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
  isTyping,
  draft,
  onClick,
  onMouseEnter,
  onMouseMove,
  'data-selected': _dataSelected,
  ...rest
}: ConversationItemProps) {
  const { t, i18n } = useTranslation()
  const { getItemMenuProps, isOpen, longPressTriggered } = useSidebarListMenu<Conversation>()
  const currentLang = i18n.language.split('-')[0]
  const timeFormat = useSettingsStore((s) => s.timeFormat)

  const isGroupChat = conversation.type === 'groupchat'
  const menuProps = getItemMenuProps(conversation)

  const handleClick = () => {
    if (isOpen || longPressTriggered.current) return
    onClick()
  }

  return (
    <Tooltip
      content={contact ? <ContactDevicesTooltip contact={contact} t={t} /> : null}
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
        className={`w-full px-2 py-1.5 rounded flex items-center gap-3 text-left cursor-pointer
                    transition-colors ${isActive
                      ? 'bg-fluux-active text-fluux-text'
                      : isSelected
                        ? 'bg-fluux-hover text-fluux-text ring-1 ring-fluux-brand/50'
                        : isKeyboardNav
                          ? 'text-fluux-muted'
                          : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'}`}
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
            overlay={isTyping ? <TypingIndicator /> : undefined}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate font-medium">{conversation.name}</p>
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
            <p className={`truncate text-xs opacity-75 ${conversation.lastMessage.isRetracted ? 'italic' : ''}`}>
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

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && (
        <div data-modal="true" className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-fluux-sidebar rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-fluux-text mb-2">
              {t('conversations.delete')}
            </h3>
            <p className="text-sm text-fluux-muted mb-4">
              {t('conversations.deleteConfirmMessage')}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false)
                  setDeleteTargetId(null)
                }}
                className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active
                           rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-sm text-white bg-fluux-red hover:bg-fluux-red/80
                           rounded-lg transition-colors"
              >
                {t('conversations.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
