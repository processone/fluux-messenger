import { format } from 'date-fns'

/**
 * Check if message is a /me action message (IRC-style action).
 * Used to display timestamps instead of avatars for action messages.
 */
export function isActionMessage(body: string | undefined): boolean {
  return body?.startsWith('/me ') ?? false
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
  securityContext?: GroupingSecurityContext
  /** XEP-0045 §7.5: true if this is a private message ("whisper"). */
  isPrivate?: boolean
  /** Nick of the whisper counterpart (recipient if outgoing, sender if incoming). */
  whisperWith?: string
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
 * Two messages share a group only if their whisper context matches: both public,
 * or both whispers with the same counterpart. A public↔whisper transition (or a
 * whisper-to-A↔whisper-to-B switch) forces a group break so the whisper badge
 * re-shows on the new header — without this, a whisper nestled after a public
 * message from the same sender would render without any "private to X" cue.
 */
function sameWhisperContext(a: GroupableMessage, b: GroupableMessage): boolean {
  if (!a.isPrivate && !b.isPrivate) return true
  if (!a.isPrivate || !b.isPrivate) return false
  return a.whisperWith === b.whisperWith
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
 */
export function shouldShowAvatar<T extends GroupableMessage>(messages: T[], index: number): boolean {
  if (index === 0) return true

  const current = messages[index]
  const previous = messages[index - 1]

  // Show avatar if different sender
  if (current.from !== previous.from) return true

  // Show avatar if security context changed (encryption added/removed/trust shift)
  if (!sameSecurityContext(current.securityContext, previous.securityContext)) return true

  // Show avatar if whisper context changed (public↔private, or different counterpart)
  if (!sameWhisperContext(current, previous)) return true

  // Show avatar if more than 5 minutes apart
  const timeDiff = current.timestamp.getTime() - previous.timestamp.getTime()
  return timeDiff > 5 * 60 * 1000
}

/**
 * Scrolls to a message element and highlights it temporarily.
 * Used when clicking on reply context to jump to the original message.
 *
 * @param messageId - The ID of the message to scroll to (matches data-message-id attribute)
 */
export function scrollToMessage(messageId: string): void {
  // Use CSS.escape to handle special characters in message IDs (e.g., +, /, =)
  // Some clients use base64-encoded IDs that contain these characters
  const escapedId = CSS.escape(messageId)

  function tryScroll(retriesLeft: number) {
    const element = document.querySelector(`[data-message-id="${escapedId}"]`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      element.classList.add('message-highlight')
      setTimeout(() => element.classList.remove('message-highlight'), 1500)
    } else if (retriesLeft > 0) {
      // Element may not be in DOM yet (first render). Retry after next frame.
      requestAnimationFrame(() => tryScroll(retriesLeft - 1))
    } else {
      // Debug: message not found in DOM, log to help diagnose issues
      console.warn(`[scrollToMessage] Message not found in DOM: id="${messageId}"`)
      const allMsgEls = document.querySelectorAll('[data-message-id]')
      const ids = Array.from(allMsgEls).slice(-20).map(el => el.getAttribute('data-message-id'))
      console.warn(`[scrollToMessage] Last ${ids.length} message IDs in DOM:`, ids)
    }
  }

  tryScroll(3)
}
