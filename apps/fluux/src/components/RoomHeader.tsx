/**
 * Header component for MUC room conversations.
 *
 * Displays room avatar, name, subject, and controls for:
 * - Notification settings (mentions only, all messages)
 * - Room management (owners/admins): settings, subject, avatar, members
 * - Occupant panel toggle
 */
import { useState, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Room } from '@fluux/sdk'
import { generateConsistentColorHexSync, getUniqueOccupantCount } from '@fluux/sdk'
import { Avatar } from './Avatar'
import { Tooltip } from './Tooltip'
import { useWindowDrag, useClickOutside } from '@/hooks'
import { renderTextWithLinks } from '@/utils/messageStyles'
import { AvatarCropModal } from './AvatarCropModal'
import { InviteToRoomModal } from './InviteToRoomModal'
import {
  Hash,
  ArrowLeft,
  Users,
  X,
  ChevronRight,
  Bell,
  BellOff,
  BellRing,
  Check,
  ChevronDown,
  Trash2,
  Settings,
  UserPlus,
  UserMinus,
  Image,
  Type,
} from 'lucide-react'

// Notification mode for rooms
type NotifyMode = 'mentions' | 'all-session' | 'all-always'

export interface RoomHeaderProps {
  room: Room
  onBack?: () => void
  showOccupants: boolean
  onToggleOccupants: () => void
  setRoomNotifyAll: (roomJid: string, notifyAll: boolean, persistent?: boolean) => Promise<void>
  setRoomAvatar: (roomJid: string, imageData: Uint8Array, mimeType: string) => Promise<void>
  clearRoomAvatar: (roomJid: string) => Promise<void>
}

export function RoomHeader({
  room,
  onBack,
  showOccupants,
  onToggleOccupants,
  setRoomNotifyAll,
  setRoomAvatar,
  clearRoomAvatar,
}: RoomHeaderProps) {
  const { t } = useTranslation()
  const [showNotifyMenu, setShowNotifyMenu] = useState(false)
  const [showOwnerMenu, setShowOwnerMenu] = useState(false)
  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const notifyMenuRef = useRef<HTMLDivElement>(null)
  const ownerMenuRef = useRef<HTMLDivElement>(null)
  const { titleBarClass, dragRegionProps } = useWindowDrag()

  // Get self occupant to check affiliation
  const selfOccupant = room.nickname ? room.occupants.get(room.nickname) : undefined
  const isOwner = selfOccupant?.affiliation === 'owner'
  const isAdmin = selfOccupant?.affiliation === 'admin'
  const canManageRoom = isOwner || isAdmin

  // Close menus when clicking outside
  const closeNotifyMenu = useCallback(() => setShowNotifyMenu(false), [])
  useClickOutside(notifyMenuRef, closeNotifyMenu, showNotifyMenu)

  const closeOwnerMenu = useCallback(() => setShowOwnerMenu(false), [])
  useClickOutside(ownerMenuRef, closeOwnerMenu, showOwnerMenu)

  // Determine current notification mode
  const getNotifyMode = (): NotifyMode => {
    if (room.notifyAllPersistent) return 'all-always'
    if (room.notifyAll) return 'all-session'
    return 'mentions'
  }
  const notifyMode = getNotifyMode()

  // Count unique users by bare JID (multiple connections from same user count as one)
  const uniqueOccupantCount = useMemo(
    () => getUniqueOccupantCount(room.occupants.values()),
    [room.occupants]
  )

  // Get icon based on mode
  const NotifyIcon = notifyMode === 'mentions' ? BellOff
    : notifyMode === 'all-always' ? BellRing
    : Bell

  const handleSelectMode = (mode: NotifyMode) => {
    switch (mode) {
      case 'mentions':
        // Turn off both session and persistent
        void setRoomNotifyAll(room.jid, false, false)
        if (room.notifyAllPersistent) {
          void setRoomNotifyAll(room.jid, false, true)
        }
        break
      case 'all-session':
        // Enable session-only, disable persistent
        void setRoomNotifyAll(room.jid, true, false)
        if (room.notifyAllPersistent) {
          void setRoomNotifyAll(room.jid, false, true)
        }
        break
      case 'all-always':
        // Enable persistent (and clear session)
        void setRoomNotifyAll(room.jid, true, true)
        break
    }
    setShowNotifyMenu(false)
  }

  return (
    <header className={`h-14 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3`} {...dragRegionProps}>
      {/* Back button - mobile only */}
      {onBack && (
        <button
          onClick={onBack}
          className="p-1 -ml-1 rounded hover:bg-fluux-hover md:hidden"
          aria-label="Back to rooms"
        >
          <ArrowLeft className="w-5 h-5 text-fluux-muted" />
        </button>
      )}

      {/* Room Avatar or Icon */}
      {room.avatar ? (
        <Avatar
          identifier={room.jid}
          name={room.name}
          avatarUrl={room.avatar}
          size="header"
        />
      ) : (
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: generateConsistentColorHexSync(room.jid, { saturation: 60, lightness: 45 }) }}
        >
          <Hash className="w-5 h-5 text-white" />
        </div>
      )}

      {/* Name and info */}
      <div className="flex-1 min-w-0">
        <h2 className="font-semibold text-fluux-text truncate leading-tight">{room.name}</h2>
        <p className="text-xs text-fluux-muted truncate">
          {room.subject ? renderTextWithLinks(room.subject) : room.jid}
        </p>
      </div>

      {/* Notification dropdown */}
      <div className="relative" ref={notifyMenuRef}>
        <Tooltip content={t('rooms.notificationSettings')} position="bottom" disabled={showNotifyMenu}>
          <button
            onClick={() => setShowNotifyMenu(!showNotifyMenu)}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors
                       ${notifyMode !== 'mentions'
                         ? 'bg-fluux-brand/20 text-fluux-brand'
                         : 'hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text'
                       }`}
            aria-label={t('rooms.notificationSettings')}
          >
            <NotifyIcon className="w-4 h-4" />
            <ChevronDown className={`w-3 h-3 transition-transform ${showNotifyMenu ? 'rotate-180' : ''}`} />
          </button>
        </Tooltip>

        {/* Dropdown menu */}
        {showNotifyMenu && (
          <div className="absolute right-0 top-full mt-1 w-56 bg-fluux-bg border border-fluux-hover rounded-lg shadow-lg z-30 py-1">
            {/* Mentions only */}
            <button
              onClick={() => handleSelectMode('mentions')}
              className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors"
            >
              <BellOff className="w-4 h-4 text-fluux-muted" />
              <div className="flex-1">
                <div className="text-sm text-fluux-text">{t('rooms.mentionsOnly')}</div>
                <div className="text-xs text-fluux-muted">{t('rooms.defaultBehavior')}</div>
              </div>
              {notifyMode === 'mentions' && (
                <Check className="w-4 h-4 text-fluux-brand" />
              )}
            </button>

            {/* All messages (session) */}
            <button
              onClick={() => handleSelectMode('all-session')}
              className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors"
            >
              <Bell className="w-4 h-4 text-fluux-muted" />
              <div className="flex-1">
                <div className="text-sm text-fluux-text">{t('rooms.allMessages')}</div>
                <div className="text-xs text-fluux-muted">{t('rooms.thisSessionOnly')}</div>
              </div>
              {notifyMode === 'all-session' && (
                <Check className="w-4 h-4 text-fluux-brand" />
              )}
            </button>

            {/* All messages (always) - only for bookmarked rooms, not quick chats */}
            {!room.isQuickChat && (
              <button
                onClick={() => handleSelectMode('all-always')}
                className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors"
              >
                <BellRing className="w-4 h-4 text-fluux-muted" />
                <div className="flex-1">
                  <div className="text-sm text-fluux-text">{t('rooms.allMessages')}</div>
                  <div className="text-xs text-fluux-muted">{t('rooms.alwaysSavedToBookmark')}</div>
                </div>
                {notifyMode === 'all-always' && (
                  <Check className="w-4 h-4 text-fluux-brand" />
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Invite member - available to all occupants */}
      <Tooltip content={t('rooms.inviteMember')} position="bottom">
        <button
          onClick={() => setShowInviteModal(true)}
          className="p-1.5 rounded-lg hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
          aria-label={t('rooms.inviteMember')}
        >
          <UserPlus className="w-4 h-4" />
        </button>
      </Tooltip>

      {/* Room management dropdown (owners/admins only) */}
      {canManageRoom && (
        <div className="relative" ref={ownerMenuRef}>
          <Tooltip content={t('rooms.manageRoom')} position="bottom" disabled={showOwnerMenu}>
            <button
              onClick={() => setShowOwnerMenu(!showOwnerMenu)}
              className={`flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors
                         ${showOwnerMenu
                           ? 'bg-fluux-hover text-fluux-text'
                           : 'hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text'
                         }`}
              aria-label={t('rooms.manageRoom')}
            >
              <Settings className="w-4 h-4" />
              <ChevronDown className={`w-3 h-3 transition-transform ${showOwnerMenu ? 'rotate-180' : ''}`} />
            </button>
          </Tooltip>

          {/* Room management dropdown menu */}
          {showOwnerMenu && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-fluux-bg border border-fluux-hover rounded-lg shadow-lg z-30 py-1">
              {/* Room Settings (placeholder) */}
              <Tooltip content={t('common.comingSoon')} position="left" className='w-full'>
                <button
                  onClick={() => {
                    // TODO: Open room settings modal
                    setShowOwnerMenu(false)
                  }}
                  className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors opacity-60 cursor-not-allowed"
                  disabled
                >
                  <Settings className="w-4 h-4 text-fluux-muted" />
                  <div className="flex-1">
                    <div className="text-sm text-fluux-text">{t('rooms.roomSettings')}</div>
                    <div className="text-xs text-fluux-muted">{t('rooms.configureRoom')}</div>
                  </div>
                </button>
              </Tooltip>

              {/* Change Room Subject (placeholder) */}
              <Tooltip content={t('common.comingSoon')} position="left" className='w-full'>
                <button
                  onClick={() => {
                    // TODO: Open change subject modal
                    setShowOwnerMenu(false)
                  }}
                  className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors opacity-60 cursor-not-allowed"
                  disabled
                >
                  <Type className="w-4 h-4 text-fluux-muted" />
                  <div className="flex-1">
                    <div className="text-sm text-fluux-text">{t('rooms.changeSubject')}</div>
                  </div>
                </button>
              </Tooltip>

              {/* Change Room Avatar (owner only) */}
              {isOwner && (
                <button
                  onClick={() => {
                    setShowAvatarModal(true)
                    setShowOwnerMenu(false)
                  }}
                  className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors"
                >
                  <Image className="w-4 h-4 text-fluux-muted" />
                  <div className="flex-1">
                    <div className="text-sm text-fluux-text">{t('rooms.changeAvatar')}</div>
                  </div>
                </button>
              )}

              {/* Clear Room Avatar (owner only, only show if room has avatar) */}
              {isOwner && room.avatar && (
                <button
                  onClick={async () => {
                    try {
                      await clearRoomAvatar(room.jid)
                      setShowOwnerMenu(false)
                    } catch {
                      setAvatarError(t('rooms.avatarClearFailed'))
                    }
                  }}
                  className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors text-fluux-red"
                >
                  <Trash2 className="w-4 h-4" />
                  <div className="flex-1">
                    <div className="text-sm">{t('rooms.removeAvatar')}</div>
                  </div>
                </button>
              )}

              {/* Kick/Ban Member (placeholder) - owner only */}
              {isOwner && (
                <Tooltip content={t('common.comingSoon')} position="left" className='w-full'>
                  <button
                    onClick={() => {
                      // TODO: Open kick/ban member modal
                      setShowOwnerMenu(false)
                    }}
                    className="w-full px-3 py-2 flex items-center gap-3 hover:bg-fluux-hover text-left transition-colors opacity-60 cursor-not-allowed"
                    disabled
                  >
                    <UserMinus className="w-4 h-4 text-fluux-muted" />
                    <div className="flex-1">
                      <div className="text-sm text-fluux-text">{t('rooms.manageMembership')}</div>
                      <div className="text-xs text-fluux-muted">{t('rooms.kickBanMembers')}</div>
                    </div>
                  </button>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      )}

      {/* Occupant toggle button */}
      <Tooltip content={showOccupants ? t('rooms.hideMembers') : t('rooms.showMembers')} position="bottom">
        <button
          onClick={onToggleOccupants}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors
                     ${showOccupants
                       ? 'bg-fluux-brand/20 text-fluux-brand'
                       : 'hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text'
                     }`}
          aria-label={showOccupants ? t('rooms.hideMembers') : t('rooms.showMembers')}
        >
          <Users className="w-4 h-4" />
          <span className="text-sm font-medium">{uniqueOccupantCount}</span>
          <ChevronRight className={`w-4 h-4 transition-transform ${showOccupants ? '' : 'rotate-180'}`} />
        </button>
      </Tooltip>

      {/* Room avatar error message */}
      {avatarError && (
        <div className="absolute top-full left-0 right-0 mt-1 mx-4 p-2 bg-fluux-red/20 border border-fluux-red/50 rounded text-fluux-red text-sm flex items-center justify-between z-40">
          <span>{avatarError}</span>
          <button onClick={() => setAvatarError(null)} className="p-1 hover:bg-fluux-red/20 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Room avatar crop modal */}
      <AvatarCropModal
        isOpen={showAvatarModal}
        onClose={() => {
          setShowAvatarModal(false)
          setAvatarError(null)
        }}
        onSave={async (imageData, mimeType) => {
          try {
            await setRoomAvatar(room.jid, imageData, mimeType)
            setShowAvatarModal(false)
            setAvatarError(null)
          } catch {
            setAvatarError(t('rooms.avatarChangeFailed'))
          }
        }}
      />

      {/* Invite to room modal */}
      <InviteToRoomModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        room={room}
      />
    </header>
  )
}
