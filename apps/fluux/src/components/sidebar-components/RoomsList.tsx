import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useContextMenu, useListKeyboardNav } from '@/hooks'
import {
  useRoom,
  generateConsistentColorHexSync,
  formatMessagePreview,
  type Room,
} from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'
import { EditBookmarkModal } from '../EditBookmarkModal'
import { Tooltip } from '../Tooltip'
import { useSidebarZone } from './types'
import { formatConversationTime } from '@/utils/dateFormat'
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
} from 'lucide-react'

export function RoomsList() {
  const { t } = useTranslation()
  const { allRooms: rooms, joinRoom, leaveRoom, setBookmark, removeBookmark, activeRoomJid, setActiveRoom, restoreRoomAvatarFromCache, drafts } = useRoom()
  // NOTE: Use direct store subscription to avoid re-renders from activeMessages changes
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const [editingRoom, setEditingRoom] = useState<Room | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const zoneRef = useSidebarZone()

  // Restore room avatars from cache for rooms that have avatarHash but no avatar blob URL
  useEffect(() => {
    for (const room of rooms) {
      if (room.avatarHash && !room.avatar) {
        restoreRoomAvatarFromCache(room.jid, room.avatarHash)
      }
    }
  }, [rooms, restoreRoomAvatarFromCache])

  // Separate quick chats, joined/joining rooms, and bookmarked-only rooms
  const quickChats = useMemo(() => rooms.filter(r => r.isQuickChat), [rooms])
  // Include rooms that are joined OR currently joining (so they move to Joined section immediately)
  const joinedRooms = useMemo(() => rooms.filter(r => (r.joined || r.isJoining) && !r.isQuickChat), [rooms])
  const bookmarkedNotJoined = useMemo(() => rooms.filter(r => !r.joined && !r.isJoining && r.isBookmarked && !r.isQuickChat), [rooms])

  // Full list of rooms for plain arrow navigation (all rooms)
  const flatRooms = useMemo(() => [...quickChats, ...joinedRooms, ...bookmarkedNotJoined], [quickChats, joinedRooms, bookmarkedNotJoined])

  // Active rooms only for Alt+arrow navigation (quick chats + joined, excludes bookmarked-not-joined)
  const activeRooms = useMemo(() => [...quickChats, ...joinedRooms], [quickChats, joinedRooms])

  // Map from jid to flat index for quick lookup
  const jidToIndex = useMemo(() => new Map(flatRooms.map((r, i) => [r.jid, i])), [flatRooms])

  const handleRoomClick = useCallback((roomJid: string, isJoined: boolean) => {
    // Allow single-click to select any room (joined or bookmarked)
    // Non-joined rooms will show cached history with a "join to participate" prompt
    void isJoined // Unused now, but kept for API consistency
    // Clear any active 1:1 conversation
    setActiveConversation(null)
    // Set this room as active
    setActiveRoom(roomJid)
  }, [setActiveConversation, setActiveRoom])

  const handleRoomDoubleClick = useCallback(async (roomJid: string, isJoined: boolean, nickname: string) => {
    if (isJoined) {
      // If already joined, just select it
      setActiveConversation(null)
      setActiveRoom(roomJid)
    } else {
      // Join the bookmarked room and switch to it
      await joinRoom(roomJid, nickname)
      setActiveConversation(null)
      setActiveRoom(roomJid)
    }
  }, [setActiveConversation, setActiveRoom, joinRoom])

  // Keyboard navigation - select room on Enter (same as single-click)
  const handleRoomSelect = useCallback((room: Room) => {
    // Select the room (joined or bookmarked) to show its content
    // Non-joined rooms will show cached history with join prompt
    setActiveConversation(null)
    setActiveRoom(room.jid)
  }, [setActiveConversation, setActiveRoom])

  // Keyboard navigation:
  // - Plain arrows: highlight rooms (all rooms including bookmarked)
  // - Alt+arrows: navigate AND switch to active rooms only (excludes bookmarked)
  // - Enter: select highlighted room
  const { selectedIndex, isKeyboardNav, getItemProps, getItemAttribute, getContainerProps } = useListKeyboardNav({
    items: flatRooms,
    altKeyItems: activeRooms, // Alt+arrow navigates only active rooms (excludes bookmarked)
    onSelect: handleRoomSelect,
    listRef,
    getItemId: (room) => room.jid,
    itemAttribute: 'data-room-jid',
    zoneRef,
    enableBounce: true,
    activateOnAltNav: true, // Alt+arrow switches to the room, plain arrow only highlights
  })

  if (rooms.length === 0) {
    return (
      <div className="px-3 py-4 text-fluux-muted text-sm text-center">
        <Hash className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p className="mb-2">{t('rooms.noRooms')}</p>
        <p className="text-xs opacity-75">
          {t('rooms.noRoomsHint')}
        </p>
      </div>
    )
  }

  return (
    <div ref={listRef} className="px-2 py-2" {...getContainerProps()}>
      {/* Quick Chats - only show if any exist */}
      {quickChats.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 flex items-center gap-1">
            <Zap className="w-3 h-3 text-amber-500" />
            {t('rooms.quickChatSection')} — {quickChats.length}
          </h3>
          {quickChats.map((room) => {
            const flatIndex = jidToIndex.get(room.jid) ?? -1
            const draft = drafts.get(room.jid)
            return (
              <RoomItem
                key={room.jid}
                room={room}
                isActive={room.jid === activeRoomJid}
                isSelected={flatIndex === selectedIndex}
                isKeyboardNav={isKeyboardNav}
                draft={draft}
                onClick={() => handleRoomClick(room.jid, true)}
                onDoubleClick={() => handleRoomDoubleClick(room.jid, true, room.nickname)}
                onJoin={() => joinRoom(room.jid, room.nickname)}
                onLeave={() => {
                  if (activeRoomJid === room.jid) setActiveRoom(null)
                  leaveRoom(room.jid)
                }}
                onEditBookmark={() => {}} // Quick chats don't have bookmark editing
                onRemoveBookmark={() => {}} // Quick chats aren't bookmarked
                onToggleAutojoin={() => {}} // Quick chats don't have autojoin
                isQuickChat
                {...getItemAttribute(flatIndex)}
                {...getItemProps(flatIndex)}
              />
            )
          })}
        </>
      )}

      {/* Joined rooms */}
      {joinedRooms.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2">
            {t('rooms.joined')} — {joinedRooms.length}
          </h3>
          {joinedRooms.map((room) => {
            const flatIndex = jidToIndex.get(room.jid) ?? -1
            const draft = drafts.get(room.jid)
            return (
              <RoomItem
                key={room.jid}
                room={room}
                isActive={room.jid === activeRoomJid}
                isSelected={flatIndex === selectedIndex}
                isKeyboardNav={isKeyboardNav}
                draft={draft}
                onClick={() => handleRoomClick(room.jid, true)}
                onDoubleClick={() => handleRoomDoubleClick(room.jid, true, room.nickname)}
                onJoin={() => joinRoom(room.jid, room.nickname)}
                onLeave={() => {
                  if (activeRoomJid === room.jid) setActiveRoom(null)
                  leaveRoom(room.jid)
                }}
                onEditBookmark={() => setEditingRoom(room)}
                onRemoveBookmark={() => removeBookmark(room.jid)}
                onToggleAutojoin={() => setBookmark(room.jid, {
                  name: room.name,
                  nick: room.nickname,
                  autojoin: !room.autojoin,
                })}
                {...getItemAttribute(flatIndex)}
                {...getItemProps(flatIndex)}
              />
            )
          })}
        </>
      )}

      {/* Bookmarked but not joined */}
      {bookmarkedNotJoined.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 mt-4">
            {t('rooms.bookmarked')} — {bookmarkedNotJoined.length}
          </h3>
          {bookmarkedNotJoined.map((room) => {
            const flatIndex = jidToIndex.get(room.jid) ?? -1
            const draft = drafts.get(room.jid)
            return (
              <RoomItem
                key={room.jid}
                room={room}
                isActive={room.jid === activeRoomJid}
                isSelected={flatIndex === selectedIndex}
                isKeyboardNav={isKeyboardNav}
                draft={draft}
                onClick={() => handleRoomClick(room.jid, false)}
                onDoubleClick={() => handleRoomDoubleClick(room.jid, false, room.nickname)}
                onJoin={() => joinRoom(room.jid, room.nickname)}
                onLeave={() => leaveRoom(room.jid)}
                onEditBookmark={() => setEditingRoom(room)}
                onRemoveBookmark={() => removeBookmark(room.jid)}
                onToggleAutojoin={() => setBookmark(room.jid, {
                  name: room.name,
                  nick: room.nickname,
                  autojoin: !room.autojoin,
                })}
                {...getItemAttribute(flatIndex)}
                {...getItemProps(flatIndex)}
              />
            )
          })}
        </>
      )}

      {/* Edit Bookmark Modal */}
      {editingRoom && (
        <EditBookmarkModal
          room={editingRoom}
          onSave={async (options) => {
            await setBookmark(editingRoom.jid, options)
            setEditingRoom(null)
          }}
          onClose={() => setEditingRoom(null)}
        />
      )}
    </div>
  )
}

interface RoomItemProps {
  room: Room
  isActive: boolean
  isSelected?: boolean
  isKeyboardNav?: boolean
  draft?: string
  onClick: () => void
  onDoubleClick: () => void
  onJoin: () => void
  onLeave: () => void
  onEditBookmark: () => void
  onRemoveBookmark: () => void
  onToggleAutojoin: () => void
  onMouseEnter?: () => void
  onMouseMove?: () => void
  isQuickChat?: boolean
  'data-room-jid'?: string
  'data-selected'?: boolean
}

const RoomItem = memo(function RoomItem({
  room,
  isActive,
  isSelected,
  isKeyboardNav,
  draft,
  onClick,
  onDoubleClick,
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

  // Get last message for preview (uses pre-computed lastMessage from metadata for better performance)
  const lastMessage = room.lastMessage ?? null

  const handleClick = () => {
    if (menu.isOpen || menu.longPressTriggered.current) return
    // Don't allow click during joining - room is not ready yet
    if (room.isJoining) return
    onClick()
  }

  const handleDoubleClick = () => {
    if (menu.isOpen) return
    // Don't allow double-click during joining
    if (room.isJoining) return
    onDoubleClick()
  }

  // Determine tooltip based on state
  const getTitle = () => {
    if (room.isJoining) return t('rooms.joining')
    if (room.joined) return undefined
    return t('rooms.doubleClickToJoin')
  }

  const tooltipContent = getTitle()

  return (
    <>
      <Tooltip content={tooltipContent || ''} position="right" disabled={!tooltipContent} className="w-full">
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
          className={`w-full px-2 py-1.5 rounded flex items-center gap-3
                   transition-colors cursor-pointer group
                   ${room.isJoining
                     ? isSelected
                       ? 'bg-fluux-hover text-fluux-text ring-1 ring-fluux-brand/50 opacity-70'
                       : isKeyboardNav
                         ? 'text-fluux-muted opacity-70'
                         : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text opacity-70'
                     : room.joined
                       ? isActive
                         ? 'bg-fluux-active text-fluux-text'
                         : isSelected
                           ? 'bg-fluux-hover text-fluux-text ring-1 ring-fluux-brand/50'
                           : isKeyboardNav
                             ? 'text-fluux-muted'
                             : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text'
                       : isActive
                         ? 'bg-fluux-active text-fluux-text opacity-80'
                         : isSelected
                           ? 'bg-fluux-hover text-fluux-text ring-1 ring-fluux-brand/50 opacity-80'
                           : isKeyboardNav
                             ? 'text-fluux-muted opacity-60'
                             : 'text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text opacity-60 hover:opacity-100'
                   }`}
      >
        {/* Room avatar or icon */}
        <div className="relative flex-shrink-0">
          {room.avatar ? (
            <img
              src={room.avatar}
              alt={room.name}
              className="w-8 h-8 rounded-full object-cover"
              draggable={false}
            />
          ) : isQuickChat ? (
            <Zap className="w-8 h-8 p-1.5 bg-amber-500/20 rounded-full text-amber-500" />
          ) : (
            <Hash
              className="w-8 h-8 p-1.5 rounded-full text-white"
              style={{ backgroundColor: generateConsistentColorHexSync(room.jid, { saturation: 60, lightness: 45 }) }}
            />
          )}
          {/* Joining spinner */}
          {room.isJoining && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-fluux-sidebar bg-fluux-sidebar flex items-center justify-center">
              <Loader2 className="w-2.5 h-2.5 text-fluux-brand animate-spin" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{room.name}</p>
            {/* Activity dot for unread (non-mention) activity */}
            {room.joined && room.unreadCount > 0 && room.mentionsCount === 0 && (
              <Tooltip content={`${room.unreadCount} unread`} position="top">
                <div className="w-2.5 h-2.5 rounded-full bg-fluux-brand flex-shrink-0" />
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
              <span className="text-xs text-fluux-muted flex-shrink-0 ml-auto">
                {formatConversationTime(lastMessage.timestamp, t, currentLang)}
              </span>
            )}
          </div>
          <p className={`truncate text-xs opacity-75 ${draft ? 'italic' : ''}`}>
            {draft ? (
              <>{t('conversations.draft')}: {draft}</>
            ) : room.isJoining ? (
              <span className="italic">{t('rooms.joining')}</span>
            ) : lastMessage ? (
              <span className={lastMessage.isRetracted ? 'italic' : ''}>
                {lastMessage.isOutgoing ? `${t('chat.me')}: ` : `${lastMessage.nick}: `}
                {lastMessage.isRetracted ? t('chat.messageDeleted') : formatMessagePreview(lastMessage)}
              </span>
            ) : room.joined ? (
              <>
                {room.occupants.size} {room.occupants.size === 1 ? t('rooms.user') : t('rooms.users')}
                {room.nickname && ` • ${room.nickname}`}
              </>
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
              onClick={() => { menu.close(); onJoin() }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              <LogIn className="w-4 h-4" />
              <span>{t('rooms.joinRoom')}</span>
            </button>
          )}

          {/* Edit bookmark (only for bookmarked rooms) */}
          {room.isBookmarked && (
            <button
              onClick={() => { menu.close(); onEditBookmark() }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              <Pencil className="w-4 h-4" />
              <span>{t('rooms.editBookmark')}</span>
            </button>
          )}

          {/* Toggle autojoin (only for bookmarked rooms) */}
          {room.isBookmarked && (
            <button
              onClick={() => { menu.close(); onToggleAutojoin() }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-text hover:bg-fluux-brand hover:text-white transition-colors"
            >
              {room.autojoin ? (
                <>
                  <ToggleRight className="w-4 h-4 text-fluux-green" />
                  <span>{t('rooms.autojoinOn')}</span>
                </>
              ) : (
                <>
                  <ToggleLeft className="w-4 h-4" />
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
              onClick={() => { menu.close(); onLeave() }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-red hover:bg-fluux-red hover:text-white transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>{t('rooms.leaveRoom')}</span>
            </button>
          )}

          {/* Remove bookmark (only for bookmarked rooms) */}
          {room.isBookmarked && (
            <button
              onClick={() => { menu.close(); onRemoveBookmark() }}
              className="w-full px-3 py-2 flex items-center gap-3 text-left text-fluux-red hover:bg-fluux-red hover:text-white transition-colors"
            >
              <BookmarkX className="w-4 h-4" />
              <span>{t('rooms.removeBookmark')}</span>
            </button>
          )}
        </div>
      )}
    </>
  )
})
