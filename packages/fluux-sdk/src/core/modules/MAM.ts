/**
 * Message Archive Management (XEP-0313) module.
 *
 * Provides unified archive querying for both 1:1 conversations and MUC rooms.
 * Handles result collection, pagination, and applying modifications (retractions,
 * corrections, fastenings, reactions) to archived messages.
 *
 * ## Lazy Loading Strategy
 *
 * MAM queries are **lazy** - they only run when needed, not on connect:
 *
 * 1. **On conversation open**: Side effects trigger a MAM query with `start` filter
 *    to fetch messages newer than the most recent cached message.
 * 2. **On scroll up**: `fetchOlderHistory()` queries MAM with `before` cursor for
 *    older messages (pagination).
 * 3. **On reconnect**: Only the active conversation catches up; others wait until opened.
 *
 * This approach minimizes connection time and bandwidth by avoiding bulk queries
 * for all conversations upfront.
 *
 * @module MAM
 * @category Modules
 */

import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getBareJid, getResource } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { executeWithConcurrency } from '../../utils/concurrencyUtils'
import { parseRSMResponse } from '../../utils/rsm'
import {
  NS_MAM,
  NS_RSM,
  NS_DATA_FORMS,
  NS_FORWARD,
  NS_DELAY,
  NS_RETRACT,
  NS_CORRECTION,
  NS_FASTEN,
  NS_REACTIONS,
  NS_OOB,
} from '../namespaces'
import type {
  Message,
  RoomMessage,
  MAMQueryOptions,
  MAMResult,
  RoomMAMQueryOptions,
  RoomMAMResult,
  RSMResponse,
} from '../types'
import { parseMessageContent, parseOgpFastening, applyRetraction, applyCorrection } from './messagingUtils'

/**
 * Internal type for collected modifications during MAM query
 */
interface MAMModifications {
  retractions: { targetId: string; from: string }[]
  corrections: { targetId: string; from: string; body: string; messageEl: Element }[]
  fastenings: { targetId: string; applyToEl: Element }[]
  reactions: { targetId: string; from: string; emojis: string[] }[]
}

/**
 * Message Archive Management (XEP-0313) module.
 *
 * Retrieves archived messages from the server's message archive for both
 * 1:1 conversations and MUC rooms. Supports pagination for incremental loading.
 *
 * @remarks
 * This module is accessed via `client.mam` on the XMPPClient instance.
 * For convenience, `queryMAM` and `queryRoomMAM` are also available via `client.chat`.
 *
 * @example Fetch recent 1:1 messages
 * ```typescript
 * const result = await client.mam.queryArchive({
 *   with: 'user@example.com',
 *   max: 50
 * })
 * console.log(`Fetched ${result.messages.length} messages, complete: ${result.complete}`)
 * ```
 *
 * @example Fetch room messages with pagination
 * ```typescript
 * // Initial fetch
 * const initial = await client.mam.queryRoomArchive({
 *   roomJid: 'room@conference.example.com',
 *   max: 50
 * })
 *
 * // Load older messages
 * if (!initial.complete && initial.rsm?.first) {
 *   const older = await client.mam.queryRoomArchive({
 *     roomJid: 'room@conference.example.com',
 *     before: initial.rsm.first
 *   })
 * }
 * ```
 *
 * @category Core
 */
export class MAM extends BaseModule {
  /**
   * MAM module doesn't handle incoming stanzas directly.
   * Results are collected via temporary listeners during queries.
   */
  handle(_stanza: Element): boolean {
    return false
  }

  /**
   * Query message archive for a 1:1 conversation (XEP-0313).
   *
   * @param options - Query options
   * @param options.with - The JID to fetch history with (conversation partner)
   * @param options.max - Maximum number of messages to retrieve (default: 50)
   * @param options.before - RSM cursor for pagination (empty string for latest, or message ID for older)
   * @returns Query result with messages, completion status, and pagination info
   */
  async queryArchive(options: MAMQueryOptions): Promise<MAMResult> {
    const { with: withJid, max = 50, before = '', start, end } = options
    const conversationId = getBareJid(withJid)

    // Track total messages across automatic pagination
    const allMessages: Message[] = []
    let currentBefore = before
    let isComplete = false
    let lastRsm: RSMResponse = {}
    const maxAutoPages = 5 // Limit automatic pagination to avoid infinite loops

    this.deps.emitSDK('chat:mam-loading', { conversationId, isLoading: true })

    try {
      for (let page = 0; page < maxAutoPages; page++) {
        const queryId = `mam_${generateUUID()}`

        // Build form fields with 'with' filter for 1:1 conversations
        const formFields: Element[] = [
          xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
          xml('field', { var: 'with' }, xml('value', {}, conversationId)),
        ]

        // Add time-based filters if provided (XEP-0313 Section 4.1.2)
        if (start) {
          formFields.push(xml('field', { var: 'start' }, xml('value', {}, start)))
        }
        if (end) {
          formFields.push(xml('field', { var: 'end' }, xml('value', {}, end)))
        }

        const iq = this.buildMAMQuery(queryId, formFields, max, currentBefore)

        const collectedMessages: Message[] = []
        const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }

        const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl) => {
          // Check for modifications first
          if (this.collectModification(messageEl, modifications, (from) => getBareJid(from))) {
            return
          }

          const msg = this.parseArchiveMessage(forwarded, conversationId)
          if (msg) collectedMessages.push(msg)
        })

        // Use the collector registry if available, otherwise fall back to direct listeners
        // (fallback is needed for tests that don't provide the registry)
        let unregister: () => void
        if (this.deps.registerMAMCollector) {
          unregister = this.deps.registerMAMCollector(queryId, collectMessage)
        } else {
          const xmpp = this.deps.getXmpp()
          xmpp?.on('stanza', collectMessage)
          unregister = () => xmpp?.removeListener('stanza', collectMessage)
        }

        try {
          const response = await this.deps.sendIQ(iq)
          if (!response) {
            throw new Error('No response from MAM query - client may be disconnected')
          }
          const { complete, rsm } = this.parseMAMResponse(response)

          // Apply modifications to collected messages
          this.applyModifications(collectedMessages, modifications, (msg, from) => msg.from === from)

          allMessages.push(...collectedMessages)
          isComplete = complete
          lastRsm = rsm

          // If we got displayable messages or archive is complete, stop paginating
          if (collectedMessages.length > 0 || complete) {
            break
          }

          // No displayable messages but archive has more - continue with next page
          // Use the 'first' ID as the 'before' cursor for backward pagination
          if (rsm.first) {
            currentBefore = rsm.first
            this.deps.emitSDK('console:event', {
              message: `Page ${page + 1} had no displayable messages, fetching older...`,
              category: 'sm',
            })
          } else {
            // No pagination cursor available, stop
            break
          }
        } finally {
          unregister()
        }
      }

      // Determine query direction:
      // - Forward: has `start` filter (fetching messages after a timestamp, like catching up)
      // - Backward: no `start` filter (fetching older history with `before` cursor)
      const direction = start ? 'forward' : 'backward'

      this.deps.emitSDK('chat:mam-messages', {
        conversationId,
        messages: allMessages,
        rsm: lastRsm,
        complete: isComplete,
        direction,
      })
      return { messages: allMessages, complete: isComplete, rsm: lastRsm }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      this.deps.emitSDK('chat:mam-error', { conversationId, error: msg })
      throw error
    } finally {
      this.deps.emitSDK('chat:mam-loading', { conversationId, isLoading: false })
    }
  }

  /**
   * Query message archive for a MUC room (XEP-0313 MUC MAM).
   *
   * @param options - Query options
   * @param options.roomJid - The room JID to fetch history for
   * @param options.max - Maximum number of messages to retrieve (default: 50)
   * @param options.before - RSM cursor for pagination (empty string for latest, or message ID for older)
   * @returns Query result with messages, completion status, and pagination info
   */
  async queryRoomArchive(options: RoomMAMQueryOptions): Promise<RoomMAMResult> {
    const { roomJid, max = 50, before, after, start } = options
    const queryId = `mam_${generateUUID()}`

    // Room MAM doesn't need a 'with' filter - we query the room's archive directly
    const formFields: Element[] = [
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
    ]

    // Add time filter if specified
    if (start) {
      formFields.push(xml('field', { var: 'start' }, xml('value', {}, start)))
    }

    // Send IQ to room JID (not user's archive)
    const iq = this.buildMAMQuery(queryId, formFields, max, before, roomJid, after)

    const collectedMessages: RoomMessage[] = []
    const modifications: MAMModifications = { retractions: [], corrections: [], fastenings: [], reactions: [] }

    const room = this.deps.stores?.room.getRoom(roomJid)
    const myNickname = room?.nickname || ''

    const collectMessage = this.createMessageCollector(queryId, (forwarded, messageEl) => {
      // Check for modifications first (keep full JID for room messages)
      if (this.collectModification(messageEl, modifications, (from) => from)) {
        return
      }

      const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname)
      if (msg) collectedMessages.push(msg)
    })

    // Use the collector registry if available, otherwise fall back to direct listeners
    let unregister: () => void
    if (this.deps.registerMAMCollector) {
      unregister = this.deps.registerMAMCollector(queryId, collectMessage)
    } else {
      const xmpp = this.deps.getXmpp()
      xmpp?.on('stanza', collectMessage)
      unregister = () => xmpp?.removeListener('stanza', collectMessage)
    }
    this.deps.emitSDK('room:mam-loading', { roomJid, isLoading: true })

    try {
      const response = await this.deps.sendIQ(iq)
      if (!response) {
        throw new Error('No response from room MAM query - client may be disconnected')
      }
      const { complete, rsm } = this.parseMAMResponse(response)

      // Apply modifications to collected messages (full JID comparison for rooms)
      this.applyModifications(collectedMessages, modifications, (msg, from) => msg.from === from)

      // Determine query direction:
      // - Forward: has `start` filter (fetching messages after a timestamp, like catching up)
      // - Backward: no `start` filter (fetching older history with `before` cursor)
      const direction = start ? 'forward' : 'backward'

      this.deps.emitSDK('room:mam-messages', {
        roomJid,
        messages: collectedMessages,
        rsm,
        complete,
        direction,
      })
      return { messages: collectedMessages, complete, rsm }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      this.deps.emitSDK('room:mam-error', { roomJid, error: msg })
      throw error
    } finally {
      unregister()
      this.deps.emitSDK('room:mam-loading', { roomJid, isLoading: false })
    }
  }

  /**
   * Fetch missed messages for a room or all joined rooms.
   *
   * After room join, the MUC history (`<history maxstanzas="50"/>`) may not
   * contain all recent messages since it's from the server's in-memory buffer.
   * This method queries MAM for the complete archive to catch up.
   *
   * For each room, it finds the latest message we have and queries MAM for
   * messages after that timestamp. Duplicate messages are automatically
   * filtered out by the store's merge logic.
   *
   * @param roomJid - Optional specific room to fetch. If omitted, fetches for all joined rooms.
   */
  async fetchMissedRoomMessages(roomJid?: string): Promise<void> {
    // Get the room(s) to fetch for
    let rooms: Array<{ jid: string; messages: Array<{ timestamp: Date }> }>

    if (roomJid) {
      const room = this.deps.stores?.room.getRoom(roomJid)
      if (!room) return
      rooms = [{ jid: room.jid, messages: room.messages || [] }]
    } else {
      const joinedRooms = this.deps.stores?.room.joinedRooms() || []
      if (joinedRooms.length === 0) return
      rooms = joinedRooms.map(r => ({ jid: r.jid, messages: r.messages || [] }))

      this.deps.emitSDK('console:event', {
        message: `Fetching missed messages for ${joinedRooms.length} joined room(s)`,
        category: 'sm',
      })
    }

    // Query each room in parallel
    const promises = rooms.map(async (room) => {
      try {
        // Find the latest message we have for this room
        const latestMessage = room.messages[room.messages.length - 1]

        if (latestMessage) {
          // Query for messages after the latest one we have
          // Add 1ms to avoid fetching the same message
          const startTime = new Date(latestMessage.timestamp.getTime() + 1)
          await this.queryRoomArchive({
            roomJid: room.jid,
            max: 100, // Fetch up to 100 missed messages
            start: startTime.toISOString(),
          })
        } else {
          // No messages - fetch latest
          await this.queryRoomArchive({
            roomJid: room.jid,
            max: 50,
            before: '', // Empty = get latest
          })
        }
      } catch (error) {
        // Log but don't fail - some rooms might not support MAM
        console.warn(`[MAM] Failed to fetch missed messages for ${room.jid}:`, error)
      }
    })

    await Promise.allSettled(promises)
  }

  /**
   * Fetch missed messages for 1:1 conversations.
   *
   * After reconnection, conversations may have new messages that arrived while
   * the client was offline. This method iterates backward from "now" until we
   * find messages that overlap with what we already have.
   *
   * Strategy: Query latest messages first, then iterate backward until we find
   * a message we already have. This ensures users see the most recent messages
   * first, even if thousands of messages arrived while offline.
   *
   * This is the 1:1 chat equivalent of `fetchMissedRoomMessages()`.
   */
  async fetchMissedConversationMessages(): Promise<void> {
    const conversations = this.deps.stores?.chat.getAllConversations() || []
    if (conversations.length === 0) return

    // Only process conversations that have messages (need overlap detection)
    const conversationsWithMessages = conversations.filter(c => c.messages.length > 0)
    if (conversationsWithMessages.length === 0) return

    this.deps.emitSDK('console:event', {
      message: `Fetching missed messages for ${conversationsWithMessages.length} conversation(s)`,
      category: 'sm',
    })

    // Query each conversation in parallel
    const promises = conversationsWithMessages.map(async (conv) => {
      try {
        // Build a set of known message IDs for quick overlap detection
        const knownMessageIds = new Set<string>()
        for (const msg of conv.messages) {
          knownMessageIds.add(msg.id)
          if (msg.stanzaId) knownMessageIds.add(msg.stanzaId)
        }

        // Also track the latest message timestamp for fallback overlap detection
        const latestKnownTimestamp = conv.messages[conv.messages.length - 1]?.timestamp

        let beforeCursor: string | undefined = undefined
        const maxIterations = 10 // Safety limit to prevent infinite loops
        let foundOverlap = false

        for (let i = 0; i < maxIterations && !foundOverlap; i++) {
          // Query backward: empty before = latest, or specific ID for older pages
          const result = await this.queryArchive({
            with: conv.id,
            max: 50,
            before: beforeCursor ?? '',
          })

          // Check if any returned message overlaps with what we have
          for (const msg of result.messages) {
            if (knownMessageIds.has(msg.id) || (msg.stanzaId && knownMessageIds.has(msg.stanzaId))) {
              foundOverlap = true
              break
            }
            // Fallback: if message timestamp is older than our latest, we've caught up
            if (latestKnownTimestamp && msg.timestamp <= latestKnownTimestamp) {
              foundOverlap = true
              break
            }
          }

          // If archive is complete or we found overlap, stop
          if (result.complete || foundOverlap) {
            break
          }

          // Prepare cursor for next iteration (get messages before the oldest returned)
          if (result.rsm?.first) {
            beforeCursor = result.rsm.first
          } else {
            // No pagination cursor available, stop
            break
          }
        }
      } catch (error) {
        // Log but don't fail - some conversations might have issues
        console.warn(`[MAM] Failed to fetch missed messages for ${conv.id}:`, error)
      }
    })

    await Promise.allSettled(promises)
  }

  /**
   * Refresh sidebar previews for all conversations by fetching the latest message.
   *
   * After being offline, the cached lastMessage may be stale (messages exchanged on
   * other devices). This method fetches `max=1` from MAM for each conversation to
   * update the sidebar preview without affecting the message history.
   *
   * The fetched messages are NOT stored in IndexedDB or the messages array - they
   * only update the `lastMessage` field for sidebar display. When the conversation
   * is opened, a full MAM fetch will retrieve the complete history.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 3)
   */
  async refreshConversationPreviews(options: { concurrency?: number } = {}): Promise<void> {
    const { concurrency = 3 } = options
    const conversations = this.deps.stores?.chat.getAllConversations() || []
    if (conversations.length === 0) return

    this.deps.emitSDK('console:event', {
      message: `Refreshing previews for ${conversations.length} conversation(s)`,
      category: 'sm',
    })

    const conversationIds = conversations.map((c) => c.id)

    await executeWithConcurrency(
      conversationIds,
      (conversationId) => this.fetchPreviewForConversation(conversationId),
      concurrency
    )
  }

  /**
   * Fetch the latest message for a single conversation (preview only).
   * Updates lastMessage without affecting message history.
   */
  private async fetchPreviewForConversation(conversationId: string): Promise<void> {
    try {
      const queryId = `preview_${generateUUID()}`

      // Build form fields with 'with' filter for 1:1 conversations
      const formFields: Element[] = [
        xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
        xml('field', { var: 'with' }, xml('value', {}, conversationId)),
      ]

      // Query with max=5 to find a displayable message (reactions/corrections are skipped)
      // This handles the case where recent messages are modifications that can't be previewed
      const iq = this.buildMAMQuery(queryId, formFields, 5, '')

      let latestMessage: Message | null = null

      const collectMessage = this.createMessageCollector(queryId, (forwarded, _messageEl) => {
        const msg = this.parseArchiveMessage(forwarded, conversationId)
        if (msg) latestMessage = msg
      })

      // Use the collector registry if available, otherwise fall back to direct listeners
      let unregister: () => void
      if (this.deps.registerMAMCollector) {
        unregister = this.deps.registerMAMCollector(queryId, collectMessage)
      } else {
        const xmpp = this.deps.getXmpp()
        xmpp?.on('stanza', collectMessage)
        unregister = () => xmpp?.removeListener('stanza', collectMessage)
      }

      try {
        const response = await this.deps.sendIQ(iq)
        if (response && latestMessage) {
          // Update only the lastMessage preview, not the message history
          this.deps.stores?.chat.updateLastMessagePreview(conversationId, latestMessage)
        }
      } finally {
        unregister()
      }
    } catch (_error) {
      // Silently ignore errors - preview refresh is best-effort
      // Individual conversation failures shouldn't affect others
    }
  }

  /**
   * Refresh sidebar previews for all joined rooms by fetching the latest message.
   *
   * After being offline or auto-joining rooms, the lastMessage preview may be stale.
   * This method fetches `max=1` from MAM for each room that supports MAM to update
   * the sidebar preview without affecting the message history.
   *
   * @param options - Optional configuration
   * @param options.concurrency - Maximum parallel requests (default: 3)
   */
  async refreshRoomPreviews(options: { concurrency?: number } = {}): Promise<void> {
    const { concurrency = 3 } = options
    // Get all joined rooms (skip QuickChat rooms)
    const joinedRooms = this.deps.stores?.room.joinedRooms() || []
    const nonQuickChatRooms = joinedRooms.filter((r) => !r.isQuickChat)
    if (nonQuickChatRooms.length === 0) return

    // Separate rooms by MAM support
    const mamRooms = nonQuickChatRooms.filter((r) => r.supportsMAM)
    const nonMamRooms = nonQuickChatRooms.filter((r) => !r.supportsMAM)

    this.deps.emitSDK('console:event', {
      message: `Refreshing previews for ${mamRooms.length} MAM room(s), ${nonMamRooms.length} non-MAM room(s)`,
      category: 'sm',
    })

    // For MAM rooms: fetch preview via MAM query
    const mamRoomJids = mamRooms.map((r) => r.jid)
    await executeWithConcurrency(
      mamRoomJids,
      (roomJid) => this.fetchPreviewForRoom(roomJid),
      concurrency
    )

    // For non-MAM rooms: load preview from cache to populate lastMessage
    // This only updates lastMessage without modifying the messages array
    for (const room of nonMamRooms) {
      if (!room.lastMessage) {
        await this.deps.stores?.room.loadPreviewFromCache(room.jid)
      }
    }
  }

  /**
   * Fetch the latest message for a single room (preview only).
   * Updates lastMessage without affecting message history.
   *
   * This is called automatically when a room is successfully joined
   * to populate the sidebar preview immediately.
   *
   * @param roomJid - The bare JID of the room
   */
  async fetchPreviewForRoom(roomJid: string): Promise<void> {
    try {
      const queryId = `preview_${generateUUID()}`

      // Room MAM doesn't need a 'with' filter
      const formFields: Element[] = [
        xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_MAM)),
      ]

      // Query with max=30 to find a displayable message (reactions/corrections/markers are skipped)
      // High-traffic rooms may have many non-displayable messages (reactions, read markers, etc.)
      // so we request more to increase the chance of finding a message with actual body text
      const iq = this.buildMAMQuery(queryId, formFields, 30, '', roomJid)

      const room = this.deps.stores?.room.getRoom(roomJid)
      const myNickname = room?.nickname || ''
      let latestMessage: RoomMessage | null = null

      const collectMessage = this.createMessageCollector(queryId, (forwarded, _messageEl) => {
        const msg = this.parseRoomArchiveMessage(forwarded, roomJid, myNickname)
        if (msg) latestMessage = msg
      })

      // Use the collector registry if available, otherwise fall back to direct listeners
      let unregister: () => void
      if (this.deps.registerMAMCollector) {
        unregister = this.deps.registerMAMCollector(queryId, collectMessage)
      } else {
        const xmpp = this.deps.getXmpp()
        xmpp?.on('stanza', collectMessage)
        unregister = () => xmpp?.removeListener('stanza', collectMessage)
      }

      try {
        const response = await this.deps.sendIQ(iq)
        if (response && latestMessage) {
          // Update only the lastMessage preview, not the message history
          this.deps.stores?.room.updateLastMessagePreview(roomJid, latestMessage)
        }
      } finally {
        unregister()
      }
    } catch (_error) {
      // Silently ignore errors - preview refresh is best-effort
    }
  }

  // --- Private Helpers ---

  /**
   * Build MAM query IQ stanza with RSM pagination.
   *
   * @param queryId - Unique query identifier
   * @param formFields - Data form fields for filtering
   * @param max - Maximum results to return
   * @param before - RSM cursor for backward pagination (empty = latest, ID = before that ID)
   * @param toJid - Optional JID to send query to (for room MAM)
   * @param after - RSM cursor for forward pagination (get messages after this ID)
   */
  private buildMAMQuery(
    queryId: string,
    formFields: Element[],
    max: number,
    before?: string,
    toJid?: string,
    after?: string
  ): Element {
    const rsmChildren: Element[] = [xml('max', {}, String(max))]

    // RSM pagination: before and after are mutually exclusive
    if (after) {
      // Forward pagination: get messages after this ID
      rsmChildren.push(xml('after', {}, after))
    } else if (before === '') {
      // Empty before = get latest messages (backward from end)
      rsmChildren.push(xml('before', {}))
    } else if (before) {
      // Backward pagination: get messages before this ID
      rsmChildren.push(xml('before', {}, before))
    }

    const iqAttrs: Record<string, string> = { type: 'set', id: queryId }
    if (toJid) {
      iqAttrs.to = toJid
    }

    return xml(
      'iq',
      iqAttrs,
      xml(
        'query',
        { xmlns: NS_MAM, queryid: queryId },
        xml('x', { xmlns: NS_DATA_FORMS, type: 'submit' }, ...formFields),
        xml('set', { xmlns: NS_RSM }, ...rsmChildren)
      )
    )
  }

  /**
   * Create a stanza collector function that processes MAM result messages.
   */
  private createMessageCollector(
    queryId: string,
    onMessage: (forwarded: Element, messageEl: Element) => void
  ): (stanza: Element) => void {
    return (stanza: Element) => {
      // Skip error stanzas - server may return error with stale MAM result inside
      if (stanza.attrs.type === 'error') return

      const result = stanza.getChild('result', NS_MAM)
      if (!result || result.attrs.queryid !== queryId) return

      const forwarded = result.getChild('forwarded', NS_FORWARD)
      if (!forwarded) return

      const messageEl = forwarded.getChild('message')
      if (!messageEl) return

      onMessage(forwarded, messageEl)
    }
  }

  /**
   * Check for and collect modifications (retractions, corrections, fastenings, reactions).
   * Returns true if the message was a modification (not a regular message).
   */
  private collectModification(
    messageEl: Element,
    modifications: MAMModifications,
    normalizeFrom: (from: string) => string
  ): boolean {
    const from = messageEl.attrs.from
    if (!from) return false

    // Retraction
    const retractEl = messageEl.getChild('retract', NS_RETRACT)
    if (retractEl?.attrs.id) {
      modifications.retractions.push({ targetId: retractEl.attrs.id, from: normalizeFrom(from) })
      return true
    }

    // Correction
    const replaceEl = messageEl.getChild('replace', NS_CORRECTION)
    if (replaceEl?.attrs.id) {
      const bodyText = messageEl.getChildText('body')
      if (bodyText) {
        modifications.corrections.push({
          targetId: replaceEl.attrs.id,
          from: normalizeFrom(from),
          body: bodyText,
          messageEl,
        })
      }
      return true
    }

    // Fastening (link preview)
    const applyToEl = messageEl.getChild('apply-to', NS_FASTEN)
    if (applyToEl?.attrs.id) {
      modifications.fastenings.push({ targetId: applyToEl.attrs.id, applyToEl })
      return true
    }

    // Reactions (XEP-0444)
    const reactionsEl = messageEl.getChild('reactions', NS_REACTIONS)
    if (reactionsEl?.attrs.id) {
      const emojis = reactionsEl.getChildren('reaction').map(r => r.getText()).filter(Boolean)
      modifications.reactions.push({
        targetId: reactionsEl.attrs.id,
        from: normalizeFrom(from),
        emojis,
      })
      return true
    }

    return false
  }

  /**
   * Apply collected modifications to messages.
   */
  private applyModifications<T extends Message | RoomMessage>(
    messages: T[],
    modifications: MAMModifications,
    senderMatches: (msg: T, from: string) => boolean
  ): void {
    // Apply retractions
    for (const retraction of modifications.retractions) {
      const target = messages.find(m => m.id === retraction.targetId || m.stanzaId === retraction.targetId)
      if (target) {
        const retractionData = applyRetraction(senderMatches(target, retraction.from))
        if (retractionData) {
          target.isRetracted = retractionData.isRetracted
          target.retractedAt = retractionData.retractedAt
        }
      }
    }

    // Apply corrections
    for (const correction of modifications.corrections) {
      const target = messages.find(m => m.id === correction.targetId || m.stanzaId === correction.targetId)
      if (target && senderMatches(target, correction.from)) {
        const correctionData = applyCorrection(
          correction.messageEl,
          correction.body,
          target.originalBody ?? target.body
        )
        target.body = correctionData.body
        target.isEdited = correctionData.isEdited
        target.originalBody = correctionData.originalBody
        if (correctionData.attachment) {
          target.attachment = correctionData.attachment
        }
      }
    }

    // Apply link previews from fastenings
    for (const fastening of modifications.fastenings) {
      const target = messages.find(m => m.id === fastening.targetId || m.stanzaId === fastening.targetId)
      if (target) {
        const linkPreview = parseOgpFastening(fastening.applyToEl)
        if (linkPreview) {
          target.linkPreview = linkPreview
        }
      }
    }

    // Apply reactions (XEP-0444)
    // Reactions replace the user's previous reactions on the same message
    for (const reaction of modifications.reactions) {
      const target = messages.find(m => m.id === reaction.targetId || m.stanzaId === reaction.targetId)
      if (target) {
        // Initialize reactions object if not present
        if (!target.reactions) {
          target.reactions = {}
        }

        // Remove this user from all existing reactions on this message
        for (const emoji of Object.keys(target.reactions)) {
          target.reactions[emoji] = target.reactions[emoji].filter(jid => jid !== reaction.from)
          if (target.reactions[emoji].length === 0) {
            delete target.reactions[emoji]
          }
        }

        // Add the new reactions from this user
        for (const emoji of reaction.emojis) {
          if (!target.reactions[emoji]) {
            target.reactions[emoji] = []
          }
          if (!target.reactions[emoji].includes(reaction.from)) {
            target.reactions[emoji].push(reaction.from)
          }
        }

        // Clean up empty reactions object
        if (Object.keys(target.reactions).length === 0) {
          target.reactions = undefined
        }
      }
    }
  }

  /**
   * Parse MAM response to extract completion status and RSM info.
   */
  private parseMAMResponse(response: Element): { complete: boolean; rsm: RSMResponse } {
    const fin = response.getChild('fin', NS_MAM)
    const complete = fin?.attrs.complete === 'true'
    const rsm = parseRSMResponse(fin?.getChild('set', NS_RSM))
    return { complete, rsm }
  }

  /**
   * Parse a single archived message for 1:1 conversations.
   */
  private parseArchiveMessage(forwarded: Element, conversationId: string): Message | null {
    const messageEl = forwarded.getChild('message')
    const delayEl = forwarded.getChild('delay', NS_DELAY)
    if (!messageEl) return null

    const from = messageEl.attrs.from
    const body = messageEl.getChildText('body')

    // Skip modification messages (retractions, corrections, reactions)
    // These are handled separately by detectAndCollectModification()
    if (messageEl.getChild('retract', NS_RETRACT)) return null
    if (messageEl.getChild('replace', NS_CORRECTION)) return null
    if (messageEl.getChild('reactions', NS_REACTIONS)) return null

    // Accept messages with body OR OOB attachment (file-only messages have no body)
    if (!from) return null
    if (!body && !messageEl.getChild('x', NS_OOB)) return null

    const bareFrom = getBareJid(from)
    const isOutgoing = bareFrom === getBareJid(this.deps.getCurrentJid() ?? '')
    const parsed = parseMessageContent({ messageEl, body: body || '', delayEl, forceDelayed: true })

    return {
      type: 'chat',
      id: messageEl.attrs.id || generateUUID(),
      ...(parsed.stanzaId && { stanzaId: parsed.stanzaId }),
      conversationId,
      from: bareFrom,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      isDelayed: true,
      ...(parsed.noStyling && { noStyling: parsed.noStyling }),
      ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      ...(parsed.attachment && { attachment: parsed.attachment }),
    }
  }

  /**
   * Parse a single archived message for MUC rooms.
   */
  private parseRoomArchiveMessage(forwarded: Element, roomJid: string, myNickname: string): RoomMessage | null {
    const messageEl = forwarded.getChild('message')
    const delayEl = forwarded.getChild('delay', NS_DELAY)
    if (!messageEl) return null

    const from = messageEl.attrs.from
    const body = messageEl.getChildText('body')

    // Skip modification messages (retractions, corrections, reactions)
    // These are handled separately by detectAndCollectModification()
    if (messageEl.getChild('retract', NS_RETRACT)) return null
    if (messageEl.getChild('replace', NS_CORRECTION)) return null
    if (messageEl.getChild('reactions', NS_REACTIONS)) return null

    // Accept messages with body OR OOB attachment (file-only messages have no body)
    if (!from) return null
    if (!body && !messageEl.getChild('x', NS_OOB)) return null

    const nick = getResource(from) || ''
    // Case-insensitive nickname comparison - some servers may change case
    const isOutgoing = nick.toLowerCase() === myNickname.toLowerCase()
    const parsed = parseMessageContent({ messageEl, body: body || '', delayEl, forceDelayed: true, preserveFullReplyToJid: true })

    return {
      type: 'groupchat',
      id: messageEl.attrs.id || generateUUID(),
      ...(parsed.stanzaId && { stanzaId: parsed.stanzaId }),
      roomJid,
      from,
      nick,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      isDelayed: true,
      ...(parsed.noStyling && { noStyling: parsed.noStyling }),
      ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      ...(parsed.attachment && { attachment: parsed.attachment }),
    }
  }
}
