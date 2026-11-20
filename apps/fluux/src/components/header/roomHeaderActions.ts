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
  /** Called when a choice could not be saved to the room's bookmark. */
  onSaveFailed: () => void
}

export function buildNotifyGroup({ room, t, setRoomNotifyLevel, onSaveFailed }: NotifyArgs): HeaderActionGroup {
  const mode = notifyModeOf(room)
  // Levels are saved to the bookmark, so a room without one (a quick chat, or a joined
  // room that is not bookmarked) keeps Off for the session only and has no saved All messages.
  const hasNoBookmark = room.isQuickChat || !room.isBookmarked
  // A level saved in the bookmark must be cleared when a session-only choice replaces it.
  // A saved level shows as a session choice until the bookmark stores it, so a bookmarked
  // room showing All messages or Off may be about to save it: Mentions only is saved then
  // too, and the bookmark ends on the latest choice.
  const storesMentions = savedNotifyLevel(room) === 'mentions'
  const hasSavedChoice = !storesMentions || (!hasNoBookmark && mode !== 'mentions')
  // The menu closes on click, so a saved level the bookmark write refuses is
  // reported through onSaveFailed instead of being dropped unhandled.
  const setLevel = (level: NotifyLevel, persistent: boolean) => {
    setRoomNotifyLevel(room.jid, level, persistent).catch(onSaveFailed)
  }
  const select = (next: NotifyMode) => {
    switch (next) {
      case 'mentions':
        // When the bookmark already stores Mentions only, it applies for the session first,
        // so it stays applied if the save is refused; a stored save clears that session choice.
        if (hasSavedChoice && storesMentions) setLevel('mentions', false)
        setLevel('mentions', hasSavedChoice)
        break
      case 'all-session':
        if (hasSavedChoice) setLevel('mentions', true)
        setLevel('all', false)
        break
      case 'all-always':
        setLevel('all', true)
        break
      case 'off':
        setLevel('none', !hasNoBookmark)
        break
    }
  }

  const items = [
    {
      key: 'off', label: t('rooms.notificationsOff'),
      description: hasNoBookmark ? t('rooms.thisSessionOnly') : t('rooms.alwaysSavedToBookmark'),
      icon: notifyIconOf('off'), active: mode === 'off', onSelect: () => select('off'),
    },
    {
      key: 'mentions', label: t('rooms.mentionsOnly'), description: t('rooms.defaultBehavior'),
      icon: notifyIconOf('mentions'), active: mode === 'mentions', onSelect: () => select('mentions'),
    },
    {
      key: 'all-session', label: t('rooms.allMessages'), description: t('rooms.thisSessionOnly'),
      icon: notifyIconOf('all-session'), active: mode === 'all-session', onSelect: () => select('all-session'),
    },
  ]
  if (!hasNoBookmark) {
    items.push({
      key: 'all-always', label: t('rooms.allMessages'), description: t('rooms.alwaysSavedToBookmark'),
      icon: notifyIconOf('all-always'), active: mode === 'all-always', onSelect: () => select('all-always'),
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
