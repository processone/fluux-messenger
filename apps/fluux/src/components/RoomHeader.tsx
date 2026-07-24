/**
 * Header component for MUC room conversations.
 *
 * Displays room avatar, name, subject, and controls for:
 * - Notification settings (mentions only, all messages)
 * - Room management (owners/admins): settings, subject, avatar, members
 * - Occupant panel toggle
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Room } from '@fluux/sdk'
import { getUniqueOccupantCount } from '@fluux/sdk'
import { RoomAvatar } from './RoomAvatar'
import { Tooltip } from './Tooltip'
import { useWindowDrag } from '@/hooks'
import { renderTextWithLinks } from '@/utils/messageStyles'
import { AvatarCropModal } from './AvatarCropModal'
import { InviteToRoomModal } from './InviteToRoomModal'
import { RoomConfigModal } from './RoomConfigModal'
import { RoomMembersModal } from './RoomMembersModal'
import { RoomHatsModal } from './RoomHatsModal'
import { RoomInfoModal } from './RoomInfoModal'
import { HeaderSubmenuButton } from './header/HeaderSubmenuButton'
import { HeaderOverflowKebab, type OverflowEntry } from './header/HeaderOverflowKebab'
import { buildNotifyGroup, buildManagementGroup, notifyModeOf } from './header/roomHeaderActions'
import { inlineClass, kebabClass, KEBAB_TRIGGER_CLASS } from './header/headerOverflow'
import { useRoomUiStore } from '../stores/roomUiStore'
import {
  ArrowLeft,
  Users,
  X,
  ChevronRight,
  Bell,
  BellOff,
  BellRing,
  Settings,
  UserPlus,
  Search,
} from 'lucide-react'

export interface RoomHeaderProps {
  room: Room
  onBack?: () => void
  showOccupants: boolean
  onToggleOccupants: () => void
  setRoomNotifyAll: (roomJid: string, notifyAll: boolean, persistent?: boolean) => Promise<void>
  setRoomAvatar: (roomJid: string, imageData: Uint8Array, mimeType: string) => Promise<void>
  clearRoomAvatar: (roomJid: string) => Promise<void>
  submitRoomConfig: (roomJid: string, values: Record<string, string | string[]>) => Promise<void>
  setSubject: (roomJid: string, subject: string) => Promise<void>
  destroyRoom: (roomJid: string, reason?: string) => Promise<void>
  onSearchInConversation?: () => void
}

export function RoomHeader({
  room,
  onBack,
  showOccupants,
  onToggleOccupants,
  setRoomNotifyAll,
  setRoomAvatar,
  clearRoomAvatar,
  submitRoomConfig,
  setSubject,
  destroyRoom,
  onSearchInConversation,
}: RoomHeaderProps) {
  const { t } = useTranslation()
  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [showMembersModal, setShowMembersModal] = useState(false)
  const [showHatsModal, setShowHatsModal] = useState(false)
  const [showInfoModal, setShowInfoModal] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const { dragRegionProps } = useWindowDrag()
  const configModalOpen = useRoomUiStore((s) => s.configModalOpen)
  const inviteModalOpen = useRoomUiStore((s) => s.inviteModalOpen)
  const openConfig = useRoomUiStore((s) => s.openConfig)
  const closeConfig = useRoomUiStore((s) => s.closeConfig)
  const openInvite = useRoomUiStore((s) => s.openInvite)
  const closeInvite = useRoomUiStore((s) => s.closeInvite)

  // Get self occupant to check affiliation
  const selfOccupant = room.nickname ? room.occupants.get(room.nickname) : undefined
  const isOwner = selfOccupant?.affiliation === 'owner'
  const isAdmin = selfOccupant?.affiliation === 'admin'
  const canManageRoom = isOwner || isAdmin

  // Count unique users by bare JID (multiple connections from same user count as one)
  const uniqueOccupantCount = getUniqueOccupantCount(room.occupants.values())

  const mode = notifyModeOf(room)
  const NotifyIcon = mode === 'mentions' ? BellOff : mode === 'all-always' ? BellRing : Bell
  const notifyGroup = buildNotifyGroup({ room, t, setRoomNotifyAll })
  const managementGroup = buildManagementGroup({
    room, t, isOwner, canManageRoom,
    onConfig: openConfig,
    onAvatar: () => setShowAvatarModal(true),
    onClearAvatar: async () => {
      try { await clearRoomAvatar(room.jid) } catch { setAvatarError(t('rooms.avatarClearFailed')) }
    },
    onMembers: () => setShowMembersModal(true),
    onHats: () => { if (room.supportsHats) setShowHatsModal(true) },
  })

  return (
    <header className="@container relative aurora-horizon h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-2 md:gap-3" {...dragRegionProps}>
      {/* Back button - mobile only */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="p-1 -ms-1 rounded hover:bg-fluux-hover md:hidden tap-target"
          aria-label={t('rooms.backToRooms')}
        >
          <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
        </button>
      )}

      {/* Room Avatar or Icon */}
      <RoomAvatar
        identifier={room.jid}
        name={room.name}
        avatarUrl={room.avatar}
        size="header"
      />

      {/* Name and info — opens Room Info modal with the full topic and details.
          The tooltip wrapper carries the flex sizing so the button still fills
          the free space between the avatar and the trailing action cluster. */}
      <Tooltip content={t('rooms.showRoomInfo')} position="bottom" className="flex flex-1 min-w-0">
        <button
          type="button"
          onClick={() => setShowInfoModal(true)}
          aria-label={`${t('rooms.showRoomInfo')}: ${room.name}`}
          className="flex-1 min-w-0 text-start rounded-md px-1 -mx-1 py-0.5 hover:bg-fluux-hover transition-colors"
        >
          <span className="block font-semibold text-fluux-text truncate leading-tight">{room.name}</span>
          <p className="text-xs text-fluux-muted truncate">
            {room.subject?.trim() ? renderTextWithLinks(room.subject) : room.jid}
          </p>
        </button>
      </Tooltip>

      {/* Trailing action cluster — grouped tightly on mobile (gap-1) so the
          kebab and members pill read as one unit; desktop keeps the header's md
          gap so the wide-tier controls are spaced as before. */}
      <div className="flex items-center gap-1 md:gap-3">
        {/* Notification settings — inline copy (wide tier) */}
        <div className={inlineClass('wide')}>
          <HeaderSubmenuButton
            ariaLabel={t('rooms.notificationSettings')}
            tooltip={t('rooms.notificationSettings')}
            icon={NotifyIcon}
            active={mode !== 'mentions'}
            group={notifyGroup}
          />
        </div>

        {/* Invite member — inline copy (wide tier) */}
        <div className={inlineClass('wide')}>
          <Tooltip content={t('rooms.inviteMember')} position="bottom">
            <button
              type="button"
              onClick={openInvite}
              className="p-1.5 rounded-lg hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
              aria-label={t('rooms.inviteMember')}
            >
              <UserPlus className="size-4" />
            </button>
          </Tooltip>
        </div>

        {/* Room management — inline copy (wide tier, owners/admins only) */}
        {managementGroup && (
          <div className={inlineClass('wide')}>
            <HeaderSubmenuButton
              ariaLabel={t('rooms.manageRoom')}
              tooltip={t('rooms.manageRoom')}
              icon={Settings}
              group={managementGroup}
            />
          </div>
        )}

        {/* Search — inline copy (search tier) */}
        {onSearchInConversation && (
          <div className={inlineClass('search')}>
            <Tooltip content={t('chat.searchInConversation', 'Search in conversation')} position="bottom">
              <button
                type="button"
                onClick={onSearchInConversation}
                className="p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
                aria-label={t('chat.searchInConversation', 'Search in conversation')}
              >
                <Search className="size-4" />
              </button>
            </Tooltip>
          </div>
        )}

        {/* Overflow kebab — holds the collapsed copies. Every room entry also has
            an inline copy, so once the header is wide enough to show them all the
            kebab is redundant: KEBAB_TRIGGER_CLASS hides it at the wide tier. */}
        <div className={KEBAB_TRIGGER_CLASS}>
          <HeaderOverflowKebab
            ariaLabel={t('rooms.roomActions', 'Room actions')}
            entries={[
              ...(onSearchInConversation
                ? [{ kind: 'action', key: 'search', label: t('chat.searchInConversation', 'Search in conversation'), icon: Search, onSelect: onSearchInConversation, kebabClassName: kebabClass('search') } as OverflowEntry]
                : []),
              { kind: 'action', key: 'invite', label: t('rooms.inviteMember'), icon: UserPlus, onSelect: openInvite, kebabClassName: kebabClass('wide') },
              { kind: 'submenu', key: 'notify', label: t('rooms.notificationSettings'), icon: NotifyIcon, group: notifyGroup, kebabClassName: kebabClass('wide') },
              ...(managementGroup
                ? [{ kind: 'submenu', key: 'manage', label: t('rooms.manageRoom'), icon: Settings, group: managementGroup, kebabClassName: kebabClass('wide') } as OverflowEntry]
                : []),
            ]}
          />
        </div>

        {/* Occupant toggle button */}
        <Tooltip content={showOccupants ? t('rooms.hideMembers') : t('rooms.showMembers')} position="bottom">
          <button
            type="button"
            onClick={onToggleOccupants}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors tap-target
                       ${showOccupants
                         ? 'bg-fluux-brand/20 text-fluux-brand'
                         : 'hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text'
                       }`}
            aria-label={showOccupants ? t('rooms.hideMembers') : t('rooms.showMembers')}
          >
            <Users className="size-4" />
            <span className="text-sm font-medium">{uniqueOccupantCount}</span>
            <ChevronRight className={`size-4 transition-transform ${showOccupants ? '' : 'rotate-180'}`} />
          </button>
        </Tooltip>
      </div>

      {/* Room avatar error message */}
      {avatarError && (
        <div className="absolute top-full inset-x-0 mt-1 mx-4 p-2 bg-fluux-red/20 border border-fluux-red/50 rounded text-fluux-error text-sm flex items-center justify-between z-40">
          <span>{avatarError}</span>
          <button type="button" onClick={() => setAvatarError(null)} className="p-1 hover:bg-fluux-red/20 rounded">
            <X className="size-4" />
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
      {inviteModalOpen && (
        <InviteToRoomModal
          isOpen={inviteModalOpen}
          onClose={closeInvite}
          room={room}
        />
      )}

      {/* Room configuration modal */}
      {configModalOpen && (
        <RoomConfigModal
          room={room}
          onClose={closeConfig}
          submitRoomConfig={submitRoomConfig}
          setSubject={setSubject}
          destroyRoom={destroyRoom}
        />
      )}

      {showMembersModal && (
        <RoomMembersModal
          room={room}
          onClose={() => setShowMembersModal(false)}
        />
      )}

      {showHatsModal && (
        <RoomHatsModal
          room={room}
          onClose={() => setShowHatsModal(false)}
        />
      )}

      {showInfoModal && (
        <RoomInfoModal
          room={room}
          onClose={() => setShowInfoModal(false)}
        />
      )}
    </header>
  )
}
