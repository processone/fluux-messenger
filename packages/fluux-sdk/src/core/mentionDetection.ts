/**
 * Mention detection utilities for XMPP group chat messages.
 *
 * Detects mentions in multiple formats used by different XMPP clients:
 * - @nick anywhere in message (modern XMPP clients)
 * - nick: or nick, at start of message (IRC-style clients like Gajim, Profanity)
 * - nick (bare, 5+ chars) at start of message followed by space
 */

/** Minimum nickname length for bare "nick " detection (no separator) */
const BARE_NICK_MIN_LENGTH = 5

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Check if a message body contains a mention of the given nickname.
 * Used for notification/badge counting in room messages.
 */
export function checkForMention(body: string, nickname: string): boolean {
  if (!nickname || !body) return false
  const escaped = escapeRegex(nickname)

  // @nick anywhere in message (followed by word boundary, whitespace, punctuation, or end)
  if (new RegExp(`@${escaped}(?=[\\s.,;:!?)"'\\]|]|$)`, 'i').test(body)) return true

  // nick: or nick, at start of message
  if (new RegExp(`^${escaped}[,:]`, 'i').test(body)) return true

  // Bare nick at start (5+ chars only) followed by space
  if (nickname.length >= BARE_NICK_MIN_LENGTH) {
    if (new RegExp(`^${escaped}\\s`, 'i').test(body)) return true
  }

  return false
}

/**
 * Find all mention ranges in a message body for the given nickname.
 * Returns begin/end positions suitable for rendering highlights.
 */
export function findMentionRanges(body: string, nickname: string): { begin: number; end: number }[] {
  if (!nickname || !body) return []
  const escaped = escapeRegex(nickname)
  const ranges: { begin: number; end: number }[] = []

  // @nick anywhere (include the @ in the highlight range)
  const atRegex = new RegExp(`@${escaped}(?=[\\s.,;:!?)"'\\]|]|$)`, 'gi')
  let match
  while ((match = atRegex.exec(body)) !== null) {
    ranges.push({ begin: match.index, end: match.index + match[0].length })
  }

  // nick: or nick, at start of message (highlight just the nick, not the separator)
  const separatorMatch = new RegExp(`^(${escaped})[,:]`, 'i').exec(body)
  if (separatorMatch) {
    ranges.push({ begin: 0, end: separatorMatch[1].length })
  }

  // Bare nick at start (5+ chars) followed by space
  if (nickname.length >= BARE_NICK_MIN_LENGTH && !separatorMatch) {
    const bareMatch = new RegExp(`^(${escaped})\\s`, 'i').exec(body)
    if (bareMatch) {
      ranges.push({ begin: 0, end: bareMatch[1].length })
    }
  }

  return ranges.sort((a, b) => a.begin - b.begin)
}
