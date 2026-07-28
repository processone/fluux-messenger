import { format } from 'date-fns'
import { getActiveMessageListController } from './activeMessageListController'

/**
 * Check if message is a /me action message (IRC-style action).
 * Used to display timestamps instead of avatars for action messages.
 */
export function isActionMessage(body: string | undefined): boolean {
  return body?.startsWith('/me ') ?? false
}

/**
 * Whether the "close poll" action should be offered for a message.
 *
 * GUARD (regression class): `isClosed` MUST be a plain reactive value — derived
 * per-message and passed to the row as a prop — NOT read at render time from a
 * stable getter/ref inside a memoized row. A memoized row only re-renders when its
 * own props change, so reading a stable getter during render freezes the result:
 * the row would keep offering "close" on an already-closed poll until it remounts.
 * This is the same failure mode that froze the reply-scroll target (see
 * `scrollToMessage` and RoomView's `getMessageById` note). Keeping this a typed
 * `boolean` parameter makes the freeze unrepresentable for this decision.
 */
export function canClosePoll(
  message: { isOutgoing?: boolean; poll?: unknown; pollClosedAt?: Date },
  isClosed: boolean,
): boolean {
  return Boolean(message.isOutgoing && message.poll && !isClosed && !message.pollClosedAt)
}

/**
 * Security context subset used for grouping. Matches the SDK's
 * `MessageSecurityContext` shape — duplicated here to keep this module
 * free of SDK imports so it stays cheap to unit-test.
 */
interface GroupingSecurityContext {
  protocolId: string
  trust: 'verified' | 'introduced' | 'tofu' | 'untrusted' | 'rejected'
}

/**
 * Base message interface for grouping (works with both Message and RoomMessage)
 */
interface GroupableMessage {
  id: string
  timestamp: Date
  from: string
  /** True for messages the local user sent — drives own-message grouping. */
  isOutgoing?: boolean
  /** Message body — used to detect /me action messages for grouping. */
  body?: string
  securityContext?: GroupingSecurityContext
  /** XEP-0045 §7.5: true if this is a private message ("whisper"). */
  isPrivate?: boolean
  /** Nick of the whisper counterpart (recipient if outgoing, sender if incoming). */
  whisperWith?: string
  /** XEP-0421 occupant-id of the whisper counterpart, when known. */
  whisperWithOccupantId?: string
}

/**
 * Two messages share a group only if their (protocolId, trust) are the same —
 * including both being cleartext (no context). A trust change mid-burst forces
 * a group break so the lock indicator re-shows.
 */
function sameSecurityContext(
  a: GroupingSecurityContext | undefined,
  b: GroupingSecurityContext | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.protocolId === b.protocolId && a.trust === b.trust
}

/**
 * Whether two whispers share the same counterpart. Prefers the stable XEP-0421
 * occupant-id when both carry it (so a recycled nick can't merge two different
 * people's runs); falls back to the nick when either side lacks an id (legacy /
 * persisted whispers, or rooms without occupant-id support).
 */
function sameWhisperCounterpart(
  a: GroupableMessage | undefined,
  b: GroupableMessage | undefined,
): boolean {
  if (a?.whisperWithOccupantId && b?.whisperWithOccupantId) {
    return a.whisperWithOccupantId === b.whisperWithOccupantId
  }
  return a?.whisperWith === b?.whisperWith
}

/**
 * Two messages share a group only if their whisper context matches: both public,
 * or both whispers with the same counterpart. A public↔whisper transition (or a
 * whisper-to-A↔whisper-to-B switch) forces a group break so the whisper badge
 * re-shows on the new header — without this, a whisper nestled after a public
 * message from the same sender would render without any "private to X" cue.
 */
function sameWhisperContext(a: GroupableMessage, b: GroupableMessage): boolean {
  if (!a.isPrivate && !b.isPrivate) return true
  if (!a.isPrivate || !b.isPrivate) return false
  return sameWhisperCounterpart(a, b)
}

/**
 * A group of messages that occurred on the same date
 */
export interface MessageGroup<T extends GroupableMessage> {
  /** Date string in yyyy-MM-dd format */
  date: string
  /** Messages from this date */
  messages: T[]
}

/**
 * Groups messages by their date (yyyy-MM-dd format).
 *
 * Uses a Map to collect messages by date, then sorts both the groups (by date)
 * and messages within each group (by timestamp). This handles the case where
 * messages may arrive out of order (e.g., delayed messages via live path,
 * cached messages merged with live messages).
 */
export function groupMessagesByDate<T extends GroupableMessage>(messages: T[]): MessageGroup<T>[] {
  // Collect messages by date using a Map
  const groupMap = new Map<string, T[]>()

  for (const msg of messages) {
    const dateStr = format(msg.timestamp, 'yyyy-MM-dd')
    const existing = groupMap.get(dateStr)
    if (existing) {
      existing.push(msg)
    } else {
      groupMap.set(dateStr, [msg])
    }
  }

  // Convert to array and sort groups by date, messages by timestamp
  const groups: MessageGroup<T>[] = []
  for (const [date, msgs] of groupMap) {
    // Sort messages within each group by timestamp
    msgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    groups.push({ date, messages: msgs })
  }

  // Sort groups by date (chronological order)
  groups.sort((a, b) => a.date.localeCompare(b.date))

  return groups
}

/**
 * Determines if a message should show its avatar based on:
 * - First message always shows avatar
 * - Different sender from previous message
 * - More than 5 minutes gap from previous message
 * - E2EE security context differs from previous (protocol or trust change
 *   forces a group break so the lock indicator re-shows — without this, a
 *   sender's untrusted message nestled between trusted ones would render
 *   without any security-state cue).
 * - Whisper context differs from previous (public↔private or a different
 *   whisper counterpart forces a group break so the whisper badge re-shows).
 * - Previous message was a /me action and this one is not (see below).
 */
export function shouldShowAvatar<T extends GroupableMessage>(messages: T[], index: number): boolean {
  if (index === 0) return true

  const current = messages[index]
  const previous = messages[index - 1]

  // Show avatar if different sender
  if (current.from !== previous.from) return true

  // A /me action renders a timestamp in the avatar column with its nick inline —
  // it never spends the avatar/name header. So a following non-action message from
  // the same sender would otherwise render as a headerless continuation with no
  // sender attribution at all, visually attaching to the PREVIOUS sender's group.
  // Re-show the avatar when emerging from an action so the sender is identified.
  if (isActionMessage(previous.body) && !isActionMessage(current.body)) return true

  // Show avatar if security context changed (encryption added/removed/trust shift)
  if (!sameSecurityContext(current.securityContext, previous.securityContext)) return true

  // Show avatar if whisper context changed (public↔private, or different counterpart)
  if (!sameWhisperContext(current, previous)) return true

  // Show avatar if more than 5 minutes apart
  const timeDiff = current.timestamp.getTime() - previous.timestamp.getTime()
  return timeDiff > 5 * 60 * 1000
}

/**
 * Stable key identifying the run of consecutive OWN messages a row belongs to,
 * or `undefined` when the row is incoming OR is a solo own message (a group of
 * one needs no shared-width coordination). The key is the group-start message's
 * id, so every member of the same run resolves to the same value.
 *
 * A "run" is an avatar-group (same boundaries as {@link shouldShowAvatar}) whose
 * rows are all outgoing — the exact span the own-message tint renders as one
 * continuous surface. Used to make those rows share the widest line's width so
 * the tint reads as a clean rectangle (see `useOwnGroupWidth`).
 */
export function ownGroupKey<T extends GroupableMessage>(messages: T[], index: number): string | undefined {
  if (!messages[index]?.isOutgoing) return undefined

  // Walk back to the group start (rows without an avatar continue the previous).
  let start = index
  while (start > 0 && !shouldShowAvatar(messages, start)) start--
  // Walk forward to the group end (the next avatar row starts a new group).
  let end = index
  while (end < messages.length - 1 && !shouldShowAvatar(messages, end + 1)) end++

  // The whole run must be outgoing (a sender change is an avatar break, so this
  // holds by construction, but guard the boundaries defensively) and span > 1 row.
  if (start === end) return undefined
  if (!messages[start].isOutgoing || !messages[end].isOutgoing) return undefined
  return messages[start].id
}

/** Position of a message within a whisper thread (see `whisperThreadPosition`). */
export type WhisperThreadPosition = 'solo' | 'start' | 'middle' | 'end'

/**
 * Two messages belong to the same whisper thread when both are private and share
 * the same counterpart — regardless of who sent each. This lets a back-and-forth
 * (Emma → you → Emma) gather into one thread even though the sender alternates.
 */
function sameWhisperThread(
  a: GroupableMessage | undefined,
  b: GroupableMessage | undefined,
): boolean {
  return !!a?.isPrivate && !!b?.isPrivate && sameWhisperCounterpart(a, b)
}

/**
 * Position of a message within a "whisper thread" — a consecutive run of private
 * messages (XEP-0045 §7.5) with the same counterpart, used to render the run as a
 * single bounded "private with X" container. A public message or a switch to a
 * different counterpart breaks the run. Returns null for non-whisper messages.
 */
export function whisperThreadPosition<T extends GroupableMessage>(
  messages: T[],
  index: number,
): WhisperThreadPosition | null {
  const current = messages[index]
  if (!current?.isPrivate) return null

  const isStart = !sameWhisperThread(current, messages[index - 1])
  const isEnd = !sameWhisperThread(current, messages[index + 1])

  if (isStart && isEnd) return 'solo'
  if (isStart) return 'start'
  if (isEnd) return 'end'
  return 'middle'
}

/**
 * Whether the counterpart of a whisper is currently in the room — used to gate
 * replying (you can only continue a private thread with someone who is present).
 * Matches on the stable occupant-id when the message carries one (so a recycled
 * nick held by someone else reads as "not present"); otherwise falls back to nick.
 */
export function whisperCounterpartPresent(
  msg: { whisperWith?: string; whisperWithOccupantId?: string },
  occupants: ReadonlyMap<string, { occupantId?: string }>,
): boolean {
  if (msg.whisperWithOccupantId) {
    for (const occ of occupants.values()) {
      if (occ.occupantId === msg.whisperWithOccupantId) return true
    }
    return false
  }
  return !!msg.whisperWith && occupants.has(msg.whisperWith)
}

/**
 * Ask the LIVE conversation list to position and highlight a message.
 *
 * The active list owns target resolution, loading, browser reconciliation, and cancellation. This
 * helper intentionally performs no DOM lookup or scroll write of its own.
 *
 * Only for callers with no enclosing message list that genuinely mean the live conversation
 * (PollBanner above the list, find-on-page at the layout level). Anything rendered INSIDE a list —
 * reply quotes, poll cards — must use `useRequestMessageTarget` so the click routes to the list it
 * happened in; otherwise a click inside a search/activity preview scrolls the live conversation.
 *
 * @param messageId - Local, stanza, or origin ID understood by the active list's target resolver.
 */
export function scrollToMessage(messageId: string): void {
  getActiveMessageListController()?.requestMessageTarget(messageId)
}
