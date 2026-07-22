import type { Room } from '@fluux/sdk'

// Matches the TranslateFn convention in messagePreviewText.ts / roomJoinError.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * The room fields the sidebar row tooltip needs.
 *
 * `mentionsCount` is deliberately absent. The unread headline must not be gated
 * on it — the row's own `@N` badge already carries the mentions number, and a
 * room WITH mentions is exactly the case where the total unread is otherwise
 * invisible. Leaving the field out of the input type makes that gate
 * unrepresentable here.
 */
export type RoomTooltipRoom = Pick<
  Room,
  'joined' | 'isJoining' | 'unreadCount' | 'occupants' | 'nickname'
>

export interface RoomTooltipParts {
  /** "37 unread messages", or null when there is nothing unread to announce. */
  headline: string | null
  /** "12 users • MyNick" | "Joining..." | "Double-click to join" */
  detail: string
}

/**
 * Compose the sidebar room row tooltip.
 *
 * The detail line reproduces the tooltip as it was before the unread headline
 * existed, including the manual singular/plural selection between `rooms.user`
 * and `rooms.users`. The headline is the only new information, and it appears
 * only for a joined room with unread messages.
 */
export function roomTooltipParts(room: RoomTooltipRoom, t: TranslateFn): RoomTooltipParts {
  if (room.isJoining) return { headline: null, detail: t('rooms.joining') }
  if (!room.joined) return { headline: null, detail: t('rooms.doubleClickToJoin') }

  const userCount = room.occupants.size
  const userText = `${userCount} ${userCount === 1 ? t('rooms.user') : t('rooms.users')}`
  const detail = room.nickname ? `${userText} • ${room.nickname}` : userText

  const headline =
    room.unreadCount > 0 ? t('rooms.unreadMessages', { count: room.unreadCount }) : null

  return { headline, detail }
}
