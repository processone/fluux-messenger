/**
 * Header component for MUC room conversations.
 *
 * Displays room avatar, name, subject, and controls for:
 * - Notification settings (mentions only, all messages, off)
 * - Room management (owners/admins): settings, subject, avatar, members
 * - Occupant panel toggle
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NotifyLevel, Room, RoomReadMarkers } from '@fluux/sdk'
import { getUniqueOccupantCount, useSavedCountInConversation } from '@fluux/sdk'
import { RoomAvatar } from './RoomAvatar'
import { Tooltip } from './Tooltip'
import { ConnectionStepSlot } from './ConnectionStep'
import { UpdateStatus } from './UpdateStatus'
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
import { buildNotifyGroup, buildManagementGroup, notifyModeOf, notifyIconOf } from './header/roomHeaderActions'
import { inlineClass, kebabClass } from './header/headerOverflow'
import { useRoomUiStore } from '../stores/roomUiStore'
import { useToastStore } from '@/stores/toastStore'
import {
  ArrowLeft,
  Users,
  X,
  ChevronRight,
  Settings,
  UserPlus,
  Search,
  Bookmark,
  CalendarDays,
} from 'lucide-react'

export interface RoomHeaderProps {
  room: Room
  peerReadMarkers?: RoomReadMarkers
  /** This header is covered by another pane, so retrieval stays silent. */
  covered?: boolean
  onBack?: () => void
  showOccupants: boolean
  onToggleOccupants: () => void
  setRoomNotifyLevel: (roomJid: string, level: NotifyLevel, persistent?: boolean) => Promise<void>
  setRoomAvatar: (roomJid: string, imageData: Uint8Array, mimeType: string) => Promise<void>
  clearRoomAvatar: (roomJid: string) => Promise<void>
  submitRoomConfig: (roomJid: string, values: Record<string, string | string[]>) => Promise<void>
  setSubject: (roomJid: string, subject: string) => Promise<void>
  destroyRoom: (roomJid: string, reason?: string) => Promise<void>
  onSearchInConversation?: () => void
  /** Open the jump-to-date dialog. */
  onJumpToDate?: () => void
  /** Open the Saved tab narrowed to this room. The button shows only where something is saved. */
  onShowSavedInConversation?: () => void
  onBulkModeration?: () => void
}

export function RoomHeader({
  room,
  peerReadMarkers,
  covered = false,
  onBack,
  showOccupants,
  onToggleOccupants,
  setRoomNotifyLevel,
  setRoomAvatar,
  clearRoomAvatar,
  submitRoomConfig,
  setSubject,
  destroyRoom,
  onSearchInConversation,
  onJumpToDate,
  onShowSavedInConversation,
  onBulkModeration,
}: RoomHeaderProps) {
  const { t } = useTranslation()
  const [showAvatarModal, setShowAvatarModal] = useState(false)
  const [showMembersModal, setShowMembersModal] = useState(false)
  const [showHatsModal, setShowHatsModal] = useState(false)
  const [showInfoModal, setShowInfoModal] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const { dragRegionProps } = useWindowDrag()
  const savedCount = useSavedCountInConversation(room.jid)
  const showSaved = !!onShowSavedInConversation && savedCount > 0
  const configModalOpen = useRoomUiStore((s) => s.configModalOpen)
  const inviteModalOpen = useRoomUiStore((s) => s.inviteModalOpen)
  const openConfig = useRoomUiStore((s) => s.openConfig)
  const closeConfig = useRoomUiStore((s) => s.closeConfig)
  const openInvite = useRoomUiStore((s) => s.openInvite)
  const closeInvite = useRoomUiStore((s) => s.closeInvite)
  const addToast = useToastStore((s) => s.addToast)

  // Get self occupant to check affiliation
  const selfOccupant = room.nickname ? room.occupants.get(room.nickname) : undefined
  const isOwner = selfOccupant?.affiliation === 'owner'
  const isAdmin = selfOccupant?.affiliation === 'admin'
  const canManageRoom = isOwner || isAdmin

  // Count unique users by bare JID (multiple connections from same user count as one)
  const uniqueOccupantCount = getUniqueOccupantCount(room.occupants.values())

  const mode = notifyModeOf(room)
  const NotifyIcon = notifyIconOf(mode)
  const notifyChanged = mode !== 'mentions'
  const notifyGroup = buildNotifyGroup({
    room, t, setRoomNotifyLevel,
    onSaveFailed: () => addToast('error', t('rooms.failedToSaveBookmark')),
  })
  const managementGroup = buildManagementGroup({
    room, t, isOwner, canManageRoom,
    onConfig: openConfig,
    onAvatar: () => setShowAvatarModal(true),
    onClearAvatar: async () => {
      try { await clearRoomAvatar(room.jid) } catch { setAvatarError(t('rooms.avatarClearFailed')) }
    },
    onMembers: () => setShowMembersModal(true),
    onHats: () => { if (room.supportsHats) setShowHatsModal(true) },
    onBulkModeration,
  })

  return (
    <header className="@container relative aurora-horizon h-14 px-4 flex items-center border-b border-fluux-bg gap-2 md:gap-3" {...dragRegionProps}>
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

      {/* The room-info button covers the original full free area. Content is
          hit-transparent except links and the separate explanation control. */}
      <div className="relative flex-1 min-w-0 py-0.5" data-testid="room-info-area">
        <Tooltip content={t('rooms.showRoomInfo')} position="bottom" className="absolute inset-0 -mx-1 flex">
          <button
            type="button"
            onClick={() => setShowInfoModal(true)}
            aria-label={`${t('rooms.showRoomInfo')}: ${room.name}`}
            className="flex-1 min-w-0 rounded-md hover:bg-fluux-hover transition-colors"
          />
        </Tooltip>
        <div className="relative pointer-events-none min-w-0 [&_a]:pointer-events-auto">
          <span aria-hidden="true" className="block type-view-title text-fluux-text truncate !leading-tight">{room.name}</span>
          <ConnectionStepSlot>
            <UpdateStatus scope={`room:${room.jid}`} target={room.name} visible={!covered}>
              {room.subject?.trim() ? renderTextWithLinks(room.subject) : room.jid}
            </UpdateStatus>
          </ConnectionStepSlot>
        </div>
      </div>

      {/* Trailing action cluster — grouped tightly on mobile (gap-1) so the
          kebab and members pill read as one unit. Only search and the members
          toggle are inline on a wide header; the other actions live in the kebab. */}
      <div className="flex items-center gap-1 md:gap-3">
        {/* Notification settings — inline only as a status icon while the room is
            muted or set to all messages; at the default (mentions only) it lives in
            the kebab. Collapses with search on a narrow header. */}
        {notifyChanged && (
          <div className={inlineClass('search')}>
            <HeaderSubmenuButton
              ariaLabel={t('rooms.notificationSettings')}
              tooltip={t('rooms.notificationSettings')}
              icon={NotifyIcon}
              active
              group={notifyGroup}
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

        {/* Overflow kebab — always shown: invite always lives here, and search and a
            changed notification level fold in on a narrow header. */}
        <div className="flex">
          <HeaderOverflowKebab
            ariaLabel={t('rooms.roomActions', 'Room actions')}
            entries={[
              ...(showSaved
                ? [{ kind: 'action', key: 'saved', label: `${t('saved.title')} (${savedCount})`, icon: Bookmark, onSelect: onShowSavedInConversation } as OverflowEntry]
                : []),
              ...(onSearchInConversation
                ? [{ kind: 'action', key: 'search', label: t('chat.searchInConversation', 'Search in conversation'), icon: Search, onSelect: onSearchInConversation, kebabClassName: kebabClass('search') } as OverflowEntry]
                : []),
              ...(onJumpToDate
                ? [{ kind: 'action', key: 'jumpToDate', label: t('chat.jumpToDate.title'), icon: CalendarDays, onSelect: onJumpToDate } as OverflowEntry]
                : []),
              { kind: 'action', key: 'invite', label: t('rooms.inviteMember'), icon: UserPlus, onSelect: openInvite },
              { kind: 'submenu', key: 'notify', label: t('rooms.notificationSettings'), icon: NotifyIcon, group: notifyGroup, kebabClassName: notifyChanged ? kebabClass('search') : undefined },
              ...(managementGroup
                ? [{ kind: 'submenu', key: 'manage', label: t('rooms.manageRoom'), icon: Settings, group: managementGroup } as OverflowEntry]
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
                         ? 'bg-fluux-brand/20 text-fluux-brand-on-tint'
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

      {/* Room configuration modal. Rendered before the dialogs it links to
          (avatar, members, hats) so they stack above it when opened from it. */}
      {configModalOpen && (
        <RoomConfigModal
          room={room}
          onClose={closeConfig}
          submitRoomConfig={submitRoomConfig}
          setSubject={setSubject}
          destroyRoom={destroyRoom}
          notifyGroup={notifyGroup}
          onAvatar={isOwner ? () => setShowAvatarModal(true) : undefined}
          onMembers={canManageRoom ? () => setShowMembersModal(true) : undefined}
          onHats={isOwner ? () => { if (room.supportsHats) setShowHatsModal(true) } : undefined}
          onBulkModeration={onBulkModeration}
        />
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
          peerReadMarkers={peerReadMarkers}
          room={room}
          onClose={() => setShowInfoModal(false)}
        />
      )}
    </header>
  )
}
