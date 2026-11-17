import type { TFunction } from 'i18next'
import { resolveNotifyLevel, savedNotifyLevel, type NotifyLevel, type Room } from '@fluux/sdk'
import { AtSign, Bell, BellOff, BellRing, Settings, Type, Image, Trash2, UserMinus, Award, Shield } from 'lucide-react'
import type { HeaderActionGroup } from './headerOverflow'

export type NotifyMode = 'mentions' | 'all-session' | 'all-always' | 'off'

export function notifyModeOf(room: Room): NotifyMode {
  const level = resolveNotifyLevel(room)
  if (level === 'none') return 'off'
  if (level === 'mentions') return 'mentions'
  return room.notifyAllPersistent && room.notifyAll !== false ? 'all-always' : 'all-session'
}

/** Header icon for a notification mode: crossed bell is Off, @ is Mentions only. */
export function notifyIconOf(mode: NotifyMode) {
  switch (mode) {
    case 'off': return BellOff
    case 'mentions': return AtSign
    case 'all-always': return BellRing
    case 'all-session': return Bell
  }
}

interface NotifyArgs {
  room: Room
  t: TFunction
  setRoomNotifyLevel: (jid: string, level: NotifyLevel, persistent?: boolean) => Promise<void>
}

export function buildNotifyGroup({ room, t, setRoomNotifyLevel }: NotifyArgs): HeaderActionGroup {
  const mode = notifyModeOf(room)
  // A level saved in the bookmark must be cleared when a session-only choice replaces it.
  const hasSavedChoice = savedNotifyLevel(room) !== 'mentions'
  const select = (next: NotifyMode) => {
    switch (next) {
      case 'mentions':
        void setRoomNotifyLevel(room.jid, 'mentions', hasSavedChoice)
        break
      case 'all-session':
        if (hasSavedChoice) void setRoomNotifyLevel(room.jid, 'mentions', true)
        void setRoomNotifyLevel(room.jid, 'all', false)
        break
      case 'all-always':
        void setRoomNotifyLevel(room.jid, 'all', true)
        break
      case 'off':
        // A quick chat has no bookmark: Off lasts for the session there.
        void setRoomNotifyLevel(room.jid, 'none', !room.isQuickChat)
        break
    }
  }

  const items = [
    {
      key: 'mentions', label: t('rooms.mentionsOnly'), description: t('rooms.defaultBehavior'),
      icon: notifyIconOf('mentions'), active: mode === 'mentions', onSelect: () => select('mentions'),
    },
    {
      key: 'all-session', label: t('rooms.allMessages'), description: t('rooms.thisSessionOnly'),
      icon: notifyIconOf('all-session'), active: mode === 'all-session', onSelect: () => select('all-session'),
    },
  ]
  if (!room.isQuickChat) {
    items.push({
      key: 'all-always', label: t('rooms.allMessages'), description: t('rooms.alwaysSavedToBookmark'),
      icon: notifyIconOf('all-always'), active: mode === 'all-always', onSelect: () => select('all-always'),
    })
  }
  items.push({
    key: 'off', label: t('rooms.notificationsOff'),
    description: room.isQuickChat ? t('rooms.thisSessionOnly') : t('rooms.alwaysSavedToBookmark'),
    icon: notifyIconOf('off'), active: mode === 'off', onSelect: () => select('off'),
  })
  return { title: t('rooms.notificationSettings'), items }
}

interface ManagementArgs {
  room: Room
  t: TFunction
  isOwner: boolean
  canManageRoom: boolean
  onConfig: () => void
  onAvatar: () => void
  onClearAvatar: () => void
  onMembers: () => void
  onHats: () => void
  onBulkModeration?: () => void
}

export function buildManagementGroup(args: ManagementArgs): HeaderActionGroup | null {
  const { room, t, isOwner, canManageRoom, onConfig, onAvatar, onClearAvatar, onMembers, onHats, onBulkModeration } = args
  if (!canManageRoom && !onBulkModeration) return null

  const items: HeaderActionGroup['items'] = canManageRoom ? [
    { key: 'settings', label: t('rooms.roomSettings'), description: t('rooms.configureRoom'), icon: Settings, onSelect: onConfig },
    { key: 'subject', label: t('rooms.changeSubject'), icon: Type, onSelect: onConfig },
  ] : []
  if (onBulkModeration) {
    items.push({ key: 'bulk-moderation', label: t('rooms.bulkModeration'), icon: Shield, onSelect: onBulkModeration })
  }
  if (isOwner) {
    items.push({ key: 'avatar', label: t('rooms.changeAvatar'), icon: Image, onSelect: onAvatar })
    if (room.avatar) {
      items.push({ key: 'clear-avatar', label: t('rooms.removeAvatar'), icon: Trash2, danger: true, onSelect: onClearAvatar })
    }
  }
  if (canManageRoom) {
    items.push({ key: 'membership', label: t('rooms.manageMembership'), description: t('rooms.kickBanMembers'), icon: UserMinus, onSelect: onMembers })
  }
  if (isOwner) {
    items.push({
      key: 'hats', label: t('rooms.manageHats'),
      description: room.supportsHats ? t('rooms.manageHatsDesc') : t('rooms.hatsNotEnabled'),
      icon: Award, disabled: !room.supportsHats, onSelect: onHats,
    })
  }
  return { title: t('rooms.manageRoom'), items }
}
