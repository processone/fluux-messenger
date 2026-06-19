import type { TFunction } from 'i18next'
import type { Room } from '@fluux/sdk'
import { Bell, BellOff, BellRing, Settings, Type, Image, Trash2, UserMinus, Award } from 'lucide-react'
import type { HeaderActionGroup } from './headerOverflow'

export type NotifyMode = 'mentions' | 'all-session' | 'all-always'

export function notifyModeOf(room: Room): NotifyMode {
  if (room.notifyAllPersistent) return 'all-always'
  if (room.notifyAll) return 'all-session'
  return 'mentions'
}

interface NotifyArgs {
  room: Room
  t: TFunction
  setRoomNotifyAll: (jid: string, all: boolean, persistent?: boolean) => Promise<void>
}

export function buildNotifyGroup({ room, t, setRoomNotifyAll }: NotifyArgs): HeaderActionGroup {
  const mode = notifyModeOf(room)
  const select = (next: NotifyMode) => {
    switch (next) {
      case 'mentions':
        void setRoomNotifyAll(room.jid, false, false)
        if (room.notifyAllPersistent) void setRoomNotifyAll(room.jid, false, true)
        break
      case 'all-session':
        void setRoomNotifyAll(room.jid, true, false)
        if (room.notifyAllPersistent) void setRoomNotifyAll(room.jid, false, true)
        break
      case 'all-always':
        void setRoomNotifyAll(room.jid, true, true)
        break
    }
  }

  const items = [
    {
      key: 'mentions', label: t('rooms.mentionsOnly'), description: t('rooms.defaultBehavior'),
      icon: BellOff, active: mode === 'mentions', onSelect: () => select('mentions'),
    },
    {
      key: 'all-session', label: t('rooms.allMessages'), description: t('rooms.thisSessionOnly'),
      icon: Bell, active: mode === 'all-session', onSelect: () => select('all-session'),
    },
  ]
  if (!room.isQuickChat) {
    items.push({
      key: 'all-always', label: t('rooms.allMessages'), description: t('rooms.alwaysSavedToBookmark'),
      icon: BellRing, active: mode === 'all-always', onSelect: () => select('all-always'),
    })
  }
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
}

export function buildManagementGroup(args: ManagementArgs): HeaderActionGroup | null {
  const { room, t, isOwner, canManageRoom, onConfig, onAvatar, onClearAvatar, onMembers, onHats } = args
  if (!canManageRoom) return null

  const items: HeaderActionGroup['items'] = [
    { key: 'settings', label: t('rooms.roomSettings'), description: t('rooms.configureRoom'), icon: Settings, onSelect: onConfig },
    { key: 'subject', label: t('rooms.changeSubject'), icon: Type, onSelect: onConfig },
  ]
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
