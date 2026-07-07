import { isMessageFromIgnoredUser, type Room } from '@fluux/sdk'
import type { IgnoredUser } from '@fluux/sdk/stores'

/**
 * Nicknames to display as "typing" on a room's sidebar row, with the user's own
 * nick and any ignored users removed. Order-preserving. Returns [] when none apply.
 *
 * Mirrors the ignore filter RoomView applies to its live typing indicator so the
 * sidebar and the open room agree on who counts as typing.
 */
export function visibleRoomTypingNicks(room: Room, ignoredForRoom: IgnoredUser[]): string[] {
  if (!room.typingUsers || room.typingUsers.size === 0) return []
  const own = room.nickname
  const cache = room.nickToJidCache
  return Array.from(room.typingUsers).filter(
    (nick) => nick !== own && !isMessageFromIgnoredUser(ignoredForRoom, { nick }, cache),
  )
}
