import type { Room } from '@fluux/sdk'

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

export type RoomTooltipRoom = Pick<Room, 'joined' | 'isJoining' | 'occupants' | 'nickname'>

export function roomTooltip(room: RoomTooltipRoom, t: TranslateFn): string {
  if (room.isJoining) return t('rooms.joining')
  if (!room.joined) return t('rooms.doubleClickToJoin')

  const userCount = room.occupants.size
  const userText = `${userCount} ${userCount === 1 ? t('rooms.user') : t('rooms.users')}`
  return room.nickname ? `${userText} • ${room.nickname}` : userText
}
