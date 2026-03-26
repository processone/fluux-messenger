/**
 * Poll utility functions — pure functions for building, parsing, and tallying polls.
 *
 * Polls use XEP-0444 reactions as the voting mechanism. Each poll option
 * maps to a numbered emoji, and voting = sending a reaction with that emoji.
 *
 * @packageDocumentation
 * @module Poll
 */

import type { Element } from '@xmpp/client'
import type { PollData, PollOption, PollSettings, PollClosedData, PollCheckpointData } from './types/message-base'

/** The numbered emoji set used for poll options (index 0 = 1️⃣, etc.) */
export const POLL_OPTION_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'] as const

/** Maximum number of poll options */
export const MAX_POLL_OPTIONS = POLL_OPTION_EMOJIS.length

/** Default poll settings */
export const DEFAULT_POLL_SETTINGS: PollSettings = {
  allowMultiple: false,
  hideResultsBeforeVote: false,
}

/**
 * Build PollData from a title, optional description, and option labels.
 *
 * @param customEmojis - Optional array of emojis to use instead of the default numbered set.
 *   Must match the length of `optionLabels`. When omitted, numbered emojis (1️⃣, 2️⃣, …) are used
 *   and `optionLabels` is capped at {@link MAX_POLL_OPTIONS}.
 */
export function buildPollData(
  title: string,
  optionLabels: string[],
  settings: Partial<PollSettings> = {},
  description?: string,
  deadline?: string,
  customEmojis?: string[],
): PollData {
  if (optionLabels.length < 2) {
    throw new Error(`Poll must have at least 2 options, got ${optionLabels.length}`)
  }

  if (customEmojis) {
    if (customEmojis.length !== optionLabels.length) {
      throw new Error(`customEmojis length (${customEmojis.length}) must match optionLabels length (${optionLabels.length})`)
    }
  } else if (optionLabels.length > MAX_POLL_OPTIONS) {
    throw new Error(`Poll must have at most ${MAX_POLL_OPTIONS} options when using default emojis, got ${optionLabels.length}`)
  }

  const options: PollOption[] = optionLabels.map((label, i) => ({
    emoji: customEmojis ? customEmojis[i] : POLL_OPTION_EMOJIS[i],
    label,
  }))

  return {
    title,
    ...(description ? { description } : {}),
    options,
    settings: { ...DEFAULT_POLL_SETTINGS, ...settings },
    ...(deadline ? { deadline } : {}),
  }
}

/**
 * Build the text fallback body for legacy clients.
 *
 * @example
 * ```
 * 📊 Poll: What for lunch?
 * Pick your favorite option
 * 1️⃣ Pizza
 * 2️⃣ Sushi
 * 3️⃣ Tacos
 * ```
 */
export function buildPollFallbackBody(title: string, optionLabels: string[], description?: string, customEmojis?: string[]): string {
  const header = `📊 Poll: ${title}`
  const descLine = description ? [description] : []
  const lines = optionLabels.map((label, i) => {
    const emoji = customEmojis ? customEmojis[i] : POLL_OPTION_EMOJIS[i]
    return `${emoji} ${label}`
  })
  return [header, ...descLine, ...lines].join('\n')
}

/**
 * Parse a `<poll xmlns="urn:fluux:poll:0">` element into PollData.
 */
export function parsePollElement(pollEl: Element): PollData | null {
  const title = pollEl.getChildText('title')
  if (!title) return null

  const optionEls = pollEl.getChildren('option')
  if (optionEls.length < 2) return null

  const options: PollOption[] = optionEls
    .map((el) => ({
      emoji: el.attrs.emoji as string,
      label: el.getText() || '',
    }))
    .filter((opt) => opt.emoji && opt.label)

  if (options.length < 2) return null

  const allowMultiple = pollEl.attrs['allow-multiple'] === 'true'
  const hideResultsBeforeVote = pollEl.attrs['hide-results'] === 'true'
  const description = pollEl.getChildText('description') || undefined
  const deadline = pollEl.attrs.deadline as string | undefined

  return {
    title,
    ...(description ? { description } : {}),
    options,
    settings: { allowMultiple, hideResultsBeforeVote },
    ...(deadline ? { deadline } : {}),
  }
}

/**
 * Result entry for a single poll option.
 */
export interface PollTally {
  /** The option emoji */
  emoji: string
  /** The option label */
  label: string
  /** List of voter identifiers (JIDs or nicks) */
  voters: string[]
  /** Number of votes */
  count: number
}

/**
 * Tally poll results from a reactions map.
 *
 * Returns one entry per option with voter list and count,
 * in the same order as the poll options.
 *
 * In single-vote mode, if a voter has reacted with multiple poll-option emojis,
 * only their first vote (in option order) is counted. This provides a graceful
 * best-effort handling of malformed votes from legacy or buggy clients.
 * In multi-vote mode, all votes are counted as-is.
 */
export function tallyPollResults(
  poll: PollData,
  reactions: Record<string, string[]> | undefined,
): PollTally[] {
  if (poll.settings.allowMultiple) {
    // Multi-vote: count all reactions per option
    return poll.options.map((opt) => {
      const voters = reactions?.[opt.emoji] ?? []
      return { emoji: opt.emoji, label: opt.label, voters, count: voters.length }
    })
  }

  // Single-vote: each voter is counted in their first option only (in option order).
  // This handles the case where a legacy client sent multiple poll-option reactions.
  const voterAssigned = new Set<string>()

  return poll.options.map((opt) => {
    const rawVoters = reactions?.[opt.emoji] ?? []
    const voters = rawVoters.filter((voter) => {
      if (voterAssigned.has(voter)) return false
      voterAssigned.add(voter)
      return true
    })
    return { emoji: opt.emoji, label: opt.label, voters, count: voters.length }
  })
}

/**
 * Get the total number of unique voters across all options.
 * A voter who reacted with multiple poll emojis is counted once.
 */
export function getTotalVoters(
  poll: PollData,
  reactions: Record<string, string[]> | undefined,
): number {
  const uniqueVoters = new Set<string>()
  for (const opt of poll.options) {
    const voters = reactions?.[opt.emoji]
    if (voters) {
      for (const voter of voters) {
        uniqueVoters.add(voter)
      }
    }
  }
  return uniqueVoters.size
}

/**
 * Enforce single-vote mode: when voting for a new option,
 * remove any other poll-option emojis from the current reaction set.
 * Non-poll emojis (like 👍) are preserved.
 *
 * @param currentReactions - The user's current reaction emojis on this message
 * @param newVote - The poll-option emoji being voted for
 * @param pollEmojis - The set of emojis used by this poll's options
 * @returns The filtered emoji array to send as the new reaction set
 */
export function enforceSingleVote(
  currentReactions: string[],
  newVote: string,
  pollEmojis: string[],
): string[] {
  const pollEmojiSet = new Set(pollEmojis)

  // Keep non-poll emojis, remove all poll emojis
  const nonPollReactions = currentReactions.filter((emoji) => !pollEmojiSet.has(emoji))

  // Check if we're toggling off the current vote
  const isTogglingOff = currentReactions.includes(newVote)
  if (isTogglingOff) {
    return nonPollReactions
  }

  // Add the new vote
  return [...nonPollReactions, newVote]
}

/**
 * Enforce multi-vote mode: toggle the voted emoji in the current reaction set.
 * This is the standard reaction toggle behavior.
 *
 * @param currentReactions - The user's current reaction emojis on this message
 * @param toggledEmoji - The poll-option emoji being toggled
 * @returns The updated emoji array
 */
export function enforceMultiVote(
  currentReactions: string[],
  toggledEmoji: string,
): string[] {
  if (currentReactions.includes(toggledEmoji)) {
    return currentReactions.filter((e) => e !== toggledEmoji)
  }
  return [...currentReactions, toggledEmoji]
}

/**
 * Extract the emoji keys that the current user has reacted with.
 *
 * Room messages store reactors as occupant nicks, while 1:1 messages use bare JIDs.
 * This helper picks the right identifier depending on context.
 *
 * @param reactions - The message's reactions map (emoji → reactor IDs)
 * @param myNick - The user's room nickname (for groupchat messages)
 * @param myBareJid - The user's bare JID (for 1:1 messages)
 * @param isGroupchat - Whether the message is a groupchat (room) message
 * @returns Array of emoji strings the user has reacted with
 */
export function getMyReactions(
  reactions: Record<string, string[]> | undefined,
  myNick: string | undefined,
  myBareJid: string | undefined,
  isGroupchat: boolean,
): string[] {
  if (!reactions) return []
  const myId = (isGroupchat && myNick) ? myNick : myBareJid
  if (!myId) return []
  return Object.entries(reactions)
    .filter(([, reactors]) => reactors.includes(myId))
    .map(([emoji]) => emoji)
}

/**
 * Check whether a user has voted on a poll.
 *
 * @param poll - The poll data
 * @param reactions - The message's reactions map
 * @param myId - The current user's identifier (JID or nick)
 * @returns True if the user has voted for at least one option
 */
export function hasVotedOnPoll(
  poll: PollData,
  reactions: Record<string, string[]> | undefined,
  myId: string,
): boolean {
  return poll.options.some((opt) => reactions?.[opt.emoji]?.includes(myId))
}

/**
 * Get the option emojis for a poll.
 */
export function getPollOptionEmojis(poll: PollData): string[] {
  return poll.options.map((opt) => opt.emoji)
}

/**
 * Check whether a poll's deadline has passed.
 *
 * @param poll - The poll data
 * @param now - Current time (defaults to `new Date()`, injectable for tests)
 * @returns True if the poll has a deadline and it has passed
 */
export function isPollExpired(poll: PollData, now: Date = new Date()): boolean {
  if (!poll.deadline) return false
  const deadlineDate = new Date(poll.deadline)
  return now >= deadlineDate
}

/**
 * Parse a `<poll-closed xmlns="urn:fluux:poll:0">` element into PollClosedData.
 *
 * Sent by the poll creator to freeze and broadcast the final result.
 */
export function parsePollClosedElement(el: Element): PollClosedData | null {
  const pollMessageId = el.attrs['message-id']
  if (!pollMessageId) return null

  const title = el.getChildText('title')
  if (!title) return null

  const description = el.getChildText('description') || undefined

  const tallyEls = el.getChildren('tally')
  const results = tallyEls
    .map((t) => {
      const votersStr = (t.attrs.voters as string) || ''
      const voters = votersStr.split(',').filter(Boolean)
      return {
        emoji: t.attrs.emoji as string,
        label: (t.attrs.label as string) ?? '',
        count: Math.max(0, parseInt(t.attrs.count as string, 10) || 0),
        ...(voters.length > 0 ? { voters } : {}),
      }
    })
    .filter((r) => r.emoji)

  return { title, ...(description ? { description } : {}), pollMessageId, results }
}

/**
 * Parse a `<poll-checkpoint xmlns="urn:fluux:poll:0">` element into PollCheckpointData.
 *
 * Sent by the poll creator to broadcast a snapshot of the current tally.
 * Same structure as poll-closed — only the element name differs.
 */
export function parsePollCheckpointElement(el: Element): PollCheckpointData | null {
  const pollMessageId = el.attrs['message-id']
  if (!pollMessageId) return null

  const title = el.getChildText('title')
  if (!title) return null

  const description = el.getChildText('description') || undefined

  const tallyEls = el.getChildren('tally')
  const results = tallyEls
    .map((t) => ({
      emoji: t.attrs.emoji as string,
      label: (t.attrs.label as string) ?? '',
      count: Math.max(0, parseInt(t.attrs.count as string, 10) || 0),
      voters: ((t.attrs.voters as string) || '').split(',').filter(Boolean),
    }))
    .filter((r) => r.emoji)

  return { title, ...(description ? { description } : {}), pollMessageId, results }
}
