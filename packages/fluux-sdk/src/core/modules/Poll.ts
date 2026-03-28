/**
 * Poll Module — Manages client-side polls using XEP-0444 reactions as the voting mechanism.
 *
 * Polls are sent as groupchat messages with a custom `<poll xmlns="urn:fluux:poll:0">`
 * element. Voting is done by sending reactions with numbered emojis (1️⃣, 2️⃣, etc.).
 *
 * The module handles:
 * - Creating and sending poll messages
 * - Enforcing voting rules (single-vote / multi-vote)
 * - Responding to poll result IQ queries from other clients
 *
 * @packageDocumentation
 * @module Poll
 */

import { xml, type Element } from '@xmpp/client'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import type { Chat } from './Chat'
import type { PollData, PollSettings } from '../types/message-base'
import { NS_POLL } from '../namespaces'
import { NS_FALLBACK, NS_HINTS } from '../namespaces'
import { generateUUID } from '../../utils/uuid'
import {
  buildPollData,
  buildPollFallbackBody,
  tallyPollResults,
  enforceSingleVote,
  enforceMultiVote,
  getPollOptionEmojis,
  isPollExpired,
} from '../poll'
import { roomStore } from '../../stores/roomStore'

/**
 * Lightweight metadata for polls created by the local user.
 * Enables answering IQ result queries and creator-only actions.
 */
interface LocalPollEntry {
  roomJid: string
  messageId: string
  poll: PollData
  closed: boolean
}

/**
 * Poll module for managing reaction-based polls in MUC rooms.
 *
 * @example
 * ```typescript
 * // Create a poll
 * await client.poll.sendPoll('room@conference.example.com', 'What for lunch?', ['Pizza', 'Sushi', 'Tacos'])
 *
 * // Vote on a poll (single-vote mode)
 * await client.poll.vote('room@conference.example.com', 'msg-123', '2️⃣', ['1️⃣'], pollData)
 * ```
 *
 * @category Modules
 */
export class Poll extends BaseModule {
  private chat: Chat
  /** Polls created by the local user, keyed by message ID */
  private localPolls = new Map<string, LocalPollEntry>()
  /** Tracks poll IDs that have been closed (prevents duplicate close messages) */
  private closedPollIds = new Set<string>()

  constructor(deps: ModuleDependencies, chat: Chat) {
    super(deps)
    this.chat = chat
  }

  /**
   * Handle incoming stanzas — intercepts poll-results IQ queries.
   */
  handle(stanza: Element): boolean {
    if (!stanza.is('iq')) return false

    const type = stanza.attrs.type
    if (type !== 'get') return false

    const pollResults = stanza.getChild('poll-results', NS_POLL)
    if (!pollResults) return false

    this.handlePollResultQuery(stanza, pollResults)
    return true
  }

  /**
   * Send a poll message to a MUC room.
   *
   * @param roomJid - The room JID to send the poll to
   * @param title - The poll title (typically a question)
   * @param optionLabels - 2-9 option labels
   * @param settings - Optional voting settings
   * @param description - Optional description providing context
   * @param deadline - Optional ISO 8601 deadline after which voting is blocked
   * @param customEmojis - Optional custom emojis for each option (must match optionLabels length)
   * @returns The message ID of the poll message
   */
  async sendPoll(
    roomJid: string,
    title: string,
    optionLabels: string[],
    settings: Partial<PollSettings> = {},
    description?: string,
    deadline?: string,
    customEmojis?: string[],
  ): Promise<string> {
    const id = generateUUID()
    const pollData = buildPollData(title, optionLabels, settings, description, deadline, customEmojis)
    const fallbackBody = buildPollFallbackBody(title, optionLabels, description, customEmojis)

    const optionElements = pollData.options.map((opt) =>
      xml('option', { emoji: opt.emoji }, opt.label)
    )

    const pollAttrs: Record<string, string> = { xmlns: NS_POLL }
    if (pollData.settings.allowMultiple) {
      pollAttrs['allow-multiple'] = 'true'
    }
    if (pollData.settings.hideResultsBeforeVote) {
      pollAttrs['hide-results'] = 'true'
    }
    if (pollData.deadline) {
      pollAttrs.deadline = pollData.deadline
    }

    const pollChildren = [
      xml('title', {}, title),
      ...(description ? [xml('description', {}, description)] : []),
      ...optionElements,
    ]

    const message = xml('message', { to: roomJid, type: 'groupchat', id },
      xml('body', {}, fallbackBody),
      xml('poll', pollAttrs, ...pollChildren),
      xml('fallback', { xmlns: NS_FALLBACK, for: NS_POLL },
        xml('body', {}),
      ),
      xml('store', { xmlns: NS_HINTS }),
    )

    await this.deps.sendStanza(message)

    // Track locally for IQ result queries
    this.localPolls.set(id, {
      roomJid,
      messageId: id,
      poll: pollData,
      closed: false,
    })

    return id
  }

  /**
   * Vote on a poll, enforcing voting rules.
   *
   * In single-vote mode, removes any other poll-option emojis before sending.
   * In multi-vote mode, toggles the selected emoji.
   *
   * @param roomJid - The room JID
   * @param messageId - The poll message ID
   * @param optionEmoji - The emoji of the option being voted for
   * @param currentMyReactions - The user's current reaction emojis on this message
   * @param poll - The poll data (for settings and option emojis)
   * @param isClosed - Whether the poll has been closed by its creator
   */
  async vote(
    roomJid: string,
    messageId: string,
    optionEmoji: string,
    currentMyReactions: string[],
    poll: PollData,
    isClosed?: boolean,
  ): Promise<void> {
    if (isClosed) {
      throw new Error('Poll is closed — voting is no longer allowed')
    }
    if (isPollExpired(poll)) {
      throw new Error('Poll has expired — voting is no longer allowed')
    }

    const pollEmojis = getPollOptionEmojis(poll)

    if (!pollEmojis.includes(optionEmoji)) {
      throw new Error(`"${optionEmoji}" is not a valid poll option`)
    }
    let newReactions: string[]

    if (poll.settings.allowMultiple) {
      newReactions = enforceMultiVote(currentMyReactions, optionEmoji)
    } else {
      newReactions = enforceSingleVote(currentMyReactions, optionEmoji, pollEmojis)
    }

    await this.chat.sendReaction(roomJid, messageId, newReactions, 'groupchat')

    // Persist vote acknowledgement locally for banner dismissal across page reloads
    if (newReactions.length > 0) {
      roomStore.getState().recordPollVote(roomJid, messageId)
    } else {
      roomStore.getState().removePollVote(roomJid, messageId)
    }
  }

  /**
   * Close a poll and publish the frozen result to the room.
   *
   * Only the poll creator can close a poll. Sends a groupchat message
   * with a `<poll-closed>` element containing the final tally, so all
   * participants receive the authoritative result.
   *
   * @param roomJid - The room JID
   * @param messageId - The poll message ID to close
   * @returns The message ID of the result message, or null if poll not found
   */
  async closePoll(roomJid: string, messageId: string): Promise<string | null> {
    // Guard: already closed — don't send duplicate close messages
    if (this.closedPollIds.has(messageId)) return null
    const localPoll = this.localPolls.get(messageId)
    if (localPoll?.closed) return null

    // Get poll data from store (works for MAM-loaded polls) or fall back to localPolls
    const roomMessage = this.deps.stores?.room.getMessage(roomJid, messageId)
    const localPollData = localPoll?.roomJid === roomJid ? localPoll.poll : undefined
    const pollData = roomMessage?.poll ?? localPollData
    if (!pollData) return null

    // Mark as closed
    this.closedPollIds.add(messageId)
    if (localPoll) localPoll.closed = true

    // Get current tally from store
    const reactions = roomMessage?.reactions ?? {}
    const tally = tallyPollResults(pollData, reactions)

    // Build a result summary for the body fallback
    const resultLines = tally.map((t) => `${t.emoji} ${t.label}: ${t.count}`)
    const fallbackBody = `📊 Poll closed: ${pollData.title}\n${resultLines.join('\n')}`

    const tallyElements = tally.map((t) =>
      xml('tally', {
        emoji: t.emoji,
        label: t.label,
        count: String(t.count),
        ...(t.voters.length > 0 ? { voters: t.voters.join(',') } : {}),
      })
    )

    const pollClosedChildren = [
      xml('title', {}, pollData.title),
      ...(pollData.description ? [xml('description', {}, pollData.description)] : []),
      ...tallyElements,
    ]

    const resultId = generateUUID()
    const message = xml('message', { to: roomJid, type: 'groupchat', id: resultId },
      xml('body', {}, fallbackBody),
      xml('poll-closed', { xmlns: NS_POLL, 'message-id': messageId },
        ...pollClosedChildren,
      ),
      xml('fallback', { xmlns: NS_FALLBACK, for: NS_POLL },
        xml('body', {}),
      ),
      xml('store', { xmlns: NS_HINTS }),
    )

    await this.deps.sendStanza(message)

    // Mark the original poll message as closed immediately on the sender side
    this.deps.emitSDK('room:message-updated', {
      roomJid,
      messageId,
      updates: { pollClosedAt: new Date() },
    })

    return resultId
  }

  /**
   * Handle an incoming poll-results IQ query.
   * Responds with the current tally for polls created by this client.
   */
  private async handlePollResultQuery(iq: Element, pollResultsEl: Element): Promise<void> {
    const messageId = pollResultsEl.attrs['message-id']
    const from = iq.attrs.from
    const id = iq.attrs.id

    if (!messageId || !from) return

    const localPoll = this.localPolls.get(messageId)
    if (!localPoll) {
      // We don't know about this poll — send error
      const errorIq = xml('iq', { type: 'error', to: from, id },
        xml('poll-results', { xmlns: NS_POLL, 'message-id': messageId }),
        xml('error', { type: 'cancel' },
          xml('item-not-found', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
        ),
      )
      await this.deps.sendStanza(errorIq)
      return
    }

    // Get reactions from the room store
    const roomMessage = this.deps.stores?.room.getMessage(localPoll.roomJid, messageId)
    const reactions = roomMessage?.reactions ?? {}

    const tally = tallyPollResults(localPoll.poll, reactions)
    const tallyElements = tally.map((t) =>
      xml('tally', { emoji: t.emoji, label: t.label, count: String(t.count) })
    )

    const resultIq = xml('iq', { type: 'result', to: from, id },
      xml('poll-results', {
        xmlns: NS_POLL,
        'message-id': messageId,
        closed: String(localPoll.closed),
      }, ...tallyElements),
    )
    await this.deps.sendStanza(resultIq)
  }

}
