import React, { useState, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useContextMenu, useListKeyboardNav, useRouteSync } from '@/hooks'
import { detectRenderLoop, trackSelectorChange } from '@/utils/renderLoopDetector'
import {
  useRoomActions,
  roomStore,
  generateConsistentColorHexSync,
} from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { formatLocalizedPreview } from '@/utils/messagePreviewText'
import { EditBookmarkModal } from '../EditBookmarkModal'
import { Tooltip } from '../Tooltip'
import { useSidebarZone } from './types'
import { formatConversationTime } from '@/utils/dateFormat'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
import { CreateRoomModal } from '../CreateRoomModal'
import {
  Hash,
  LogIn,
  LogOut,
  Pencil,
  BookmarkX,
  ToggleLeft,
  ToggleRight,
  Zap,
  Loader2,
  Plus,
} from 'lucide-react'

type SidebarSection = 'quick' | 'joined' | 'bookmarked'

/** Decode a "<section> <jid>" entry from roomSidebarJids(). */
function decodeSidebarEntry(entry: string): { section: SidebarSection; jid: string } {
  const sep = entry.indexOf(' ')
  return { section: entry.slice(0, sep) as SidebarSection, jid: entry.slice(sep + 1) }
}

export function RoomsList() {
  detectRenderLoop('RoomsList')
  const { t } = useTranslation()

  // Subscribe ONLY to the sidebar-ordered, section-encoded list of room JIDs.
  // This re-renders the list only on membership / order / section changes — NOT on
  // per-room message, unread, or last-message-preview churn (which is the storm a
  // multi-room join produces). Each RoomItem subscribes to its own room by JID, so
  // a message to one room re-renders just that row. drafts/typing are likewise per-row.
  const sidebarEntries = useRoomStore(useShallow((s) => s.roomSidebarJids()))
  const activeRoomJid = useRoomStore((s) => s.activeRoomJid)
  const { joinRoom, joinResult, leaveRoom, setBookmark, removeBookmark, setActiveRoom } = useRoomActions()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const addToast = useToastStore((s) => s.addToast)
  const { navigateToRooms } = useRouteSync()
  const [editingRoomJid, setEditingRoomJid] = useState<string | null>(null)
  const [showCreateRoom, setShowCreateRoom] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Diagnostic: track the subscription value per render (dev-only).
  trackSelectorChange('RoomsList', 'sidebarEntries', sidebarEntries)
  trackSelectorChange('RoomsList', 'activeRoomJid', activeRoomJid)

  // Decode into sections (display order is already correct in sidebarEntries).
  const quickChatJids: string[] = []
  const joinedJids: string[] = []
  const bookmarkedJids: string[] = []
  const flatJids: string[] = []
  for (const entry of sidebarEntries) {
    const { section, jid } = decodeSidebarEntry(entry)
    flatJids.push(jid)
    if (section === 'quick') quickChatJids.push(jid)
    else if (section === 'joined') joinedJids.push(jid)
    else bookmarkedJids.push(jid)
  }
  const jidToIndex = new Map(flatJids.map((jid, i) => [jid, i]))

  // Stable per-row callbacks (taking a JID) so the memoized RoomItem rows keep
  // identity-stable props and only re-render when their own room changes.
  //
  // NOTE: useCallback is intentionally NOT used here. With the React Compiler
  // enabled, callbacks that are only consumed by JSX (not by a hook dependency)
  // are left as fresh closures each render; the parent's JSX memoization is
  // supposed to cover them, but it is invalidated whenever activeRoomJid /
  // selectedIndex change — which re-creates the closures and breaks RoomItem's
  // React.memo, re-rendering every row. Building the handlers once in a ref and
  // routing through a "latest" ref keeps their identity stable for the lifetime
  // of the list while always invoking the current actions.
  const latestRef = useRef({ setActiveConversation, setActiveRoom, joinRoom, joinResult, leaveRoom, removeBookmark, setBookmark, navigateToRooms, setEditingRoomJid, addToast, t })
  latestRef.current = { setActiveConversation, setActiveRoom, joinRoom, joinResult, leaveRoom, removeBookmark, setBookmark, navigateToRooms, setEditingRoomJid, addToast, t }

  const handlersRef = useRef<{
    onSelect: (roomJid: string) => void
    onActivate: (roomJid: string) => void
    onJoin: (roomJid: string) => void
    onLeave: (roomJid: string) => void
    onEditBookmark: (roomJid: string) => void
    onRemoveBookmark: (roomJid: string) => void
    onToggleAutojoin: (roomJid: string) => void
  } | null>(null)
  if (!handlersRef.current) {
    handlersRef.current = {
      onSelect: (roomJid) => {
        const L = latestRef.current
        const hasActive = !!roomStore.getState().activeRoomJid
        void L.setActiveConversation(null)
        void roomStore.getState().activateRoom(roomJid)
        L.navigateToRooms(roomJid, { replace: hasActive })
      },
      onActivate: async (roomJid) => {
        const L = latestRef.current
        const room = roomStore.getState().getRoom(roomJid)
        const hasActive = !!roomStore.getState().activeRoomJid
        if (room?.joined) {
          void L.setActiveConversation(null)
          void roomStore.getState().activateRoom(roomJid)
        } else {
          try {
            await L.joinRoom(roomJid, room?.nickname ?? '')
            await L.joinResult(roomJid)
          } catch (err) {
            // Do not activate/navigate into a room we failed to join.
            L.addToast('error', getRoomJoinErrorMessage(L.t, err))
            return
          }
          void L.setActiveConversation(null)
          void roomStore.getState().activateRoom(roomJid)
        }
        L.navigateToRooms(roomJid, { replace: hasActive })
      },
      onJoin: (roomJid) => {
        const L = latestRef.current
        const room = roomStore.getState().getRoom(roomJid)
        void (async () => {
          try {
            await L.joinRoom(roomJid, room?.nickname ?? '')
            await L.joinResult(roomJid)
          } catch (err) {
            L.addToast('error', getRoomJoinErrorMessage(L.t, err))
          }
        })()
      },
      onLeave: (roomJid) => {
        const L = latestRef.current
        if (roomStore.getState().activeRoomJid === roomJid) void L.setActiveRoom(null)
        void L.leaveRoom(roomJid)
      },
      onEditBookmark: (roomJid) => latestRef.current.setEditingRoomJid(roomJid),
      onRemoveBookmark: (roomJid) => { void latestRef.current.removeBookmark(roomJid) },
      onToggleAutojoin: (roomJid) => {
        const room = roomStore.getState().getRoom(roomJid)
        if (!room) return
        void latestRef.current.setBookmark(roomJid, {
          name: room.name,
          nick: room.nickname,
          autojoin: !room.autojoin,
        })
      },
    }
  }
  const handlers = handlersRef.current

  // Keyboard navigation over the flat JID list. Enter selects the highlighted room.
  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav({
    items: flatJids,
    onSelect: handlers.onSelect,
    listRef,
    getItemId: (jid) => jid,
    itemAttribute: 'data-room-jid',
    zoneRef,
    enableBounce: true,
    activeItemId: activeRoomJid,
  })

  if (sidebarEntries.length === 0) {
    return (
      <>
        <div className="px-3 py-4 text-fluux-muted text-sm text-center">
          <Hash className="size-12 mx-auto mb-3 opacity-50" />
          <p className="mb-2">{t('rooms.noRooms')}</p>
          <p className="text-xs opacity-75 mb-3">
            {t('rooms.noRoomsHint')}
          </p>
          <button
            onClick={() => setShowCreateRoom(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-fluux-brand bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-lg transition-colors"
          >
            <Plus className="size-3" />
            {t('rooms.createRoom')}
          </button>
        </div>
        {showCreateRoom && (
          <CreateRoomModal onClose={() => setShowCreateRoom(false)} />
        )}
      </>
    )
  }

  const editingRoom = editingRoomJid ? roomStore.getState().getRoom(editingRoomJid) : null

  const renderRoom = (jid: string, isQuickChat: boolean) => {
    const flatIndex = jidToIndex.get(jid) ?? -1
    return (
      <RoomItem
        key={jid}
        roomJid={jid}
        isActive={jid === activeRoomJid}
        isSelected={flatIndex === selectedIndex}
        isKeyboardNav={isKeyboardNav}
        isQuickChat={isQuickChat}
        onSelect={handlers.onSelect}
        onActivate={handlers.onActivate}
        onJoin={handlers.onJoin}
        onLeave={handlers.onLeave}
        onEditBookmark={handlers.onEditBookmark}
        onRemoveBookmark={handlers.onRemoveBookmark}
        onToggleAutojoin={handlers.onToggleAutojoin}
        {...getItemAttribute(flatIndex)}
        {...getItemProps(flatIndex)}
      />
    )
  }

  return (
    <div ref={listRef} className="px-2 py-2" {...getContainerProps()}>
      {/* Quick Chats - only show if any exist */}
      {quickChatJids.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 flex items-center gap-1">
            <Zap className="size-3 text-amber-500" />
            {t('rooms.quickChatSection')} — {quickChatJids.length}
          </h3>
          <div className="space-y-0.5">
            {quickChatJids.map((jid) => renderRoom(jid, true))}
          </div>
        </div>
      )}

      {/* Joined rooms */}
      {joinedJids.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2">
              {t('rooms.joined')} — {joinedJids.length}
          </h3>
          <div className="space-y-0.5">
            {joinedJids.map((jid) => renderRoom(jid, false))}
          </div>
        </>
      )}

      {/* Bookmarked but not joined */}
      {bookmarkedJids.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 mt-4">
            {t('rooms.bookmarked')} — {bookmarkedJids.length}
          </h3>
          <div className="space-y-0.5">
            {bookmarkedJids.map((jid) => renderRoom(jid, false))}
          </div>
        </>
      )}

      {/* Edit Bookmark Modal */}
      {editingRoom && (
        <EditBookmarkModal
          room={editingRoom}
          onSave={async (options) => {
            await setBookmark(editingRoom.jid, options)
            setEditingRoomJid(null)
          }}
          onClose={() => setEditingRoomJid(null)}
        />
      )}

      {/* Create Room Modal */}
      {showCreateRoom && (
        <CreateRoomModal onClose={() => setShowCreateRoom(false)} />
      )}
    </div>
  )
}

interface RoomItemProps {
  roomJid: string
  isActive: boolean
  isSelected?: boolean
  isKeyboardNav?: boolean
  onSelect: (roomJid: string) => void
  onActivate: (roomJid: string) => void
  onJoin: (roomJid: string) => void
  onLeave: (roomJid: string) => void
  onEditBookmark: (roomJid: string) => void
  onRemoveBookmark: (roomJid: string) => void
  onToggleAutojoin: (roomJid: string) => void
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseMove?: (e: React.MouseEvent) => void
  isQuickChat?: boolean
  'data-room-jid'?: string
  'data-selected'?: boolean
}

const RoomItem = memo(function RoomItem({
  roomJid,
  isActive,
  isSelected,
  isKeyboardNav,
  onSelect,
  onActivate,
  onJoin,
  onLeave,
  onEditBookmark,
  onRemoveBookmark,
  onToggleAutojoin,
  onMouseEnter,
  onMouseMove,
  isQuickChat = false,
  'data-selected': _dataSelected, // Consumed but not used in DOM
  ...rest
}: RoomItemProps) {
  const { t, i18n } = useTranslation()
  const menu = useContextMenu()
  const currentLang = i18n.language.split('-')[0]
  const timeFormat = useSettingsStore((s) => s.timeFormat)
  // Per-row subscriptions: this row re-renders only when ITS room (messages,
  // unread, last message, presence) or draft changes — not when any other room
  // updates during a multi-room join / MAM sync.
  const room = useRoomStore((s) => s.getRoom(roomJid))
  const draft = useRoomStore((s) => s.drafts.get(roomJid))

  if (!room) return null

  // Get last message for preview (uses pre-computed lastMessage from metadata for better performance)
  const lastMessage = room.lastMessage ?? null

  const handleClick = () => {
    if (menu.isOpen || menu.longPressTriggered.current) return
    // Don't allow click during joining - room is not ready yet
    if (room.isJoining) return
    onSelect(roomJid)
  }

  const handleDoubleClick = () => {
    if (menu.isOpen) return
    // Don't allow double-click during joining
    if (room.isJoining) return
    onActivate(roomJid)
  }

  // Determine tooltip based on state
  const getTooltipContent = () => {
    if (room.isJoining) return t('rooms.joining')
    if (room.joined) {
      // Show user count and nickname in tooltip for joined rooms
      const userCount = room.occupants.size
      const userText = `${userCount} ${userCount === 1 ? t('rooms.user') : t('rooms.users')}`
      if (room.nickname) {
        return `${userText} • ${room.nickname}`
      }
      return userText
    }
    return t('rooms.doubleClickToJoin')
  }

  const tooltipContent = getTooltipContent()

  return (
    <>
      <Tooltip content={tooltipContent} position="right" className="w-full">
        <div
          {...rest}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={menu.handleContextMenu}
          onTouchStart={menu.handleTouchStart}
          onTouchEnd={menu.handleTouchEnd}
          onTouchMove={menu.handleTouchEnd}
          onMouseEnter={onMouseEnter}
          onMouseMove={onMouseMove}
          className={`w-full relative px-2 py-1.5 rounded border flex items-center gap-3
                   transition-colors cursor-pointer group
                   ${room.isJoining
                     ? isSelected
                       ? 'bg-fluux-hover text-fluux-text border-fluux-brand opacity-70'
                       : isKeyboardNav
                         ? 'text-fluux-muted border-transparent opacity-70'
                         : 'text-fluux-muted border-transparent hover:bg-fluux-hover hover:text-fluux-text opacity-70'
                     : room.joined
                       ? isActive
                         ? "bg-fluux-sidebar-item-active text-fluux-text border-transparent before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-fluux-sidebar-item-active-accent"
                         : isSelected
                           ? 'bg-fluux-hover text-fluux-text border-fluux-brand'
                           : isKeyboardNav
                             ? 'text-fluux-muted border-transparent'
                             : 'text-fluux-muted border-transparent hover:bg-fluux-hover hover:text-fluux-text'
                       : isActive
                         ? "bg-fluux-sidebar-item-active text-fluux-text border-transparent opacity-80 before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-fluux-sidebar-item-active-accent"
                         : isSelected
                           ? 'bg-fluux-hover text-fluux-text border-fluux-brand opacity-80'
                           : isKeyboardNav
                             ? 'text-fluux-muted border-transparent opacity-60'
                             : 'text-fluux-muted border-transparent hover:bg-fluux-hover hover:text-fluux-text opacity-60 hover:opacity-100'
                   }`}
      >
        {/* Room avatar or icon */}
        <div className="relative flex-shrink-0">
          {room.avatar ? (
            <img
              src={room.avatar}
              alt={room.name}
              className="size-8 rounded-full object-cover"
              draggable={false}
            />
          ) : isQuickChat ? (
            <Zap className="size-8 p-1.5 bg-amber-500/20 rounded-full text-amber-500" />
          ) : (
            <Hash
              className="size-8 p-1.5 rounded-full text-white"
              style={{ backgroundColor: generateConsistentColorHexSync(room.jid, { saturation: 60, lightness: 45 }) }}
            />
          )}
          {/* Joining spinner */}
          {room.isJoining && (
            <div className="absolute -bottom-0.5 -end-0.5 size-3.5 rounded-full border-2 border-fluux-sidebar bg-fluux-sidebar flex items-center justify-center">
              <Loader2 className="size-2.5 text-fluux-brand animate-spin" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p dir="auto" className="truncate font-medium">{room.name}</p>
            {/* Activity dot for unread (non-mention) activity */}
            {room.joined && room.unreadCount > 0 && room.mentionsCount === 0 && (
              <Tooltip content={`${room.unreadCount} unread`} position="top">
                <div className="size-2.5 rounded-full bg-fluux-brand flex-shrink-0" />
              </Tooltip>
            )}
            {/* Mentions count badge */}
            {room.mentionsCount > 0 && (
              <span className="min-w-5 h-5 px-1.5 bg-fluux-red text-white text-xs font-bold rounded-full flex-shrink-0 flex items-center justify-center">
                @{room.mentionsCount}
              </span>
            )}
            {/* Timestamp */}
            {lastMessage && (
              <span className="text-xs text-fluux-muted flex-shrink-0 ms-auto">
                {formatConversationTime(lastMessage.timestamp, t, currentLang, timeFormat)}
              </span>
            )}
          </div>
          <p dir="auto" className={`truncate text-xs opacity-75 ${draft ? 'italic' : ''}`}>
            {draft ? (
              <>{t('conversations.draft')}: {draft}</>
            ) : room.isJoining ? (
              <span className="italic">{t('rooms.joining')}</span>
            ) : lastMessage ? (
              <span className={lastMessage.isRetracted ? 'italic' : ''}>
                {lastMessage.isOutgoing ? `${t('chat.me')}: ` : `${lastMessage.nick}: `}
                {lastMessage.isRetracted ? t('chat.messageDeleted') : formatLocalizedPreview(lastMessage, t)}
              </span>
            ) : room.joined ? (
              // No messages yet - show room subject if available, otherwise subtle placeholder
              room.subject ? (
                <span className="text-fluux-muted">{room.subject}</span>
              ) : (
                <span className="text-fluux-muted italic">{t('rooms.noMessages')}</span>
              )
            ) : (
              <>
                {room.nickname && t('rooms.asNickname', { nickname: room.nickname })}
                {room.autojoin && ` • ${t('rooms.autoJoin')}`}
              </>
            )}
          </p>
        </div>
        </div>
      </Tooltip>

      {/* Context Menu */}
      {menu.isOpen && (
        <div
          ref={menu.menuRef}
          className="fixed bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50 min-w-48"
          style={{ left: menu.position.x, top: menu.position.y }}
        >
          {/* Join (only for non-joined rooms) */}
          {!room.joined && (
            <button
              onClick={() => { menu.close(); onJoin(roomJid) }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
            >
              <LogIn className="size-4" />
              <span>{t('rooms.joinRoom')}</span>
            </button>
          )}

          {/* Edit bookmark (only for bookmarked rooms) */}
          {room.isBookmarked && (
            <button
              onClick={() => { menu.close(); onEditBookmark(roomJid) }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
            >
              <Pencil className="size-4" />
              <span>{t('rooms.editBookmark')}</span>
            </button>
          )}

          {/* Toggle autojoin (only for bookmarked rooms) */}
          {room.isBookmarked && (
            <button
              onClick={() => { menu.close(); onToggleAutojoin(roomJid) }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-text hover:bg-fluux-brand hover:text-fluux-text-on-accent transition-colors"
            >
              {room.autojoin ? (
                <>
                  <ToggleRight className="size-4 text-fluux-green" />
                  <span>{t('rooms.autojoinOn')}</span>
                </>
              ) : (
                <>
                  <ToggleLeft className="size-4" />
                  <span>{t('rooms.autojoinOff')}</span>
                </>
              )}
            </button>
          )}

          {/* Divider before destructive actions */}
          {(room.joined || room.isBookmarked) && (
            <div className="my-1 border-t border-fluux-hover" />
          )}

          {/* Leave room (only for joined rooms) */}
          {room.joined && (
            <button
              onClick={() => { menu.close(); onLeave(roomJid) }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-red hover:bg-fluux-red hover:text-white transition-colors"
            >
              <LogOut className="size-4" />
              <span>{t('rooms.leaveRoom')}</span>
            </button>
          )}

          {/* Remove bookmark (only for bookmarked rooms) */}
          {room.isBookmarked && (
            <button
              onClick={() => { menu.close(); onRemoveBookmark(roomJid) }}
              className="w-full px-3 py-2 flex items-center gap-3 text-start text-fluux-red hover:bg-fluux-red hover:text-white transition-colors"
            >
              <BookmarkX className="size-4" />
              <span>{t('rooms.removeBookmark')}</span>
            </button>
          )}
        </div>
      )}
    </>
  )
})
